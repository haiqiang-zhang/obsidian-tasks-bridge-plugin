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
});
