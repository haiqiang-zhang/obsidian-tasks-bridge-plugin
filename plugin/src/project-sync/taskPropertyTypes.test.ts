import type { App, CachedMetadata, EventRef, TFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TASK_TEMPORAL_PROPERTY_TYPES } from "./properties";
import { TaskPropertyTypes } from "./taskPropertyTypes";

type TypeName = "date" | "datetime";
type Frontmatter = Record<string, unknown>;
const settle = async () => await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const makeHarness = () => {
  const files: TFile[] = [];
  const caches = new Map<string, CachedMetadata>();
  const assigned = new Map<string, string>();
  const persisted = new Map<string, string>();
  const changed: ((file: TFile, data: string, cache: CachedMetadata) => void)[] = [];
  const resolved: (() => void)[] = [];
  const layoutReady: (() => void)[] = [];
  const managerChanged: ((name: string) => void)[] = [];
  const modify = vi.fn();
  const processFrontMatter = vi.fn();
  const getMarkdownFiles = vi.fn(() => files);
  const manager = {
    _loaded: true,
    getAssignedWidget: vi.fn((name: string) => assigned.get(name) ?? null),
    setType: vi.fn(async (name: string, type: TypeName) => {
      assigned.set(name, type);
      persisted.set(name, type);
      for (const listener of managerChanged) {
        listener(name);
      }
    }),
    on: vi.fn((_event: string, listener: (name: string) => void) => {
      managerChanged.push(listener);
      return {} as EventRef;
    }),
  };
  const app = {
    metadataTypeManager: manager as unknown,
    vault: { getMarkdownFiles, modify },
    fileManager: { processFrontMatter },
    metadataCache: {
      getFileCache: (file: TFile) => caches.get(file.path),
      on: (event: string, listener: unknown) => {
        if (event === "changed") {
          changed.push(listener as (file: TFile, data: string, cache: CachedMetadata) => void);
        } else if (event === "resolved") {
          resolved.push(listener as () => void);
        }
        return {} as EventRef;
      },
    },
    workspace: { onLayoutReady: (listener: () => void) => layoutReady.push(listener) },
  };
  const service = new TaskPropertyTypes(app as unknown as App);
  const registerEvent = vi.fn();
  const addFile = (path: string, frontmatter?: Frontmatter) => {
    const file = { path, extension: "md" } as TFile;
    files.push(file);
    if (frontmatter !== undefined) {
      caches.set(path, { frontmatter } as CachedMetadata);
    }
    return file;
  };
  const cacheChanged = (file: TFile, frontmatter: Frontmatter) => {
    const cache = { frontmatter } as CachedMetadata;
    caches.set(file.path, cache);
    for (const listener of changed) {
      listener(file, "unchanged native Markdown", cache);
    }
  };
  return {
    addFile,
    app,
    assigned,
    cacheChanged,
    caches,
    files,
    getMarkdownFiles,
    manager,
    modify,
    persisted,
    processFrontMatter,
    registerEvent,
    service,
    start: () => service.start(registerEvent),
    ready: () => {
      for (const listener of layoutReady) {
        listener();
      }
    },
    resolved: () => {
      for (const listener of resolved) {
        listener();
      }
    },
    managerChanged: (name: string) => {
      for (const listener of managerChanged) {
        listener(name);
      }
    },
  };
};

describe("native task temporal property types", () => {
  const services: TaskPropertyTypes[] = [];
  const setup = () => {
    const harness = makeHarness();
    services.push(harness.service);
    return harness;
  };
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.dispose();
    }
    vi.restoreAllMocks();
  });

  it("repairs existing text types after layout readiness without rewriting timestamps or notes", async () => {
    const h = setup();
    const frontmatter = Object.freeze({
      "task id": "task-1",
      "created at": "2026-09-17T07:50:59.985444Z",
      "updated at": "2026-09-17T07:51:09.868364Z",
      "completed at": "2026-09-17T07:51:09.039900Z",
      "due date": "2026-10-25",
      "due datetime": "2026-10-25T09:30:00+08:00",
      deadline: "2026-10-30",
      "due timezone": "Asia/Shanghai",
      duration: 30,
      "custom date": "User-owned text",
    });
    const original = JSON.stringify(frontmatter);
    const file = h.addFile("Tasks/Existing.task.md", frontmatter);
    for (const name of Object.keys(frontmatter)) {
      h.assigned.set(name, "text");
    }
    h.start();
    h.cacheChanged(file, frontmatter);
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
    h.ready();
    await settle();
    expect(Object.fromEntries(h.persisted)).toEqual({
      "created at": "datetime",
      "updated at": "datetime",
      "completed at": "datetime",
      "due date": "date",
      "due datetime": "datetime",
      deadline: "date",
    });
    expect(JSON.stringify(frontmatter)).toBe(original);
    expect(h.modify).not.toHaveBeenCalled();
    expect(h.processFrontMatter).not.toHaveBeenCalled();
    expect(h.assigned.get("due timezone")).toBe("text");
    expect(h.assigned.get("custom date")).toBe("text");
  });

  it("covers every current and legacy temporal field, including existing empty values", async () => {
    const h = setup();
    const current: Frontmatter = { "task id": "current" };
    const legacy: Frontmatter = { todoist_task_id: "legacy" };
    for (const name of Object.keys(TASK_TEMPORAL_PROPERTY_TYPES)) {
      (name.startsWith("todoist_") ? legacy : current)[name] = null;
    }
    h.addFile("Tasks/Current.task.md", current);
    h.addFile("Legacy/Task.md", legacy);
    h.start();
    h.ready();
    await settle();
    expect(Object.fromEntries(h.persisted)).toEqual(TASK_TEMPORAL_PROPERTY_TYPES);
  });

  it("ignores ordinary notes, generic task IDs, invalid identities, and conflicting schemas", async () => {
    const h = setup();
    h.addFile("Ordinary.task.md", { "created at": "ordinary text" });
    h.addFile("Ordinary.md", { "task id": "personal", "created at": "ordinary text" });
    h.addFile("Legacy.txt", {
      todoist_task_id: "not-markdown",
      todoist_created_at: "ordinary text",
    });
    h.addFile("Invalid.task.md", { "task id": [], "due date": "2026-10-25" });
    h.addFile("Conflict.task.md", {
      "task id": "task-1",
      todoist_task_id: "different",
      "created at": "2026-10-25T09:30:00Z",
    });
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
  });

  it("coalesces scans and does not repeatedly write correct types", async () => {
    const h = setup();
    const properties = { "task id": "task-1", "created at": "2026-10-25T09:30:00Z" };
    const file = h.addFile("Task.task.md", properties);
    h.start();
    h.start();
    h.ready();
    h.resolved();
    h.resolved();
    await settle();
    expect(h.getMarkdownFiles).toHaveBeenCalledOnce();
    expect(h.manager.setType).toHaveBeenCalledOnce();
    expect(h.registerEvent).toHaveBeenCalledTimes(3);
    h.cacheChanged(file, properties);
    h.cacheChanged(file, properties);
    h.resolved();
    h.resolved();
    await settle();
    expect(h.getMarkdownFiles).toHaveBeenCalledTimes(2);
    expect(h.manager.setType).toHaveBeenCalledOnce();
  });

  it("handles metadata arriving after the initial scan without another edit", async () => {
    const h = setup();
    const file = h.addFile("Late.task.md");
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
    h.cacheChanged(file, { "task id": "late", "completed at": "2026-10-25T09:30:00Z" });
    await settle();
    expect(h.persisted.get("completed at")).toBe("datetime");
    h.caches.set(file.path, {
      frontmatter: { "task id": "late", "due date": "2026-10-25" },
    } as CachedMetadata);
    h.resolved();
    await settle();
    expect(h.persisted.get("due date")).toBe("date");
  });

  it("retains work when the native manager is unavailable or still loading", async () => {
    const h = setup();
    h.addFile("Task.task.md", { "task id": "task-1", "created at": "2026-10-25T09:30:00Z" });
    h.app.metadataTypeManager = undefined;
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
    h.manager._loaded = false;
    h.app.metadataTypeManager = h.manager;
    h.resolved();
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
    h.manager._loaded = true;
    h.resolved();
    await settle();
    expect(h.persisted.get("created at")).toBe("datetime");
  });

  it("serializes writes and handles metadata arriving during an in-flight save", async () => {
    const h = setup();
    const file = h.addFile("Task.task.md", {
      "task id": "task-1",
      "created at": "2026-10-25T09:30:00Z",
      "updated at": "2026-10-25T10:30:00Z",
    });
    let release: (() => void) | undefined;
    h.manager.setType.mockImplementationOnce(
      async (name, type) =>
        await new Promise<void>((resolve) => {
          release = () => {
            h.assigned.set(name, type);
            h.persisted.set(name, type);
            resolve();
          };
        }),
    );
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(1);
    h.cacheChanged(file, { "task id": "task-1", "due date": "2026-10-25" });
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(1);
    release?.();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(3);
    expect(h.persisted.get("due date")).toBe("date");
  });

  it("retries failed persistence even if the native setter changed memory, without spinning", async () => {
    const h = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.addFile("Task.task.md", {
      "task id": "task-1",
      "created at": "2026-10-25T09:30:00Z",
      "updated at": "2026-10-25T10:30:00Z",
    });
    h.manager.setType.mockImplementation(async (name, type) => {
      h.assigned.set(name, type);
      throw new Error("Disk unavailable");
    });
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(2);
    h.manager.setType.mockImplementation(async (name, type) => {
      h.assigned.set(name, type);
      h.persisted.set(name, type);
    });
    h.resolved();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(4);
    expect(h.persisted.size).toBe(2);
  });

  it("repairs synced type changes only for discovered names and ignores its own events", async () => {
    const h = setup();
    h.addFile("Task.task.md", { "task id": "task-1", "created at": "2026-10-25T09:30:00Z" });
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledOnce();
    h.assigned.set("created at", "text");
    h.managerChanged("Created At");
    h.managerChanged("unrelated");
    h.managerChanged("deadline");
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(2);
    expect(h.assigned.get("created at")).toBe("datetime");
  });

  it("does not start queued work after disposal", async () => {
    const h = setup();
    h.addFile("Task.task.md", { "task id": "task-1", "created at": "2026-10-25T09:30:00Z" });
    h.start();
    h.ready();
    h.service.dispose();
    await settle();
    h.resolved();
    h.ready();
    await settle();
    expect(h.manager.setType).not.toHaveBeenCalled();
  });

  it("allows an in-flight save to finish but prevents remaining writes after disposal", async () => {
    const h = setup();
    h.addFile("Task.task.md", {
      "task id": "task-1",
      "created at": "2026-10-25T09:30:00Z",
      "updated at": "2026-10-25T10:30:00Z",
    });
    let release: (() => void) | undefined;
    h.manager.setType.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.start();
    h.ready();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(1);
    h.service.dispose();
    release?.();
    await settle();
    expect(h.manager.setType).toHaveBeenCalledTimes(1);
  });
});
