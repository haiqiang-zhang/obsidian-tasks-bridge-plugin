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
import type { ProjectCatalogStorage } from "@/project-sync/catalog";
import type { ManagedFrontmatter, ManagedNoteIdentity } from "@/project-sync/document";

const LOCAL_COMPLETION_EVENT_PREFIX = "local:";

export type ManagedProjectTaskReference = {
  id: string;
  filePath: string;
};

export type ProjectTaskMutationResult = {
  targetedProjection: Promise<void>;
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

export type ManagedProjectTaskStatus = "active" | "completed";

type ManagedProjectTaskTarget = {
  file: TFile;
  identity: ManagedNoteIdentity;
  mappingId: string;
  rootProjectId: string;
  projectId?: string;
  completedProperty: boolean | undefined;
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
  private readonly catalogStorage?: ProjectCatalogStorage;

  constructor(
    vault: Vault,
    fileManager: FileManager,
    metadataCache: MetadataCache,
    todoist: TodoistAdapter,
    projectSync: ProjectFolderSyncService,
    projectionCoordinator: ProjectTaskProjectionCoordinator,
    catalogStorage?: ProjectCatalogStorage,
  ) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.metadataCache = metadataCache;
    this.todoist = todoist;
    this.projectSync = projectSync;
    this.projectionCoordinator = projectionCoordinator;
    this.catalogStorage = catalogStorage;
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
    return await this.mutateCompletedStatus(target, true);
  }

  public setCompleted(
    reference: ManagedProjectTaskReference,
    completed: boolean,
  ): Promise<ProjectTaskMutationResult> {
    return completed ? this.completeTask(reference) : this.reopenTask(reference);
  }

  public async reopenTask(
    reference: ManagedProjectTaskReference,
  ): Promise<ProjectTaskMutationResult> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "completed", "Only completed tasks can be reopened");
    return await this.mutateCompletedStatus(target, false);
  }

  /**
   * Applies the user-editable `todoist_completed` property to Todoist.
   *
   * `todoist_status` is the last server-projected state, so a mismatch between the two fields is
   * an explicit local completion intent. Plugin projections update both values atomically and do
   * not enter this path.
   */
  public async applyCompletedProperty(
    reference: ManagedProjectTaskReference,
    completed: boolean,
    confirmedStatus?: ManagedProjectTaskStatus,
  ): Promise<ProjectTaskMutationResult | null> {
    const resolvedTarget = this.resolveTarget(reference);
    const target =
      confirmedStatus === undefined
        ? resolvedTarget
        : { ...resolvedTarget, status: confirmedStatus };
    const desiredStatus: ManagedProjectTaskStatus = completed ? "completed" : "active";
    if (target.status === desiredStatus) {
      return null;
    }

    try {
      if (completed) {
        this.requireStatus(target, "active", "Only active tasks can be completed");
        return await this.mutateCompletedStatus(target, true);
      }

      this.requireStatus(target, "completed", "Only completed tasks can be reopened");
      return await this.mutateCompletedStatus(target, false);
    } catch (error: unknown) {
      // A projection error means Todoist already accepted the mutation. Never roll the property
      // back to the old value in that case; doing so would misrepresent server state and could
      // submit the inverse mutation when the metadata observer runs again.
      if (!(error instanceof ProjectTaskProjectionError)) {
        try {
          await this.restoreCompletedProperty(target, completed);
        } catch (restoreError: unknown) {
          console.error(
            "Failed to restore todoist_completed after Todoist rejected it",
            restoreError,
          );
        }
      }
      throw error;
    }
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
      if (mapping.project === null || !availableProjectIds.has(mapping.project.projectId)) {
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

    const owner = candidates[0];
    if (owner?.project === null || owner === undefined) {
      throw new ProjectTaskCommandError(
        "This managed task note does not belong to one configured Project sync mapping",
      );
    }
    const catalog = this.catalogStorage?.getCatalog(owner.id);
    if (
      catalog === null ||
      catalog === undefined ||
      catalog.rootProjectId !== owner.project.projectId
    ) {
      throw new ProjectTaskCommandError(
        "This task is unavailable until Project sync confirms its Todoist project",
      );
    }
    const catalogTask = catalog?.tasks.find((task) => task.id === identity.taskId);
    if (catalogTask === undefined) {
      throw new ProjectTaskCommandError(
        "This task is unavailable until Project sync confirms its Todoist project",
      );
    }
    return {
      file,
      identity,
      mappingId: owner.id,
      rootProjectId: owner.project.projectId,
      projectId: catalogTask?.projectId,
      completedProperty:
        typeof frontmatter.todoist_completed === "boolean"
          ? frontmatter.todoist_completed
          : undefined,
      status,
      taskId: identity.taskId,
    };
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

  private async mutateCompletedStatus(
    target: ManagedProjectTaskTarget,
    completed: boolean,
  ): Promise<ProjectTaskMutationResult> {
    let followupError: ProjectTaskProjectionError | undefined;
    let completedAt: Date | undefined;

    try {
      if (completed) {
        completedAt = await this.todoist.actions.closeProjectTask(target.taskId);
      } else {
        await this.todoist.actions.reopenProjectTask(target.taskId);
      }
    } catch (error: unknown) {
      if (!(error instanceof TodoistRemoteMutationFollowupError)) {
        throw error;
      }

      // The HTTP mutation has already succeeded. Project the confirmed remote transition so the
      // UI/property queue cannot retry it, then report the adapter follow-up failure through the
      // slower projection milestone.
      followupError = new ProjectTaskProjectionError(error);
      if (completed) {
        completedAt = new Date();
      }
    }

    return this.startStatusProjection(
      target,
      completed ? "completed" : "active",
      completedAt,
      followupError,
    );
  }

  private startStatusProjection(
    target: ManagedProjectTaskTarget,
    status: ManagedProjectTaskStatus,
    completedAt?: Date,
    remoteFollowupError?: ProjectTaskProjectionError,
  ): ProjectTaskMutationResult {
    const syncedAt = new Date().toISOString();
    let resolveTargetedProjection: () => void;
    let rejectTargetedProjection: (error: unknown) => void;
    const targetedProjection = new Promise<void>((resolve, reject) => {
      resolveTargetedProjection = resolve;
      rejectTargetedProjection = reject;
    });
    const projection = this.projectStatusAndReconcile(
      target,
      status,
      syncedAt,
      completedAt,
      remoteFollowupError,
      () => resolveTargetedProjection(),
      (error) => rejectTargetedProjection(asProjectionError(error)),
    ).catch((error: unknown) => {
      const projectionError = asProjectionError(error);
      rejectTargetedProjection(projectionError);
      throw projectionError;
    });
    // Callers may be superseded by a newer render or may only care about one milestone. Mark both
    // promises handled here while returning the originals so active callers can still observe a
    // rejection without creating a transient unhandled-rejection window.
    void targetedProjection.catch(() => undefined);
    void projection.catch(() => undefined);
    return { projection, targetedProjection };
  }

  private async projectStatusAndReconcile(
    target: ManagedProjectTaskTarget,
    status: ManagedProjectTaskStatus,
    syncedAt: string,
    completedAt?: Date,
    remoteFollowupError?: ProjectTaskProjectionError,
    onTargetedProjected: () => void = () => undefined,
    onTargetedProjectionFailed: (error: unknown) => void = () => undefined,
  ): Promise<void> {
    const projectionResult = await this.projectionCoordinator.runAutomaticProjection(
      async (assertValid) => {
        assertValid();
        let targetedProjectionError: ProjectTaskProjectionError | undefined;
        try {
          await this.projectionCoordinator.runInternalMutation(
            this.automaticProjectionPaths(target.file.path),
            async () =>
              await this.projectStatus(target, status, syncedAt, assertValid, completedAt),
          );
          onTargetedProjected();
        } catch (error: unknown) {
          targetedProjectionError = asProjectionError(error);
          onTargetedProjectionFailed(targetedProjectionError);
        }

        // A canonical reconciliation is still useful when the targeted write failed after the
        // Todoist mutation. Keep its failure in the background, as before, while preserving the
        // more actionable targeted-write error for the caller.
        assertValid();
        try {
          await this.projectSync.sync();
        } catch (error: unknown) {
          console.error(
            "Background Project sync failed after a Todoist task status change:",
            error,
          );
        }

        if (targetedProjectionError !== undefined) {
          throw targetedProjectionError;
        }
        if (remoteFollowupError !== undefined) {
          throw remoteFollowupError;
        }
      },
    );
    if (!projectionResult.performed) {
      throw new Error("Automatic Vault projection was deferred");
    }
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
    const completedAtIso =
      status === "completed" && completedAt !== undefined ? completedAt.toISOString() : undefined;
    await this.fileManager.processFrontMatter(target.file, (frontmatter: unknown) => {
      assertValid();
      if (!isRecord(frontmatter)) {
        throw new Error(`Invalid frontmatter in '${target.file.path}'`);
      }
      this.requireSameIdentity(target, frontmatter);

      frontmatter.todoist_status = status;
      // The editable property can change again while the Todoist request is in flight. Preserve
      // that newer intent; the property observer will serialize the inverse remote mutation.
      if (frontmatter.todoist_completed === target.completedProperty) {
        frontmatter.todoist_completed = status === "completed";
      }
      frontmatter.todoist_synced_at = syncedAt;

      if (completedAtIso !== undefined) {
        frontmatter.todoist_completed_at = completedAtIso;
      } else {
        delete frontmatter.todoist_completed_at;
      }
    });
    if (completedAtIso !== undefined) {
      await this.persistLocalCompletionEvent(target, completedAtIso);
    }
  }

  private async persistLocalCompletionEvent(
    target: ManagedProjectTaskTarget,
    completedAt: string,
  ): Promise<void> {
    if (this.catalogStorage === undefined || target.projectId === undefined) {
      return;
    }
    const catalog = this.catalogStorage.getCatalog(target.mappingId);
    if (catalog === null) {
      return;
    }
    const event = {
      id: `${LOCAL_COMPLETION_EVENT_PREFIX}${JSON.stringify([
        target.mappingId,
        target.rootProjectId,
        target.taskId,
        completedAt,
      ])}`,
      taskId: target.taskId,
      projectId: target.projectId,
      completedAt,
    };
    if (!catalog.completionEvents.some(({ id }) => id === event.id)) {
      catalog.completionEvents.push(event);
      catalog.completionEvents.sort((left, right) => {
        const byTime = left.completedAt.localeCompare(right.completedAt);
        return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
      });
      await this.catalogStorage.persistCatalogs([catalog]);
    }
  }

  private requireSameIdentity(
    target: ManagedProjectTaskTarget,
    frontmatter: ManagedFrontmatter,
  ): void {
    const identity = readManagedNoteIdentity(frontmatter);
    if (identity === null || identity.taskId !== target.identity.taskId) {
      throw new Error("The managed Todoist task identity changed before its status was projected");
    }
  }

  private async restoreCompletedProperty(
    target: ManagedProjectTaskTarget,
    failedDesiredValue: boolean,
  ): Promise<void> {
    await this.projectionCoordinator.runInternalMutation(
      this.automaticProjectionPaths(target.file.path),
      async () => {
        await this.fileManager.processFrontMatter(target.file, (frontmatter: unknown) => {
          if (!isRecord(frontmatter)) {
            throw new Error(`Invalid frontmatter in '${target.file.path}'`);
          }
          this.requireSameIdentity(target, frontmatter);
          // Only roll back the rejected value. If the user changed the property again while the
          // request was in flight, that newer intent owns the switch.
          if (frontmatter.todoist_completed === failedDesiredValue) {
            frontmatter.todoist_completed = target.status === "completed";
          }
        });
      },
    );
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

const asProjectionError = (error: unknown): ProjectTaskProjectionError =>
  error instanceof ProjectTaskProjectionError ? error : new ProjectTaskProjectionError(error);
