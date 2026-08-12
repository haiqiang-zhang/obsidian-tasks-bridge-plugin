import type { Project } from "@/api/domain/project";
import type { ProjectCompletionEvent } from "@/api/domain/task";
import type { Task } from "@/data/task";
import type { ProjectSyncMapping } from "@/settings";

export type { ProjectCompletionEvent } from "@/api/domain/task";
export type { ProjectSyncMapping } from "@/settings";

export type ProjectSyncConfig = {
  enabled: boolean;
  mappings: ProjectSyncMapping[];
};

export type ProjectTaskPage = {
  activeTasks: Task[];
  completedTasks: Task[];
  completionEvents: ProjectCompletionEvent[];
};

export interface ProjectSyncSource {
  listProjects(): Project[];
  fetchProjectTasks(projectId: string): Promise<ProjectTaskPage>;
}

export type SnapshotTask = {
  task: Task;
  completed: boolean;
};

export type ProjectSyncSnapshot = {
  rootProjectId: string;
  projects: Project[];
  tasks: SnapshotTask[];
  syncedAt: string;
};

export type ProjectSyncStatisticsCounts = Readonly<{
  active: number;
  completed: number;
}>;

export type ProjectSyncProjectStatistics = Readonly<{
  id: string;
  parentId: string | null;
  name: string;
  childOrder: number;
  directCounts: ProjectSyncStatisticsCounts;
  directCompletionEvents: readonly ProjectCompletionEvent[];
}>;

export type ProjectSyncStatisticsScope = Readonly<{
  mappingId: string;
  rootProjectId: string;
  includeSubprojects: boolean;
  projects: readonly ProjectSyncProjectStatistics[];
}>;

export type ProjectSyncStatisticsSnapshot = Readonly<{
  syncedAt: string;
  scopes: readonly ProjectSyncStatisticsScope[];
}>;

export type ProjectSyncConflict = {
  message: string;
  path?: string;
  taskId?: string;
  deferred?: true;
  /** This task's desired projection was not applied during the sync run. */
  projectionBlocked?: true;
};

export type ProjectSyncResult = {
  created: number;
  updated: number;
  moved: number;
  unchanged: number;
  stale: number;
  outOfScope: number;
  deferred: number;
  conflicts: ProjectSyncConflict[];
  /** Configured mappings skipped because their project is unavailable in this account. */
  pausedMappingIds: string[];
  settledMappingIds: string[];
};

export type ProjectSyncMappingRoot = {
  mappingId: string;
  rootProjectId: string;
  folder: string;
  /** False for a configured mapping whose project is unavailable in the current account. */
  active?: boolean;
};

export type ProjectSyncRunContext = {
  assertValid(): void;
  mappingRoots?: readonly ProjectSyncMappingRoot[];
  scanToken?: object;
};

export interface ProjectSyncVault {
  validateConfig(config: ProjectSyncConfig): void;
  reconcile(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    runContext: ProjectSyncRunContext,
  ): Promise<ProjectSyncResult>;
}

export type ProjectSyncStatus =
  | { state: "idle" }
  | { state: "disabled" }
  | { state: "syncing"; startedAt: string }
  | { state: "success"; completedAt: string; result: ProjectSyncResult }
  | { state: "error"; completedAt: string; message: string }
  | { state: "disposed" };

export type ProjectSyncStatusListener = (status: ProjectSyncStatus) => void;
