import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TodoistListActions, TodoistListTaskRecord } from "@/bases/todoist-list";
import type { ProjectSyncResult } from "@/project-sync";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";

const runtime = vi.hoisted(() => ({
  addSettingTab: vi.fn(),
  loadData: vi.fn(),
  makeServices: vi.fn(),
  notices: [] as unknown[],
  registerCommands: vi.fn(),
  registerBasesView: vi.fn(),
  registerInterval: vi.fn(),
  registerMarkdownCodeBlockProcessor: vi.fn(),
  saveData: vi.fn(),
  settings: {
    current: {} as Record<string, unknown>,
  },
}));

vi.mock("obsidian", () => ({
  Notice: class {
    constructor(message: unknown) {
      runtime.notices.push(message);
    }
  },
  Plugin: class {
    public readonly app: unknown;
    public readonly manifest: unknown;

    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }

    public addSettingTab(tab: unknown): void {
      runtime.addSettingTab(tab);
    }

    public loadData(): Promise<unknown> {
      return runtime.loadData();
    }

    public registerInterval(id: number): void {
      runtime.registerInterval(id);
    }

    public registerBasesView(id: string, registration: unknown): void {
      runtime.registerBasesView(id, registration);
    }

    public registerMarkdownCodeBlockProcessor(
      language: string,
      processor: (...args: unknown[]) => unknown,
    ): void {
      runtime.registerMarkdownCodeBlockProcessor(language, processor);
    }

    public saveData(data: unknown): Promise<void> {
      return runtime.saveData(data);
    }
  },
}));

vi.mock("@/api", () => ({
  TodoistApiClient: class {
    public readonly token: string;

    constructor(token: string) {
      this.token = token;
    }
  },
}));

vi.mock("@/api/fetcher", () => ({
  ObsidianFetcher: class {},
}));

vi.mock("@/commands", () => ({
  registerCommands: runtime.registerCommands,
}));

vi.mock("@/bases/todoist-list", () => ({
  TASKS_LIST_VIEW_ID: "tasks-list",
  createTasksListViewRegistration: (actions: unknown) => ({
    name: "Tasks List",
    actions,
  }),
}));

vi.mock("@/data/queryCache", () => ({
  QueryCache: class {
    public readonly bindCredential = vi.fn(() => false);
    public readonly completeTaskInAll = vi.fn(() => false);
    public readonly load = vi.fn();
    public readonly removeTaskFromAll = vi.fn(() => false);
    public readonly serialize = vi.fn(() => ({}));
    public readonly set = vi.fn(() => false);
  },
}));

vi.mock("@/i18n", () => ({
  setLanguage: vi.fn(),
  t: () => ({
    editTaskModal: {
      projectionErrorNotice: "Todoist was updated, but its Vault note could not be refreshed.",
    },
    notices: {
      migrationFailed: "Migration failed",
      projectSyncComplete: (
        created: number,
        updated: number,
        moved: number,
        stale: number,
        conflicts: number,
      ) => `Project sync complete: ${created}/${updated}/${moved}/${stale}/${conflicts}`,
      projectSyncDisabled: "Project sync is disabled",
      projectSyncFailed: (message: string) => `Project sync failed: ${message}`,
    },
  }),
}));

vi.mock("@/infra/time", () => ({
  secondsToMillis: (seconds: number) => seconds * 1000,
}));

vi.mock("@/query/injector", () => ({
  QueryInjector: class {
    public onNewBlock(): void {}
  },
}));

vi.mock("@/services", () => ({
  makeServices: runtime.makeServices,
}));

vi.mock("@/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/settings")>();
  return {
    ...actual,
    useSettingsStore: {
      getState: () => runtime.settings.current,
      setState: (
        update:
          | Record<string, unknown>
          | ((old: Record<string, unknown>) => Record<string, unknown>),
        replace = false,
      ) => {
        const next = typeof update === "function" ? update(runtime.settings.current) : update;
        runtime.settings.current = replace ? next : { ...runtime.settings.current, ...next };
      },
    },
  };
});

vi.mock("@/ui/settings", () => ({
  SettingsTab: class {},
}));

import TodoistPlugin from "@/index";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type TestServices = ReturnType<typeof makeServices>;

type LifecycleInternals = {
  loadApiClient(): Promise<void>;
  runScheduledSync(): Promise<void>;
};

const defaultSettings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  autoRefreshInterval: 60,
  autoRefreshToggle: false,
  projectSyncEnabled: false,
  projectSyncMappings: [],
  version: 1,
  ...overrides,
});

const emptyResult = (): ProjectSyncResult => ({
  conflicts: [],
  created: 0,
  deferred: 0,
  moved: 0,
  outOfScope: 0,
  stale: 0,
  unchanged: 0,
  updated: 0,
  settledMappingIds: [],
});

const makeServices = () => ({
  modals: {
    onboarding: vi.fn(),
    taskEdit: vi.fn(),
  },
  projectSync: {
    dispose: vi.fn(),
    getConfig: vi.fn(() => ({
      enabled: false,
      mappings: [],
    })),
    invalidate: vi.fn(),
    setConfig: vi.fn(),
    sync: vi.fn(async (): Promise<ProjectSyncResult | null> => null),
  },
  projectTasks: {
    completeTask: vi.fn(async () => undefined),
    isReady: vi.fn(() => true),
    loadEditableTask: vi.fn(),
    reopenTask: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
  },
  todoist: {
    initialize: vi.fn<(client: unknown) => Promise<void>>(async () => undefined),
    isReady: vi.fn(() => true),
    reset: vi.fn(),
    sync: vi.fn<() => Promise<boolean>>(async () => true),
    syncMetadata: vi.fn<() => Promise<boolean>>(async () => true),
  },
  token: {
    migrateStorage: vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined),
    read: vi.fn(async (): Promise<string | null> => null),
    write: vi.fn<(token: string) => Promise<void>>(async () => undefined),
  },
});

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const makePlugin = (services: TestServices, onLayoutReady = vi.fn()) => {
  runtime.makeServices.mockReturnValue(services);
  const app = {
    workspace: {
      onLayoutReady,
    },
  } as unknown as App;
  const manifest = {} as PluginManifest;
  return new TodoistPlugin(app, manifest);
};

const internals = (plugin: TodoistPlugin): LifecycleInternals =>
  plugin as unknown as LifecycleInternals;

describe("TodoistPlugin async lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.notices.length = 0;
    runtime.settings.current = defaultSettings();
    runtime.loadData.mockResolvedValue(defaultSettings());
    runtime.saveData.mockResolvedValue(undefined);
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([0xab]).buffer),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the Tasks List Bases view", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(runtime.registerBasesView).toHaveBeenCalledWith(
      "tasks-list",
      expect.objectContaining({ name: "Tasks List" }),
    );
  });

  it("wires Tasks List actions through the managed-note command service and editor", async () => {
    const services = makeServices();
    const currentTask = { id: "task-42", content: "Current task" };
    services.projectTasks.loadEditableTask.mockResolvedValue(currentTask);
    const plugin = makePlugin(services);
    await plugin.onload();
    const registration = runtime.registerBasesView.mock.calls[0]?.[1] as {
      actions: TodoistListActions;
    };
    const task = {
      id: "task-42",
      filePath: "Todoist/Work/Task.md",
      projectPath: ["Work", "Launch"],
      sectionName: "This week",
    } as TodoistListTaskRecord;

    await registration.actions.completeTask(task);
    expect(services.projectTasks.completeTask).toHaveBeenCalledWith({
      id: task.id,
      filePath: task.filePath,
    });

    await registration.actions.editTask(task);
    expect(services.projectTasks.loadEditableTask).toHaveBeenCalledWith({
      id: task.id,
      filePath: task.filePath,
    });
    expect(services.modals.taskEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        task: currentTask,
        projectPath: "Work / Launch",
        sectionName: "This week",
      }),
    );

    const editProps = services.modals.taskEdit.mock.calls[0]?.[0] as {
      onSubmit(params: { content: string }): Promise<void>;
    };
    await editProps.onSubmit({ content: "Updated" });
    expect(services.projectTasks.updateTask).toHaveBeenCalledWith(
      { id: task.id, filePath: task.filePath },
      { content: "Updated" },
    );
  });

  it.each([
    ["complete", "completeTask"],
    ["reopen", "reopenTask"],
  ] as const)("keeps a Tasks List %s projection failure observable after showing its notice", async (_name, actionName) => {
    const services = makeServices();
    const projectionCause = new Error("Vault projection failed");
    const projectionError = new ProjectTaskProjectionError(projectionCause);
    services.projectTasks[actionName].mockRejectedValueOnce(projectionError);
    const plugin = makePlugin(services);
    await plugin.onload();
    const registration = runtime.registerBasesView.mock.calls[0]?.[1] as {
      actions: TodoistListActions;
    };
    const task = {
      id: "task-42",
      filePath: "Todoist/Work/Task.md",
    } as TodoistListTaskRecord;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(registration.actions[actionName](task)).rejects.toBe(projectionError);
      expect(runtime.notices).toContain(
        "Todoist was updated, but its Vault note could not be refreshed.",
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Project sync failed"),
        projectionCause,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("normalizes a legacy single mapping and drops obsolete stored keys", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      projectSyncEnabled: true,
      projectSyncFolder: "Todoist Projects",
      projectSyncIncludeSubprojects: true,
      projectSyncProject: { projectId: "root", projectName: "Root/Project" },
      removedLegacyOption: "do not persist",
      version: 1,
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(runtime.settings.current).toMatchObject({
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          folder: "Todoist Projects/Root-Project",
          includeSubprojects: true,
          project: { projectId: "root", projectName: "Root/Project" },
        },
      ],
    });
    expect(runtime.settings.current).not.toHaveProperty("projectSyncFolder");
    expect(runtime.settings.current).not.toHaveProperty("projectSyncProject");
    expect(runtime.settings.current).not.toHaveProperty("projectSyncIncludeSubprojects");
    expect(runtime.settings.current).not.toHaveProperty("removedLegacyOption");
    expect(services.projectSync.setConfig).toHaveBeenCalledWith({
      enabled: true,
      mappings: [
        expect.objectContaining({
          id: expect.any(String),
          folder: "Todoist Projects/Root-Project",
          includeSubprojects: true,
          previousFolders: [],
          project: { projectId: "root", projectName: "Root/Project" },
        }),
      ],
    });
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty("projectSyncFolder");
    expect(lastSave).not.toHaveProperty("removedLegacyOption");
  });

  it("disables an incomplete legacy mapping until the user remaps it", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      projectSyncEnabled: true,
      projectSyncFolder: "Todoist Projects",
      projectSyncIncludeSubprojects: false,
      projectSyncProject: null,
      version: 1,
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(runtime.settings.current).toMatchObject({
      projectSyncEnabled: false,
      projectSyncMappings: [
        {
          folder: "Todoist Projects",
          includeSubprojects: false,
          project: null,
        },
      ],
    });
  });

  it("serializes token writes and initializes only the newest token", async () => {
    const services = makeServices();
    const firstWrite = deferred<void>();
    services.token.write
      .mockImplementationOnce(async () => await firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const plugin = makePlugin(services);

    const firstUpdate = plugin.updateApiToken("first-token");
    await vi.waitFor(() => expect(services.token.write).toHaveBeenCalledWith("first-token"));

    const secondUpdate = plugin.updateApiToken("second-token");
    firstWrite.resolve(undefined);
    await Promise.all([firstUpdate, secondUpdate]);

    expect(services.token.write.mock.calls).toEqual([["first-token"], ["second-token"]]);
    expect(services.todoist.initialize).toHaveBeenCalledTimes(1);
    expect(services.todoist.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ token: "second-token" }),
    );
  });

  it("does not start Project sync when the plugin unloads during client initialization", async () => {
    const services = makeServices();
    const initialization = deferred<void>();
    services.todoist.initialize.mockImplementationOnce(async () => await initialization.promise);
    const plugin = makePlugin(services);

    const update = plugin.updateApiToken("token");
    await vi.waitFor(() => expect(services.todoist.initialize).toHaveBeenCalledTimes(1));
    plugin.onunload();
    initialization.resolve(undefined);
    await update;

    expect(services.projectSync.sync).not.toHaveBeenCalled();
    expect(services.todoist.reset).toHaveBeenCalled();
    expect(services.projectSync.dispose).toHaveBeenCalled();
  });

  it("logs the full task identity and path for manual conflicts", async () => {
    const services = makeServices();
    const result = emptyResult();
    result.conflicts.push({
      message: "The managed note changed locally",
      path: "Todoist/Project/Task.md",
      taskId: "task-42",
    });
    services.projectSync.sync.mockResolvedValueOnce(result);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await expect(plugin.syncProjectFolderNow()).resolves.toBe(result);

    expect(warning).toHaveBeenCalledWith(
      "Manual Todoist project sync completed with conflicts:",
      result.conflicts,
    );
    expect(JSON.stringify(warning.mock.calls)).toContain("task-42");
    expect(JSON.stringify(warning.mock.calls)).toContain("Todoist/Project/Task.md");
  });

  it("compacts previous projection roots only after the Vault reports migration complete", async () => {
    const services = makeServices();
    const stored = {
      ...defaultSettings(),
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          id: "mapping-work",
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/New Work",
          includeSubprojects: true,
          previousFolders: ["Todoist/Old Work"],
        },
      ],
      version: 3,
    };
    runtime.loadData.mockResolvedValueOnce(stored);
    const result = emptyResult();
    result.settledMappingIds = ["mapping-work"];
    services.projectSync.sync.mockResolvedValueOnce(result);
    const plugin = makePlugin(services);
    await plugin.loadOptions();

    await expect(plugin.syncProjectFolderNow()).resolves.toBe(result);

    expect(runtime.settings.current.projectSyncMappings).toEqual([
      expect.objectContaining({
        id: "mapping-work",
        folder: "Todoist/New Work",
        previousFolders: [],
      }),
    ]);
  });

  it("reports startup conflicts in both the console and a notice", async () => {
    const services = makeServices();
    const result = emptyResult();
    result.conflicts.push({ message: "Conflict", taskId: "startup-task" });
    services.projectSync.sync.mockResolvedValueOnce(result);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await plugin.updateApiToken("token");

    expect(warning).toHaveBeenCalledWith(
      "Startup Todoist project sync completed with conflicts:",
      result.conflicts,
    );
    expect(runtime.notices).toEqual(["Project sync complete: 0/0/0/0/1"]);
  });

  it.each([
    ["disabled", false, 60],
    ["a zero interval", true, 0],
  ])("does not register an Auto-refresh timer when %s", async (_label, enabled, interval) => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: interval, autoRefreshToggle: enabled }),
    );
    const setInterval = vi.spyOn(window, "setInterval");
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(setInterval).not.toHaveBeenCalled();
    expect(runtime.registerInterval).not.toHaveBeenCalled();
  });

  it("converts the shared Auto-refresh interval from seconds to milliseconds", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 45, autoRefreshToggle: true }),
    );
    const intervalId = 17 as unknown as ReturnType<typeof window.setInterval>;
    const setInterval = vi.spyOn(window, "setInterval").mockReturnValue(intervalId);
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(runtime.registerInterval).toHaveBeenCalledWith(intervalId);
  });

  it("replaces the timer only when an Auto-refresh setting changes", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const setInterval = vi
      .spyOn(window, "setInterval")
      .mockReturnValueOnce(31 as unknown as ReturnType<typeof window.setInterval>)
      .mockReturnValueOnce(32 as unknown as ReturnType<typeof window.setInterval>);
    const clearInterval = vi.spyOn(window, "clearInterval");
    const plugin = makePlugin(services);
    await plugin.onload();

    await plugin.writeOptions({ projectSyncEnabled: true });

    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(clearInterval).not.toHaveBeenCalled();

    await plugin.writeOptions({ autoRefreshInterval: 90 });

    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(31);
    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(setInterval).toHaveBeenLastCalledWith(expect.any(Function), 90_000);
    expect(runtime.registerInterval).toHaveBeenLastCalledWith(32);

    await plugin.writeOptions({ debugLogging: true });

    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it("clears the active timer when Auto-refresh is toggled off", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 60, autoRefreshToggle: true }),
    );
    const intervalId = 41 as unknown as ReturnType<typeof window.setInterval>;
    const setInterval = vi.spyOn(window, "setInterval").mockReturnValue(intervalId);
    const clearInterval = vi.spyOn(window, "clearInterval");
    const plugin = makePlugin(services);
    await plugin.onload();

    await plugin.writeOptions({ autoRefreshToggle: false });

    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(intervalId);
    expect(setInterval).toHaveBeenCalledOnce();
  });

  it("does not run scheduled work before the Todoist client is ready", async () => {
    const services = makeServices();
    services.todoist.isReady.mockReturnValue(false);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.sync).not.toHaveBeenCalled();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("coalesces overlapping scheduled ticks into one refresh", async () => {
    const services = makeServices();
    const todoistSync = deferred<boolean>();
    services.todoist.sync.mockImplementationOnce(async () => await todoistSync.promise);
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    const first = internals(plugin).runScheduledSync();
    const second = internals(plugin).runScheduledSync();
    await vi.waitFor(() => expect(services.todoist.sync).toHaveBeenCalledOnce());

    expect(second).toBe(first);
    todoistSync.resolve(true);
    await Promise.all([first, second]);

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("refreshes query-block subscriptions without Project sync when Project sync is disabled", async () => {
    const services = makeServices();
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: false,
    });
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("does not run Project sync when the metadata refresh fails", async () => {
    const services = makeServices();
    services.todoist.sync.mockResolvedValueOnce(false);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("keeps startup and manual Project sync independent of Auto-refresh", async () => {
    const services = makeServices();
    const result = emptyResult();
    services.projectSync.sync.mockResolvedValue(result);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: false,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    await plugin.updateApiToken("token");
    await plugin.syncProjectFolderNow();

    expect(services.todoist.initialize).toHaveBeenCalledOnce();
    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledTimes(2);
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();
  });

  it("reports scheduled conflicts in both the console and a notice", async () => {
    const services = makeServices();
    const result = emptyResult();
    result.conflicts.push({ message: "Conflict", path: "Todoist/Task.md" });
    services.projectSync.sync.mockResolvedValueOnce(result);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(warning).toHaveBeenCalledWith(
      "Scheduled Todoist project sync completed with conflicts:",
      result.conflicts,
    );
    expect(runtime.notices).toEqual(["Project sync complete: 0/0/0/0/1"]);
  });

  it("logs background deferrals without repeatedly notifying the user", async () => {
    const services = makeServices();
    const result = emptyResult();
    result.deferred = 1;
    result.conflicts.push({
      message: "The task note is open and has unsaved changes",
      path: "Todoist/Open task.md",
      taskId: "deferred-task",
    });
    services.projectSync.sync.mockResolvedValueOnce(result);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(warning).toHaveBeenCalledWith(
      "Scheduled Todoist project sync completed with conflicts:",
      result.conflicts,
    );
    expect(runtime.notices).toEqual([]);
  });

  it("stops a scheduled continuation after unload", async () => {
    const services = makeServices();
    const todoistSync = deferred<boolean>();
    services.todoist.sync.mockImplementationOnce(async () => await todoistSync.promise);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    const scheduled = internals(plugin).runScheduledSync();
    await vi.waitFor(() => expect(services.todoist.sync).toHaveBeenCalledTimes(1));
    plugin.onunload();
    todoistSync.resolve(true);
    await scheduled;

    expect(services.projectSync.sync).not.toHaveBeenCalled();
    expect(runtime.notices).toEqual([]);
  });

  it("ignores an onboarding submission after unload", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);

    await internals(plugin).loadApiClient();
    const [{ onTokenSubmit }] = services.modals.onboarding.mock.calls[0] as [
      { onTokenSubmit(token: string): Promise<void> },
    ];
    plugin.onunload();
    await onTokenSubmit("late-token");

    expect(services.token.write).not.toHaveBeenCalled();
    expect(services.todoist.initialize).not.toHaveBeenCalled();
  });

  it("does not continue from layout-ready migration after unload", async () => {
    const services = makeServices();
    const migration = deferred<void>();
    services.token.migrateStorage.mockImplementationOnce(async () => await migration.promise);
    const onLayoutReady = vi.fn();
    const plugin = makePlugin(services, onLayoutReady);
    runtime.settings.current = { ...defaultSettings(), version: 0 };
    runtime.loadData.mockResolvedValueOnce({ ...defaultSettings(), version: 0 });
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>,
    );

    await plugin.onload();
    const [layoutReady] = onLayoutReady.mock.calls[0] as [() => Promise<void>];
    services.token.read.mockClear();
    const ready = layoutReady();
    await vi.waitFor(() => expect(services.token.migrateStorage).toHaveBeenCalledTimes(1));
    plugin.onunload();
    migration.resolve(undefined);
    await ready;

    expect(services.token.read).not.toHaveBeenCalled();
    expect(services.todoist.initialize).not.toHaveBeenCalled();
  });
});
