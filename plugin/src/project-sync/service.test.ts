import { describe, expect, it, vi } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import { ProjectFolderSyncService } from "./service";
import type {
  ProjectSyncConfig,
  ProjectSyncMapping,
  ProjectSyncResult,
  ProjectSyncSource,
  ProjectSyncVault,
  ProjectTaskPage,
} from "./types";

const successResult = (overrides: Partial<ProjectSyncResult> = {}): ProjectSyncResult => ({
  created: 0,
  updated: 0,
  moved: 0,
  unchanged: 0,
  stale: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  settledMappingIds: [],
  ...overrides,
});

const mapping = (
  projectId = "root",
  overrides: Partial<ProjectSyncMapping> = {},
): ProjectSyncMapping => ({
  id: `mapping-${projectId}`,
  folder: `Todoist/${projectId}`,
  project: { projectId, projectName: projectId },
  includeSubprojects: true,
  previousFolders: [],
  ...overrides,
});

const config = (...mappings: ProjectSyncMapping[]): ProjectSyncConfig => ({
  enabled: true,
  mappings: mappings.length === 0 ? [mapping()] : mappings,
});

const makeVault = (overrides: Partial<ProjectSyncVault> = {}): ProjectSyncVault => ({
  validateConfig: vi.fn(() => undefined),
  reconcile: vi.fn(async () => successResult()),
  ...overrides,
});

describe("ProjectFolderSyncService", () => {
  it("validates first, scans every mapping sequentially, and mutates only after all fetches", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const other = makeProject("other", { name: "Other" });
    const events: string[] = [];
    const source: ProjectSyncSource = {
      listProjects: () => [root, child, other],
      fetchProjectTasks: vi.fn(async (projectId): Promise<ProjectTaskPage> => {
        events.push(`${projectId}:start`);
        await Promise.resolve();
        events.push(`${projectId}:end`);
        return { activeTasks: [], completedTasks: [] };
      }),
    };
    const vault = makeVault({
      validateConfig: vi.fn(() => events.push("validate")),
      reconcile: vi.fn(async (_snapshot, currentMapping) => {
        events.push(`reconcile:${currentMapping.folder}`);
        return successResult();
      }),
    });
    const mappings = [mapping(root.id), mapping(other.id, { includeSubprojects: false })];

    await new ProjectFolderSyncService(source, vault, config(...mappings)).sync();

    expect(events).toEqual([
      "validate",
      "root:start",
      "root:end",
      "child:start",
      "child:end",
      "other:start",
      "other:end",
      "validate",
      "reconcile:Todoist/root",
      "reconcile:Todoist/other",
    ]);
    expect(vault.reconcile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rootProjectId: root.id, projects: [root, child] }),
      mappings[0],
      expect.objectContaining({ assertValid: expect.any(Function) }),
    );
    expect(vault.reconcile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rootProjectId: other.id, projects: [other] }),
      mappings[1],
      expect.objectContaining({ assertValid: expect.any(Function) }),
    );
    expect(vi.mocked(vault.reconcile).mock.calls[0][2].scanToken).toBe(
      vi.mocked(vault.reconcile).mock.calls[1][2].scanToken,
    );
  });

  it("aggregates every mapping result into one synchronization result", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const vault = makeVault({
      reconcile: vi
        .fn<ProjectSyncVault["reconcile"]>()
        .mockResolvedValueOnce(
          successResult({
            created: 2,
            unchanged: 1,
            conflicts: [{ message: "first" }],
            settledMappingIds: ["mapping-first"],
          }),
        )
        .mockResolvedValueOnce(
          successResult({
            updated: 3,
            moved: 1,
            deferred: 1,
            conflicts: [{ message: "second" }],
            settledMappingIds: ["mapping-second"],
          }),
        ),
    });
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async () => ({ activeTasks: [], completedTasks: [] }),
      },
      vault,
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).resolves.toEqual(
      successResult({
        created: 2,
        updated: 3,
        moved: 1,
        unchanged: 1,
        deferred: 1,
        conflicts: [{ message: "first" }, { message: "second" }],
        settledMappingIds: ["mapping-first", "mapping-second"],
      }),
    );
  });

  it("deduplicates task IDs with active tasks winning", async () => {
    const root = makeProject("root", { name: "Root" });
    const active = makeTask("same", { content: "Active", project: root });
    const completed = makeTask("same", {
      content: "Completed",
      completedAt: "2026-08-09T00:00:00.000Z",
      project: root,
    });
    const reconcile = vi.fn<ProjectSyncVault["reconcile"]>(async () => successResult());
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root],
        fetchProjectTasks: async () => ({ activeTasks: [active], completedTasks: [completed] }),
      },
      makeVault({ reconcile }),
      config(),
    );

    await service.sync();

    const snapshot = reconcile.mock.calls[0][0];
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ completed: false, task: { content: "Active" } });
  });

  it("rejects invalid Vault mappings before making a Todoist task request", async () => {
    const root = makeProject("root");
    const fetchProjectTasks = vi.fn(async () => ({ activeTasks: [], completedTasks: [] }));
    const vault = makeVault({
      validateConfig: vi.fn(() => {
        throw new Error("folder does not exist");
      }),
    });
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    await expect(service.sync()).rejects.toThrow("folder does not exist");
    expect(fetchProjectTasks).not.toHaveBeenCalled();
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("validates mapping contents for the UI even while synchronization is disabled", async () => {
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [], fetchProjectTasks: vi.fn() },
      vault,
      { enabled: false, mappings: [] },
    );

    expect(() => service.validateConfig()).toThrow("at least one project mapping");
    expect(vault.validateConfig).not.toHaveBeenCalled();
    await expect(service.sync()).resolves.toBeNull();
  });

  it("rejects an incomplete mapping before Vault or Todoist access", async () => {
    const fetchProjectTasks = vi.fn(async () => ({ activeTasks: [], completedTasks: [] }));
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [], fetchProjectTasks },
      vault,
      config(mapping("root", { project: null })),
    );

    await expect(service.sync()).rejects.toThrow("mapping 1");
    expect(vault.validateConfig).not.toHaveBeenCalled();
    expect(fetchProjectTasks).not.toHaveBeenCalled();
  });

  it("rejects overlapping Todoist scopes before fetching either mapping", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const fetchProjectTasks = vi.fn(async () => ({ activeTasks: [], completedTasks: [] }));
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root, child], fetchProjectTasks },
      vault,
      config(mapping(root.id), mapping(child.id, { includeSubprojects: false })),
    );

    await expect(service.sync()).rejects.toThrow("included by project sync mappings 1 and 2");
    expect(fetchProjectTasks).not.toHaveBeenCalled();
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile any mapping when a later mapping fetch fails", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async (projectId) => {
          if (projectId === second.id) {
            throw new Error("network failed");
          }
          return { activeTasks: [], completedTasks: [] };
        },
      },
      vault,
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).rejects.toThrow("network failed");
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("rejects a task returned by two mappings before mutating either folder", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const fetchProjectTasks = vi.fn(
      async (projectId: string): Promise<ProjectTaskPage> => ({
        activeTasks: [
          makeTask("shared-task", {
            project: projectId === first.id ? first : second,
          }),
        ],
        completedTasks: [],
      }),
    );
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [first, second], fetchProjectTasks },
      vault,
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).rejects.toThrow("appeared in project sync mappings");
    expect(fetchProjectTasks).toHaveBeenCalledTimes(2);
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("coalesces concurrent sync requests", async () => {
    const root = makeProject("root");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchProjectTasks = vi.fn(async () => {
      await gate;
      return { activeTasks: [], completedTasks: [] };
    });
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    const first = service.sync();
    const second = service.sync();
    release?.();
    await Promise.all([first, second]);

    expect(fetchProjectTasks).toHaveBeenCalledTimes(1);
    expect(vault.reconcile).toHaveBeenCalledTimes(1);
  });

  it("invalidates an in-flight snapshot before Vault reconciliation", async () => {
    const root = makeProject("root");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root],
        fetchProjectTasks: async () => {
          await gate;
          return { activeTasks: [], completedTasks: [] };
        },
      },
      vault,
      config(),
    );

    const sync = service.sync();
    service.invalidate();
    release?.();

    await expect(sync).resolves.toBeNull();
    expect(vault.reconcile).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ state: "idle" });
  });

  it("does not start synchronization after disposal", async () => {
    const root = makeProject("root");
    const fetchProjectTasks = vi.fn(async () => ({ activeTasks: [], completedTasks: [] }));
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    service.dispose();

    await expect(service.sync()).resolves.toBeNull();
    expect(fetchProjectTasks).not.toHaveBeenCalled();
    expect(vault.reconcile).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ state: "disposed" });
  });

  it("disposes an in-flight fetch without reconciling or replacing disposed status", async () => {
    const root = makeProject("root");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchProjectTasks = vi.fn(async () => {
      await gate;
      return { activeTasks: [], completedTasks: [] };
    });
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    const sync = service.sync();
    expect(fetchProjectTasks).toHaveBeenCalledTimes(1);
    service.dispose();
    release?.();

    await expect(sync).resolves.toBeNull();
    expect(vault.reconcile).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ state: "disposed" });
  });
});
