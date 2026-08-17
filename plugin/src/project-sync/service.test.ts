import { describe, expect, it, vi } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import { ProjectFolderSyncService } from "./service";
import type {
  ProjectCompletionEvent,
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
  deleted: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  pausedMappingIds: [],
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
  validateSnapshot: vi.fn(() => undefined),
  reconcile: vi.fn(async () => successResult()),
  ...overrides,
});

const projectTaskPage = (overrides: Partial<ProjectTaskPage> = {}): ProjectTaskPage => ({
  activeTasks: [],
  completedTasks: [],
  completionEvents: [],
  ...overrides,
});

const completionEvent = (
  id: string,
  taskId: string,
  projectId: string,
  completedAt: string,
): ProjectCompletionEvent => ({ id, taskId, projectId, completedAt });

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
        return projectTaskPage();
      }),
    };
    const vault = makeVault({
      validateConfig: vi.fn(() => events.push("validate")),
      validateSnapshot: vi.fn((_snapshot, currentMapping) => {
        events.push(`snapshot:${currentMapping.folder}`);
      }),
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
      "snapshot:Todoist/root",
      "snapshot:Todoist/other",
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
            deleted: 2,
            unchanged: 1,
            conflicts: [{ message: "first" }],
            settledMappingIds: ["mapping-first"],
          }),
        )
        .mockResolvedValueOnce(
          successResult({
            updated: 3,
            moved: 1,
            deleted: 1,
            deferred: 1,
            conflicts: [{ message: "second" }],
            settledMappingIds: ["mapping-second"],
          }),
        ),
    });
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async () => projectTaskPage(),
      },
      vault,
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).resolves.toEqual(
      successResult({
        created: 2,
        updated: 3,
        moved: 1,
        deleted: 3,
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
        fetchProjectTasks: async () =>
          projectTaskPage({ activeTasks: [active], completedTasks: [completed] }),
      },
      makeVault({ reconcile }),
      config(),
    );

    await service.sync();

    const snapshot = reconcile.mock.calls[0][0];
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ completed: false, task: { content: "Active" } });
  });

  it("publishes complete direct statistics including zero-task descendants", async () => {
    const root = makeProject("root", { name: "Root", childOrder: 1 });
    const child = makeProject("child", {
      name: "Child",
      parentId: root.id,
      childOrder: 2,
    });
    const grandchild = makeProject("grandchild", {
      name: "Grandchild",
      parentId: child.id,
      childOrder: 3,
    });
    const pages = new Map<string, ProjectTaskPage>([
      [
        root.id,
        projectTaskPage({
          activeTasks: [
            makeTask("root-active-1", { project: root }),
            makeTask("root-active-2", { project: root }),
          ],
          completedTasks: [makeTask("root-completed", { project: root })],
          completionEvents: [
            completionEvent(
              "root-completion",
              "root-completed",
              root.id,
              "2026-08-08T08:00:00.000Z",
            ),
          ],
        }),
      ],
      [child.id, projectTaskPage()],
      [
        grandchild.id,
        projectTaskPage({
          activeTasks: [makeTask("grandchild-active", { project: grandchild })],
          completedTasks: [
            makeTask("grandchild-completed-1", { project: grandchild }),
            makeTask("grandchild-completed-2", { project: grandchild }),
          ],
          completionEvents: [
            completionEvent(
              "grandchild-completion-1",
              "grandchild-completed-1",
              grandchild.id,
              "2026-08-09T08:00:00.000Z",
            ),
            completionEvent(
              "grandchild-completion-2",
              "grandchild-completed-2",
              grandchild.id,
              "2026-08-10T08:00:00.000Z",
            ),
            completionEvent(
              "grandchild-completion-2",
              "grandchild-completed-2",
              grandchild.id,
              "2026-08-10T08:00:00.000Z",
            ),
          ],
        }),
      ],
    ]);
    const reconcile = vi.fn<ProjectSyncVault["reconcile"]>(async () => successResult());
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root, child, grandchild],
        fetchProjectTasks: async (projectId) => {
          const page = pages.get(projectId);
          if (page === undefined) {
            throw new Error(`Unexpected project '${projectId}'`);
          }
          return page;
        },
      },
      makeVault({ reconcile }),
      config(mapping(root.id)),
    );

    await service.sync();

    const syncedAt = reconcile.mock.calls[0]?.[0].syncedAt;
    expect(service.getStatisticsSnapshot()).toEqual({
      syncedAt,
      scopes: [
        {
          mappingId: "mapping-root",
          rootProjectId: root.id,
          includeSubprojects: true,
          projects: [
            {
              id: root.id,
              parentId: null,
              name: "Root",
              childOrder: 1,
              directCounts: { active: 2, completed: 1 },
              directCompletionEvents: [
                completionEvent(
                  "root-completion",
                  "root-completed",
                  root.id,
                  "2026-08-08T08:00:00.000Z",
                ),
              ],
            },
            {
              id: child.id,
              parentId: root.id,
              name: "Child",
              childOrder: 2,
              directCounts: { active: 0, completed: 0 },
              directCompletionEvents: [],
            },
            {
              id: grandchild.id,
              parentId: child.id,
              name: "Grandchild",
              childOrder: 3,
              directCounts: { active: 1, completed: 2 },
              directCompletionEvents: [
                completionEvent(
                  "grandchild-completion-1",
                  "grandchild-completed-1",
                  grandchild.id,
                  "2026-08-09T08:00:00.000Z",
                ),
                completionEvent(
                  "grandchild-completion-2",
                  "grandchild-completed-2",
                  grandchild.id,
                  "2026-08-10T08:00:00.000Z",
                ),
              ],
            },
          ],
          tasks: [
            { id: "grandchild-active", projectId: grandchild.id, order: 0 },
            { id: "grandchild-completed-1", projectId: grandchild.id, order: 0 },
            { id: "grandchild-completed-2", projectId: grandchild.id, order: 0 },
            { id: "root-active-1", projectId: root.id, order: 0 },
            { id: "root-active-2", projectId: root.id, order: 0 },
            { id: "root-completed", projectId: root.id, order: 0 },
          ],
        },
      ],
    });
  });

  it("rejects a completion event returned for a different project before Vault mutation", async () => {
    const root = makeProject("root");
    const child = makeProject("child", { parentId: root.id });
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root, child],
        fetchProjectTasks: async (projectId) =>
          projectTaskPage({
            completionEvents:
              projectId === root.id
                ? [completionEvent("wrong-project", "task-1", child.id, "2026-08-10T08:00:00.000Z")]
                : [],
          }),
      },
      vault,
      config(mapping(root.id)),
    );

    await expect(service.sync()).rejects.toThrow(
      "returned project 'child' while scanning project 'root'",
    );
    expect(vault.reconcile).not.toHaveBeenCalled();
    expect(service.getStatisticsSnapshot()).toBeNull();
  });

  it("publishes one complete statistics scope for each mapping", async () => {
    const first = makeProject("first", { name: "First" });
    const firstChild = makeProject("first-child", { parentId: first.id, name: "First child" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping = mapping(first.id);
    const secondMapping = mapping(second.id, { includeSubprojects: false });
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, firstChild, second],
        fetchProjectTasks: async (projectId) =>
          projectTaskPage({
            activeTasks:
              projectId === second.id ? [makeTask("second-active", { project: second })] : [],
          }),
      },
      makeVault(),
      config(firstMapping, secondMapping),
    );

    await service.sync();

    expect(service.getStatisticsSnapshot()?.scopes).toEqual([
      expect.objectContaining({
        mappingId: firstMapping.id,
        rootProjectId: first.id,
        includeSubprojects: true,
        projects: [
          expect.objectContaining({ id: first.id }),
          expect.objectContaining({ id: firstChild.id }),
        ],
      }),
      expect.objectContaining({
        mappingId: secondMapping.id,
        rootProjectId: second.id,
        includeSubprojects: false,
        projects: [
          expect.objectContaining({
            id: second.id,
            directCounts: { active: 1, completed: 0 },
          }),
        ],
      }),
    ]);
  });

  it("keeps last-good statistics across ordinary invalidation and a failed refresh", async () => {
    const root = makeProject("root");
    let shouldFail = false;
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root],
        fetchProjectTasks: async () => {
          if (shouldFail) {
            throw new Error("network failed");
          }
          return projectTaskPage({ activeTasks: [makeTask("active", { project: root })] });
        },
      },
      makeVault(),
      config(),
    );
    await service.sync();
    const lastGood = service.getStatisticsSnapshot();

    service.invalidate();
    expect(service.getStatisticsSnapshot()).toBe(lastGood);

    shouldFail = true;
    await expect(service.sync()).rejects.toThrow("network failed");
    expect(service.getStatisticsSnapshot()).toBe(lastGood);
  });

  it("preserves statistics for projection-only config changes and clears them at scope boundaries", async () => {
    const root = makeProject("root");
    const originalConfig = config();
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [root],
        fetchProjectTasks: async () => projectTaskPage(),
      },
      makeVault(),
      originalConfig,
    );
    const observed: Array<{ state: string; hasSnapshot: boolean }> = [];
    service.subscribe((status) => {
      observed.push({
        state: status.state,
        hasSnapshot: service.getStatisticsSnapshot() !== null,
      });
    });

    await service.sync();
    const firstSnapshot = service.getStatisticsSnapshot();
    expect(firstSnapshot).not.toBeNull();

    service.setConfig(config());
    expect(service.getStatisticsSnapshot()).toBe(firstSnapshot);

    service.clearStatisticsSnapshot();
    expect(service.getStatisticsSnapshot()).toBeNull();
    expect(observed[observed.length - 1]).toEqual({ state: "success", hasSnapshot: false });

    await service.sync();
    const migratedSnapshot = service.getStatisticsSnapshot();
    expect(migratedSnapshot).not.toBeNull();
    service.setConfig(
      config(
        mapping(root.id, {
          folder: "Todoist/new-root",
          previousFolders: ["Todoist/root"],
        }),
      ),
    );
    expect(service.getStatisticsSnapshot()).toBe(migratedSnapshot);
    expect(observed[observed.length - 1]).toEqual({ state: "idle", hasSnapshot: true });

    service.setConfig(config(mapping(root.id, { includeSubprojects: false })));
    expect(service.getStatisticsSnapshot()).toBeNull();
    expect(observed[observed.length - 1]).toEqual({ state: "idle", hasSnapshot: false });

    service.setConfig(originalConfig);
    await service.sync();
    expect(service.getStatisticsSnapshot()).not.toBeNull();
    service.dispose();
    expect(service.getStatisticsSnapshot()).toBeNull();
    expect(observed[observed.length - 1]).toEqual({ state: "disposed", hasSnapshot: false });
  });

  it("does not publish statistics until every mapping reconciles successfully", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const reconcile = vi
      .fn<ProjectSyncVault["reconcile"]>()
      .mockResolvedValueOnce(successResult())
      .mockRejectedValueOnce(new Error("second reconcile failed"));
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async () => projectTaskPage(),
      },
      makeVault({ reconcile }),
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).rejects.toThrow("second reconcile failed");

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(service.getStatisticsSnapshot()).toBeNull();
  });

  it("rejects invalid Vault mappings before making a Todoist task request", async () => {
    const root = makeProject("root");
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
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

  it("skips only mappings whose selected project is unavailable in the current account", async () => {
    const available = makeProject("available", { name: "Available" });
    const unavailable = mapping("old-account", {
      folder: "Todoist/Old account",
      project: { projectId: "old-account", projectName: "Old account" },
    });
    const active = mapping(available.id);
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [available], fetchProjectTasks },
      vault,
      config(unavailable, active),
    );

    const result = await service.sync();

    expect(fetchProjectTasks).toHaveBeenCalledOnce();
    expect(fetchProjectTasks).toHaveBeenCalledWith(available.id);
    expect(vault.validateConfig).toHaveBeenCalledWith({ enabled: true, mappings: [active] });
    expect(vault.reconcile).toHaveBeenCalledOnce();
    expect(result?.pausedMappingIds).toEqual([unavailable.id]);
    expect(result?.conflicts).toEqual([]);
  });

  it("keeps all unavailable mappings configured while performing no Vault access", async () => {
    const unavailable = mapping("old-account", {
      folder: "Todoist/Old account",
      project: { projectId: "old-account", projectName: "Old account" },
    });
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [], fetchProjectTasks },
      vault,
      config(unavailable),
    );

    const result = await service.sync();

    expect(fetchProjectTasks).not.toHaveBeenCalled();
    expect(vault.validateConfig).not.toHaveBeenCalled();
    expect(vault.reconcile).not.toHaveBeenCalled();
    expect(result?.pausedMappingIds).toEqual([unavailable.id]);
    expect(result?.conflicts).toEqual([]);
    expect(service.getConfig().mappings).toEqual([unavailable]);
  });

  it.each([
    ["empty", ""],
    ["unsafe", "../Old account"],
  ])("ignores an %s root on a paused mapping while synchronizing an active mapping", async (_label, folder) => {
    const available = makeProject("available", { name: "Available" });
    const unavailable = mapping("old-account", {
      folder,
      project: { projectId: "old-account", projectName: "Old account" },
    });
    const active = mapping(available.id);
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [available], fetchProjectTasks },
      vault,
      config(unavailable, active),
    );

    await expect(service.sync()).resolves.toMatchObject({ pausedMappingIds: [unavailable.id] });
    expect(fetchProjectTasks).toHaveBeenCalledOnce();
    expect(vault.validateConfig).toHaveBeenCalledWith({ enabled: true, mappings: [active] });
    expect(vault.reconcile).toHaveBeenCalledOnce();
  });

  it("rejects an active root nested inside a paused mapping root before fetching or mutating", async () => {
    const available = makeProject("available", { name: "Available" });
    const paused = mapping("old-account", {
      folder: "Todoist/Work",
      project: { projectId: "old-account", projectName: "Old account" },
    });
    const active = mapping(available.id, { folder: "Todoist/Work/New" });
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [available], fetchProjectTasks },
      vault,
      config(paused, active),
    );

    await expect(service.sync()).rejects.toThrow("overlap");

    expect(fetchProjectTasks).not.toHaveBeenCalled();
    expect(vault.validateConfig).not.toHaveBeenCalled();
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
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
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
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
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
          return projectTaskPage();
        },
      },
      vault,
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).rejects.toThrow("network failed");
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("preflights every fetched mapping before mutating the first mapping", async () => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const validateSnapshot = vi.fn<ProjectSyncVault["validateSnapshot"]>(
      (_snapshot, currentMapping) => {
        if (currentMapping.project?.projectId === second.id) {
          throw new Error("Todoist cannot be mirrored without renaming");
        }
      },
    );
    const vault = makeVault({ validateSnapshot });
    const service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async (projectId) =>
          projectTaskPage({
            activeTasks: [
              makeTask(`task-${projectId}`, {
                content: "Same title",
                project: projectId === first.id ? first : second,
              }),
            ],
          }),
      },
      vault,
      config(
        mapping(first.id, { includeSubprojects: false }),
        mapping(second.id, { includeSubprojects: false }),
      ),
    );

    await expect(service.sync()).rejects.toThrow("cannot be mirrored without renaming");

    expect(validateSnapshot).toHaveBeenCalledTimes(2);
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("rejects a task returned by two mappings before mutating either folder", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const fetchProjectTasks = vi.fn(
      async (projectId: string): Promise<ProjectTaskPage> =>
        projectTaskPage({
          activeTasks: [
            makeTask("shared-task", {
              project: projectId === first.id ? first : second,
            }),
          ],
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
      return projectTaskPage();
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
          return projectTaskPage();
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

  it("finishes the complete Vault commit when external activity arrives between mappings", async () => {
    const first = makeProject("first");
    const second = makeProject("second");
    let service: ProjectFolderSyncService;
    const reconcile = vi.fn<ProjectSyncVault["reconcile"]>(
      async (_snapshot, currentMapping, runContext) => {
        if (currentMapping.project?.projectId === first.id) {
          service.invalidate();
          // The same generation remains valid until every mapping in this preflighted batch has
          // committed. Before the fix this assertion aborted the run after the first mapping.
          runContext.assertValid();
        }
        return successResult({ updated: 1 });
      },
    );
    service = new ProjectFolderSyncService(
      {
        listProjects: () => [first, second],
        fetchProjectTasks: async () => projectTaskPage(),
      },
      makeVault({ reconcile }),
      config(mapping(first.id), mapping(second.id)),
    );

    await expect(service.sync()).resolves.toMatchObject({ updated: 2 });

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toEqual({ state: "idle" });
  });

  it("does not restart a queued generation after it is invalidated while waiting", async () => {
    const root = makeProject("root");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchProjectTasks = vi.fn(async () => {
      await gate;
      return projectTaskPage();
    });
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    const first = service.sync();
    service.invalidate();
    const queued = service.sync();
    service.invalidate();
    release?.();

    await expect(first).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    expect(fetchProjectTasks).toHaveBeenCalledTimes(1);
    expect(vault.reconcile).not.toHaveBeenCalled();
  });

  it("restarts a queued generation when no newer invalidation supersedes it", async () => {
    const root = makeProject("root");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchProjectTasks = vi
      .fn<() => Promise<ProjectTaskPage>>()
      .mockImplementationOnce(async () => {
        await gate;
        return projectTaskPage();
      })
      .mockResolvedValue(projectTaskPage());
    const vault = makeVault();
    const service = new ProjectFolderSyncService(
      { listProjects: () => [root], fetchProjectTasks },
      vault,
      config(),
    );

    const first = service.sync();
    service.invalidate();
    const queued = service.sync();
    release?.();

    await expect(first).resolves.toBeNull();
    await expect(queued).resolves.toMatchObject({ conflicts: [] });
    expect(fetchProjectTasks).toHaveBeenCalledTimes(2);
    expect(vault.reconcile).toHaveBeenCalledOnce();
  });

  it("does not start synchronization after disposal", async () => {
    const root = makeProject("root");
    const fetchProjectTasks = vi.fn(async () => projectTaskPage());
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
      return projectTaskPage();
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
