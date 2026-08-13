import type { CachedMetadata, TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectTaskCommandService } from "./projectTaskCommands";
import { ProjectTaskPropertySyncService } from "./projectTaskProperties";

vi.mock("obsidian", () => ({
  Notice: vi.fn(),
}));

const file = { path: "Tasks/Work/Task.md" } as TFile;
const cache = (completed: boolean, status: "active" | "completed"): CachedMetadata =>
  ({
    frontmatter: {
      todoist_sync_managed: true,
      todoist_sync_mapping_id: "mapping-1",
      todoist_sync_root_id: "root-1",
      todoist_sync_missing_count: 0,
      todoist_task_id: "task-1",
      todoist_project_id: "project-1",
      todoist_status: status,
      todoist_completed: completed,
    },
  }) as CachedMetadata;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("ProjectTaskPropertySyncService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores ordinary Project sync projections where status and completion agree", async () => {
    const applyCompletedProperty = vi.fn(async () => undefined);
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(false, "active"));
    service.handleMetadataChange(file, cache(true, "completed"));
    await flush();

    expect(applyCompletedProperty).not.toHaveBeenCalled();
  });

  it("synchronizes a changed todoist_completed property", async () => {
    const applyCompletedProperty = vi.fn(async () => undefined);
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    expect(applyCompletedProperty).toHaveBeenCalledOnce();
    expect(applyCompletedProperty).toHaveBeenCalledWith(
      { id: "task-1", filePath: file.path },
      true,
    );
  });

  it("serializes a rapid complete then reopen intent instead of losing the latest state", async () => {
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const applyCompletedProperty = vi
      .fn<(reference: { id: string; filePath: string }, completed: boolean) => Promise<void>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined);
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    service.handleMetadataChange(file, cache(false, "active"));
    resolveFirst?.();
    await flush();

    expect(applyCompletedProperty.mock.calls.map(([, completed]) => completed)).toEqual([
      true,
      false,
    ]);
  });

  it("ignores malformed and unmanaged notes", async () => {
    const applyCompletedProperty = vi.fn(async () => undefined);
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, {
      frontmatter: { todoist_completed: true, todoist_status: "active" },
    } as CachedMetadata);
    await flush();

    expect(applyCompletedProperty).not.toHaveBeenCalled();
  });
});
