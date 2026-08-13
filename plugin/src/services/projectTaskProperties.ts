import type { CachedMetadata, TFile } from "obsidian";
import { Notice } from "obsidian";

import { readManagedNoteIdentity } from "@/project-sync";
import type { ManagedFrontmatter } from "@/project-sync/document";

import {
  type ManagedProjectTaskReference,
  type ProjectTaskCommandService,
  ProjectTaskProjectionError,
} from "./projectTaskCommands";

type PendingPropertyIntent = {
  completed: boolean;
  reference: ManagedProjectTaskReference;
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

    const active = this.activeIntents.get(file.path);
    if (active?.completed === state.completed && active.reference.id === state.reference.id) {
      return;
    }
    if (state.completed === (state.status === "completed") && active === undefined) {
      return;
    }

    const intent = { completed: state.completed, reference: state.reference };

    this.intents.set(file.path, intent);
    if (!this.running.has(file.path)) {
      void this.drain(file.path);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.intents.clear();
    this.activeIntents.clear();
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
          await this.commands.applyCompletedProperty(intent.reference, intent.completed);
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
): (PendingPropertyIntent & { status: "active" | "completed" }) | null => {
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
