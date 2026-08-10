import { type MetadataCache, normalizePath, type TFile, type Vault } from "obsidian";

import type { Task as ApiTask, UpdateTaskParams } from "@/api/domain/task";
import { type TodoistAdapter, TodoistRemoteMutationFollowupError } from "@/data";
import {
  isPathInside,
  type ProjectFolderSyncService,
  readManagedNoteIdentity,
} from "@/project-sync";
import type { ManagedFrontmatter } from "@/project-sync/document";

export type ManagedProjectTaskReference = {
  id: string;
  filePath: string;
};

type ManagedProjectTaskStatus = "active" | "completed";

type ManagedProjectTaskTarget = {
  file: TFile;
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
  private readonly metadataCache: MetadataCache;
  private readonly todoist: TodoistAdapter;
  private readonly projectSync: ProjectFolderSyncService;

  constructor(
    vault: Vault,
    metadataCache: MetadataCache,
    todoist: TodoistAdapter,
    projectSync: ProjectFolderSyncService,
  ) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.todoist = todoist;
    this.projectSync = projectSync;
  }

  public isReady(): boolean {
    return this.todoist.isReady() && this.projectSync.getConfig().enabled;
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

  public async completeTask(reference: ManagedProjectTaskReference): Promise<void> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "active", "Only active tasks can be completed");

    await this.runRemoteMutation(() => this.todoist.actions.closeProjectTask(target.taskId));
    await this.syncAfterRemoteMutation(target.taskId);
  }

  public async reopenTask(reference: ManagedProjectTaskReference): Promise<void> {
    const target = this.resolveTarget(reference);
    this.requireStatus(target, "completed", "Only completed tasks can be reopened");

    await this.runRemoteMutation(() => this.todoist.actions.reopenTask(target.taskId));
    await this.syncAfterRemoteMutation(target.taskId);
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

    const frontmatter = this.metadataCache.getFileCache(file)?.frontmatter as
      | ManagedFrontmatter
      | undefined;
    if (frontmatter === undefined) {
      throw new ProjectTaskCommandError("The managed task note metadata is not ready yet");
    }

    const identity = readManagedNoteIdentity(frontmatter);
    if (identity === null || identity.taskId !== reference.id) {
      throw new ProjectTaskCommandError("This note is not the selected managed Todoist task");
    }

    const candidates = config.mappings.filter((mapping) => {
      if (mapping.project?.projectId !== identity.rootProjectId) {
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

    return { file, status, taskId: identity.taskId };
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

  private async syncAfterRemoteMutation(taskId: string): Promise<void> {
    try {
      // A sync that started before the mutation may still be in flight. Invalidate its generation
      // before requesting the follow-up run so stale data can never absorb this refresh.
      this.projectSync.invalidate();
      const result = await this.projectSync.sync();
      if (result === null) {
        throw new Error("Project sync did not produce a Vault projection");
      }
      const blockedProjection = result.conflicts.find(
        (conflict) => conflict.taskId === taskId && conflict.projectionBlocked === true,
      );
      if (blockedProjection !== undefined) {
        throw new Error(blockedProjection.message);
      }
    } catch (error: unknown) {
      throw new ProjectTaskProjectionError(error);
    }
  }
}
