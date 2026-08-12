import { dump as dumpYaml } from "js-yaml";
import { getFrontMatterInfo, normalizePath, parseYaml, type TFile, type Vault } from "obsidian";

import type { Project } from "@/api/domain/project";

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
import type { ProjectSyncInternalMutationRunner } from "./vault";

export const PROJECT_CATALOG_MARKER = "tasks_bridge_project_catalog_managed";
export const PROJECT_CATALOG_FOLDER = "_Tasks Bridge/Project Catalogs";
const PROJECT_CATALOG_SCHEMA_VERSION = 1;
const PROJECT_CATALOG_BODY =
  "<!-- This Markdown projection is managed by Tasks Bridge. Do not edit it manually. -->\n";
const LOCAL_EVENT_PREFIX = "local:";
const LOCAL_EVENT_MATCH_TOLERANCE_MS = 120_000;
const LOCAL_REFRESH_DEBOUNCE_MS = 50;

type CatalogProject = Pick<Project, "id" | "parentId" | "name" | "childOrder">;

type ProjectCatalog = {
  mappingId: string;
  rootProjectId: string;
  includeSubprojects: boolean;
  syncedAt: string;
  projects: CatalogProject[];
};

type LocalTaskProjection = {
  taskId: string;
  mappingId?: string;
  rootProjectId: string;
  projectId: string;
  status: "active" | "completed" | "stale" | "out_of_scope";
  completionEvents: ProjectCompletionEvent[];
};

const runMutationDirectly: ProjectSyncInternalMutationRunner = async (_paths, operation) =>
  await operation();

export class ObsidianProjectSyncStatisticsRepository implements ProjectSyncStatisticsRepository {
  private readonly vault: Vault;
  private readonly runInternalMutation: ProjectSyncInternalMutationRunner;
  private config: ProjectSyncConfig;
  private snapshot: ProjectSyncStatisticsSnapshot | null = null;
  private disposed = false;
  private refreshInFlight: Promise<void> | undefined;
  private refreshAgain = false;
  private refreshTimer: number | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    vault: Vault,
    initialConfig: ProjectSyncConfig,
    runInternalMutation: ProjectSyncInternalMutationRunner = runMutationDirectly,
  ) {
    this.vault = vault;
    this.config = cloneConfig(initialConfig);
    this.runInternalMutation = runInternalMutation;
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

    await this.ensureCatalogFolder(runContext);
    const path = projectCatalogPath(mapping.id);
    const document = renderProjectCatalog(snapshot, mapping);
    const existing = this.vault.getFileByPath(path);
    if (existing === null) {
      if (this.vault.getAbstractFileByPath(path) !== null) {
        throw new Error(`Project catalog path '${path}' is occupied by a non-file Vault item`);
      }
      await this.runInternalMutation([path], async () => await this.vault.create(path, document));
      runContext.assertValid();
      return;
    }

    await this.runInternalMutation([path], async () => {
      await this.vault.process(existing, (content) => {
        runContext.assertValid();
        const current = parseProjectCatalog(content);
        if (current === null) {
          throw new Error(`Project catalog '${path}' is not owned by this Project sync mapping`);
        }
        if (current.mappingId === mapping.id && current.syncedAt > snapshot.syncedAt) {
          return content;
        }
        return content === document ? content : document;
      });
    });
    runContext.assertValid();
  }

  private async ensureCatalogFolder(runContext: ProjectSyncRunContext): Promise<void> {
    let current = "";
    for (const segment of PROJECT_CATALOG_FOLDER.split("/")) {
      current = normalizePath(current === "" ? segment : `${current}/${segment}`);
      if (this.vault.getFolderByPath(current) !== null) {
        continue;
      }
      if (this.vault.getAbstractFileByPath(current) !== null) {
        throw new Error(`Project catalog folder '${current}' is occupied by a Vault file`);
      }
      runContext.assertValid();
      await this.runInternalMutation([current], async () => await this.vault.createFolder(current));
    }
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
    const catalogs = (
      await Promise.all(
        mappings.map(async (mapping) => ({
          mapping,
          catalog: await this.readCatalog(mapping),
        })),
      )
    ).filter(
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

  private async readCatalog(mapping: ProjectSyncMapping): Promise<ProjectCatalog | null> {
    const file = this.vault.getFileByPath(projectCatalogPath(mapping.id));
    if (file === null) {
      return null;
    }
    const catalog = parseProjectCatalog(await this.vault.read(file));
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

  private async readTaskProjection(file: TFile): Promise<LocalTaskProjection | null> {
    const frontmatter = parseFrontmatter(await this.vault.read(file));
    if (frontmatter === null || frontmatter.todoist_sync_managed !== true) {
      return null;
    }
    const taskId = readNonEmptyString(frontmatter.todoist_task_id);
    const mappingId = readNonEmptyString(frontmatter.todoist_sync_mapping_id) ?? undefined;
    const rootProjectId = readNonEmptyString(frontmatter.todoist_sync_root_id);
    const projectId = readNonEmptyString(frontmatter.todoist_project_id);
    const status = readTaskStatus(frontmatter.todoist_status);
    if (taskId === null || rootProjectId === null || projectId === null || status === null) {
      return null;
    }
    return {
      taskId,
      mappingId,
      rootProjectId,
      projectId,
      status,
      completionEvents: readCompletionEvents(frontmatter.todoist_completion_events),
    };
  }

  private isRelevantPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (isPathInside(PROJECT_CATALOG_FOLDER, normalized)) {
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

export const projectCatalogPath = (mappingId: string): string =>
  normalizePath(
    `${PROJECT_CATALOG_FOLDER}/${sanitizePathSegment(mappingId, "project-sync-mapping")}.md`,
  );

const renderProjectCatalog = (
  snapshot: ProjectSyncSnapshot,
  mapping: ProjectSyncMapping,
): string => {
  const projects = snapshot.projects.map((project) => ({
    id: project.id,
    parent_id: project.parentId,
    name: project.name,
    child_order: project.childOrder,
  }));
  const yaml = dumpYaml(
    {
      [PROJECT_CATALOG_MARKER]: true,
      tasks_bridge_project_catalog_version: PROJECT_CATALOG_SCHEMA_VERSION,
      tasks_bridge_mapping_id: mapping.id,
      tasks_bridge_root_project_id: snapshot.rootProjectId,
      tasks_bridge_include_subprojects: mapping.includeSubprojects,
      tasks_bridge_synced_at: snapshot.syncedAt,
      tasks_bridge_projects: projects,
    },
    { lineWidth: -1, noRefs: true },
  );
  return `---\n${yaml}---\n${PROJECT_CATALOG_BODY}`;
};

const parseProjectCatalog = (content: string): ProjectCatalog | null => {
  const frontmatter = parseFrontmatter(content);
  if (
    frontmatter === null ||
    frontmatter[PROJECT_CATALOG_MARKER] !== true ||
    frontmatter.tasks_bridge_project_catalog_version !== PROJECT_CATALOG_SCHEMA_VERSION
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
    .filter((project): project is CatalogProject => project !== null);
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

const readCatalogProject = (value: unknown): CatalogProject | null => {
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

const readCompletionEvents = (value: unknown): ProjectCompletionEvent[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return deduplicateEvents(
    value.flatMap((entry): ProjectCompletionEvent[] => {
      if (!isRecord(entry)) {
        return [];
      }
      const id = readNonEmptyString(entry.id);
      const taskId = readNonEmptyString(entry.task_id);
      const projectId = readNonEmptyString(entry.project_id);
      const completedAt = readTimestamp(entry.completed_at);
      return id === null || taskId === null || projectId === null || completedAt === null
        ? []
        : [{ id, taskId, projectId, completedAt }];
    }),
  );
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
  const taskEvents: ProjectCompletionEvent[] = [];

  for (const task of tasks) {
    if (
      task.mappingId !== mapping.id ||
      task.rootProjectId !== catalog.rootProjectId ||
      !projectIds.has(task.projectId)
    ) {
      continue;
    }
    taskEvents.push(...task.completionEvents.filter((event) => projectIds.has(event.projectId)));
    if (task.status !== "active" && task.status !== "completed") {
      continue;
    }
    if (conflictedTaskIds.has(task.taskId)) {
      continue;
    }
    const current = taskStates.get(task.taskId);
    if (current === undefined) {
      taskStates.set(task.taskId, { projectId: task.projectId, status: task.status });
    } else if (current.projectId !== task.projectId || current.status !== task.status) {
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

  const completionEvents = mergeLocalAndCanonicalEvents(taskEvents);
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
