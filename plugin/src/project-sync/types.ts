import type { Project } from "@/api/domain/project";
import type { Task } from "@/data/task";
import type { ProjectSyncMapping } from "@/settings";

export type { ProjectSyncMapping } from "@/settings";

export type ProjectSyncConfig = {
  enabled: boolean;
  mappings: ProjectSyncMapping[];
};

export type ProjectTaskPage = {
  activeTasks: Task[];
  completedTasks: Task[];
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
  settledMappingIds: string[];
};

export type ProjectSyncMappingRoot = {
  mappingId: string;
  rootProjectId: string;
  folder: string;
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
