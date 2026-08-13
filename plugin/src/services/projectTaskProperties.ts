import type { CachedMetadata, TFile } from "obsidian";
import { Notice } from "obsidian";

import { readManagedNoteIdentity } from "@/project-sync";
import type { ManagedFrontmatter } from "@/project-sync/document";

import {
  type ManagedProjectTaskReference,
  type ManagedProjectTaskStatus,
  type ProjectTaskCommandService,
  ProjectTaskProjectionError,
} from "./projectTaskCommands";

type PendingPropertyIntent = {
  completed: boolean;
  reference: ManagedProjectTaskReference;
  observedStatus: ManagedProjectTaskStatus;
};

type PendingRemoteTransition = {
  status: ManagedProjectTaskStatus;
  taskId: string;
};

/**
 * Converts explicit edits to `todoist_completed` into serialized Todoist mutations.
 *
 * Obsidian's public MetadataCache `changed` event fires only after the note has been reparsed,
 * which gives this observer a complete frontmatter snapshot. Per-file queues prevent rapid edits,
 * Obsidian Sync writes, and a running Project sync from issuing concurrent inverse mutations.
 */
export class ProjectTaskPropertySyncService {
  private readonly commands: ProjectTaskCommandService;
  private readonly activeIntents = new Map<string, PendingPropertyIntent>();
  private readonly intents = new Map<string, PendingPropertyIntent>();
  private readonly transitions = new Map<string, PendingRemoteTransition>();
  private readonly running = new Set<string>();
  private disposed = false;

  constructor(commands: ProjectTaskCommandService) {
    this.commands = commands;
  }

  public handleMetadataChange(file: TFile, cache: CachedMetadata): void {
    if (this.disposed) {
      return;
    }
    const state = readCompletionState(file, cache.frontmatter);
    if (state === null) {
      return;
    }

    const transition = this.transitions.get(file.path);
    if (transition !== undefined && transition.taskId !== state.reference.id) {
      this.transitions.delete(file.path);
    }

    const active = this.activeIntents.get(file.path);
    if (active?.completed === state.completed && active.reference.id === state.reference.id) {
      // The latest observed property returned to the operation already in flight. Cancel an
      // inverse queued by an older event. Command-side compare-and-set projection prevents an
      // acknowledgement from overwriting a newer opposite property edit, so the latest metadata
      // snapshot is authoritative here even when its status already agrees with the active intent.
      const queued = this.intents.get(file.path);
      if (queued?.reference.id === state.reference.id) {
        this.intents.delete(file.path);
      }
      const activeStatus: ManagedProjectTaskStatus = active.completed ? "completed" : "active";
      if (state.status === activeStatus && queued?.reference.id !== state.reference.id) {
        this.transitions.delete(file.path);
      }
      return;
    }
    const desiredStatus: ManagedProjectTaskStatus = state.completed ? "completed" : "active";
    if (transition?.taskId === state.reference.id && transition.status === desiredStatus) {
      // Todoist already accepted this state. This can be a repeated stale MetadataCache event
      // after a targeted/deferred projection failure; never resubmit the same remote mutation.
      if (state.status === desiredStatus) {
        this.transitions.delete(file.path);
      }
      return;
    }
    if (state.completed === (state.status === "completed") && active === undefined) {
      const knownStatus = transition?.taskId === state.reference.id ? transition.status : undefined;
      // Usually an agreeing pair is a Project sync projection, not user intent. The exception is
      // a rapid inverse edit whose metadata event still carries the pre-projection status: the
      // queue already knows Todoist accepted the opposite state, so do not let stale metadata
      // overwrite that confirmed remote status or suppress the inverse mutation.
      if (knownStatus === undefined || knownStatus === state.status) {
        if (knownStatus === state.status) {
          this.transitions.delete(file.path);
        }
        return;
      }
    }

    const intent = {
      completed: state.completed,
      observedStatus: state.status,
      reference: state.reference,
    };

    this.intents.set(file.path, intent);
    if (!this.running.has(file.path)) {
      void this.drain(file.path);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.intents.clear();
    this.activeIntents.clear();
    this.transitions.clear();
  }

  private async drain(path: string): Promise<void> {
    this.running.add(path);
    try {
      while (!this.disposed) {
        const intent = this.intents.get(path);
        if (intent === undefined) {
          return;
        }
        this.intents.delete(path);
        this.activeIntents.set(path, intent);

        try {
          const transition = this.transitions.get(path);
          const confirmedStatus =
            transition?.taskId === intent.reference.id ? transition.status : intent.observedStatus;
          const result = await this.commands.applyCompletedProperty(
            intent.reference,
            intent.completed,
            confirmedStatus,
          );
          // Treat `undefined` as the legacy no-op result as well. This keeps integrations using an
          // older command mock from attempting to await a milestone that does not exist.
          if (result != null) {
            const nextTransition: PendingRemoteTransition = {
              status: intent.completed ? "completed" : "active",
              taskId: intent.reference.id,
            };
            this.transitions.set(path, nextTransition);
            void result.projection.catch((error: unknown) => {
              // Targeted projection failures are reported by the awaited milestone above. A later
              // canonical failure is intentionally background-only, matching command semantics.
              if (!(error instanceof ProjectTaskProjectionError)) {
                console.error(
                  "Background Project sync failed after todoist_completed changed",
                  error,
                );
              }
              // Keep the transition: Todoist accepted the mutation but no successful canonical
              // projection has acknowledged it yet.
            });
            await result.targetedProjection;
          }
        } catch (error: unknown) {
          if (error instanceof ProjectTaskProjectionError) {
            new Notice(
              "Todoist was updated, but this task note could not be refreshed. Run Project sync again.",
            );
          } else {
            new Notice("Could not update Todoist. The completion switch was restored.");
          }
          console.error("Failed to synchronize todoist_completed with Todoist", error);
        } finally {
          this.activeIntents.delete(path);
        }
      }
    } finally {
      this.running.delete(path);
      if (!this.disposed && this.intents.has(path)) {
        void this.drain(path);
      }
    }
  }
}

const readCompletionState = (
  file: TFile,
  frontmatter: ManagedFrontmatter | undefined,
):
  | (Omit<PendingPropertyIntent, "observedStatus"> & { status: ManagedProjectTaskStatus })
  | null => {
  if (frontmatter === undefined) {
    return null;
  }
  const identity = readManagedNoteIdentity(frontmatter);
  const status = frontmatter.todoist_status;
  const completed = frontmatter.todoist_completed;
  if (
    identity === null ||
    (status !== "active" && status !== "completed") ||
    typeof completed !== "boolean"
  ) {
    return null;
  }

  return {
    completed,
    reference: { id: identity.taskId, filePath: file.path },
    status,
  };
};
