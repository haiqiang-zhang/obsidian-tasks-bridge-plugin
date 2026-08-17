import {
  type CachedMetadata,
  type FileManager,
  type MetadataCache,
  Notice,
  type TFile,
  type Vault,
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TodoistAdapter } from "@/data";
import type { ProjectFolderSyncService } from "@/project-sync";
import type { ProjectCatalogStorage } from "@/project-sync/catalog";
import type { ManagedFrontmatter } from "@/project-sync/document";

import {
  ProjectTaskCommandService,
  type ProjectTaskProjectionCoordinator,
  ProjectTaskProjectionError,
} from "./projectTaskCommands";
import { ProjectTaskPropertySyncService } from "./projectTaskProperties";

vi.mock("obsidian", () => ({
  Notice: vi.fn(),
  normalizePath: (path: string) => path,
}));

const file = { path: "Tasks/Work/Task.md" } as TFile;

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const cache = (
  completed: boolean,
  status: "active" | "completed",
  taskId = "task-1",
): CachedMetadata =>
  ({
    frontmatter: {
      todoist_sync_managed: true,
      todoist_sync_mapping_id: "mapping-1",
      todoist_sync_root_id: "root-1",
      todoist_sync_missing_count: 0,
      todoist_task_id: taskId,
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
    const applyCompletedProperty = vi.fn(async () => ({
      targetedProjection: Promise.resolve(),
      projection: Promise.resolve(),
    }));
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    expect(applyCompletedProperty).toHaveBeenCalledOnce();
    expect(applyCompletedProperty).toHaveBeenCalledWith(
      { id: "task-1", filePath: file.path },
      true,
      "active",
    );
  });

  it("reopens through the real command before complete's canonical sync settles", async () => {
    const firstFullProjection = deferred<void>();
    let firstFullProjectionSettled = false;
    void firstFullProjection.promise.finally(() => {
      firstFullProjectionSettled = true;
    });
    const closeProjectTask = vi.fn(async () => new Date("2026-08-13T15:37:00.000Z"));
    const reopenProjectTask = vi.fn(async () => undefined);
    const diskFrontmatter: ManagedFrontmatter = {
      todoist_task_id: "task-1",
      todoist_status: "active",
      todoist_completed: false,
    };
    // Deliberately leave MetadataCache stale while processFrontMatter writes the disk snapshot.
    // The inverse operation must use the queue's confirmed remote state, not this old status.
    const staleMetadataFrontmatter = { ...diskFrontmatter };
    const processFrontMatter = vi.fn(
      async (_file: TFile, update: (frontmatter: ManagedFrontmatter) => void) =>
        update(diskFrontmatter),
    );
    const sync = vi
      .fn<() => Promise<null>>()
      .mockReturnValueOnce(firstFullProjection.promise.then(() => null))
      .mockResolvedValue(null);
    const commands = new ProjectTaskCommandService(
      { getFileByPath: vi.fn(() => file) } as unknown as Vault,
      { processFrontMatter } as unknown as FileManager,
      {
        getFileCache: vi.fn(() => ({ frontmatter: staleMetadataFrontmatter })),
      } as unknown as MetadataCache,
      {
        actions: { closeProjectTask, reopenProjectTask },
        isReady: vi.fn(() => true),
      } as unknown as TodoistAdapter,
      {
        getConfig: vi.fn(() => ({
          enabled: true,
          preserveUnmanagedItems: true,
          mappings: [
            {
              id: "mapping-1",
              project: { projectId: "root-1", projectName: "Root" },
              folder: "Tasks/Work",
              includeSubprojects: true,
              previousFolders: [],
            },
          ],
        })),
        invalidate: vi.fn(),
        listProjects: vi.fn(() => [{ id: "root-1" }]),
        sync,
      } as unknown as ProjectFolderSyncService,
      {
        runAutomaticProjection: vi.fn(async (operation) => ({
          performed: true,
          value: await operation(() => undefined),
        })),
        runInternalMutation: vi.fn(async (_paths, operation) => await operation()),
      } as ProjectTaskProjectionCoordinator,
      {
        getCatalog: vi.fn(() => ({
          mappingId: "mapping-1",
          rootProjectId: "root-1",
          includeSubprojects: true,
          syncedAt: "2026-08-13T00:00:00.000Z",
          projects: [{ id: "root-1", parentId: null, name: "Root", childOrder: 0 }],
          tasks: [{ id: "task-1", projectId: "root-1", order: 0 }],
          completionEvents: [],
        })),
        persistCatalogs: vi.fn(async () => undefined),
      } as unknown as ProjectCatalogStorage,
    );
    const completeTask = vi.spyOn(commands, "applyCompletedProperty");
    const service = new ProjectTaskPropertySyncService(commands);

    service.handleMetadataChange(file, cache(true, "active"));
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());

    expect(closeProjectTask).toHaveBeenCalledOnce();
    expect(reopenProjectTask).not.toHaveBeenCalled();

    // This event is indexed before the first targeted write: both its status and MetadataCache's
    // status are still `active`. It nevertheless represents the latest inverse user intent.
    service.handleMetadataChange(file, cache(false, "active"));
    await vi.waitFor(() => expect(reopenProjectTask).toHaveBeenCalledOnce());

    expect(reopenProjectTask).toHaveBeenCalledOnce();
    expect(completeTask.mock.calls.map(([, completed, status]) => [completed, status])).toEqual([
      [true, "active"],
      [false, "completed"],
    ]);
    expect(firstFullProjectionSettled).toBe(false);
    expect(Notice).not.toHaveBeenCalled();

    firstFullProjection.resolve();
    await flush();
  });

  it("cancels a queued inverse when the latest edit returns to the active intent", async () => {
    const targetedProjection = deferred<void>();
    const fullProjection = deferred<void>();
    const applyCompletedProperty = vi
      .fn(ProjectTaskCommandService.prototype.applyCompletedProperty)
      .mockResolvedValueOnce({
        targetedProjection: targetedProjection.promise,
        projection: fullProjection.promise,
      })
      .mockResolvedValueOnce({
        targetedProjection: Promise.resolve(),
        projection: Promise.resolve(),
      });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    service.handleMetadataChange(file, cache(false, "active"));
    service.handleMetadataChange(file, cache(true, "active"));
    targetedProjection.resolve();
    await flush();

    expect(applyCompletedProperty.mock.calls.map(([, completed]) => completed)).toEqual([true]);

    fullProjection.resolve();
    await flush();
  });

  it("treats the latest matching metadata value as cancellation of a queued inverse", async () => {
    const targetedProjection = deferred<void>();
    const fullProjection = deferred<void>();
    const applyCompletedProperty = vi
      .fn(ProjectTaskCommandService.prototype.applyCompletedProperty)
      .mockResolvedValueOnce({
        targetedProjection: targetedProjection.promise,
        projection: fullProjection.promise,
      })
      .mockResolvedValueOnce({
        targetedProjection: Promise.resolve(),
        projection: Promise.resolve(),
      });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    service.handleMetadataChange(file, cache(false, "active"));
    // Command-side compare-and-set projection preserves a newer opposite property edit. Therefore
    // this latest matching value is a real user return to completed, not a stale acknowledgement.
    service.handleMetadataChange(file, cache(true, "completed"));
    targetedProjection.resolve();
    await flush();

    expect(
      applyCompletedProperty.mock.calls.map(([, completed, status]) => [completed, status]),
    ).toEqual([[true, "active"]]);

    fullProjection.resolve();
    await flush();
  });

  it("keeps a fulfilled transition until MetadataCache acknowledges it", async () => {
    const fullProjection = deferred<void>();
    const applyCompletedProperty = vi
      .fn(ProjectTaskCommandService.prototype.applyCompletedProperty)
      .mockResolvedValueOnce({
        targetedProjection: Promise.resolve(),
        projection: fullProjection.promise,
      });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    fullProjection.resolve();
    await flush();

    // Full projection completion does not imply MetadataCache has indexed its write. A repeated
    // pre-projection mismatch must not submit the same completed mutation again.
    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    expect(applyCompletedProperty.mock.calls.map(([, completed]) => completed)).toEqual([true]);

    // The matching indexed pair is the explicit acknowledgement that ends the transition.
    service.handleMetadataChange(file, cache(true, "completed"));
    await flush();
    service.handleMetadataChange(file, cache(false, "active"));
    await flush();

    expect(applyCompletedProperty.mock.calls.map(([, completed]) => completed)).toEqual([true]);
  });

  it("reports a targeted projection failure once without retrying the remote mutation", async () => {
    const projectionError = new ProjectTaskProjectionError(new Error("targeted write failed"));
    const applyCompletedProperty = vi.fn().mockResolvedValue({
      targetedProjection: Promise.reject(projectionError),
      projection: Promise.resolve(),
    });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    expect(applyCompletedProperty).toHaveBeenCalledOnce();
    expect(applyCompletedProperty).toHaveBeenCalledWith(
      { id: "task-1", filePath: file.path },
      true,
      "active",
    );
    expect(Notice).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledWith(
      "Todoist was updated, but this task note could not be refreshed. Run Project sync again.",
    );
  });

  it("keeps the confirmed transition after rejected projections and suppresses a duplicate edit", async () => {
    const projectionError = new ProjectTaskProjectionError(new Error("projection unavailable"));
    const targetedProjection = deferred<void>();
    const fullProjection = deferred<void>();
    const applyCompletedProperty = vi
      .fn(ProjectTaskCommandService.prototype.applyCompletedProperty)
      .mockResolvedValueOnce({
        targetedProjection: targetedProjection.promise,
        projection: fullProjection.promise,
      })
      .mockResolvedValueOnce({
        targetedProjection: Promise.resolve(),
        projection: Promise.resolve(),
      });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    fullProjection.reject(projectionError);
    targetedProjection.reject(projectionError);
    await flush();

    // Metadata remains stale because neither projection succeeded. The same desired property must
    // not close the already-completed Todoist task a second time.
    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    expect(applyCompletedProperty).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledOnce();
  });

  it("keeps a later full projection failure in the background without another mutation or notice", async () => {
    const targetedProjection = deferred<void>();
    const fullProjection = deferred<void>();
    const applyCompletedProperty = vi.fn().mockResolvedValue({
      targetedProjection: targetedProjection.promise,
      projection: fullProjection.promise,
    });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();

    service.handleMetadataChange(file, cache(true, "completed"));
    targetedProjection.resolve();
    await flush();
    fullProjection.reject(new ProjectTaskProjectionError(new Error("canonical sync failed")));
    await flush();

    // A later canonical projection event still agrees with Todoist and must stay observational.
    service.handleMetadataChange(file, cache(true, "completed"));
    await flush();

    expect(applyCompletedProperty).toHaveBeenCalledOnce();
    expect(applyCompletedProperty).toHaveBeenCalledWith(
      { id: "task-1", filePath: file.path },
      true,
      "active",
    );
    expect(Notice).not.toHaveBeenCalled();
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

  it("accepts a legacy undefined no-op result without stalling the per-file queue", async () => {
    const applyCompletedProperty = vi.fn(
      ProjectTaskCommandService.prototype.applyCompletedProperty,
    );
    applyCompletedProperty.mockResolvedValue(undefined as never);
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active"));
    await flush();
    service.handleMetadataChange(file, cache(false, "completed"));
    await flush();

    expect(applyCompletedProperty.mock.calls.map(([, completed]) => completed)).toEqual([
      true,
      false,
    ]);
  });

  it("does not carry a path's confirmed status across a task identity replacement", async () => {
    const applyCompletedProperty = vi.fn(
      ProjectTaskCommandService.prototype.applyCompletedProperty,
    );
    applyCompletedProperty.mockResolvedValue({
      targetedProjection: Promise.resolve(),
      projection: Promise.resolve(),
    });
    const service = new ProjectTaskPropertySyncService({
      applyCompletedProperty,
    } as unknown as ProjectTaskCommandService);

    service.handleMetadataChange(file, cache(true, "active", "task-1"));
    await flush();
    service.handleMetadataChange(file, cache(true, "active", "task-2"));
    await flush();

    expect(
      applyCompletedProperty.mock.calls.map(([reference, , status]) => [reference.id, status]),
    ).toEqual([
      ["task-1", "active"],
      ["task-2", "active"],
    ]);
  });
});
