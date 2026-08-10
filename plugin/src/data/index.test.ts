import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedTasksPageRequest, TodoistApiClient } from "@/api";
import type { SyncResponse } from "@/api/domain/sync";
import {
  type CompletedTasksProgress,
  type OnSubscriptionChange,
  type SubscriptionResult,
  TodoistAdapter,
  TodoistRemoteMutationFollowupError,
} from "@/data/index";
import { makeApiTask, makeProject, makeTask } from "@/factories/data";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const makeSyncResponse = (overrides?: Partial<SyncResponse>): SyncResponse => ({
  syncToken: "token-1",
  projects: [],
  sections: [],
  labels: [],
  ...overrides,
});

const newestCompletedRequest: CompletedTasksPageRequest = {
  since: "2026-05-11T06:00:00.000Z",
  until: "2026-08-09T06:00:00.000Z",
  historyStart: "2024-01-01T00:00:00.000Z",
};

const makeCompletedProgress = (
  frontiers: CompletedTasksPageRequest[],
  latestUntil = newestCompletedRequest.until,
  historyStart = newestCompletedRequest.historyStart,
  loadedWindowCount = 1,
): CompletedTasksProgress => ({
  latestUntil,
  historyStart,
  loadedWindowCount,
  frontiers,
});

const makeMockApi = (): TodoistApiClient => {
  return {
    getTasks: vi.fn().mockResolvedValue([]),
    getActiveTasksByProject: vi.fn().mockResolvedValue([]),
    getCompletedTasksByProject: vi.fn().mockResolvedValue([]),
    getCompletedTasksPage: vi.fn().mockResolvedValue({
      tasks: [],
      request: newestCompletedRequest,
      nextPage: null,
    }),
    createTask: vi.fn(),
    closeTask: vi.fn(),
    getTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    getUser: vi.fn().mockResolvedValue({ isPremium: false }),
    sync: vi.fn().mockResolvedValue(makeSyncResponse()),
  } as unknown as TodoistApiClient;
};

const subscribeAndRefresh = async (
  adapter: TodoistAdapter,
  query = "#test",
): Promise<{ result: SubscriptionResult; callback: OnSubscriptionChange }> => {
  let captured: SubscriptionResult = { type: "not-ready" };
  const callback: OnSubscriptionChange = (r) => {
    captured = r;
  };

  const [, refresh] = adapter.subscribe(query, callback);
  await refresh();

  return { result: captured, callback };
};

describe("TodoistAdapter", () => {
  let adapter: TodoistAdapter;
  let mockApi: TodoistApiClient;

  beforeEach(() => {
    adapter = new TodoistAdapter();
    mockApi = makeMockApi();
  });

  describe("project mode access", () => {
    it("lists only active Todoist projects", async () => {
      const active = makeProject("active", { name: "Active" });
      const archived = { ...makeProject("archived", { name: "Archived" }), isArchived: true };
      const deleted = { ...makeProject("deleted", { name: "Deleted" }), isDeleted: true };
      vi.mocked(mockApi.sync).mockResolvedValue(
        makeSyncResponse({ projects: [active, archived, deleted] }),
      );

      await adapter.initialize(mockApi);

      expect(adapter.listActiveProjects()).toEqual([active]);
    });

    it("uses the later annotated state for tasks that complete during the active scan", async () => {
      vi.useFakeTimers();
      const project = makeProject("project-1", { name: "Project One" });
      const until = "2026-08-10T04:30:00.000Z";
      vi.mocked(mockApi.sync).mockResolvedValue(makeSyncResponse({ projects: [project] }));
      vi.mocked(mockApi.getActiveTasksByProject).mockImplementation(async () => {
        vi.setSystemTime(new Date(until));
        return [
          makeApiTask({ id: "active-only", projectId: project.id, checked: false }),
          makeApiTask({ id: "transitioned", projectId: project.id, checked: false }),
        ];
      });
      vi.mocked(mockApi.getCompletedTasksByProject).mockResolvedValue([
        makeApiTask({
          id: "transitioned",
          projectId: project.id,
          checked: true,
          completedAt: "2026-08-10T04:30:00.000Z",
        }),
        makeApiTask({
          id: "completed-only",
          projectId: project.id,
          checked: true,
          completedAt: "2026-08-09T04:30:00.000Z",
        }),
      ]);
      try {
        await adapter.initialize(mockApi);

        const snapshot = await adapter.getProjectTasks(project.id);

        expect(mockApi.getActiveTasksByProject).toHaveBeenCalledWith(project.id);
        expect(mockApi.getCompletedTasksByProject).toHaveBeenCalledWith(project.id, until);
        expect(vi.mocked(mockApi.getActiveTasksByProject).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(mockApi.getCompletedTasksByProject).mock.invocationCallOrder[0],
        );
        expect(snapshot.activeTasks).toEqual([
          expect.objectContaining({ id: "active-only", project, completedAt: undefined }),
        ]);
        expect(snapshot.completedTasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "transitioned",
              project,
              completedAt: "2026-08-10T04:30:00.000Z",
            }),
            expect.objectContaining({
              id: "completed-only",
              project,
              completedAt: "2026-08-09T04:30:00.000Z",
            }),
          ]),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a reopened task active when the later annotated item is unchecked", async () => {
      const project = makeProject("project-1", { name: "Project One" });
      vi.mocked(mockApi.sync).mockResolvedValue(makeSyncResponse({ projects: [project] }));
      vi.mocked(mockApi.getActiveTasksByProject).mockResolvedValue([
        makeApiTask({ id: "reopened", projectId: project.id, checked: false }),
      ]);
      vi.mocked(mockApi.getCompletedTasksByProject).mockResolvedValue([
        makeApiTask({
          id: "reopened",
          projectId: project.id,
          checked: false,
          completedAt: null,
        }),
      ]);
      await adapter.initialize(mockApi);

      const snapshot = await adapter.getProjectTasks(project.id);

      expect(snapshot.activeTasks).toEqual([
        expect.objectContaining({ id: "reopened", project, completedAt: null }),
      ]);
      expect(snapshot.completedTasks).toEqual([]);
    });

    it("rejects a project task snapshot if the Todoist account changes", async () => {
      const project = makeProject("project-1");
      vi.mocked(mockApi.sync).mockResolvedValue(makeSyncResponse({ projects: [project] }));
      vi.mocked(mockApi.getCompletedTasksByProject).mockImplementation(async () => {
        adapter.reset();
        return [];
      });
      await adapter.initialize(mockApi);

      await expect(adapter.getProjectTasks(project.id)).rejects.toThrow(
        "Todoist account changed during project task sync",
      );
    });

    it("does not start the completed scan after the account changes during the active scan", async () => {
      const project = makeProject("project-1");
      vi.mocked(mockApi.sync).mockResolvedValue(makeSyncResponse({ projects: [project] }));
      vi.mocked(mockApi.getActiveTasksByProject).mockImplementation(async () => {
        adapter.reset();
        return [];
      });
      await adapter.initialize(mockApi);

      await expect(adapter.getProjectTasks(project.id)).rejects.toThrow(
        "Todoist account changed during project task sync",
      );
      expect(mockApi.getCompletedTasksByProject).not.toHaveBeenCalled();
    });

    it("does not reuse the previous account API for sync after reset", async () => {
      await adapter.initialize(mockApi);
      const userCalls = vi.mocked(mockApi.getUser).mock.calls.length;
      const metadataCalls = vi.mocked(mockApi.sync).mock.calls.length;

      adapter.reset();
      await adapter.sync();

      expect(adapter.isReady()).toBe(false);
      expect(mockApi.getUser).toHaveBeenCalledTimes(userCalls);
      expect(mockApi.sync).toHaveBeenCalledTimes(metadataCalls);
    });

    it("does not reuse the previous account API for project tasks after reset", async () => {
      const project = makeProject("project-1");
      vi.mocked(mockApi.sync).mockResolvedValue(makeSyncResponse({ projects: [project] }));
      await adapter.initialize(mockApi);

      adapter.reset();

      await expect(adapter.getProjectTasks(project.id)).rejects.toThrow(
        "tried to access inner value of empty Maybe",
      );
      expect(mockApi.getActiveTasksByProject).not.toHaveBeenCalled();
      expect(mockApi.getCompletedTasksByProject).not.toHaveBeenCalled();
    });
  });

  describe("metadata sync", () => {
    it("refreshes account metadata without updating query subscriptions", async () => {
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());
      vi.mocked(mockApi.getTasks).mockClear();
      vi.mocked(mockApi.getCompletedTasksPage).mockClear();

      const project = makeProject("metadata-project", { name: "Metadata project" });
      vi.mocked(mockApi.sync).mockResolvedValueOnce(
        makeSyncResponse({ syncToken: "token-2", projects: [project] }),
      );

      const succeeded = await adapter.syncMetadata();

      expect(succeeded).toBe(true);
      expect(mockApi.getUser).toHaveBeenCalledTimes(2);
      expect(mockApi.sync).toHaveBeenLastCalledWith("token-1");
      expect(adapter.listActiveProjects()).toEqual([project]);
      expect(mockApi.getTasks).not.toHaveBeenCalled();
      expect(mockApi.getCompletedTasksPage).not.toHaveBeenCalled();
    });

    it("treats user-info failure as nonfatal when repository metadata succeeds", async () => {
      await adapter.initialize(mockApi);
      const project = makeProject("metadata-project", { name: "Metadata project" });
      const userError = new Error("user unavailable");
      vi.mocked(mockApi.getUser).mockRejectedValueOnce(userError);
      vi.mocked(mockApi.sync).mockResolvedValueOnce(
        makeSyncResponse({ syncToken: "token-2", projects: [project] }),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await expect(adapter.syncMetadata()).resolves.toBe(true);

        expect(adapter.listActiveProjects()).toEqual([project]);
        expect(error).toHaveBeenCalledWith("Failed to fetch user info:", userError);
      } finally {
        error.mockRestore();
      }
    });

    it("returns false when repository metadata cannot be refreshed", async () => {
      const existing = makeProject("existing-project", { name: "Existing project" });
      vi.mocked(mockApi.sync).mockResolvedValueOnce(makeSyncResponse({ projects: [existing] }));
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());
      vi.mocked(mockApi.getTasks).mockClear();
      const metadataError = new Error("metadata unavailable");
      vi.mocked(mockApi.sync).mockRejectedValueOnce(metadataError);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await expect(adapter.syncMetadata()).resolves.toBe(false);

        expect(adapter.listActiveProjects()).toEqual([existing]);
        expect(mockApi.getTasks).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith("Failed to sync metadata:", metadataError);
      } finally {
        error.mockRestore();
      }
    });

    it("keeps full sync query updates when repository metadata refresh fails", async () => {
      await adapter.initialize(mockApi);
      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe("#test", (result) => {
        captured = result;
      });
      vi.mocked(mockApi.getTasks).mockResolvedValueOnce([makeApiTask({ id: "fresh-task" })]);
      vi.mocked(mockApi.sync).mockRejectedValueOnce(new Error("metadata unavailable"));
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await adapter.sync();

        expect(adapter.isReady()).toBe(true);
        expect(mockApi.getTasks).toHaveBeenCalledWith("#test");
        const result = captured as SubscriptionResult;
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.tasks.map((task) => task.id)).toEqual(["fresh-task"]);
        }
      } finally {
        error.mockRestore();
      }
    });

    it("coalesces concurrent metadata refreshes for the same account", async () => {
      await adapter.initialize(mockApi);
      const user = deferred<{ isPremium: boolean }>();
      const metadata = deferred<SyncResponse>();
      vi.mocked(mockApi.getUser).mockImplementationOnce(async () => await user.promise);
      vi.mocked(mockApi.sync).mockImplementationOnce(async () => await metadata.promise);
      vi.mocked(mockApi.getUser).mockClear();
      vi.mocked(mockApi.sync).mockClear();

      const first = adapter.syncMetadata();
      const second = adapter.syncMetadata();

      expect(second).toBe(first);
      expect(mockApi.getUser).toHaveBeenCalledOnce();
      expect(mockApi.sync).toHaveBeenCalledOnce();

      user.resolve({ isPremium: true });
      metadata.resolve(makeSyncResponse({ syncToken: "token-2" }));
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    });

    it("starts a new metadata refresh after reset without applying the old account response", async () => {
      await adapter.initialize(mockApi);
      const oldProject = makeProject("old-project", { name: "Old project" });
      const oldUser = deferred<{ isPremium: boolean }>();
      const oldMetadata = deferred<SyncResponse>();
      vi.mocked(mockApi.getUser).mockImplementationOnce(async () => await oldUser.promise);
      vi.mocked(mockApi.sync).mockImplementationOnce(async () => await oldMetadata.promise);

      const oldRefresh = adapter.syncMetadata();
      expect(mockApi.getUser).toHaveBeenCalledTimes(2);
      expect(mockApi.sync).toHaveBeenCalledTimes(2);

      adapter.reset();
      const newApi = makeMockApi();
      const newProject = makeProject("new-project", { name: "New project" });
      vi.mocked(newApi.getUser).mockResolvedValue({ isPremium: false });
      vi.mocked(newApi.sync).mockResolvedValue(
        makeSyncResponse({ syncToken: "new-token", projects: [newProject] }),
      );

      await adapter.initialize(newApi);

      expect(newApi.getUser).toHaveBeenCalledOnce();
      expect(newApi.sync).toHaveBeenCalledOnce();
      expect(adapter.isReady()).toBe(true);
      expect(adapter.isPremium()).toBe(false);
      expect(adapter.listActiveProjects()).toEqual([newProject]);

      oldUser.resolve({ isPremium: true });
      oldMetadata.resolve(makeSyncResponse({ syncToken: "old-token", projects: [oldProject] }));
      await expect(oldRefresh).resolves.toBe(false);

      expect(adapter.isPremium()).toBe(false);
      expect(adapter.listActiveProjects()).toEqual([newProject]);
    });
  });

  describe("task actions", () => {
    it("gets an active task from the current Todoist account", async () => {
      const task = makeApiTask({ id: "task-to-edit", content: "Edit me" });
      vi.mocked(mockApi.getTask).mockResolvedValue(task);
      await adapter.initialize(mockApi);

      await expect(adapter.actions.getTask("task-to-edit")).resolves.toEqual(task);
      expect(mockApi.getTask).toHaveBeenCalledWith("task-to-edit");
    });

    it("rejects a task fetched from an account that was reset while the request was pending", async () => {
      const pendingTask = deferred<ReturnType<typeof makeApiTask>>();
      vi.mocked(mockApi.getTask).mockImplementationOnce(async () => await pendingTask.promise);
      await adapter.initialize(mockApi);

      const fetching = adapter.actions.getTask("old-account-task");
      adapter.reset();
      pendingTask.resolve(makeApiTask({ id: "old-account-task" }));

      await expect(fetching).rejects.toThrow("Todoist account changed while fetching a task");
    });

    it("returns an updated task and refreshes mounted query subscriptions", async () => {
      const updatedTask = makeApiTask({ id: "task-1", content: "Updated remotely" });
      vi.mocked(mockApi.updateTask).mockResolvedValue(updatedTask);
      vi.mocked(mockApi.getTasks).mockResolvedValue([updatedTask]);
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe("#test", (result) => {
        captured = result;
      });

      await expect(
        adapter.actions.updateTask("task-1", {
          content: "Updated remotely",
          duration: { amount: 30, unit: "minute" },
        }),
      ).resolves.toEqual(updatedTask);

      expect(mockApi.updateTask).toHaveBeenCalledWith("task-1", {
        content: "Updated remotely",
        duration: { amount: 30, unit: "minute" },
      });
      expect(mockApi.getTasks).toHaveBeenCalledWith("#test");
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.tasks).toMatchObject([{ id: "task-1", content: "Updated remotely" }]);
      }
    });

    it("does not refresh queries when updating the remote task fails", async () => {
      vi.mocked(mockApi.updateTask).mockRejectedValue(new Error("update failed"));
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      await expect(adapter.actions.updateTask("task-1", { content: "Not saved" })).rejects.toThrow(
        "update failed",
      );

      expect(mockApi.getTasks).not.toHaveBeenCalled();
    });

    it("marks an old-account update as remotely successful without refreshing the next account", async () => {
      const pendingTask = deferred<ReturnType<typeof makeApiTask>>();
      vi.mocked(mockApi.updateTask).mockImplementationOnce(async () => await pendingTask.promise);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      const updating = adapter.actions.updateTask("old-account-task", { content: "Old" });
      adapter.reset();
      pendingTask.resolve(makeApiTask({ id: "old-account-task", content: "Old" }));

      const error = await updating.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TodoistRemoteMutationFollowupError);
      expect(error).toMatchObject({
        action: "updateTask",
        remoteMutationSucceeded: true,
        cause: expect.objectContaining({
          message: "Todoist account changed while updating a task",
        }),
      });
      expect(mockApi.getTasks).not.toHaveBeenCalled();
    });

    it("marks an account reset during the update query refresh as a post-response failure", async () => {
      const updatedTask = makeApiTask({ id: "task-1", content: "Updated remotely" });
      const pendingRefresh = deferred<ReturnType<typeof makeApiTask>[]>();
      vi.mocked(mockApi.updateTask).mockResolvedValue(updatedTask);
      vi.mocked(mockApi.getTasks).mockImplementationOnce(async () => await pendingRefresh.promise);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      const updating = adapter.actions.updateTask("task-1", { content: "Updated remotely" });
      await vi.waitFor(() => expect(mockApi.getTasks).toHaveBeenCalledWith("#test"));
      adapter.reset();
      pendingRefresh.resolve([updatedTask]);

      const error = await updating.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TodoistRemoteMutationFollowupError);
      expect(error).toMatchObject({
        action: "updateTask",
        remoteMutationSucceeded: true,
      });
      expect(mockApi.updateTask).toHaveBeenCalledOnce();
    });

    it("reopens a task and refreshes mounted query subscriptions", async () => {
      const reopenedTask = makeApiTask({ id: "reopened-task", content: "Active again" });
      vi.mocked(mockApi.reopenTask).mockResolvedValue(undefined);
      vi.mocked(mockApi.getTasks).mockResolvedValue([reopenedTask]);
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe("#test", (result) => {
        captured = result;
      });

      await expect(adapter.actions.reopenTask("reopened-task")).resolves.toBeUndefined();

      expect(mockApi.reopenTask).toHaveBeenCalledWith("reopened-task");
      expect(mockApi.getTasks).toHaveBeenCalledWith("#test");
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.tasks).toMatchObject([{ id: "reopened-task" }]);
      }
    });

    it("refreshes completed-enabled subscriptions after reopening a task", async () => {
      const reopenedTask = makeApiTask({ id: "reopened-task", content: "Active again" });
      vi.mocked(mockApi.reopenTask).mockResolvedValue(undefined);
      vi.mocked(mockApi.getTasks).mockResolvedValue([reopenedTask]);
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [
          makeTask("reopened-task", {
            content: "Previously completed",
            completedAt: "2026-08-09T00:00:00.000Z",
          }),
        ],
        true,
      );

      await adapter.actions.reopenTask("reopened-task");

      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledWith("#test", undefined, undefined);
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.tasks).toMatchObject([{ id: "reopened-task", content: "Active again" }]);
        expect(result.tasks[0].completedAt).toBeUndefined();
      }
    });

    it("does not refresh queries when reopening the remote task fails", async () => {
      vi.mocked(mockApi.reopenTask).mockRejectedValue(new Error("reopen failed"));
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      await expect(adapter.actions.reopenTask("task-1")).rejects.toThrow("reopen failed");

      expect(mockApi.getTasks).not.toHaveBeenCalled();
    });

    it("marks an account change after reopening as a post-response failure", async () => {
      const pendingReopen = deferred<void>();
      vi.mocked(mockApi.reopenTask).mockImplementationOnce(async () => await pendingReopen.promise);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      const reopening = adapter.actions.reopenTask("old-account-task");
      adapter.reset();
      pendingReopen.resolve(undefined);

      const error = await reopening.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TodoistRemoteMutationFollowupError);
      expect(error).toMatchObject({
        action: "reopenTask",
        remoteMutationSucceeded: true,
        cause: expect.objectContaining({
          message: "Todoist account changed while reopening a task",
        }),
      });
      expect(mockApi.getTasks).not.toHaveBeenCalled();
    });

    it("confirms a project reopen without waiting for mounted query refreshes", async () => {
      const pendingRefresh = deferred<ReturnType<typeof makeApiTask>[]>();
      vi.mocked(mockApi.reopenTask).mockResolvedValue(undefined);
      vi.mocked(mockApi.getTasks).mockImplementationOnce(async () => await pendingRefresh.promise);
      await adapter.initialize(mockApi);
      const queryCallback = vi.fn();
      adapter.subscribe("#test", queryCallback);

      await expect(adapter.actions.reopenProjectTask("reopened-task")).resolves.toBeUndefined();

      expect(mockApi.reopenTask).toHaveBeenCalledWith("reopened-task");
      expect(mockApi.getTasks).toHaveBeenCalledWith("#test");

      pendingRefresh.resolve([makeApiTask({ id: "reopened-task" })]);
      await vi.waitFor(() =>
        expect(queryCallback).toHaveBeenCalledWith(expect.objectContaining({ type: "success" })),
      );
    });

    it("rejects a project reopen when the account changes after Todoist confirms it", async () => {
      const pendingReopen = deferred<void>();
      vi.mocked(mockApi.reopenTask).mockImplementationOnce(async () => await pendingReopen.promise);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn());

      const reopening = adapter.actions.reopenProjectTask("old-account-task");
      adapter.reset();
      pendingReopen.resolve(undefined);

      await expect(reopening).rejects.toMatchObject({
        action: "reopenProjectTask",
        remoteMutationSucceeded: true,
        cause: expect.objectContaining({
          message: "Todoist account changed while reopening a project task",
        }),
      });
      expect(mockApi.getTasks).not.toHaveBeenCalled();
    });

    it("closes a project task, updates queries, and starts its cache follow-up", async () => {
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [makeTask("task-1")],
      );

      await expect(adapter.actions.closeProjectTask("task-1")).resolves.toBeInstanceOf(Date);

      expect(mockApi.closeTask).toHaveBeenCalledWith("task-1");
      expect(onTaskClosed).toHaveBeenCalledWith("task-1", expect.any(Date));
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.tasks).toEqual([]);
        expect(result.cacheEffect).toEqual({ type: "none" });
      }
    });

    it("preserves a remote close failure when closing a project task", async () => {
      const remoteError = new Error("close failed");
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      vi.mocked(mockApi.closeTask).mockRejectedValue(remoteError);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn(), [makeTask("task-1")]);

      const error = await adapter.actions
        .closeProjectTask("task-1")
        .catch((reason: unknown) => reason);

      expect(error).toBe(remoteError);
      expect(error).not.toBeInstanceOf(TodoistRemoteMutationFollowupError);
      expect(onTaskClosed).not.toHaveBeenCalled();
    });

    it("does not reject a confirmed project close when its cache follow-up fails", async () => {
      const cacheError = new Error("cache write failed");
      adapter = new TodoistAdapter({
        onTaskClosed: vi.fn().mockRejectedValue(cacheError),
      });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [makeTask("task-1")],
      );

      await expect(adapter.actions.closeProjectTask("task-1")).resolves.toBeInstanceOf(Date);
      await vi.waitFor(() =>
        expect(errorLog).toHaveBeenCalledWith(
          "Failed to update Todoist query cache after closing a task:",
          cacheError,
        ),
      );
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.tasks).toEqual([]);
      }
      errorLog.mockRestore();
    });

    it("marks an account change after a project close without committing local follow-up", async () => {
      const pendingClose = deferred<void>();
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      vi.mocked(mockApi.closeTask).mockImplementationOnce(async () => await pendingClose.promise);
      await adapter.initialize(mockApi);
      adapter.subscribe("#test", vi.fn(), [makeTask("task-1")]);

      const closing = adapter.actions.closeProjectTask("task-1");
      adapter.reset();
      pendingClose.resolve(undefined);

      const error = await closing.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TodoistRemoteMutationFollowupError);
      expect(error).toMatchObject({
        action: "closeProjectTask",
        remoteMutationSucceeded: true,
      });
      expect(onTaskClosed).not.toHaveBeenCalled();
    });

    it("preserves the legacy close action's silent account-change behavior", async () => {
      const pendingClose = deferred<void>();
      vi.mocked(mockApi.closeTask).mockImplementationOnce(async () => await pendingClose.promise);
      await adapter.initialize(mockApi);

      const closing = adapter.actions.closeTask("task-1");
      adapter.reset();
      pendingClose.resolve(undefined);

      await expect(closing).resolves.toBeUndefined();
    });
  });

  describe("Subscription", () => {
    it("should deliver success result with tasks", async () => {
      const apiTask = makeApiTask();
      vi.mocked(mockApi.getTasks).mockResolvedValue([apiTask]);

      await adapter.initialize(mockApi);
      const { result } = await subscribeAndRefresh(adapter);

      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe("task-1");
    });

    it("should deliver not-ready result when API is not initialized", async () => {
      let captured: SubscriptionResult = {
        type: "success",
        tasks: [],
        cacheEffect: { type: "none" },
      };
      const callback: OnSubscriptionChange = (r) => {
        captured = r;
      };

      const [, refresh] = adapter.subscribe("#test", callback);
      await refresh();

      expect(captured.type).toBe("not-ready");
    });

    it("should remove a task by ID and notify callback", async () => {
      const tasks = [makeApiTask({ id: "task-1" }), makeApiTask({ id: "task-2" })];
      vi.mocked(mockApi.getTasks).mockResolvedValue(tasks);

      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const callback: OnSubscriptionChange = (r) => {
        captured = r;
      };

      const [, refresh] = adapter.subscribe("#test", callback);
      await refresh();

      const result1 = captured as SubscriptionResult;
      expect(result1.type).toBe("success");
      if (result1.type !== "success") {
        return;
      }
      expect(result1.tasks).toHaveLength(2);

      // Close task-1 to trigger remove
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);
      await adapter.actions.closeTask("task-1");

      const result2 = captured as SubscriptionResult;
      expect(result2.type).toBe("success");
      if (result2.type !== "success") {
        return;
      }
      expect(result2.tasks).toHaveLength(1);
      expect(result2.tasks[0].id).toBe("task-2");
      expect(result2.cacheEffect).toEqual({ type: "none" });
    });

    it("should retain a closed task for completed-enabled subscriptions", async () => {
      await adapter.initialize(mockApi);
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);

      let captured: SubscriptionResult = { type: "not-ready" };
      const activeTask = makeTask("task-1");
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [activeTask],
        true,
      );

      await adapter.actions.closeTask("task-1");

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks).toEqual([
        {
          ...activeTask,
          completedAt: expect.any(String),
        },
      ]);
      expect(result.cacheEffect).toEqual({ type: "none" });
    });

    it("should fetch one newest completed-task window for completed-enabled subscriptions", async () => {
      await adapter.initialize(mockApi);

      const [, refresh] = adapter.subscribe("#test", vi.fn(), [], true);
      await refresh();

      expect(mockApi.getTasks).toHaveBeenCalledWith("#test");
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledOnce();
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledWith("#test", undefined, undefined);
    });

    it("should bound completed-task history by the Todoist account join time", async () => {
      vi.mocked(mockApi.getUser).mockResolvedValue({
        isPremium: true,
        joinedAt: "2018-04-03T02:01:00.000Z",
      });
      await adapter.initialize(mockApi);

      const [, refresh] = adapter.subscribe("#test", vi.fn(), [], true);
      await refresh();

      expect(mockApi.getTasks).toHaveBeenCalledWith("#test");
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledWith(
        "#test",
        undefined,
        "2018-04-03T02:01:00.000Z",
      );
    });

    it("loads exactly one cached completed-history window per explicit request", async () => {
      const nextPage = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };
      const followingPage = {
        since: "2026-02-10T06:00:00.000Z",
        until: "2026-05-11T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockResolvedValueOnce({
        tasks: [
          makeApiTask({
            id: "older-completed",
            completedAt: "2026-05-01T06:00:00.000Z",
          }),
        ],
        request: nextPage,
        nextPage: followingPage,
      });
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const cachedCompleted = makeTask("cached-completed", {
        completedAt: "2026-08-01T06:00:00.000Z",
      });
      const [, , loadMoreCompleted] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [cachedCompleted],
        true,
        makeCompletedProgress([nextPage]),
      );

      await loadMoreCompleted();

      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledOnce();
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledWith("#test", nextPage);
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks.map((task) => task.id)).toEqual(["older-completed", "cached-completed"]);
      expect(result.completedTasksProgress).toEqual(
        makeCompletedProgress(
          [followingPage],
          newestCompletedRequest.until,
          newestCompletedRequest.historyStart,
          2,
        ),
      );
      expect(result.cacheEffect).toEqual({ type: "replace", requestedAt: expect.any(Date) });
    });

    it("advances the loaded-window count when an earlier window has no matching tasks", async () => {
      const nextWindow = {
        since: "2026-02-10T06:00:00.000Z",
        until: "2026-05-11T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };
      const followingWindow = {
        since: "2025-11-12T06:00:00.000Z",
        until: nextWindow.since,
        historyStart: nextWindow.historyStart,
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockResolvedValueOnce({
        tasks: [],
        request: nextWindow,
        nextPage: followingWindow,
      });
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const cachedCompleted = makeTask("cached-completed", {
        completedAt: "2026-08-01T06:00:00.000Z",
      });
      const [, , loadMoreCompleted] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [cachedCompleted],
        true,
        makeCompletedProgress([nextWindow]),
      );

      await loadMoreCompleted();

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks).toEqual([cachedCompleted]);
      expect(result.completedTasksProgress).toEqual(
        makeCompletedProgress(
          [followingWindow],
          newestCompletedRequest.until,
          newestCompletedRequest.historyStart,
          2,
        ),
      );
    });

    it("keeps completed-history progress unchanged when an explicit request fails", async () => {
      const nextPage = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockRejectedValueOnce(new Error("rate limited"));
      await adapter.initialize(mockApi);

      const callback = vi.fn();
      const [, , loadMoreCompleted] = adapter.subscribe(
        "#test",
        callback,
        [makeTask("cached", { completedAt: "2026-08-01T06:00:00.000Z" })],
        true,
        makeCompletedProgress([nextPage]),
      );

      await expect(loadMoreCompleted()).rejects.toThrow("rate limited");
      expect(callback).not.toHaveBeenCalled();
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledWith("#test", nextPage);
    });

    it("adds a bounded catch-up frontier after a long reopen without losing global history", async () => {
      const globalFrontier: CompletedTasksPageRequest = {
        since: "2026-02-10T06:00:00.000Z",
        until: "2026-05-11T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };
      const refreshedRequest: CompletedTasksPageRequest = {
        since: "2026-11-10T06:00:00.000Z",
        until: "2027-02-08T06:00:00.000Z",
        historyStart: globalFrontier.historyStart,
      };
      const unboundedOlderPage: CompletedTasksPageRequest = {
        since: "2026-08-12T06:00:00.000Z",
        until: refreshedRequest.since,
        historyStart: globalFrontier.historyStart,
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockResolvedValueOnce({
        tasks: [],
        request: refreshedRequest,
        nextPage: unboundedOlderPage,
      });
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const [, refresh] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [],
        true,
        makeCompletedProgress([globalFrontier]),
      );

      await refresh();

      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledOnce();
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.completedTasksProgress).toEqual({
        latestUntil: refreshedRequest.until,
        historyStart: globalFrontier.historyStart,
        loadedWindowCount: 1,
        frontiers: [
          {
            since: unboundedOlderPage.since,
            until: refreshedRequest.since,
            historyStart: newestCompletedRequest.until,
          },
          globalFrontier,
        ],
      });
    });

    it("retains a newest-window cursor when cached completed history was exhausted", async () => {
      const refreshedRequest: CompletedTasksPageRequest = {
        since: "2026-06-03T06:00:00.000Z",
        until: "2026-09-01T06:00:00.000Z",
        historyStart: newestCompletedRequest.historyStart,
      };
      const cursorPage: CompletedTasksPageRequest = {
        ...refreshedRequest,
        cursor: "latest-window-cursor",
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockResolvedValueOnce({
        tasks: [],
        request: refreshedRequest,
        nextPage: cursorPage,
      });
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const [, refresh] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [],
        true,
        makeCompletedProgress([]),
      );

      await refresh();

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.completedTasksProgress).toEqual({
        latestUntil: refreshedRequest.until,
        historyStart: newestCompletedRequest.historyStart,
        loadedWindowCount: 1,
        frontiers: [
          {
            ...cursorPage,
            historyStart: newestCompletedRequest.until,
          },
        ],
      });
    });

    it("merges an overlapping refresh and history load regardless of completion order", async () => {
      const claimedFrontier: CompletedTasksPageRequest = {
        since: "2026-02-10T06:00:00.000Z",
        until: "2026-05-11T06:00:00.000Z",
        historyStart: newestCompletedRequest.historyStart,
      };
      const followingFrontier: CompletedTasksPageRequest = {
        since: "2024-01-01T00:00:00.000Z",
        until: claimedFrontier.since,
        historyStart: newestCompletedRequest.historyStart,
      };
      const refreshedRequest: CompletedTasksPageRequest = {
        since: "2026-05-12T06:00:00.000Z",
        until: "2026-08-10T06:00:00.000Z",
        historyStart: newestCompletedRequest.historyStart,
      };
      let resolveHistoryLoad: (page: {
        tasks: ReturnType<typeof makeApiTask>[];
        request: CompletedTasksPageRequest;
        nextPage: CompletedTasksPageRequest;
      }) => void = () => {};
      vi.mocked(mockApi.getCompletedTasksPage)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveHistoryLoad = resolve;
            }),
        )
        .mockResolvedValueOnce({
          tasks: [
            makeApiTask({
              id: "refreshed-completed",
              completedAt: "2026-08-09T06:00:00.000Z",
            }),
          ],
          request: refreshedRequest,
          nextPage: {
            since: "2026-02-11T06:00:00.000Z",
            until: refreshedRequest.since,
            historyStart: refreshedRequest.historyStart,
          },
        });
      await adapter.initialize(mockApi);

      let captured: SubscriptionResult = { type: "not-ready" };
      const [, refresh, loadMoreCompleted] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [],
        true,
        makeCompletedProgress([claimedFrontier]),
      );

      const loadingHistory = loadMoreCompleted();
      await refresh();
      resolveHistoryLoad({
        tasks: [
          makeApiTask({
            id: "older-completed",
            completedAt: "2026-02-09T06:00:00.000Z",
          }),
        ],
        request: claimedFrontier,
        nextPage: followingFrontier,
      });
      await loadingHistory;

      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledTimes(2);
      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks.map((task) => task.id)).toEqual([
        "older-completed",
        "refreshed-completed",
      ]);
      expect(result.completedTasksProgress).toEqual(
        makeCompletedProgress(
          [followingFrontier],
          refreshedRequest.until,
          newestCompletedRequest.historyStart,
          2,
        ),
      );
    });

    it("shares completed tasks, progress, and in-flight requests between same-filter blocks", async () => {
      const claimedFrontier: CompletedTasksPageRequest = {
        since: "2026-02-10T06:00:00.000Z",
        until: "2026-05-11T06:00:00.000Z",
        historyStart: newestCompletedRequest.historyStart,
      };
      const followingFrontier: CompletedTasksPageRequest = {
        since: newestCompletedRequest.historyStart,
        until: claimedFrontier.since,
        historyStart: newestCompletedRequest.historyStart,
      };
      vi.mocked(mockApi.getCompletedTasksPage).mockImplementation(async (_filter, request) => {
        if (request === undefined) {
          return {
            tasks: [
              makeApiTask({
                id: "refreshed-completed",
                completedAt: "2026-08-08T06:00:00.000Z",
              }),
            ],
            request: newestCompletedRequest,
            nextPage: claimedFrontier,
          };
        }

        return {
          tasks: [
            makeApiTask({
              id: "loaded-completed",
              completedAt: "2026-02-09T06:00:00.000Z",
            }),
          ],
          request,
          nextPage: followingFrontier,
        };
      });
      await adapter.initialize(mockApi);

      const firstResults: SubscriptionResult[] = [];
      const secondResults: SubscriptionResult[] = [];
      const [, firstRefresh, firstLoad] = adapter.subscribe(
        "#test",
        (result) => firstResults.push(result),
        [],
        true,
        makeCompletedProgress([claimedFrontier]),
      );
      const staleFrontier = { ...claimedFrontier, cursor: "stale-cursor" };
      const [, secondRefresh, secondLoad] = adapter.subscribe(
        "#test",
        (result) => secondResults.push(result),
        [],
        true,
        makeCompletedProgress([staleFrontier]),
      );

      await Promise.all([firstRefresh(), secondRefresh()]);
      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledTimes(1);
      await Promise.all([firstLoad(), secondLoad()]);

      expect(mockApi.getCompletedTasksPage).toHaveBeenCalledTimes(2);
      expect(mockApi.getCompletedTasksPage).toHaveBeenLastCalledWith("#test", claimedFrontier);
      const firstResult = firstResults[firstResults.length - 1];
      const secondResult = secondResults[secondResults.length - 1];
      expect(firstResult).toEqual(secondResult);
      expect(firstResult?.type).toBe("success");
      if (firstResult?.type !== "success") {
        return;
      }
      expect(firstResult.tasks.map((task) => task.id)).toEqual([
        "loaded-completed",
        "refreshed-completed",
      ]);
      expect(firstResult.completedTasksProgress).toEqual(
        makeCompletedProgress(
          [followingFrontier],
          newestCompletedRequest.until,
          newestCompletedRequest.historyStart,
          2,
        ),
      );
    });

    it("keeps divergent local subscription snapshots cache-neutral", async () => {
      await adapter.initialize(mockApi);
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);

      const firstResults: SubscriptionResult[] = [];
      const secondResults: SubscriptionResult[] = [];
      adapter.subscribe("#test", (result) => firstResults.push(result), [
        makeTask("task-1"),
        makeTask("first-only"),
      ]);
      adapter.subscribe("#test", (result) => secondResults.push(result), [
        makeTask("task-1"),
        makeTask("second-only"),
      ]);

      await adapter.actions.closeTask("task-1");

      const firstCommitted = firstResults[firstResults.length - 1];
      const secondCommitted = secondResults[secondResults.length - 1];
      expect(firstCommitted?.type).toBe("success");
      expect(secondCommitted?.type).toBe("success");
      if (firstCommitted?.type !== "success" || secondCommitted?.type !== "success") {
        return;
      }
      expect(firstCommitted.tasks.map((task) => task.id)).toEqual(["first-only"]);
      expect(secondCommitted.tasks.map((task) => task.id)).toEqual(["second-only"]);
      expect(firstCommitted.cacheEffect).toEqual({ type: "none" });
      expect(secondCommitted.cacheEffect).toEqual({ type: "none" });
    });

    it("reports a confirmed task closure even when no query is mounted", async () => {
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      await adapter.initialize(mockApi);
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);

      await adapter.actions.closeTask("task-1");

      expect(onTaskClosed).toHaveBeenCalledOnce();
      expect(onTaskClosed).toHaveBeenCalledWith("task-1", expect.any(Date));
    });

    it("reports a confirmed closure after its originating query unmounts", async () => {
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      await adapter.initialize(mockApi);

      let resolveClose: () => void = () => {};
      vi.mocked(mockApi.closeTask).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      );
      const [unsubscribe] = adapter.subscribe("#test", vi.fn(), [makeTask("task-1")]);

      const closing = adapter.actions.closeTask("task-1");
      unsubscribe();
      expect(onTaskClosed).not.toHaveBeenCalled();

      resolveClose();
      await closing;

      expect(onTaskClosed).toHaveBeenCalledOnce();
      expect(onTaskClosed).toHaveBeenCalledWith("task-1", expect.any(Date));
    });

    it("should ignore an older refresh that finishes after a newer refresh", async () => {
      await adapter.initialize(mockApi);

      let resolveOlder: (tasks: ReturnType<typeof makeApiTask>[]) => void = () => {};
      let resolveNewer: (tasks: ReturnType<typeof makeApiTask>[]) => void = () => {};
      vi.mocked(mockApi.getTasks)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOlder = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNewer = resolve;
            }),
        );

      let captured: SubscriptionResult = { type: "not-ready" };
      const [, refresh] = adapter.subscribe("#test", (result) => {
        captured = result;
      });

      const olderRefresh = refresh();
      const newerRefresh = refresh();
      resolveNewer([makeApiTask({ id: "newer-task" })]);
      await newerRefresh;
      resolveOlder([makeApiTask({ id: "older-task" })]);
      await olderRefresh;

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks.map((task) => task.id)).toEqual(["newer-task"]);
    });

    it("should seed cached tasks and not re-add a completed task from an older refresh", async () => {
      await adapter.initialize(mockApi);

      let resolveRefresh: (tasks: ReturnType<typeof makeApiTask>[]) => void = () => {};
      vi.mocked(mockApi.getTasks).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      vi.mocked(mockApi.closeTask).mockResolvedValue(undefined);

      let captured: SubscriptionResult = { type: "not-ready" };
      const cachedTask = makeTask("cached-task", { content: "Cached task" });
      const [, refresh] = adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [cachedTask],
      );

      const openingRefresh = refresh();
      await adapter.actions.closeTask("cached-task");
      resolveRefresh([makeApiTask({ id: "cached-task", content: "Cached task" })]);
      await openingRefresh;

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks).toEqual([]);
    });

    it("should restore a cached task when closing it fails", async () => {
      const onTaskClosed = vi.fn();
      adapter = new TodoistAdapter({ onTaskClosed });
      await adapter.initialize(mockApi);
      vi.mocked(mockApi.closeTask).mockRejectedValue(new Error("close failed"));

      let captured: SubscriptionResult = { type: "not-ready" };
      const cachedTask = makeTask("cached-task", { content: "Cached task" });
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [cachedTask],
      );

      await expect(adapter.actions.closeTask("cached-task")).rejects.toThrow("close failed");

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks).toEqual([cachedTask]);
      expect(result.cacheEffect).toEqual({ type: "none" });
      expect(onTaskClosed).not.toHaveBeenCalled();
    });

    it("should leave a completed-enabled subscription unchanged when closing fails", async () => {
      await adapter.initialize(mockApi);
      vi.mocked(mockApi.closeTask).mockRejectedValue(new Error("close failed"));

      let captured: SubscriptionResult = { type: "not-ready" };
      const cachedTask = makeTask("cached-task", { content: "Cached task" });
      adapter.subscribe(
        "#test",
        (result) => {
          captured = result;
        },
        [cachedTask],
        true,
      );

      await expect(adapter.actions.closeTask("cached-task")).rejects.toThrow("close failed");

      const result = captured as SubscriptionResult;
      expect(result.type).toBe("success");
      if (result.type !== "success") {
        return;
      }
      expect(result.tasks).toEqual([cachedTask]);
      expect(result.cacheEffect).toEqual({ type: "none" });
    });

    it("should invalidate an in-flight refresh when the adapter resets", async () => {
      await adapter.initialize(mockApi);

      let resolveRefresh: (tasks: ReturnType<typeof makeApiTask>[]) => void = () => {};
      vi.mocked(mockApi.getTasks).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      let captured: SubscriptionResult = { type: "not-ready" };
      const [, refresh] = adapter.subscribe("#test", (result) => {
        captured = result;
      });

      const pendingRefresh = refresh();
      adapter.reset();
      resolveRefresh([makeApiTask({ id: "old-account-task" })]);
      await pendingRefresh;

      expect((captured as SubscriptionResult).type).toBe("not-ready");
    });
  });
});
