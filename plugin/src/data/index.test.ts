import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedTasksPageRequest, TodoistApiClient } from "@/api";
import type { SyncResponse } from "@/api/domain/sync";
import {
  type CompletedTasksProgress,
  type OnSubscriptionChange,
  type SubscriptionResult,
  TodoistAdapter,
} from "@/data/index";
import { makeApiTask, makeTask } from "@/factories/data";

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
    getCompletedTasksPage: vi.fn().mockResolvedValue({
      tasks: [],
      request: newestCompletedRequest,
      nextPage: null,
    }),
    createTask: vi.fn(),
    closeTask: vi.fn(),
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
