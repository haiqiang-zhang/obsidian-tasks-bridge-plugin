import type { Project } from "@/api/domain/project";

import { selectProjectHierarchy } from "./hierarchy";
import type {
  ProjectSyncConfig,
  ProjectSyncMapping,
  ProjectSyncResult,
  ProjectSyncSnapshot,
  ProjectSyncSource,
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

type PendingSnapshot = {
  mapping: ProjectSyncMapping;
  rootProjectId: string;
  projects: Project[];
  tasks: SnapshotTask[];
};

export class ProjectFolderSyncService {
  private readonly source: ProjectSyncSource;
  private readonly vault: ProjectSyncVault;
  private config: ProjectSyncConfig;
  private configGeneration = 0;
  private disposed = false;
  private inFlight: InFlightSync | undefined;
  private status: ProjectSyncStatus = { state: "idle" };
  private statisticsSnapshot: ProjectSyncStatisticsSnapshot | null = null;
  private readonly listeners = new Set<ProjectSyncStatusListener>();

  constructor(
    source: ProjectSyncSource,
    vault: ProjectSyncVault,
    initialConfig: ProjectSyncConfig,
  ) {
    this.source = source;
    this.vault = vault;
    this.config = cloneConfig(initialConfig);
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
    this.config = cloneConfig(config);
    this.configGeneration++;
    if (statisticsScopeChanged) {
      this.statisticsSnapshot = null;
    }
    this.setStatus(config.enabled ? { state: "idle" } : { state: "disabled" });
  }

  public invalidate(): void {
    if (this.disposed) {
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
    this.configGeneration++;
    this.statisticsSnapshot = null;
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
    return this.statisticsSnapshot;
  }

  public clearStatisticsSnapshot(): void {
    if (this.disposed || this.statisticsSnapshot === null) {
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
          // The caller requested the generation captured above. If Vault activity, a writer
          // transfer, or another config change invalidates that request while it waits, do not
          // silently restart with the newest generation: doing so would bypass the caller's
          // writer/quiet-period policy checks.
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

    try {
      this.assertCurrent(generation);
      const plans = this.makeMappingPlans(config);
      const pendingSnapshots: PendingSnapshot[] = [];

      for (const plan of plans) {
        const tasks = await this.fetchMappingTasks(plan, generation);
        pendingSnapshots.push({
          mapping: plan.mapping,
          rootProjectId: requireProject(plan.mapping).projectId,
          projects: plan.projects,
          tasks,
        });
      }

      this.assertCurrent(generation);
      assertUniqueTaskOwnership(pendingSnapshots);
      // Destination folders may change while Todoist history is loading. Re-run the complete
      // synchronous preflight before the first Vault mutation so a later mapping cannot turn a
      // multi-project run into a partial write.
      this.vault.validateConfig(config);
      const syncedAt = new Date().toISOString();
      const snapshots = pendingSnapshots.map(({ mapping, rootProjectId, projects, tasks }) => ({
        mapping,
        snapshot: { rootProjectId, projects, tasks, syncedAt } satisfies ProjectSyncSnapshot,
      }));
      const mappingRoots = snapshots.flatMap(({ mapping, snapshot }) => [
        {
          mappingId: mapping.id,
          rootProjectId: snapshot.rootProjectId,
          folder: mapping.folder,
        },
        ...mapping.previousFolders.map((folder) => ({
          mappingId: mapping.id,
          rootProjectId: snapshot.rootProjectId,
          folder,
        })),
      ]);
      const scanToken = {};
      const result = emptyResult();
      for (const { mapping, snapshot } of snapshots) {
        this.assertCurrent(generation);
        const mappingResult = await this.vault.reconcile(snapshot, mapping, {
          assertValid: () => this.assertCurrent(generation),
          mappingRoots,
          scanToken,
        });
        addResult(result, mappingResult);
      }
      this.assertCurrent(generation);
      this.statisticsSnapshot = makeStatisticsSnapshot(snapshots, syncedAt);
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
    }
  }

  private makeMappingPlans(config: ProjectSyncConfig): MappingPlan[] {
    validateMappingContents(config);
    this.vault.validateConfig(config);

    const availableProjects = this.source.listProjects();
    const owners = new Map<string, number>();
    return config.mappings.map((mapping, mappingIndex) => {
      const project = requireProject(mapping);
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
      return { mapping, projects };
    });
  }

  private async fetchMappingTasks(plan: MappingPlan, generation: number): Promise<SnapshotTask[]> {
    const selectedIds = new Set(plan.projects.map((project) => project.id));
    const activeById = new Map<string, SnapshotTask>();
    const completedById = new Map<string, SnapshotTask>();

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
    }

    const tasksById = new Map(completedById);
    for (const [taskId, active] of activeById) {
      tasksById.set(taskId, active);
    }
    const tasks = [...tasksById.values()];
    tasks.sort((left, right) => left.task.id.localeCompare(right.task.id));
    return tasks;
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
  }[],
  syncedAt: string,
): ProjectSyncStatisticsSnapshot => ({
  syncedAt,
  scopes: snapshots.map(({ mapping, snapshot }) => {
    const directCounts = new Map<string, { active: number; completed: number }>(
      snapshot.projects.map((project) => [project.id, { active: 0, completed: 0 }]),
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

    return {
      mappingId: mapping.id,
      rootProjectId: snapshot.rootProjectId,
      includeSubprojects: mapping.includeSubprojects,
      projects: snapshot.projects.map((project) => {
        const counts = directCounts.get(project.id);
        if (counts === undefined) {
          throw new Error(`Todoist project '${project.id}' is missing from its statistics scope`);
        }
        return {
          id: project.id,
          parentId: project.parentId,
          name: project.name,
          childOrder: project.childOrder,
          directCounts: { active: counts.active, completed: counts.completed },
        };
      }),
    };
  }),
});

const isSameConfig = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean =>
  left.enabled === right.enabled &&
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

const validateMappingContents = (config: ProjectSyncConfig): void => {
  if (config.mappings.length === 0) {
    throw new Error("Project sync requires at least one project mapping");
  }
  const mappingIds = new Set<string>();
  config.mappings.forEach((mapping, index) => {
    if (
      mapping.id.trim() === "" ||
      mappingIds.has(mapping.id) ||
      mapping.folder.trim() === "" ||
      mapping.project === null
    ) {
      throw new Error(
        `Project sync mapping ${index + 1} requires a vault folder and Todoist project`,
      );
    }
    mappingIds.add(mapping.id);
  });
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
  stale: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  settledMappingIds: [],
});

const addResult = (target: ProjectSyncResult, source: ProjectSyncResult): void => {
  target.created += source.created;
  target.updated += source.updated;
  target.moved += source.moved;
  target.unchanged += source.unchanged;
  target.stale += source.stale;
  target.outOfScope += source.outOfScope;
  target.deferred += source.deferred;
  target.conflicts.push(...source.conflicts);
  for (const mappingId of source.settledMappingIds) {
    if (!target.settledMappingIds.includes(mappingId)) {
      target.settledMappingIds.push(mappingId);
    }
  }
};
