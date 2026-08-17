import type { Project } from "@/api/domain/project";

import { selectProjectHierarchy } from "./hierarchy";
import type {
  ProjectCompletionEvent,
  ProjectSyncConfig,
  ProjectSyncMapping,
  ProjectSyncResult,
  ProjectSyncSnapshot,
  ProjectSyncSource,
  ProjectSyncStatisticsRepository,
  ProjectSyncStatisticsSnapshot,
  ProjectSyncStatus,
  ProjectSyncStatusListener,
  ProjectSyncVault,
  SnapshotTask,
} from "./types";

type InFlightSync = {
  generation: number;
  promise: Promise<ProjectSyncResult | null>;
};

type MappingPlan = {
  mapping: ProjectSyncMapping;
  projects: Project[];
};

type MappingPlans = {
  activeConfig: ProjectSyncConfig;
  plans: MappingPlan[];
  unavailableMappings: ProjectSyncMapping[];
};

type PendingSnapshot = {
  mapping: ProjectSyncMapping;
  rootProjectId: string;
  projects: Project[];
  tasks: SnapshotTask[];
  completionEvents: ProjectCompletionEvent[];
};

type FetchedMappingTasks = {
  tasks: SnapshotTask[];
  completionEvents: ProjectCompletionEvent[];
};

export class ProjectFolderSyncService {
  private readonly source: ProjectSyncSource;
  private readonly vault: ProjectSyncVault;
  private config: ProjectSyncConfig;
  private configGeneration = 0;
  /**
   * Once the complete remote snapshot and Vault preflight have succeeded, finish the projection
   * batch without letting a late Vault/Sync notification stop it between files. Obsidian exposes
   * atomic single-file operations, not a cross-file transaction, so an uninterrupted serialized
   * commit is the only safe batch boundary. A notification received here invalidates the next run
   * instead.
   */
  private commitInProgress = false;
  private invalidationPending = false;
  private disposed = false;
  private inFlight: InFlightSync | undefined;
  private status: ProjectSyncStatus = { state: "idle" };
  private statisticsSnapshot: ProjectSyncStatisticsSnapshot | null = null;
  private readonly statisticsRepository: ProjectSyncStatisticsRepository | undefined;
  private readonly unsubscribeStatistics: (() => void) | undefined;
  private readonly listeners = new Set<ProjectSyncStatusListener>();

  constructor(
    source: ProjectSyncSource,
    vault: ProjectSyncVault,
    initialConfig: ProjectSyncConfig,
    statisticsRepository?: ProjectSyncStatisticsRepository,
  ) {
    this.source = source;
    this.vault = vault;
    this.config = cloneConfig(initialConfig);
    this.statisticsRepository = statisticsRepository;
    this.statisticsRepository?.setConfig(initialConfig);
    this.unsubscribeStatistics = this.statisticsRepository?.subscribe(() => {
      this.setStatus(this.status);
    });
    if (!initialConfig.enabled) {
      this.status = { state: "disabled" };
    }
  }

  public setConfig(config: ProjectSyncConfig): void {
    if (this.disposed) {
      return;
    }
    if (isSameConfig(this.config, config)) {
      return;
    }

    // Vault destinations and migration bookkeeping do not change the server-side project scope.
    // Keep the last complete snapshot across those projection-only updates.
    const statisticsScopeChanged = !hasSameStatisticsScopes(this.config, config);
    this.invalidationPending = false;
    this.config = cloneConfig(config);
    this.configGeneration++;
    this.statisticsRepository?.setConfig(config);
    if (statisticsScopeChanged) {
      this.statisticsSnapshot = null;
    }
    this.setStatus(config.enabled ? { state: "idle" } : { state: "disabled" });
  }

  public invalidate(): void {
    if (this.disposed) {
      return;
    }
    if (this.commitInProgress) {
      this.invalidationPending = true;
      return;
    }
    this.configGeneration++;
    this.setStatus(this.config.enabled ? { state: "idle" } : { state: "disabled" });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidationPending = false;
    this.configGeneration++;
    this.statisticsSnapshot = null;
    this.unsubscribeStatistics?.();
    this.statisticsRepository?.dispose();
    this.setStatus({ state: "disposed" });
    this.listeners.clear();
  }

  public getConfig(): ProjectSyncConfig {
    return cloneConfig(this.config);
  }

  public getStatus(): ProjectSyncStatus {
    return this.status;
  }

  public getStatisticsSnapshot(): ProjectSyncStatisticsSnapshot | null {
    return this.statisticsRepository?.getSnapshot() ?? this.statisticsSnapshot;
  }

  public refreshStatisticsFromLocalProjection(): Promise<void> {
    return this.statisticsRepository?.refresh() ?? Promise.resolve();
  }

  public notifyLocalProjectionChanges(paths: readonly string[]): void {
    this.statisticsRepository?.notifyLocalChanges(paths);
  }

  public reloadStatisticsCatalogs(): void {
    this.statisticsRepository?.reloadCatalogs();
  }

  public clearStatisticsSnapshot(): void {
    if (this.disposed) {
      return;
    }
    if (this.statisticsRepository !== undefined) {
      this.statisticsRepository.clearSnapshot();
      return;
    }
    if (this.statisticsSnapshot === null) {
      return;
    }
    this.statisticsSnapshot = null;
    this.setStatus(this.status);
  }

  public validateConfig(config: ProjectSyncConfig = this.config): void {
    this.makeMappingPlans(cloneConfig(config));
  }

  public listProjects(): Project[] {
    return this.source.listProjects();
  }

  public subscribe(listener: ProjectSyncStatusListener): () => void {
    if (this.disposed) {
      listener(this.status);
      return () => undefined;
    }
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  public sync(): Promise<ProjectSyncResult | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const generation = this.configGeneration;
    if (this.inFlight !== undefined) {
      if (this.inFlight.generation === generation) {
        return this.inFlight.promise;
      }

      return this.inFlight.promise
        .catch(() => null)
        .then(() => {
          // The caller requested the generation captured above. If Vault activity or another
          // config change invalidates that request while it waits, do not silently restart with
          // the newest generation: doing so would bypass the caller's activity and Sync-permit
          // checks.
          if (this.disposed || generation !== this.configGeneration) {
            return null;
          }
          return this.sync();
        });
    }

    const promise = this.performSync(generation).finally(() => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = { generation, promise };
    return promise;
  }

  private async performSync(generation: number): Promise<ProjectSyncResult | null> {
    const config = cloneConfig(this.config);
    if (!config.enabled) {
      this.setStatusIfCurrent(generation, { state: "disabled" });
      return null;
    }

    const startedAt = new Date();
    this.setStatusIfCurrent(generation, {
      state: "syncing",
      startedAt: startedAt.toISOString(),
    });

    let commitStarted = false;
    try {
      this.assertCurrent(generation);
      const { activeConfig, plans, unavailableMappings } = this.makeMappingPlans(config);
      const pendingSnapshots: PendingSnapshot[] = [];

      for (const plan of plans) {
        const { tasks, completionEvents } = await this.fetchMappingTasks(plan, generation);
        pendingSnapshots.push({
          mapping: plan.mapping,
          rootProjectId: requireProject(plan.mapping).projectId,
          projects: plan.projects,
          tasks,
          completionEvents,
        });
      }

      this.assertCurrent(generation);
      assertUniqueTaskOwnership(pendingSnapshots);
      // Destination folders may change while Todoist history is loading. Re-run the complete
      // synchronous preflight before the first Vault mutation so a later mapping cannot turn a
      // multi-project run into a partial write.
      if (plans.length > 0) {
        this.vault.validateConfig(activeConfig);
      }
      const syncedAt = new Date().toISOString();
      const snapshots = pendingSnapshots.map(
        ({ mapping, rootProjectId, projects, tasks, completionEvents }) => ({
          mapping,
          completionEvents,
          snapshot: {
            rootProjectId,
            projects,
            tasks,
            completionEvents,
            syncedAt,
          } satisfies ProjectSyncSnapshot,
        }),
      );
      for (const { mapping, snapshot } of snapshots) {
        this.vault.validateSnapshot(snapshot, mapping);
      }
      const activeMappingIds = new Set(snapshots.map(({ mapping }) => mapping.id));
      const mappingRoots = config.mappings.flatMap((mapping) => {
        const project = requireProject(mapping);
        const active = activeMappingIds.has(mapping.id);
        return [
          {
            mappingId: mapping.id,
            rootProjectId: project.projectId,
            folder: mapping.folder,
            active,
          },
          ...mapping.previousFolders.map((folder) => ({
            mappingId: mapping.id,
            rootProjectId: project.projectId,
            folder,
            active,
          })),
        ];
      });
      const scanToken = {};
      const stagedUserDocumentsByTaskId = new Map<
        string,
        { frontmatter: Record<string, unknown>; body: string }
      >();
      const allSnapshotTaskIds = new Set(
        snapshots.flatMap(({ snapshot }) => snapshot.tasks.map(({ task }) => task.id)),
      );
      const result = emptyResult();
      for (const mapping of unavailableMappings) {
        result.pausedMappingIds.push(mapping.id);
      }

      // Everything above is read-only. From this point through catalog/statistics publication the
      // run is one logical commit. External activity is remembered for the next run, but it cannot
      // leave this batch half-applied.
      this.commitInProgress = true;
      commitStarted = true;
      for (const { mapping, snapshot } of snapshots) {
        this.assertCurrent(generation);
        const mappingResult = await this.vault.reconcile(snapshot, mapping, {
          assertValid: () => this.assertCurrent(generation),
          preserveUnmanagedItems: config.preserveUnmanagedItems,
          mappingRoots,
          allSnapshotTaskIds,
          stagedUserDocumentsByTaskId,
          scanToken,
        });
        addResult(result, mappingResult);
      }
      this.assertCurrent(generation);
      if (this.statisticsRepository === undefined) {
        this.statisticsSnapshot = makeStatisticsSnapshot(snapshots, syncedAt);
      } else {
        for (const { mapping, snapshot } of snapshots) {
          await this.statisticsRepository.persistProjectCatalog(snapshot, mapping, {
            assertValid: () => this.assertCurrent(generation),
            preserveUnmanagedItems: config.preserveUnmanagedItems,
            mappingRoots,
            allSnapshotTaskIds,
            stagedUserDocumentsByTaskId,
            scanToken,
          });
        }
        this.assertCurrent(generation);
        await this.statisticsRepository.refresh();
      }
      this.setStatus({
        state: "success",
        completedAt: new Date().toISOString(),
        result,
      });
      return result;
    } catch (error: unknown) {
      if (error instanceof ProjectSyncInvalidatedError) {
        return null;
      }
      this.setErrorIfCurrent(generation, error);
      throw error;
    } finally {
      if (commitStarted) {
        this.finishCommit(generation);
      }
    }
  }

  private finishCommit(generation: number): void {
    this.commitInProgress = false;
    const invalidatedDuringCommit = this.invalidationPending;
    this.invalidationPending = false;
    if (!invalidatedDuringCommit || this.disposed || generation !== this.configGeneration) {
      return;
    }

    // Preserve the completed batch, then make every later request capture a new generation. The
    // next automatic interval will reconcile any external change that arrived during the commit.
    this.configGeneration++;
    this.setStatus(this.config.enabled ? { state: "idle" } : { state: "disabled" });
  }

  private makeMappingPlans(config: ProjectSyncConfig): MappingPlans {
    validateMappingIdentities(config);
    const availableProjects = this.source.listProjects();
    const availableProjectIds = new Set(availableProjects.map((project) => project.id));
    const owners = new Map<string, number>();
    const plans: MappingPlan[] = [];
    const unavailableMappings: ProjectSyncMapping[] = [];
    for (const [mappingIndex, mapping] of config.mappings.entries()) {
      const project = requireProject(mapping);
      if (!availableProjectIds.has(project.projectId)) {
        unavailableMappings.push(mapping);
        continue;
      }
      if (normalizeConfiguredRoot(mapping.folder) === null) {
        throw new Error(
          `Project sync mapping ${mappingIndex + 1} requires a vault folder and Todoist project`,
        );
      }
      const projects = selectProjectHierarchy(
        availableProjects,
        project.projectId,
        mapping.includeSubprojects,
      );

      for (const includedProject of projects) {
        const previousOwner = owners.get(includedProject.id);
        if (previousOwner !== undefined) {
          throw new Error(
            `Todoist project '${includedProject.name}' (${includedProject.id}) is included by project sync mappings ${previousOwner + 1} and ${mappingIndex + 1}`,
          );
        }
        owners.set(includedProject.id, mappingIndex);
      }
      plans.push({ mapping, projects });
    }

    validateConfiguredRootSeparation(config);

    const activeConfig: ProjectSyncConfig = {
      enabled: config.enabled,
      preserveUnmanagedItems: config.preserveUnmanagedItems,
      mappings: plans.map(({ mapping }) => mapping),
    };
    if (plans.length > 0) {
      this.vault.validateConfig(activeConfig);
    }
    return { activeConfig, plans, unavailableMappings };
  }

  private async fetchMappingTasks(
    plan: MappingPlan,
    generation: number,
  ): Promise<FetchedMappingTasks> {
    const selectedIds = new Set(plan.projects.map((project) => project.id));
    const activeById = new Map<string, SnapshotTask>();
    const completedById = new Map<string, SnapshotTask>();
    const completionEventsById = new Map<string, ProjectCompletionEvent>();

    for (const project of plan.projects) {
      this.assertCurrent(generation);
      const page = await this.source.fetchProjectTasks(project.id);
      this.assertCurrent(generation);

      for (const task of page.activeTasks) {
        this.assertTaskProject(task.project.id, project.id, selectedIds);
        activeById.set(task.id, { task, completed: false });
      }
      for (const task of page.completedTasks) {
        this.assertTaskProject(task.project.id, project.id, selectedIds);
        completedById.set(task.id, { task, completed: true });
      }
      for (const event of page.completionEvents) {
        this.assertTaskProject(event.projectId, project.id, selectedIds);
        if (!completionEventsById.has(event.id)) {
          completionEventsById.set(event.id, { ...event });
        }
      }
    }

    const tasksById = new Map(completedById);
    for (const [taskId, active] of activeById) {
      tasksById.set(taskId, active);
    }
    const tasks = [...tasksById.values()];
    tasks.sort((left, right) => left.task.id.localeCompare(right.task.id));
    return { tasks, completionEvents: [...completionEventsById.values()] };
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.configGeneration) {
      throw new ProjectSyncInvalidatedError();
    }
  }

  private assertTaskProject(
    actualProjectId: string,
    requestedProjectId: string,
    selectedIds: ReadonlySet<string>,
  ): void {
    if (!selectedIds.has(actualProjectId) || actualProjectId !== requestedProjectId) {
      throw new Error(
        `Todoist returned project '${actualProjectId}' while scanning project '${requestedProjectId}'`,
      );
    }
  }

  private setErrorIfCurrent(generation: number, error: unknown): void {
    if (generation !== this.configGeneration) {
      return;
    }
    this.setStatus({
      state: "error",
      completedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private setStatusIfCurrent(generation: number, status: ProjectSyncStatus): void {
    if (generation === this.configGeneration) {
      this.setStatus(status);
    }
  }

  private setStatus(status: ProjectSyncStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error: unknown) {
        console.error("Project sync status listener failed:", error);
      }
    }
  }
}

class ProjectSyncInvalidatedError extends Error {}

const cloneConfig = (config: ProjectSyncConfig): ProjectSyncConfig => ({
  enabled: config.enabled,
  preserveUnmanagedItems: config.preserveUnmanagedItems,
  mappings: config.mappings.map((mapping) => ({
    ...mapping,
    project: mapping.project === null ? null : { ...mapping.project },
    previousFolders: [...mapping.previousFolders],
  })),
});

const makeStatisticsSnapshot = (
  snapshots: readonly {
    mapping: ProjectSyncMapping;
    snapshot: ProjectSyncSnapshot;
    completionEvents: readonly ProjectCompletionEvent[];
  }[],
  syncedAt: string,
): ProjectSyncStatisticsSnapshot => ({
  syncedAt,
  scopes: snapshots.map(({ mapping, snapshot, completionEvents }) => {
    const directCounts = new Map<string, { active: number; completed: number }>(
      snapshot.projects.map((project) => [project.id, { active: 0, completed: 0 }]),
    );
    const directCompletionEvents = new Map<string, ProjectCompletionEvent[]>(
      snapshot.projects.map((project) => [project.id, []]),
    );

    for (const snapshotTask of snapshot.tasks) {
      const counts = directCounts.get(snapshotTask.task.project.id);
      if (counts === undefined) {
        throw new Error(
          `Todoist task '${snapshotTask.task.id}' belongs to a project outside its statistics scope`,
        );
      }
      if (snapshotTask.completed) {
        counts.completed++;
      } else {
        counts.active++;
      }
    }

    for (const event of completionEvents) {
      const events = directCompletionEvents.get(event.projectId);
      if (events === undefined) {
        throw new Error(
          `Todoist completion event '${event.id}' belongs to a project outside its statistics scope`,
        );
      }
      events.push({ ...event });
    }

    return {
      mappingId: mapping.id,
      rootProjectId: snapshot.rootProjectId,
      includeSubprojects: mapping.includeSubprojects,
      tasks: snapshot.tasks.map(({ task }) => ({
        id: task.id,
        projectId: task.project.id,
        ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
        ...(task.section === undefined ? {} : { sectionId: task.section.id }),
        order: task.order,
      })),
      projects: snapshot.projects.map((project) => {
        const counts = directCounts.get(project.id);
        if (counts === undefined) {
          throw new Error(`Todoist project '${project.id}' is missing from its statistics scope`);
        }
        const completionEvents = directCompletionEvents.get(project.id);
        if (completionEvents === undefined) {
          throw new Error(`Todoist project '${project.id}' is missing completion activity`);
        }
        return {
          id: project.id,
          parentId: project.parentId,
          name: project.name,
          childOrder: project.childOrder,
          directCounts: { active: counts.active, completed: counts.completed },
          directCompletionEvents: completionEvents.map((event) => ({ ...event })),
        };
      }),
    };
  }),
});

const isSameConfig = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean =>
  left.enabled === right.enabled &&
  left.preserveUnmanagedItems === right.preserveUnmanagedItems &&
  left.mappings.length === right.mappings.length &&
  left.mappings.every((mapping, index) => {
    const other = right.mappings[index];
    return (
      mapping.folder === other.folder &&
      mapping.id === other.id &&
      mapping.includeSubprojects === other.includeSubprojects &&
      mapping.previousFolders.length === other.previousFolders.length &&
      mapping.previousFolders.every(
        (folder, folderIndex) => folder === other.previousFolders[folderIndex],
      ) &&
      mapping.project?.projectId === other.project?.projectId &&
      mapping.project?.projectName === other.project?.projectName
    );
  });

const hasSameStatisticsScopes = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean => {
  if (left.enabled !== right.enabled || left.mappings.length !== right.mappings.length) {
    return false;
  }

  const rightById = new Map(right.mappings.map((mapping) => [mapping.id, mapping]));
  if (rightById.size !== right.mappings.length) {
    return false;
  }
  return left.mappings.every((mapping) => {
    const other = rightById.get(mapping.id);
    return (
      other !== undefined &&
      mapping.includeSubprojects === other.includeSubprojects &&
      mapping.project?.projectId === other.project?.projectId
    );
  });
};

const validateMappingIdentities = (config: ProjectSyncConfig): void => {
  if (config.mappings.length === 0) {
    throw new Error("Project sync requires at least one project mapping");
  }
  const mappingIds = new Set<string>();
  config.mappings.forEach((mapping, index) => {
    if (mapping.id.trim() === "" || mappingIds.has(mapping.id) || mapping.project === null) {
      throw new Error(
        `Project sync mapping ${index + 1} requires a vault folder and Todoist project`,
      );
    }
    mappingIds.add(mapping.id);
  });
};

const validateConfiguredRootSeparation = (config: ProjectSyncConfig): void => {
  const roots = config.mappings.flatMap((mapping) =>
    [mapping.folder, ...mapping.previousFolders]
      .map(normalizeConfiguredRoot)
      .filter((path): path is string => path !== null)
      .map((path) => ({ mappingId: mapping.id, path })),
  );

  for (let leftIndex = 0; leftIndex < roots.length; leftIndex++) {
    const left = roots[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex++) {
      const right = roots[rightIndex];
      if (
        left.mappingId === right.mappingId ||
        (left.path !== right.path &&
          !left.path.startsWith(`${right.path}/`) &&
          !right.path.startsWith(`${left.path}/`))
      ) {
        continue;
      }
      throw new Error(
        `Project sync folders '${left.path}' and '${right.path}' overlap; paused mappings keep ownership of their Vault roots`,
      );
    }
  }
};

const normalizeConfiguredRoot = (path: string): string | null => {
  const normalized = path
    .trim()
    .normalize("NFC")
    .split("\\")
    .join("/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .toLocaleLowerCase("en-US");
  if (
    normalized === "" ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
};

const requireProject = (
  mapping: ProjectSyncMapping,
): NonNullable<ProjectSyncMapping["project"]> => {
  if (mapping.project === null) {
    throw new Error("Project sync mapping requires a Todoist project");
  }
  return mapping.project;
};

const assertUniqueTaskOwnership = (snapshots: readonly PendingSnapshot[]): void => {
  const owners = new Map<string, string>();
  for (const snapshot of snapshots) {
    for (const { task } of snapshot.tasks) {
      const previousOwner = owners.get(task.id);
      if (previousOwner !== undefined && previousOwner !== snapshot.rootProjectId) {
        throw new Error(
          `Todoist task '${task.id}' appeared in project sync mappings '${previousOwner}' and '${snapshot.rootProjectId}'`,
        );
      }
      owners.set(task.id, snapshot.rootProjectId);
    }
  }
};

const emptyResult = (): ProjectSyncResult => ({
  created: 0,
  updated: 0,
  moved: 0,
  unchanged: 0,
  deleted: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  pausedMappingIds: [],
  settledMappingIds: [],
});

const addResult = (target: ProjectSyncResult, source: ProjectSyncResult): void => {
  target.created += source.created;
  target.updated += source.updated;
  target.moved += source.moved;
  target.unchanged += source.unchanged;
  target.deleted += source.deleted;
  target.outOfScope += source.outOfScope;
  target.deferred += source.deferred;
  target.conflicts.push(...source.conflicts);
  for (const mappingId of source.pausedMappingIds) {
    if (!target.pausedMappingIds.includes(mappingId)) {
      target.pausedMappingIds.push(mappingId);
    }
  }
  for (const mappingId of source.settledMappingIds) {
    if (!target.settledMappingIds.includes(mappingId)) {
      target.settledMappingIds.push(mappingId);
    }
  }
};
