import {
  type FileManager,
  type MetadataCache,
  normalizePath,
  type TFile,
  type Vault,
} from "obsidian";

import type { Task as ApiTask, UpdateTaskParams } from "@/api/domain/task";
import { type TodoistAdapter, TodoistRemoteMutationFollowupError } from "@/data";
import {
  isPathInside,
  type ProjectFolderSyncService,
  readManagedNoteIdentity,
} from "@/project-sync";
import type { ManagedFrontmatter, ManagedNoteIdentity } from "@/project-sync/document";

const LOCAL_COMPLETION_EVENT_PREFIX = "local:";

export type ManagedProjectTaskReference = {
  id: string;
  filePath: string;
};

export type ProjectTaskMutationResult = {
  projection: Promise<void>;
};

export type ProjectTaskAutomaticProjectionResult<T> =
  | { performed: false }
  | { performed: true; value: T };

/**
 * Owns the device-local policy for automatic Markdown projection.
 *
 * The command service deliberately knows nothing about settings, Obsidian Sync direction, or
 * Vault activity. A coordinator returns `performed: false` without invoking `operation` when an
 * automatic projection is no longer valid, such as after confirmed incoming Sync work.
 */
export interface ProjectTaskProjectionCoordinator {
  runAutomaticProjection<T>(
    operation: (assertValid: () => void) => Promise<T>,
  ): Promise<ProjectTaskAutomaticProjectionResult<T>>;
  runInternalMutation<T>(affectedPaths: readonly string[], operation: () => Promise<T>): Promise<T>;
}

type ManagedProjectTaskStatus = "active" | "completed";

type ManagedProjectTaskTarget = {
  file: TFile;
  identity: ManagedNoteIdentity;
  status: ManagedProjectTaskStatus;
  taskId: string;
};

export class ProjectTaskCommandError extends Error {}

/**
 * The Todoist mutation has already succeeded, but its managed Markdown projection could not be
 * refreshed. Callers must not retry the remote mutation automatically.
 */
export class ProjectTaskProjectionError extends Error {
  public readonly remoteMutationSucceeded = true;
  public readonly projectionCause: unknown;

  constructor(cause: unknown) {
    super("Todoist was updated, but the Vault projection could not be refreshed");
    this.name = "ProjectTaskProjectionError";
    this.projectionCause = cause;
  }
}

export class ProjectTaskCommandService {
  private readonly vault: Vault;
  private readonly fileManager: FileManager;
  private readonly metadataCache: MetadataCache;
  private readonly todoist: TodoistAdapter;
  private readonly projectSync: ProjectFolderSyncService;
  private readonly projectionCoordinator: ProjectTaskProjectionCoordinator;

  constructor(
    vault: Vault,
    fileManager: FileManager,
    metadataCache: MetadataCache,
    todoist: TodoistAdapter,
    projectSync: ProjectFolderSyncService,
    projectionCoordinator: ProjectTaskProjectionCoordinator,
  ) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.metadataCache = metadataCache;
    this.todoist = todoist;
    this.projectSync = projectSync;
    this.projectionCoordinator = projectionCoordinator;
  }

  public isReady(): boolean {
    if (!this.todoist.isReady()) {
      return false;
    }
    const config = this.projectSync.getConfig();
    const availableProjectIds = new Set(
      this.projectSync.listProjects().map((project) => project.id),
    );
    return (
      config.enabled &&
      config.mappings.some(
        (mapping) => mapping.project !== null && availableProjectIds.has(mapping.project.projectId),
      )
    );
  }

  public async loadEditableTask(reference: ManagedProjectTaskReference): Promise<ApiTask> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "active", "Completed tasks must be reopened before editing");

    const task = await this.todoist.actions.getTask(target.taskId);
    if (task.id !== target.taskId || task.checked === true) {
      throw new ProjectTaskCommandError(
        "The Todoist task changed while it was being prepared for editing. Synchronize and try again.",
      );
    }
    return task;
  }

  public async updateTask(
    reference: ManagedProjectTaskReference,
    params: UpdateTaskParams,
  ): Promise<ApiTask> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "active", "Completed tasks must be reopened before editing");

    const task = await this.runRemoteMutation(() =>
      this.todoist.actions.updateTask(target.taskId, params),
    );
    await this.syncAfterRemoteMutation(target.taskId);
    return task;
  }

  public async completeTask(
    reference: ManagedProjectTaskReference,
  ): Promise<ProjectTaskMutationResult> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "active", "Only active tasks can be completed");

    const completedAt = await this.runRemoteMutation(() =>
      this.todoist.actions.closeProjectTask(target.taskId),
    );
    return this.startStatusProjection(target, "completed", completedAt);
  }

  public async reopenTask(
    reference: ManagedProjectTaskReference,
  ): Promise<ProjectTaskMutationResult> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "completed", "Only completed tasks can be reopened");

    await this.runRemoteMutation(() => this.todoist.actions.reopenProjectTask(target.taskId));
    return this.startStatusProjection(target, "active");
  }

  private resolveTarget(reference: ManagedProjectTaskReference): ManagedProjectTaskTarget {
    if (!this.todoist.isReady()) {
      throw new ProjectTaskCommandError("Todoist is not ready yet");
    }

    const config = this.projectSync.getConfig();
    if (!config.enabled) {
      throw new ProjectTaskCommandError("Project sync is disabled");
    }

    const file = this.vault.getFileByPath(normalizePath(reference.filePath));
    if (file === null) {
      throw new ProjectTaskCommandError("The managed task note no longer exists");
    }

    const frontmatter: ManagedFrontmatter | undefined =
      this.metadataCache.getFileCache(file)?.frontmatter;
    if (frontmatter === undefined) {
      throw new ProjectTaskCommandError("The managed task note metadata is not ready yet");
    }

    const identity = readManagedNoteIdentity(frontmatter);
    if (identity === null || identity.taskId !== reference.id) {
      throw new ProjectTaskCommandError("This note is not the selected managed Todoist task");
    }

    const availableProjectIds = new Set(
      this.projectSync.listProjects().map((project) => project.id),
    );
    const candidates = config.mappings.filter((mapping) => {
      if (mapping.project?.projectId !== identity.rootProjectId) {
        return false;
      }
      if (!availableProjectIds.has(mapping.project.projectId)) {
        return false;
      }
      if (identity.mappingId !== undefined && mapping.id !== identity.mappingId) {
        return false;
      }
      return [mapping.folder, ...mapping.previousFolders].some((folder) =>
        isPathInside(normalizePath(folder), file.path),
      );
    });
    if (candidates.length !== 1) {
      throw new ProjectTaskCommandError(
        "This managed task note does not belong to one configured Project sync mapping",
      );
    }

    const status = frontmatter.todoist_status;
    if (status !== "active" && status !== "completed") {
      throw new ProjectTaskCommandError("This task is unavailable until Project sync restores it");
    }

    return { file, identity, status, taskId: identity.taskId };
  }

  private requireStatus(
    target: ManagedProjectTaskTarget,
    expected: ManagedProjectTaskStatus,
    message: string,
  ): void {
    if (target.status !== expected) {
      throw new ProjectTaskCommandError(message);
    }
  }

  private async runRemoteMutation<T>(mutation: () => Promise<T>): Promise<T> {
    try {
      return await mutation();
    } catch (error: unknown) {
      if (error instanceof TodoistRemoteMutationFollowupError) {
        throw new ProjectTaskProjectionError(error);
      }
      throw error;
    }
  }

  private startStatusProjection(
    target: ManagedProjectTaskTarget,
    status: ManagedProjectTaskStatus,
    completedAt?: Date,
  ): ProjectTaskMutationResult {
    const syncedAt = new Date().toISOString();
    const projection = this.projectStatusAndReconcile(target, status, syncedAt, completedAt).catch(
      (error: unknown) => {
        throw new ProjectTaskProjectionError(error);
      },
    );
    return { projection };
  }

  private async projectStatusAndReconcile(
    target: ManagedProjectTaskTarget,
    status: ManagedProjectTaskStatus,
    syncedAt: string,
    completedAt?: Date,
  ): Promise<void> {
    await this.projectionCoordinator.runAutomaticProjection(async (assertValid) => {
      assertValid();
      let targetedProjectionError: unknown;
      let targetedProjectionFailed = false;
      try {
        await this.projectionCoordinator.runInternalMutation(
          this.automaticProjectionPaths(target.file.path),
          async () => await this.projectStatus(target, status, syncedAt, assertValid, completedAt),
        );
      } catch (error: unknown) {
        targetedProjectionFailed = true;
        targetedProjectionError = error;
      }

      // A canonical reconciliation is still useful when the targeted write failed after the
      // Todoist mutation. Keep its failure in the background, as before, while preserving the
      // more actionable targeted-write error for the caller.
      assertValid();
      try {
        await this.projectSync.sync();
      } catch (error: unknown) {
        console.error("Background Project sync failed after a Todoist task status change:", error);
      }

      if (targetedProjectionFailed) {
        throw targetedProjectionError;
      }
    });
  }

  private async projectStatus(
    target: ManagedProjectTaskTarget,
    status: ManagedProjectTaskStatus,
    syncedAt: string,
    assertValid: () => void,
    completedAt?: Date,
  ): Promise<void> {
    // Invalidate first so a snapshot captured before the Todoist response cannot overwrite this
    // targeted projection. The canonical refresh is queued only after this atomic write settles.
    this.projectSync.invalidate();
    await this.fileManager.processFrontMatter(target.file, (frontmatter: unknown) => {
      assertValid();
      if (!isRecord(frontmatter)) {
        throw new Error(`Invalid frontmatter in '${target.file.path}'`);
      }
      this.requireSameIdentity(target, frontmatter);

      frontmatter.todoist_status = status;
      frontmatter.todoist_completed = status === "completed";
      frontmatter.todoist_synced_at = syncedAt;
      frontmatter.todoist_sync_missing_count = 0;
      delete frontmatter.todoist_stale_since;

      if (status === "completed" && completedAt !== undefined) {
        const completedAtIso = completedAt.toISOString();
        frontmatter.todoist_completed_at = completedAtIso;
        frontmatter.todoist_completion_events = appendLocalCompletionEvent(
          frontmatter.todoist_completion_events,
          {
            id: makeLocalCompletionEventId(target, completedAtIso),
            task_id: target.taskId,
            project_id: target.identity.projectId,
            completed_at: completedAtIso,
          },
        );
      } else {
        delete frontmatter.todoist_completed_at;
      }
    });
  }

  private requireSameIdentity(
    target: ManagedProjectTaskTarget,
    frontmatter: ManagedFrontmatter,
  ): void {
    const identity = readManagedNoteIdentity(frontmatter);
    if (
      identity === null ||
      identity.taskId !== target.identity.taskId ||
      identity.mappingId !== target.identity.mappingId ||
      identity.rootProjectId !== target.identity.rootProjectId ||
      identity.projectId !== target.identity.projectId
    ) {
      throw new Error("The managed Todoist task identity changed before its status was projected");
    }
  }

  private async syncAfterRemoteMutation(taskId: string): Promise<void> {
    try {
      await this.projectionCoordinator.runAutomaticProjection(async (assertValid) => {
        assertValid();
        // A sync that started before the mutation may still be in flight. Invalidate its
        // generation only on the device that is allowed to perform this automatic projection.
        this.projectSync.invalidate();
        assertValid();
        const result = await this.projectSync.sync();
        assertValid();
        if (result === null) {
          throw new Error("Project sync did not produce a Vault projection");
        }
        const blockedProjection = result.conflicts.find(
          (conflict) => conflict.taskId === taskId && conflict.projectionBlocked === true,
        );
        if (blockedProjection !== undefined) {
          throw new Error(blockedProjection.message);
        }
      });
    } catch (error: unknown) {
      throw new ProjectTaskProjectionError(error);
    }
  }

  private automaticProjectionPaths(targetPath: string): string[] {
    return [normalizePath(targetPath)];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeLocalCompletionEventId = (
  target: ManagedProjectTaskTarget,
  completedAt: string,
): string =>
  `${LOCAL_COMPLETION_EVENT_PREFIX}${JSON.stringify([
    target.identity.mappingId ?? null,
    target.identity.rootProjectId,
    target.taskId,
    completedAt,
  ])}`;

const appendLocalCompletionEvent = (
  current: unknown,
  event: Record<string, string>,
): Record<string, string>[] => {
  const result = Array.isArray(current)
    ? current.filter(
        (entry): entry is Record<string, string> =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.task_id === "string" &&
          typeof entry.project_id === "string" &&
          typeof entry.completed_at === "string",
      )
    : [];
  return result.some((entry) => entry.id === event.id) ? result : [...result, event];
};
