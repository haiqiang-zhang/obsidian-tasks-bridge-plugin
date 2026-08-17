import {
  type FileManager,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
  type TFile,
  type Vault,
} from "obsidian";

import {
  makeProjectCatalog,
  type ProjectCatalog,
  type ProjectCatalogProject,
  type ProjectCatalogStorage,
} from "./catalog";
import { isPathInside, sanitizePathSegment } from "./paths";
import type {
  ProjectCompletionEvent,
  ProjectSyncConfig,
  ProjectSyncMapping,
  ProjectSyncProjectStatistics,
  ProjectSyncRunContext,
  ProjectSyncSnapshot,
  ProjectSyncStatisticsRepository,
  ProjectSyncStatisticsScope,
  ProjectSyncStatisticsSnapshot,
} from "./types";

export const LEGACY_PROJECT_CATALOG_MARKER = "tasks_bridge_project_catalog_managed";
export const LEGACY_PROJECT_CATALOG_FOLDER = "_Tasks Bridge/Project Catalogs";
const LEGACY_PROJECT_CATALOG_ROOT = "_Tasks Bridge";
const LEGACY_PROJECT_CATALOG_SCHEMA_VERSION = 1;
const LOCAL_EVENT_PREFIX = "local:";
const LOCAL_EVENT_MATCH_TOLERANCE_MS = 120_000;
const LOCAL_REFRESH_DEBOUNCE_MS = 50;

type LocalTaskProjection = {
  taskId: string;
  filePath: string;
  status: "active" | "completed" | "stale" | "out_of_scope";
};

export class ObsidianProjectSyncStatisticsRepository implements ProjectSyncStatisticsRepository {
  private readonly vault: Vault;
  private readonly fileManager: FileManager;
  private readonly catalogStorage: ProjectCatalogStorage;
  private config: ProjectSyncConfig;
  private snapshot: ProjectSyncStatisticsSnapshot | null = null;
  private disposed = false;
  private refreshInFlight: Promise<void> | undefined;
  private refreshAgain = false;
  private refreshTimer: number | undefined;
  private legacyCatalogMigrationAttempted = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    vault: Vault,
    fileManager: FileManager,
    initialConfig: ProjectSyncConfig,
    catalogStorage: ProjectCatalogStorage,
  ) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.config = cloneConfig(initialConfig);
    this.catalogStorage = catalogStorage;
  }

  public setConfig(config: ProjectSyncConfig): void {
    if (this.disposed) {
      return;
    }
    const scopesChanged = !hasSameScopes(this.config, config);
    this.config = cloneConfig(config);
    if (scopesChanged) {
      this.setSnapshot(null);
    }
    this.scheduleRefresh();
  }

  public async persistProjectCatalog(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    runContext.assertValid();
    if (mapping.project?.projectId !== snapshot.rootProjectId) {
      throw new Error("Project catalog snapshot does not match its configured mapping");
    }

    await this.catalogStorage.persistCatalogs([makeProjectCatalog(snapshot, mapping)]);
    runContext.assertValid();
  }

  public refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.refreshInFlight !== undefined) {
      this.refreshAgain = true;
      return this.refreshInFlight;
    }

    const promise = (async () => {
      do {
        this.refreshAgain = false;
        await this.performRefresh();
      } while (this.refreshAgain && !this.disposed);
    })().finally(() => {
      if (this.refreshInFlight === promise) {
        this.refreshInFlight = undefined;
      }
    });
    this.refreshInFlight = promise;
    return promise;
  }

  public notifyLocalChanges(paths: readonly string[]): void {
    if (this.disposed || !paths.some((path) => this.isRelevantPath(path))) {
      return;
    }
    this.scheduleRefresh();
  }

  public getSnapshot(): ProjectSyncStatisticsSnapshot | null {
    return this.snapshot;
  }

  public clearSnapshot(): void {
    this.setSnapshot(null);
  }

  public reloadCatalogs(): void {
    if (this.disposed) {
      return;
    }
    this.legacyCatalogMigrationAttempted = false;
    this.scheduleRefresh();
  }

  public subscribe(listener: () => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.snapshot = null;
    this.listeners.clear();
  }

  private async performRefresh(): Promise<void> {
    const config = cloneConfig(this.config);
    const mappings = config.mappings.filter((mapping) => mapping.project !== null);
    await this.migrateLegacyCatalogs();
    const catalogs = mappings
      .map((mapping) => ({
        mapping,
        catalog: this.readCatalog(mapping),
      }))
      .filter(
        (entry): entry is { mapping: ProjectSyncMapping; catalog: ProjectCatalog } =>
          entry.catalog !== null,
      );

    if (catalogs.length === 0) {
      this.setSnapshot(null);
      return;
    }

    const taskFiles = this.vault
      .getMarkdownFiles()
      .filter((file) =>
        mappings.some((mapping) =>
          mappingRoots(mapping).some((root) => isPathInside(root, file.path)),
        ),
      );
    const parsedTasks = await Promise.all(
      taskFiles.map(async (file) => await this.readTaskProjection(file)),
    );
    const tasks = parsedTasks.filter((task): task is LocalTaskProjection => task !== null);
    const scopes = catalogs.map(({ mapping, catalog }) =>
      buildStatisticsScope(mapping, catalog, tasks),
    );
    const syncedAt = catalogs
      .map(({ catalog }) => catalog.syncedAt)
      .sort((left, right) => left.localeCompare(right))[0];
    this.setSnapshot({ syncedAt, scopes });
  }

  private readCatalog(mapping: ProjectSyncMapping): ProjectCatalog | null {
    const catalog = this.catalogStorage.getCatalog(mapping.id);
    if (
      catalog === null ||
      catalog.mappingId !== mapping.id ||
      catalog.rootProjectId !== mapping.project?.projectId ||
      catalog.includeSubprojects !== mapping.includeSubprojects
    ) {
      return null;
    }
    return catalog;
  }

  private async migrateLegacyCatalogs(): Promise<void> {
    if (this.legacyCatalogMigrationAttempted) {
      return;
    }
    this.legacyCatalogMigrationAttempted = true;

    try {
      const legacyCatalogs: ProjectCatalog[] = [];
      const legacyFiles: TFile[] = [];
      const files = this.vault
        .getMarkdownFiles()
        .filter((file) => isPathInside(LEGACY_PROJECT_CATALOG_FOLDER, file.path));
      for (const file of files) {
        const catalog = parseLegacyProjectCatalog(await this.vault.read(file));
        if (catalog === null || file.path !== legacyProjectCatalogPath(catalog.mappingId)) {
          console.warn(
            `Tasks Bridge left an unrecognized legacy Project catalog at '${file.path}'`,
          );
          continue;
        }
        legacyCatalogs.push(catalog);
        legacyFiles.push(file);
      }

      if (legacyCatalogs.length > 0) {
        await this.catalogStorage.persistCatalogs(legacyCatalogs);
      }

      for (const file of legacyFiles) {
        await this.fileManager.trashFile(file);
      }
      await this.trashLegacyCatalogFoldersIfEmpty();
    } catch (error: unknown) {
      this.legacyCatalogMigrationAttempted = false;
      throw error;
    }
  }

  private async trashLegacyCatalogFoldersIfEmpty(): Promise<void> {
    for (const path of [LEGACY_PROJECT_CATALOG_FOLDER, LEGACY_PROJECT_CATALOG_ROOT]) {
      const folder = this.vault.getFolderByPath(path);
      if (folder !== null && folder.children.length === 0) {
        await this.fileManager.trashFile(folder);
      }
    }
  }

  private async readTaskProjection(file: TFile): Promise<LocalTaskProjection | null> {
    const frontmatter = parseFrontmatter(await this.vault.read(file));
    if (frontmatter === null) {
      return null;
    }
    const taskId = readNonEmptyString(frontmatter.todoist_task_id);
    const status = readTaskStatus(frontmatter.todoist_status);
    if (taskId === null || status === null) {
      return null;
    }
    return {
      taskId,
      filePath: file.path,
      status,
    };
  }

  private isRelevantPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (isPathInside(LEGACY_PROJECT_CATALOG_FOLDER, normalized)) {
      return true;
    }
    return this.config.mappings.some((mapping) =>
      mappingRoots(mapping).some((root) => isPathInside(root, normalized)),
    );
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer !== undefined) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error: unknown) => {
        console.error("Failed to rebuild Project Overview from local Markdown:", error);
      });
    }, LOCAL_REFRESH_DEBOUNCE_MS);
  }

  private setSnapshot(snapshot: ProjectSyncStatisticsSnapshot | null): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error: unknown) {
        console.error("Local Project Overview listener failed:", error);
      }
    }
  }
}

export const legacyProjectCatalogPath = (mappingId: string): string =>
  normalizePath(
    `${LEGACY_PROJECT_CATALOG_FOLDER}/${sanitizePathSegment(mappingId, "project-sync-mapping")}.md`,
  );

const parseLegacyProjectCatalog = (content: string): ProjectCatalog | null => {
  const frontmatter = parseFrontmatter(content);
  if (
    frontmatter === null ||
    frontmatter[LEGACY_PROJECT_CATALOG_MARKER] !== true ||
    frontmatter.tasks_bridge_project_catalog_version !== LEGACY_PROJECT_CATALOG_SCHEMA_VERSION
  ) {
    return null;
  }
  const mappingId = readNonEmptyString(frontmatter.tasks_bridge_mapping_id);
  const rootProjectId = readNonEmptyString(frontmatter.tasks_bridge_root_project_id);
  const syncedAt = readTimestamp(frontmatter.tasks_bridge_synced_at);
  const includeSubprojects = frontmatter.tasks_bridge_include_subprojects;
  if (
    mappingId === null ||
    rootProjectId === null ||
    syncedAt === null ||
    typeof includeSubprojects !== "boolean" ||
    !Array.isArray(frontmatter.tasks_bridge_projects)
  ) {
    return null;
  }

  const projects = frontmatter.tasks_bridge_projects
    .map(readCatalogProject)
    .filter((project): project is ProjectCatalogProject => project !== null);
  if (
    projects.length !== frontmatter.tasks_bridge_projects.length ||
    !projects.some((project) => project.id === rootProjectId)
  ) {
    return null;
  }
  return {
    mappingId,
    rootProjectId,
    includeSubprojects,
    syncedAt,
    projects,
    tasks: [],
    completionEvents: [],
  };
};

const parseFrontmatter = (content: string): Record<string, unknown> | null => {
  const info = getFrontMatterInfo(content);
  if (!info.exists) {
    return null;
  }
  try {
    const parsed: unknown = parseYaml(info.frontmatter);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readCatalogProject = (value: unknown): ProjectCatalogProject | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const name = readNonEmptyString(value.name);
  const parentId = value.parent_id === null ? null : readNonEmptyString(value.parent_id);
  const childOrder = value.child_order;
  if (
    id === null ||
    name === null ||
    (value.parent_id !== null && parentId === null) ||
    typeof childOrder !== "number" ||
    !Number.isFinite(childOrder)
  ) {
    return null;
  }
  return { id, name, parentId, childOrder };
};

const buildStatisticsScope = (
  mapping: ProjectSyncMapping,
  catalog: ProjectCatalog,
  tasks: readonly LocalTaskProjection[],
): ProjectSyncStatisticsScope => {
  const projectIds = new Set(catalog.projects.map((project) => project.id));
  const directCounts = new Map(
    catalog.projects.map((project) => [project.id, { active: 0, completed: 0 }]),
  );
  const taskStates = new Map<string, { projectId: string; status: "active" | "completed" }>();
  const conflictedTaskIds = new Set<string>();
  const catalogTasks = new Map(catalog.tasks.map((task) => [task.id, task]));
  const roots = mappingRoots(mapping);

  for (const task of tasks) {
    const catalogTask = catalogTasks.get(task.taskId);
    if (
      catalogTask === undefined ||
      !projectIds.has(catalogTask.projectId) ||
      !roots.some((root) => isPathInside(root, task.filePath))
    ) {
      continue;
    }
    if (task.status !== "active" && task.status !== "completed") {
      continue;
    }
    if (conflictedTaskIds.has(task.taskId)) {
      continue;
    }
    const current = taskStates.get(task.taskId);
    if (current === undefined) {
      taskStates.set(task.taskId, { projectId: catalogTask.projectId, status: task.status });
    } else if (current.projectId !== catalogTask.projectId || current.status !== task.status) {
      // Conflicting copies share one immutable ID. Count neither state until Project sync resolves
      // the conflict instead of selecting an arbitrary file.
      taskStates.delete(task.taskId);
      conflictedTaskIds.add(task.taskId);
    }
  }
  for (const task of taskStates.values()) {
    const counts = directCounts.get(task.projectId);
    if (counts !== undefined) {
      counts[task.status]++;
    }
  }

  const completionEvents = mergeLocalAndCanonicalEvents(
    catalog.completionEvents.filter((event) => projectIds.has(event.projectId)),
  );
  const directCompletionEvents = new Map<string, ProjectCompletionEvent[]>(
    catalog.projects.map((project) => [project.id, []]),
  );
  for (const event of completionEvents) {
    directCompletionEvents.get(event.projectId)?.push(event);
  }

  const projects: ProjectSyncProjectStatistics[] = catalog.projects.map((project) => ({
    ...project,
    directCounts: directCounts.get(project.id) ?? { active: 0, completed: 0 },
    directCompletionEvents: directCompletionEvents.get(project.id) ?? [],
  }));
  return {
    mappingId: mapping.id,
    rootProjectId: catalog.rootProjectId,
    includeSubprojects: catalog.includeSubprojects,
    projects,
    tasks: catalog.tasks.map((task) => ({ ...task })),
  };
};

const mergeLocalAndCanonicalEvents = (
  events: readonly ProjectCompletionEvent[],
): ProjectCompletionEvent[] => {
  const unique = deduplicateEvents(events);
  const canonical = unique.filter((event) => !event.id.startsWith(LOCAL_EVENT_PREFIX));
  const unmatchedCanonical = new Set(canonical.map((event) => event.id));
  const result = [...canonical];
  for (const local of unique.filter((event) => event.id.startsWith(LOCAL_EVENT_PREFIX))) {
    let closest: ProjectCompletionEvent | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    const localTime = Date.parse(local.completedAt);
    for (const event of canonical) {
      if (
        !unmatchedCanonical.has(event.id) ||
        event.taskId !== local.taskId ||
        event.projectId !== local.projectId
      ) {
        continue;
      }
      const distance = Math.abs(Date.parse(event.completedAt) - localTime);
      if (distance <= LOCAL_EVENT_MATCH_TOLERANCE_MS && distance < closestDistance) {
        closest = event;
        closestDistance = distance;
      }
    }
    if (closest === undefined) {
      result.push(local);
    } else {
      unmatchedCanonical.delete(closest.id);
    }
  }
  return result.sort(compareEvents);
};

const deduplicateEvents = (events: readonly ProjectCompletionEvent[]): ProjectCompletionEvent[] => {
  const byId = new Map<string, ProjectCompletionEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) {
      byId.set(event.id, { ...event });
    }
  }
  return [...byId.values()].sort(compareEvents);
};

const compareEvents = (left: ProjectCompletionEvent, right: ProjectCompletionEvent): number => {
  const byTime = left.completedAt.localeCompare(right.completedAt);
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
};

const mappingRoots = (mapping: ProjectSyncMapping): string[] =>
  [mapping.folder, ...mapping.previousFolders]
    .map((folder) => normalizePath(folder))
    .filter((folder) => folder !== "");

const readTaskStatus = (value: unknown): LocalTaskProjection["status"] | null => {
  switch (value) {
    case "active":
    case "completed":
    case "stale":
    case "out_of_scope":
      return value;
    default:
      return null;
  }
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const readTimestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneConfig = (config: ProjectSyncConfig): ProjectSyncConfig => ({
  enabled: config.enabled,
  preserveUnmanagedItems: config.preserveUnmanagedItems,
  mappings: config.mappings.map((mapping) => ({
    ...mapping,
    project: mapping.project === null ? null : { ...mapping.project },
    previousFolders: [...mapping.previousFolders],
  })),
});

const hasSameScopes = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean => {
  if (left.mappings.length !== right.mappings.length) {
    return false;
  }
  const rightById = new Map(right.mappings.map((mapping) => [mapping.id, mapping]));
  return left.mappings.every((mapping) => {
    const other = rightById.get(mapping.id);
    return (
      other !== undefined &&
      mapping.project?.projectId === other.project?.projectId &&
      mapping.includeSubprojects === other.includeSubprojects
    );
  });
};
