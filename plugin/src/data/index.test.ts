import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TodoistApiClient } from "@/api";
import type { SyncResponse } from "@/api/domain/sync";
import { type OnSubscriptionChange, type SubscriptionResult, TodoistAdapter } from "@/data/index";
import { makeApiTask, makeTask } from "@/factories/data";

const makeSyncResponse = (overrides?: Partial<SyncResponse>): SyncResponse => ({
  syncToken: "token-1",
  projects: [],
  sections: [],
  labels: [],
  ...overrides,
});

const makeMockApi = (): TodoistApiClient => {
  return {
    getTasks: vi.fn().mockResolvedValue([]),
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
