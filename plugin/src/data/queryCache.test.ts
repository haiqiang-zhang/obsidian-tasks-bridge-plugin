import { describe, expect, it, vi } from "vitest";

import { QueryCache } from "@/data/queryCache";
import { makeTask } from "@/factories/data";

describe("QueryCache", () => {
  it("loads and returns a cached query", () => {
    const cache = new QueryCache();
    const task = makeTask("cached-task", { content: "Cached task" });

    cache.load({
      version: 2,
      credentialFingerprint: "credential-a",
      entries: {
        '{"filter":"today"}': {
          tasks: [task],
          updatedAt: "2026-08-09T05:00:00.000Z",
        },
      },
    });

    expect(cache.get("today")).toEqual({
      tasks: [task],
      updatedAt: new Date("2026-08-09T05:00:00.000Z"),
    });
  });

  it("ignores cache data from an unsupported version", () => {
    const cache = new QueryCache();

    cache.load({
      version: 1,
      credentialFingerprint: "credential-a",
      entries: {
        '{"filter":"today"}': {
          tasks: [makeTask("stale")],
          updatedAt: "2026-08-09T05:00:00.000Z",
        },
      },
    });

    expect(cache.get("today")).toBeUndefined();
  });

  it("keeps valid entries when another entry is malformed", () => {
    const cache = new QueryCache();
    const task = makeTask("valid");

    cache.load({
      version: 2,
      credentialFingerprint: "credential-a",
      entries: {
        '{"filter":"today"}': {
          tasks: [task],
          updatedAt: "2026-08-09T05:00:00.000Z",
        },
        '{"filter":"tomorrow"}': {
          tasks: "not-an-array",
          updatedAt: "invalid-date",
        },
      },
    });

    expect(cache.get("today")?.tasks).toEqual([task]);
    expect(cache.get("tomorrow")).toBeUndefined();
  });

  it("stores successful empty results and serializes their timestamp", () => {
    const cache = new QueryCache();
    const updatedAt = new Date("2026-08-09T06:00:00.000Z");

    cache.set("today", [], updatedAt);

    expect(cache.get("today")).toEqual({ tasks: [], updatedAt });
    expect(cache.serialize()).toEqual({
      version: 2,
      credentialFingerprint: null,
      entries: {
        '{"filter":"today"}': {
          tasks: [],
          updatedAt: "2026-08-09T06:00:00.000Z",
        },
      },
    });
  });

  it("isolates completed-enabled entries while preserving the legacy active-only key", () => {
    const cache = new QueryCache();
    const updatedAt = new Date("2026-08-09T06:00:00.000Z");
    const activeTask = makeTask("active");
    const completedTask = makeTask("completed", {
      completedAt: "2026-08-09T05:30:00.000Z",
    });

    cache.set("today", [activeTask], updatedAt);
    cache.set("today", [activeTask, completedTask], updatedAt, true);

    expect(cache.get("today")?.tasks).toEqual([activeTask]);
    expect(cache.get("today", true)?.tasks).toEqual([activeTask, completedTask]);
    expect(cache.serialize().entries).toEqual({
      '{"filter":"today"}': {
        tasks: [activeTask],
        updatedAt: updatedAt.toISOString(),
      },
      '{"filter":"today","completedTasks":true}': {
        tasks: [activeTask, completedTask],
        updatedAt: updatedAt.toISOString(),
      },
    });
  });

  it("loads nullable completion identity without changing cache version", () => {
    const cache = new QueryCache();
    const completedTask = makeTask("completed", { completedAt: null });

    cache.load({
      version: 2,
      credentialFingerprint: "credential-a",
      entries: {
        '{"filter":"today","completedTasks":true}': {
          tasks: [completedTask],
          updatedAt: "2026-08-09T05:00:00.000Z",
        },
      },
    });

    expect(cache.get("today", true)?.tasks).toEqual([completedTask]);
  });

  it("round-trips completed-history progress and preserves it during local task updates", () => {
    const cache = new QueryCache();
    const updatedAt = new Date("2026-08-09T06:00:00.000Z");
    const nextPage = {
      since: "2026-05-11T06:00:00.000Z",
      until: "2026-08-09T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
      cursor: "next-cursor",
    };
    const progress = {
      latestUntil: updatedAt.toISOString(),
      historyStart: nextPage.historyStart,
      loadedWindowCount: 2,
      frontiers: [nextPage],
    };
    const task = makeTask("task-1");

    cache.set("today", [task], updatedAt, true, progress);

    expect(cache.get("today", true)).toEqual({
      tasks: [task],
      updatedAt,
      completedTasksProgress: progress,
    });
    expect(cache.serialize().entries['{"filter":"today","completedTasks":true}']).toEqual({
      tasks: [task],
      updatedAt: updatedAt.toISOString(),
      completedTasksProgress: progress,
    });

    const completedAt = new Date("2026-08-09T07:00:00.000Z");
    cache.completeTaskInAll("task-1", completedAt);
    expect(cache.get("today", true)?.completedTasksProgress).toEqual(progress);
  });

  it("migrates the one-frontier completed-history cache without discarding progress", () => {
    const cache = new QueryCache();
    const nextPage = {
      since: "2026-05-11T06:00:00.000Z",
      until: "2026-08-09T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
      cursor: "next-cursor",
    };

    cache.load({
      version: 2,
      credentialFingerprint: "credential-a",
      entries: {
        '{"filter":"today","completedTasks":true}': {
          tasks: [],
          updatedAt: "2026-08-09T06:00:00.000Z",
          completedTasksNextPage: nextPage,
        },
      },
    });

    expect(cache.get("today", true)?.completedTasksProgress).toEqual({
      latestUntil: "2026-08-09T06:00:00.000Z",
      historyStart: nextPage.historyStart,
      loadedWindowCount: 1,
      frontiers: [nextPage],
    });
  });

  it("clears entries when the Todoist credential changes", () => {
    const cache = new QueryCache();
    const onClear = vi.fn();
    cache.onClear(onClear);
    cache.bindCredential("credential-a");
    cache.set("today", [makeTask("account-a-task")], new Date("2026-08-09T06:00:00.000Z"));

    expect(cache.bindCredential("credential-a")).toBe(false);
    expect(cache.get("today")).toBeDefined();

    expect(cache.bindCredential("credential-b")).toBe(true);
    expect(cache.get("today")).toBeUndefined();
    expect(onClear).toHaveBeenCalledTimes(2);
    expect(cache.serialize().credentialFingerprint).toBe("credential-b");
  });

  it("does not let an older request overwrite a newer cache entry", () => {
    const cache = new QueryCache();
    const newerTask = makeTask("newer");

    expect(cache.set("today", [newerTask], new Date("2026-08-09T06:00:01.000Z"))).toBe(true);
    expect(cache.set("today", [makeTask("older")], new Date("2026-08-09T06:00:00.000Z"))).toBe(
      false,
    );

    expect(cache.get("today")?.tasks).toEqual([newerTask]);
  });

  it("removes a confirmed task from every cached query without regressing timestamps", () => {
    const cache = new QueryCache();
    const olderTimestamp = new Date("2026-08-09T05:00:00.000Z");
    const removalTimestamp = new Date("2026-08-09T06:00:00.000Z");
    const newerTimestamp = new Date("2026-08-09T07:00:00.000Z");
    const retainedTask = makeTask("retained");
    cache.set("today", [makeTask("completed"), retainedTask], olderTimestamp);
    cache.set("work", [makeTask("completed")], removalTimestamp);
    cache.set("newer", [makeTask("completed")], newerTimestamp);

    expect(cache.removeTaskFromAll("completed", removalTimestamp)).toBe(true);
    expect(cache.get("today")).toEqual({ tasks: [retainedTask], updatedAt: removalTimestamp });
    expect(cache.get("work")).toEqual({ tasks: [], updatedAt: removalTimestamp });
    expect(cache.get("newer")).toEqual({
      tasks: [],
      updatedAt: newerTimestamp,
    });
    expect(cache.removeTaskFromAll("completed", removalTimestamp)).toBe(false);
  });

  it("removes a closed task from active caches and marks it completed in enabled caches", () => {
    const cache = new QueryCache();
    const olderTimestamp = new Date("2026-08-09T05:00:00.000Z");
    const completedAt = new Date("2026-08-09T06:00:00.000Z");
    const task = makeTask("task-1");
    const retainedTask = makeTask("retained");
    cache.set("today", [task, retainedTask], olderTimestamp);
    cache.set("today", [task, retainedTask], olderTimestamp, true);

    expect(cache.completeTaskInAll("task-1", completedAt)).toBe(true);
    expect(cache.get("today")).toEqual({ tasks: [retainedTask], updatedAt: completedAt });
    expect(cache.get("today", true)).toEqual({
      tasks: [{ ...task, completedAt: completedAt.toISOString() }, retainedTask],
      updatedAt: completedAt,
    });
    expect(cache.completeTaskInAll("missing-task", completedAt)).toBe(false);
  });
});
