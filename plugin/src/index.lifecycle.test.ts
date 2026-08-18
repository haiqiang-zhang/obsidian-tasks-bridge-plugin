import type { App, EventRef, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TodoistListActions, TodoistListTaskRecord } from "@/bases/todoist-list";
import { makeSettings } from "@/factories/settings";
import { OBSIDIAN_SYNC_SETTLE_MS } from "@/infra/obsidianSyncGate";
import {
  PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY,
  type ProjectSyncConfig,
  type ProjectSyncResult,
} from "@/project-sync";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";

const runtime = vi.hoisted(() => ({
  addSettingTab: vi.fn(),
  loadData: vi.fn(),
  loadLocalStorage: vi.fn(),
  metadataCacheOn: vi.fn(),
  makeServices: vi.fn(),
  notices: [] as unknown[],
  registerCommands: vi.fn(),
  registerBasesView: vi.fn(),
  registerEvent: vi.fn(),
  registerInterval: vi.fn(),
  registerMarkdownCodeBlockProcessor: vi.fn(),
  saveData: vi.fn(),
  saveLocalStorage: vi.fn(),
  settings: {
    current: {} as Record<string, unknown>,
  },
  vaultOn: vi.fn(),
}));

vi.mock("obsidian", () => ({
  MarkdownRenderChild: class {
    public readonly containerEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
      this.containerEl = containerEl;
    }
  },
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

    public registerEvent(eventRef: unknown): void {
      runtime.registerEvent(eventRef);
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
  createTasksListViewRegistration: (actions: unknown, projectContext: unknown) => ({
    name: "Tasks List",
    actions,
    projectContext,
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

vi.mock("@/uiText", () => ({
  uiText: {
    editTaskModal: {
      projectionErrorNotice: "Todoist was updated, but its Vault note could not be refreshed.",
    },
    notices: {
      migrationFailed: "Migration failed",
      querySyncFailed: (message: string) => `Query sync failed: ${message}`,
      projectSyncComplete: (
        created: number,
        updated: number,
        moved: number,
        deleted: number,
        conflicts: number,
      ) => `Project sync complete: ${created}/${updated}/${moved}/${deleted}/${conflicts}`,
      projectSyncInterrupted: "Project sync was interrupted",
      projectSyncFailed: (message: string) => `Project sync failed: ${message}`,
    },
  },
}));

vi.mock("@/infra/time", () => ({
  secondsToMillis: (seconds: number) => seconds * 1000,
}));

vi.mock("@/query/injector", () => ({
  LEGACY_QUERY_CODE_BLOCK: "todoist",
  QUERY_CODE_BLOCK: "tasks-bridge-query",
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

type VaultActivityListener = (file: { path: string }, oldPath?: string) => void;

type MutableSyncInstance = {
  dataLoaded: boolean;
  getStatus(): string;
  gettingServer: unknown;
  initial: boolean;
  initialized: boolean;
  newServerFiles: unknown[];
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pause: boolean;
  ready: boolean;
  syncStatus: string;
};

const defaultSettings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  apiTokenSecretId: "swt-todoist-api-token",
  autoRefreshInterval: 60,
  autoRefreshToggle: false,
  projectSyncEnabled: false,
  projectSyncPreserveUnmanagedItems: true,
  projectSyncMappings: [],
  tokenStorage: "secrets",
  version: 1,
  ...overrides,
});

const workProjectSyncMapping = {
  id: "mapping-work",
  project: { projectId: "work", projectName: "Work" },
  folder: "Task Projects/Work",
  includeSubprojects: true,
  previousFolders: [],
};

const emptyResult = (): ProjectSyncResult => ({
  conflicts: [],
  created: 0,
  deferred: 0,
  moved: 0,
  outOfScope: 0,
  pausedMappingIds: [],
  deleted: 0,
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
    clearStatisticsSnapshot: vi.fn(),
    dispose: vi.fn(),
    getConfig: vi.fn(
      (): ProjectSyncConfig => ({
        enabled: false,
        preserveUnmanagedItems: true,
        mappings: [],
      }),
    ),
    getStatus: vi.fn(() => ({ state: "disabled" as const })),
    getStatisticsSnapshot: vi.fn(() => null),
    invalidate: vi.fn(),
    notifyLocalProjectionChanges: vi.fn(),
    reloadStatisticsCatalogs: vi.fn(),
    refreshStatisticsFromLocalProjection: vi.fn(async () => undefined),
    setConfig: vi.fn(),
    subscribe: vi.fn<(listener: () => void) => () => void>(() => () => undefined),
    sync: vi.fn(async (): Promise<ProjectSyncResult | null> => null),
  },
  projectTasks: {
    applyCompletedProperty: vi.fn(async () => undefined),
    completeTask: vi.fn(async () => ({ projection: Promise.resolve() })),
    isReady: vi.fn(() => true),
    loadEditableTask: vi.fn(),
    reopenTask: vi.fn(async () => ({ projection: Promise.resolve() })),
    updateTask: vi.fn(async () => undefined),
  },
  projectTaskProperties: {
    dispose: vi.fn(),
    handleMetadataChange: vi.fn(),
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

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const makeSyncHarness = (
  overrides: Partial<Omit<MutableSyncInstance, "getStatus" | "off" | "on">> & {
    coreStatus?: string;
  } = {},
) => {
  const { coreStatus: initialCoreStatus = "syncing", ...instanceOverrides } = overrides;
  const listeners = new Set<() => void>();
  let coreStatus = initialCoreStatus;
  const eventRef = {} as EventRef;
  const instance: MutableSyncInstance = {
    dataLoaded: true,
    getStatus: () => coreStatus,
    gettingServer: null,
    initial: false,
    initialized: true,
    newServerFiles: [],
    off: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)),
    on: vi.fn((_name: string, listener: () => void) => {
      listeners.add(listener);
      return eventRef;
    }),
    pause: false,
    ready: true,
    syncStatus: "Fully synced",
    ...instanceOverrides,
  };
  const internalPlugins = {
    getEnabledPluginById: vi.fn(() => instance),
    getPluginById: vi.fn(() => ({ enabled: true, instance })),
  };

  return {
    emitStatusChange: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    instance,
    internalPlugins,
    setCoreStatus: (status: string) => {
      coreStatus = status;
    },
  };
};

const makePlugin = (
  services: TestServices,
  onLayoutReady = vi.fn(),
  internalPlugins: unknown | null = makeSyncHarness().internalPlugins,
) => {
  runtime.makeServices.mockReturnValue(services);
  const app = {
    ...(internalPlugins === null ? {} : { internalPlugins }),
    loadLocalStorage: runtime.loadLocalStorage,
    metadataCache: {
      getFileCache: vi.fn(),
      on: runtime.metadataCacheOn,
    },
    saveLocalStorage: runtime.saveLocalStorage,
    vault: {
      on: runtime.vaultOn,
    },
    workspace: {
      onLayoutReady,
    },
  } as unknown as App;
  const manifest = {} as PluginManifest;
  return new TodoistPlugin(app, manifest);
};

const internals = (plugin: TodoistPlugin): LifecycleInternals =>
  plugin as unknown as LifecycleInternals;

const vaultActivityListener = (eventName: string): VaultActivityListener => {
  const registration = runtime.vaultOn.mock.calls.find(([event]) => event === eventName);
  if (registration === undefined) {
    throw new Error(`Vault listener '${eventName}' was not registered`);
  }
  return registration[1] as VaultActivityListener;
};

describe("TodoistPlugin async lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.notices.length = 0;
    runtime.settings.current = defaultSettings();
    runtime.loadData.mockResolvedValue(defaultSettings());
    runtime.loadLocalStorage.mockReturnValue(null);
    runtime.vaultOn.mockReturnValue({});
    runtime.saveData.mockResolvedValue(undefined);
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([0xab]).buffer),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the Tasks List Bases view", async () => {
    const services = makeServices();
    const unsubscribe = vi.fn();
    services.projectSync.subscribe.mockReturnValueOnce(unsubscribe);
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(runtime.registerBasesView).toHaveBeenCalledWith(
      "tasks-list",
      expect.objectContaining({ name: "Tasks List" }),
    );
    const registration = runtime.registerBasesView.mock.calls[0]?.[1] as {
      projectContext: {
        getConfig(): unknown;
        getContext(): unknown;
        subscribeContext(listener: () => void): () => void;
      };
    };
    expect(registration.projectContext.getConfig()).toEqual({
      enabled: false,
      preserveUnmanagedItems: true,
      mappings: [],
    });
    expect(registration.projectContext.getContext()).toBeNull();
    expect(services.projectSync.getStatisticsSnapshot).not.toHaveBeenCalled();

    const listener = vi.fn();
    expect(registration.projectContext.subscribeContext(listener)).toBe(unsubscribe);
    expect(services.projectSync.subscribe).toHaveBeenCalledOnce();
    const notifyContext = services.projectSync.subscribe.mock.calls[0]?.[0];
    expect(notifyContext).toBeTypeOf("function");
    notifyContext?.();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("builds Tasks List hierarchy context directly from the persisted Project catalog", async () => {
    const services = makeServices();
    vi.mocked(services.projectSync.getConfig).mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [workProjectSyncMapping],
    });
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings({
        projectSyncEnabled: true,
        projectSyncMappings: [workProjectSyncMapping],
      }),
      projectSyncCatalogs: {
        version: 2,
        items: [
          {
            mappingId: "mapping-work",
            rootProjectId: "work",
            includeSubprojects: true,
            syncedAt: "2026-08-18T08:00:00.000Z",
            projects: [
              { id: "work", parentId: null, name: "Work", childOrder: 0 },
              { id: "child", parentId: "work", name: "Child", childOrder: 1 },
            ],
            tasks: [
              {
                id: "task-1",
                projectId: "child",
                parentId: "parent-task",
                order: 2,
              },
            ],
            completionEvents: [],
          },
        ],
      },
    });
    const plugin = makePlugin(services);

    await plugin.onload();

    const registration = runtime.registerBasesView.mock.calls[0]?.[1] as {
      projectContext: { getContext(): unknown };
    };
    expect(registration.projectContext.getContext()).toEqual({
      scopes: [
        {
          mappingId: "mapping-work",
          rootProjectId: "work",
          projects: [
            { id: "work", parentId: null, name: "Work", childOrder: 0 },
            { id: "child", parentId: "work", name: "Child", childOrder: 1 },
          ],
          tasks: [
            {
              id: "task-1",
              projectId: "child",
              parentId: "parent-task",
              order: 2,
            },
          ],
        },
      ],
    });
    expect(services.projectSync.getStatisticsSnapshot).not.toHaveBeenCalled();
  });

  it("registers canonical block names before their compatibility aliases", async () => {
    const plugin = makePlugin(makeServices());

    await plugin.onload();

    expect(
      runtime.registerMarkdownCodeBlockProcessor.mock.calls.map(([language]) => language),
    ).toEqual(["tasks-bridge-query", "tasks-bridge-project-task", "todoist", "tasks-bridge-task"]);
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
      preserveUnmanagedItems: true,
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

  it("migrates the legacy synchronized query cache into vault-local storage", async () => {
    const services = makeServices();
    const legacyQueryCache = {
      version: 2,
      credentialFingerprint: "credential-a",
      entries: { '{"filter":"today"}': { tasks: [], updatedAt: "2026-08-11T10:00:00.000Z" } },
    };
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings(),
      queryCache: legacyQueryCache,
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(runtime.loadLocalStorage).toHaveBeenCalledWith("tasks-bridge:query-cache:v2");
    expect(plugin.queryCache.load).toHaveBeenCalledWith(legacyQueryCache);
    expect(runtime.saveLocalStorage).toHaveBeenCalledWith("tasks-bridge:query-cache:v2", {});
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty("queryCache");
  });

  it("propagates an explicit unmanaged-content opt-out into Project sync", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ projectSyncPreserveUnmanagedItems: false }),
    );
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(runtime.settings.current.projectSyncPreserveUnmanagedItems).toBe(false);
    expect(services.projectSync.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ preserveUnmanagedItems: false }),
    );
  });

  it("does not rewrite an already canonical settings file during startup", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(makeSettings());
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(runtime.saveData).not.toHaveBeenCalled();
  });

  it("preserves Project catalogs in plugin data when settings are updated", async () => {
    const services = makeServices();
    const stored = {
      ...makeSettings(),
      projectSyncCatalogs: {
        version: 1,
        items: [
          {
            mappingId: "mapping-work",
            rootProjectId: "work",
            includeSubprojects: true,
            syncedAt: "2026-08-12T01:00:00.000Z",
            projects: [
              { id: "work", parentId: null, name: "Work", childOrder: 1 },
              { id: "empty", parentId: "work", name: "Empty", childOrder: 2 },
            ],
          },
        ],
      },
    };
    runtime.loadData.mockResolvedValueOnce(stored);
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();

    await plugin.writeOptions({ debugLogging: true });

    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        debugLogging: true,
        projectSyncCatalogs: {
          version: 2,
          items: [
            expect.objectContaining({
              mappingId: "mapping-work",
              tasks: [],
              completionEvents: [],
            }),
          ],
        },
      }),
    );
  });

  it("keeps the newest Project catalog when external plugin data arrives", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings(),
      projectSyncCatalogs: {
        version: 1,
        items: [
          {
            mappingId: "mapping-work",
            rootProjectId: "work",
            includeSubprojects: true,
            syncedAt: "2026-08-12T02:00:00.000Z",
            projects: [{ id: "work", parentId: null, name: "Newest", childOrder: 1 }],
          },
        ],
      },
    });
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ debugLogging: true }),
      projectSyncCatalogs: {
        version: 1,
        items: [
          {
            mappingId: "mapping-work",
            rootProjectId: "work",
            includeSubprojects: true,
            syncedAt: "2026-08-12T01:00:00.000Z",
            projects: [{ id: "work", parentId: null, name: "Older", childOrder: 1 }],
          },
        ],
      },
    });

    await plugin.onExternalSettingsChange();

    expect(services.projectSync.reloadStatisticsCatalogs).toHaveBeenCalledOnce();
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        debugLogging: true,
        projectSyncCatalogs: expect.objectContaining({
          items: [expect.objectContaining({ syncedAt: "2026-08-12T02:00:00.000Z" })],
        }),
      }),
    );
  });

  it("loads folder ownership from plugin data and batches durable creation records", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();

    const listed = plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work");
    expect(listed).toEqual([
      expect.objectContaining({
        creationId: "created-child",
        path: "Task Projects/Work/Child",
      }),
    ]);
    listed[0].path = "Changed by caller";
    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")[0]?.path).toBe(
      "Task Projects/Work/Child",
    );

    await plugin.projectSyncFolderOwnershipStorage.recordCreatedFolders([
      {
        mappingId: "mapping-work",
        rootProjectId: "work",
        ownerKind: "project",
        ownerId: "second",
        path: "Task Projects/Work/Second",
      },
      {
        mappingId: "mapping-work",
        rootProjectId: "work",
        ownerKind: "task",
        ownerId: "parent-task",
        path: "Task Projects/Work/Parent task",
      },
    ]);

    expect(runtime.saveData).toHaveBeenCalledOnce();
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          version: 2,
          records: expect.arrayContaining([
            expect.objectContaining({ path: "Task Projects/Work/Child" }),
            expect.objectContaining({ path: "Task Projects/Work/Second" }),
            expect.objectContaining({ path: "Task Projects/Work/Parent task" }),
          ]),
        }),
      }),
    );

    runtime.saveData.mockClear();
    await plugin.projectSyncFolderOwnershipStorage.recordCreatedFolder({
      mappingId: "mapping-work",
      rootProjectId: "work",
      ownerKind: "project",
      ownerId: "second",
      path: "task projects/work/second",
    });
    expect(runtime.saveData).not.toHaveBeenCalled();
  });

  it.each([
    ["is no longer configured", []],
    [
      "now points at a different Todoist root",
      [
        {
          ...workProjectSyncMapping,
          project: { projectId: "personal", projectName: "Personal" },
        },
      ],
    ],
  ])("revokes loaded folder ownership when its mapping %s", async (_label, mappings) => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: mappings }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [],
          pathTombstones: [
            expect.objectContaining({
              mappingId: "mapping-work",
              path: "Task Projects/Work/Child",
            }),
          ],
        }),
      }),
    );
  });

  it("keeps current folder ownership when an older external payload omits the registry", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.loadData.mockResolvedValueOnce(
      makeSettings({
        debugLogging: true,
        projectSyncMappings: [workProjectSyncMapping],
      }),
    );

    await plugin.onExternalSettingsChange();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([
      expect.objectContaining({ creationId: "created-child" }),
    ]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        debugLogging: true,
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [expect.objectContaining({ creationId: "created-child" })],
        }),
      }),
    );
  });

  it.each([
    ["removes the mapping", []],
    [
      "changes the mapping's Todoist root",
      [
        {
          ...workProjectSyncMapping,
          project: { projectId: "personal", projectName: "Personal" },
        },
      ],
    ],
  ])("revokes ownership when synchronized settings %s", async (_label, mappings) => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.loadData.mockResolvedValueOnce(
      makeSettings({ debugLogging: true, projectSyncMappings: mappings }),
    );

    await plugin.onExternalSettingsChange();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        debugLogging: true,
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [],
          pathTombstones: [
            expect.objectContaining({
              mappingId: "mapping-work",
              path: "Task Projects/Work/Child",
            }),
          ],
        }),
      }),
    );
  });

  it("restores folder ownership when external data arrives during its queued save", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
    );
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    const firstSave = deferred<void>();
    runtime.saveData
      .mockImplementationOnce(async () => await firstSave.promise)
      .mockResolvedValue(undefined);

    const ownershipWrite = plugin.projectSyncFolderOwnershipStorage.recordCreatedFolder({
      mappingId: "mapping-work",
      rootProjectId: "work",
      ownerKind: "project",
      ownerId: "child",
      path: "Task Projects/Work/Child",
    });
    await vi.waitFor(() => expect(runtime.saveData).toHaveBeenCalledOnce());

    runtime.loadData.mockResolvedValueOnce(
      makeSettings({
        debugLogging: true,
        projectSyncMappings: [workProjectSyncMapping],
      }),
    );
    const externalReload = plugin.onExternalSettingsChange();
    firstSave.resolve(undefined);
    await Promise.all([ownershipWrite, externalReload]);

    expect(runtime.saveData).toHaveBeenCalledTimes(2);
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        debugLogging: true,
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [expect.objectContaining({ path: "Task Projects/Work/Child" })],
        }),
      }),
    );
  });

  it("does not let stale external plugin data resurrect released folder ownership", async () => {
    const services = makeServices();
    const staleData = {
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    };
    runtime.loadData.mockResolvedValueOnce(staleData);
    const plugin = makePlugin(services);
    await plugin.loadOptions();

    await plugin.projectSyncFolderOwnershipStorage.releaseOwnedFolderPath(
      "mapping-work",
      "Task Projects/Work/Child",
    );
    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);

    runtime.saveData.mockClear();
    runtime.loadData.mockResolvedValueOnce(staleData);
    await plugin.onExternalSettingsChange();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
          version: 2,
          records: [],
          tombstones: ["created-child"],
          pathTombstones: [
            {
              mappingId: "mapping-work",
              path: "Task Projects/Work/Child",
              generation: 1,
            },
          ],
        },
      }),
    );
  });

  it("retries a failed ownership save instead of treating the in-memory change as durable", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.saveData.mockRejectedValueOnce(new Error("disk unavailable"));

    const creation = {
      mappingId: "mapping-work",
      rootProjectId: "work",
      ownerKind: "project" as const,
      ownerId: "child",
      path: "Task Projects/Work/Child",
    };
    await expect(
      plugin.projectSyncFolderOwnershipStorage.recordCreatedFolder(creation),
    ).rejects.toThrow("disk unavailable");
    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([
      expect.objectContaining({ path: creation.path }),
    ]);

    runtime.saveData.mockResolvedValue(undefined);
    await plugin.projectSyncFolderOwnershipStorage.recordCreatedFolder(creation);

    expect(runtime.saveData).toHaveBeenCalledTimes(2);
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [expect.objectContaining({ path: creation.path })],
        }),
      }),
    );
  });

  it("automatically retries a failed ownership release without waiting for another sync", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.saveData
      .mockRejectedValueOnce(new Error("sync file unavailable"))
      .mockResolvedValue(undefined);

    await expect(
      plugin.projectSyncFolderOwnershipStorage.releaseOwnedFolderPath(
        "mapping-work",
        "Task Projects/Work/Child",
      ),
    ).rejects.toThrow("sync file unavailable");
    expect(runtime.saveData).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(runtime.saveData).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.saveData).toHaveBeenCalledTimes(2);
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [],
          pathTombstones: [expect.objectContaining({ path: "Task Projects/Work/Child" })],
        }),
      }),
    );
  });

  it("still saves authoritative ownership when the local safety journal is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = makePlugin(makeServices());
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.saveLocalStorage.mockImplementationOnce(() => {
      throw new Error("local storage quota exceeded");
    });

    await plugin.projectSyncFolderOwnershipStorage.recordCreatedFolder({
      mappingId: "mapping-work",
      rootProjectId: "work",
      ownerKind: "project",
      ownerId: "child",
      path: "Task Projects/Work/Child",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to persist the Project sync folder safety journal:",
      expect.any(Error),
    );
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [expect.objectContaining({ path: "Task Projects/Work/Child" })],
        }),
      }),
    );
  });

  it("restores a failed release from the device-local safety shadow after restart", async () => {
    const services = makeServices();
    const staleData = {
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    };
    runtime.loadData.mockResolvedValueOnce(staleData);
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockRejectedValueOnce(new Error("sync file unavailable"));

    await expect(
      plugin.projectSyncFolderOwnershipStorage.releaseOwnedFolderPath(
        "mapping-work",
        "Task Projects/Work/Child",
      ),
    ).rejects.toThrow("sync file unavailable");
    const shadowWrites = runtime.saveLocalStorage.mock.calls.filter(
      ([key]) => key === "tasks-bridge:project-sync-folder-ownership:v2",
    );
    const shadow = shadowWrites[shadowWrites.length - 1]?.[1];
    expect(shadow).toEqual(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({ records: [] }),
      }),
    );

    runtime.loadData.mockReset();
    runtime.loadData.mockResolvedValueOnce(staleData);
    runtime.loadLocalStorage.mockReset();
    runtime.loadLocalStorage.mockReturnValueOnce(null).mockReturnValueOnce(shadow);
    runtime.saveData.mockReset();
    runtime.saveData.mockResolvedValue(undefined);
    const restarted = makePlugin(makeServices());
    await restarted.loadOptions();

    expect(restarted.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual(
      [],
    );
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [],
          pathTombstones: [
            expect.objectContaining({
              mappingId: "mapping-work",
              path: "Task Projects/Work/Child",
            }),
          ],
        }),
      }),
    );
  });

  it("does not restore active folder deletion grants from the local safety shadow", async () => {
    runtime.loadData.mockResolvedValueOnce(
      makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
    );
    runtime.loadLocalStorage.mockReturnValueOnce(null).mockReturnValueOnce({
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 2,
        records: [
          {
            creationId: "stale-local-grant",
            generation: 1,
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
        pathTombstones: [],
      },
    });
    const plugin = makePlugin(makeServices());

    await plugin.loadOptions();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveLocalStorage).toHaveBeenCalledWith(
      "tasks-bridge:project-sync-folder-ownership:v2",
      {},
    );
    expect(runtime.saveData).not.toHaveBeenCalled();
  });

  it("treats missing plugin data as an ownership reset instead of restoring a stale grant", async () => {
    runtime.loadData.mockResolvedValueOnce(null);
    runtime.loadLocalStorage.mockReturnValueOnce(null).mockReturnValueOnce({
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 2,
        records: [
          {
            creationId: "stale-local-grant",
            generation: 1,
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
        pathTombstones: [],
      },
    });
    const plugin = makePlugin(makeServices());

    await plugin.loadOptions();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveLocalStorage).toHaveBeenCalledWith(
      "tasks-bridge:project-sync-folder-ownership:v2",
      {},
    );
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty(PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY);
  });

  it("preserves an unsupported local ownership shadow and disables folder cleanup", async () => {
    const synchronizedOwnership = {
      version: 1,
      records: [
        {
          creationId: "created-child",
          mappingId: "mapping-work",
          rootProjectId: "work",
          ownerKind: "project",
          ownerId: "child",
          path: "Task Projects/Work/Child",
        },
      ],
      tombstones: [],
    };
    const futureShadow = {
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 99,
        records: [{ future: true }],
        tombstones: ["future-revocation"],
      },
    };
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: synchronizedOwnership,
    });
    runtime.loadLocalStorage.mockReturnValueOnce(null).mockReturnValueOnce(futureShadow);
    const plugin = makePlugin(makeServices());

    await plugin.loadOptions();
    await plugin.projectSyncFolderOwnershipStorage.releaseOwnedFolderPath(
      "mapping-work",
      "Task Projects/Work/Child",
    );
    await plugin.writeOptions({ debugLogging: true });

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveLocalStorage).not.toHaveBeenCalled();
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        debugLogging: true,
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [expect.objectContaining({ creationId: "created-child" })],
        }),
      }),
    );
  });

  it("preserves an unsupported ownership envelope and disables its deletion authority", async () => {
    const services = makeServices();
    const futureOwnership = {
      version: 99,
      records: [{ future: true }],
      tombstones: ["future-revocation"],
    };
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings(),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: futureOwnership,
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).not.toHaveBeenCalled();
    await plugin.writeOptions({ debugLogging: true });
    expect(runtime.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        debugLogging: true,
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: futureOwnership,
      }),
    );
  });

  it("revokes ownership when a local settings edit removes its mapping", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();

    await plugin.writeOptions({ projectSyncMappings: [] });

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSyncMappings: [],
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({
          records: [],
          pathTombstones: [
            expect.objectContaining({ path: "Task Projects/Work/Child", generation: 1 }),
          ],
        }),
      }),
    );
  });

  it("releases an owned path when a Vault delete or rename event replaces its folder", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce({
      ...makeSettings({ projectSyncMappings: [workProjectSyncMapping] }),
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "created-child",
            mappingId: "mapping-work",
            rootProjectId: "work",
            ownerKind: "project",
            ownerId: "child",
            path: "Task Projects/Work/Child",
          },
        ],
        tombstones: [],
      },
    });
    const plugin = makePlugin(services);
    await plugin.onload();
    runtime.saveData.mockClear();

    vaultActivityListener("delete")({ path: "Task Projects/Work/Child" });
    await vi.waitFor(() =>
      expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]),
    );
    vaultActivityListener("create")({ path: "Task Projects/Work/Child" });

    expect(plugin.projectSyncFolderOwnershipStorage.listOwnedFolders("mapping-work")).toEqual([]);
    expect(runtime.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: expect.objectContaining({ records: [] }),
      }),
    );
  });

  it("prefers the device-local query cache over a legacy cache received through Sync", async () => {
    const services = makeServices();
    const localQueryCache = { version: 2, credentialFingerprint: "local", entries: {} };
    const syncedQueryCache = { version: 2, credentialFingerprint: "synced", entries: {} };
    runtime.loadLocalStorage.mockReturnValueOnce(localQueryCache);
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings(),
      queryCache: syncedQueryCache,
    });
    const plugin = makePlugin(services);

    await plugin.loadOptions();

    expect(plugin.queryCache.load).toHaveBeenCalledWith(localQueryCache);
    expect(runtime.saveLocalStorage).not.toHaveBeenCalled();
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty("queryCache");
  });

  it("persists query-cache mutations only in device-local storage", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    vi.mocked(plugin.queryCache.set).mockReturnValueOnce(true);
    vi.mocked(plugin.queryCache.completeTaskInAll).mockReturnValueOnce(true);
    vi.mocked(plugin.queryCache.removeTaskFromAll).mockReturnValueOnce(true);
    const updatedAt = new Date("2026-08-11T10:00:00.000Z");

    await plugin.writeQueryCache("today", [], updatedAt);
    await plugin.completeTaskInAllQueryCaches("task-1", updatedAt);
    await plugin.removeTaskFromAllQueryCaches("task-1", updatedAt);

    expect(runtime.saveLocalStorage).toHaveBeenCalledTimes(3);
    expect(runtime.saveLocalStorage).toHaveBeenCalledWith("tasks-bridge:query-cache:v2", {});
    expect(runtime.saveData).not.toHaveBeenCalled();
  });

  it("reloads externally synchronized settings without importing their query cache", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    vi.mocked(plugin.queryCache.load).mockClear();
    runtime.saveData.mockClear();
    services.projectSync.setConfig.mockClear();
    const timeoutId = 53 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeout = vi.spyOn(window, "setTimeout").mockReturnValue(timeoutId);
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings({
        autoRefreshInterval: 30,
        autoRefreshToggle: true,
        projectSyncEnabled: true,
        projectSyncMappings: [
          {
            id: "mapping-work",
            project: { projectId: "work", projectName: "Work" },
            folder: "Tasks/Work",
            includeSubprojects: true,
            previousFolders: [],
          },
        ],
      }),
      queryCache: { version: 2, credentialFingerprint: "another-device", entries: {} },
    });

    await plugin.onExternalSettingsChange();

    expect(runtime.settings.current).toMatchObject({
      autoRefreshInterval: 30,
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    expect(services.projectSync.setConfig).toHaveBeenLastCalledWith({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [
        expect.objectContaining({
          id: "mapping-work",
          folder: "Tasks/Work",
          project: { projectId: "work", projectName: "Work" },
        }),
      ],
    });
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(plugin.queryCache.load).not.toHaveBeenCalled();
    expect(runtime.saveLocalStorage).not.toHaveBeenCalled();
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty("queryCache");
  });

  it("preserves newer settings when an older device omits fields it does not know", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    runtime.settings.current = defaultSettings({
      debugLogging: false,
      projectSyncPreserveUnmanagedItems: false,
      renderLabelsIcon: false,
      version: 5,
    });
    runtime.loadData.mockResolvedValueOnce({
      autoRefreshInterval: 45,
      autoRefreshToggle: true,
      debugLogging: true,
      projectSyncEnabled: false,
      projectSyncMappings: [],
      tokenStorage: "secrets",
      version: 4,
    });

    await plugin.onExternalSettingsChange();

    expect(runtime.settings.current).toMatchObject({
      autoRefreshInterval: 45,
      autoRefreshToggle: true,
      debugLogging: true,
      projectSyncPreserveUnmanagedItems: false,
      renderLabelsIcon: false,
      version: 5,
    });
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).toMatchObject({
      projectSyncPreserveUnmanagedItems: false,
      renderLabelsIcon: false,
      version: 5,
    });
  });

  it("drops a legacy Project sync writer assignment received from another device", async () => {
    const services = makeServices();
    runtime.settings.current = defaultSettings({ version: 5 });
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings({ version: 4 }),
      projectSyncWriterId: "device-b",
    });
    const plugin = makePlugin(services);

    await plugin.onExternalSettingsChange();

    expect(runtime.settings.current).not.toHaveProperty("projectSyncWriterId");
    expect(runtime.settings.current.version).toBe(5);
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).not.toHaveProperty("projectSyncWriterId");
  });

  it("keeps the legacy Project mapping migration path for external settings", async () => {
    const services = makeServices();
    runtime.settings.current = defaultSettings({
      projectSyncMappings: [
        {
          id: "current-mapping",
          project: { projectId: "current", projectName: "Current" },
          folder: "Tasks/Current",
          includeSubprojects: false,
          previousFolders: [],
        },
      ],
      version: 5,
    });
    runtime.loadData.mockResolvedValueOnce({
      projectSyncEnabled: true,
      projectSyncFolder: "Todoist Projects",
      projectSyncIncludeSubprojects: true,
      projectSyncProject: { projectId: "root", projectName: "Root/Project" },
      version: 4,
    });
    const plugin = makePlugin(services);

    await plugin.onExternalSettingsChange();

    expect(runtime.settings.current.projectSyncMappings).toEqual([
      expect.objectContaining({
        folder: "Todoist Projects/Root-Project",
        includeSubprojects: true,
        project: { projectId: "root", projectName: "Root/Project" },
      }),
    ]);
    expect(runtime.settings.current.version).toBe(5);
  });

  it("does not echo an already canonical external settings update back to Sync", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    runtime.saveData.mockClear();
    runtime.loadData.mockResolvedValueOnce(makeSettings({ renderDateIcon: false, version: 1 }));

    await plugin.onExternalSettingsChange();

    expect(runtime.settings.current.renderDateIcon).toBe(false);
    expect(runtime.saveData).not.toHaveBeenCalled();
  });

  it("reloads the active Todoist credential when external token settings change", async () => {
    const services = makeServices();
    services.token.read.mockResolvedValueOnce("external-token");
    const plugin = makePlugin(services);
    await plugin.loadOptions();
    services.projectSync.clearStatisticsSnapshot.mockClear();
    services.projectSync.invalidate.mockClear();
    services.todoist.reset.mockClear();
    runtime.loadData.mockResolvedValueOnce(makeSettings({ tokenStorage: "file" }));

    await plugin.onExternalSettingsChange();

    expect(services.projectSync.clearStatisticsSnapshot).toHaveBeenCalledOnce();
    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
    expect(services.todoist.reset).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(services.todoist.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ token: "external-token" }),
      ),
    );
  });

  it("orders an external settings reload between an older save and a later local update", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);
    const firstSave = deferred<void>();
    runtime.saveData
      .mockImplementationOnce(async () => await firstSave.promise)
      .mockResolvedValue(undefined);

    const olderLocalWrite = plugin.writeOptions({ debugLogging: true });
    await vi.waitFor(() => expect(runtime.saveData).toHaveBeenCalledTimes(1));

    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings(),
      debugLogging: false,
      fadeToggle: true,
    });
    const externalReload = plugin.onExternalSettingsChange();
    const laterLocalWrite = plugin.writeOptions({ fadeToggle: false });

    firstSave.resolve(undefined);
    await Promise.all([olderLocalWrite, externalReload, laterLocalWrite]);

    expect(runtime.saveData).toHaveBeenCalledTimes(3);
    expect(runtime.settings.current).toMatchObject({ debugLogging: false, fadeToggle: false });
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).toMatchObject({
      debugLogging: false,
      fadeToggle: false,
    });
    expect(lastSave).not.toHaveProperty("queryCache");
  });

  it("restores external settings received during a startup canonicalization save", async () => {
    const services = makeServices();
    const firstSave = deferred<void>();
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings(),
      removedLegacyOption: "drop me",
    });
    runtime.saveData
      .mockImplementationOnce(async () => await firstSave.promise)
      .mockResolvedValue(undefined);
    const plugin = makePlugin(services);

    const startupLoad = plugin.loadOptions();
    await vi.waitFor(() => expect(runtime.saveData).toHaveBeenCalledOnce());

    const externalSettings = makeSettings({ debugLogging: true, version: 1 });
    runtime.loadData.mockResolvedValueOnce(externalSettings);
    const externalReload = plugin.onExternalSettingsChange();

    firstSave.resolve(undefined);
    await Promise.all([startupLoad, externalReload]);

    expect(runtime.settings.current.debugLogging).toBe(true);
    expect(runtime.saveData).toHaveBeenCalledTimes(2);
    expect(runtime.saveData.mock.calls[1]?.[0]).toEqual(externalSettings);
  });

  it("restores a newer external file received during an external normalization save", async () => {
    const services = makeServices();
    const firstSave = deferred<void>();
    runtime.loadData.mockResolvedValueOnce({
      ...defaultSettings(),
      debugLogging: false,
      obsoleteExternalField: true,
    });
    runtime.saveData
      .mockImplementationOnce(async () => await firstSave.promise)
      .mockResolvedValue(undefined);
    const plugin = makePlugin(services);

    const firstExternalReload = plugin.onExternalSettingsChange();
    await vi.waitFor(() => expect(runtime.saveData).toHaveBeenCalledOnce());

    const newestExternalSettings = makeSettings({ debugLogging: true, version: 1 });
    runtime.loadData.mockResolvedValueOnce(newestExternalSettings);
    const newestExternalReload = plugin.onExternalSettingsChange();

    firstSave.resolve(undefined);
    await Promise.all([firstExternalReload, newestExternalReload]);

    expect(runtime.settings.current.debugLogging).toBe(true);
    expect(runtime.saveData).toHaveBeenCalledTimes(2);
    expect(runtime.saveData.mock.calls[1]?.[0]).toEqual(newestExternalSettings);
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
    expect(services.projectSync.clearStatisticsSnapshot).toHaveBeenCalledTimes(2);
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
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
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

  it("reports an interrupted manual Project sync separately from a disabled configuration", async () => {
    const services = makeServices();
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
    services.projectSync.sync.mockResolvedValueOnce(null);
    const plugin = makePlugin(services);

    await expect(plugin.syncProjectFolderNow()).resolves.toBeNull();

    expect(runtime.notices).toEqual(["Project sync was interrupted"]);
  });

  it("refreshes Query blocks without waiting for disabled Project sync", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);

    await expect(plugin.syncProjectFolderNow()).resolves.toBeNull();

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
    expect(runtime.notices).toEqual([]);
  });

  it("continues Project sync when the Query refresh fails", async () => {
    const services = makeServices();
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
    const result = emptyResult();
    services.todoist.sync.mockRejectedValueOnce(new Error("query unavailable"));
    services.projectSync.sync.mockResolvedValueOnce(result);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await expect(plugin.syncProjectFolderNow()).resolves.toBe(result);

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Failed to synchronize Todoist query blocks:",
      expect.objectContaining({ message: "query unavailable" }),
    );
    expect(runtime.notices).toEqual([
      "Query sync failed: query unavailable",
      "Project sync complete: 0/0/0/0/0",
    ]);
  });

  it("refreshes Query blocks exactly once when Project sync fails", async () => {
    const services = makeServices();
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
    services.projectSync.sync.mockRejectedValueOnce(new Error("project unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = makePlugin(services);

    await expect(plugin.syncProjectFolderNow()).resolves.toBeNull();

    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Failed to synchronize the Todoist project folder:",
      expect.objectContaining({ message: "project unavailable" }),
    );
    expect(runtime.notices).toEqual(["Project sync failed: project unavailable"]);
  });

  it("retains previous projection roots after migration to catch late Sync files", async () => {
    const services = makeServices();
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
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
        previousFolders: ["Todoist/Old Work"],
      }),
    ]);
  });

  it("never projects Markdown files during Todoist client startup", async () => {
    const services = makeServices();
    const plugin = makePlugin(services);

    await plugin.updateApiToken("token");

    expect(services.todoist.initialize).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
    expect(runtime.notices).toEqual([]);
  });

  it.each([
    ["disabled", false, 60],
    ["a zero interval", true, 0],
  ])("does not schedule Auto-refresh when %s", async (_label, enabled, interval) => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: interval, autoRefreshToggle: enabled }),
    );
    const setTimeout = vi.spyOn(window, "setTimeout");
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(setTimeout).not.toHaveBeenCalled();
    expect(runtime.registerInterval).not.toHaveBeenCalled();
  });

  it("converts the shared Auto-refresh interval from seconds to milliseconds", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 45, autoRefreshToggle: true }),
    );
    const timeoutId = 17 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeout = vi.spyOn(window, "setTimeout").mockReturnValue(timeoutId);
    const plugin = makePlugin(services);

    await plugin.onload();

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(runtime.registerInterval).not.toHaveBeenCalled();
  });

  it("replaces the timer only when an Auto-refresh setting changes", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const setTimeout = vi
      .spyOn(window, "setTimeout")
      .mockReturnValueOnce(31 as unknown as ReturnType<typeof window.setTimeout>)
      .mockReturnValueOnce(32 as unknown as ReturnType<typeof window.setTimeout>);
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const plugin = makePlugin(services);
    await plugin.onload();

    await plugin.writeOptions({ projectSyncEnabled: true });

    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(clearTimeout).not.toHaveBeenCalled();

    await plugin.writeOptions({ autoRefreshInterval: 90 });

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(31);
    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 90_000);

    await plugin.writeOptions({ debugLogging: true });

    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(clearTimeout).toHaveBeenCalledOnce();
  });

  it("clears the active timer when Auto-refresh is toggled off", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 60, autoRefreshToggle: true }),
    );
    const timeoutId = 41 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeout = vi.spyOn(window, "setTimeout").mockReturnValue(timeoutId);
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const plugin = makePlugin(services);
    await plugin.onload();

    await plugin.writeOptions({ autoRefreshToggle: false });

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(timeoutId);
    expect(setTimeout).toHaveBeenCalledOnce();
  });

  it("clears the active Auto-refresh timer on unload", async () => {
    const services = makeServices();
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 60, autoRefreshToggle: true }),
    );
    const timeoutId = 42 as unknown as ReturnType<typeof window.setTimeout>;
    vi.spyOn(window, "setTimeout").mockReturnValue(timeoutId);
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const plugin = makePlugin(services);
    await plugin.onload();

    plugin.onunload();

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(timeoutId);
  });

  it("does not overlap cycles and waits a full interval after one settles", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const firstRefresh = deferred<boolean>();
    services.todoist.syncMetadata
      .mockImplementationOnce(async () => await firstRefresh.promise)
      .mockResolvedValueOnce(true);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(30_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(37_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    firstRefresh.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(29_999);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(services.todoist.syncMetadata).toHaveBeenCalledTimes(2);
  });

  it("waits a full interval after a failed scheduled cycle settles", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const firstRefresh = deferred<boolean>();
    services.todoist.syncMetadata
      .mockImplementationOnce(async () => await firstRefresh.promise)
      .mockResolvedValueOnce(true);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 45, autoRefreshToggle: true }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(45_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(17_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    firstRefresh.reject(new Error("refresh failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      "Scheduled Todoist auto-refresh failed:",
      expect.objectContaining({ message: "refresh failed" }),
    );

    vi.advanceTimersByTime(44_999);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(services.todoist.syncMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not let an older in-flight cycle revive the previous interval after a setting change", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const firstRefresh = deferred<boolean>();
    services.todoist.syncMetadata
      .mockImplementationOnce(async () => await firstRefresh.promise)
      .mockResolvedValueOnce(true);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(30_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    await plugin.writeOptions({ autoRefreshInterval: 90 });
    vi.advanceTimersByTime(37_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    firstRefresh.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(89_999);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(services.todoist.syncMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    "success",
    "failure",
  ] as const)("waits a full interval after a manual Project sync %s settles", async (outcome) => {
    vi.useFakeTimers();
    const services = makeServices();
    const manualRefresh = deferred<boolean>();
    services.todoist.sync.mockImplementationOnce(async () => await manualRefresh.promise);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({
        autoRefreshInterval: 30,
        autoRefreshToggle: true,
        projectSyncEnabled: true,
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(25_000);
    const manual = plugin.syncProjectFolderNow();
    expect(services.todoist.sync).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30_000);
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();

    if (outcome === "success") {
      manualRefresh.resolve(true);
    } else {
      manualRefresh.reject(new Error("manual refresh failed"));
    }
    await manual;

    vi.advanceTimersByTime(29_999);
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("uses the last overlapping manual Project sync settlement as the cadence boundary", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const firstRefresh = deferred<boolean>();
    const secondRefresh = deferred<boolean>();
    services.todoist.sync
      .mockImplementationOnce(async () => await firstRefresh.promise)
      .mockImplementationOnce(async () => await secondRefresh.promise);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(20_000);
    const firstManual = plugin.syncProjectFolderNow();
    vi.advanceTimersByTime(5000);
    const secondManual = plugin.syncProjectFolderNow();

    firstRefresh.resolve(true);
    await firstManual;
    vi.advanceTimersByTime(60_000);
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();

    secondRefresh.resolve(true);
    await secondManual;
    vi.advanceTimersByTime(29_999);
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
  });

  it.each([
    "disabled",
    "unloaded",
  ] as const)("does not let an in-flight cycle revive Auto-refresh after it is %s", async (endState) => {
    vi.useFakeTimers();
    const services = makeServices();
    const firstRefresh = deferred<boolean>();
    services.todoist.syncMetadata.mockImplementationOnce(async () => await firstRefresh.promise);
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({ autoRefreshInterval: 30, autoRefreshToggle: true }),
    );
    const plugin = makePlugin(services);
    await plugin.onload();

    vi.advanceTimersByTime(30_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();

    if (endState === "disabled") {
      await plugin.writeOptions({ autoRefreshToggle: false });
    } else {
      plugin.onunload();
    }
    firstRefresh.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(300_000);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
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
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("runs automatic Project sync independently on every device", async () => {
    const firstDeviceServices = makeServices();
    const secondDeviceServices = makeServices();
    firstDeviceServices.projectSync.sync.mockResolvedValueOnce(emptyResult());
    secondDeviceServices.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const firstDevice = makePlugin(firstDeviceServices);
    const secondDevice = makePlugin(secondDeviceServices);

    await Promise.all([
      internals(firstDevice).runScheduledSync(),
      internals(secondDevice).runScheduledSync(),
    ]);

    expect(firstDeviceServices.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(secondDeviceServices.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(firstDeviceServices.projectSync.sync).toHaveBeenCalledOnce();
    expect(secondDeviceServices.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("does not defer Fully synced when the coarse Sync engine status is still syncing", async () => {
    const services = makeServices();
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({ coreStatus: "syncing", syncStatus: "Fully synced" });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("does not defer automatic Project sync during an upload-only cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({
      coreStatus: "syncing",
      syncStatus: "Fully synced",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    const baseline = internals(plugin).runScheduledSync();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS + 250);
    await baseline;
    services.projectSync.sync.mockClear();
    services.todoist.syncMetadata.mockClear();

    sync.instance.syncStatus = "Uploading Tasks/Work/Local task.md";
    sync.emitStatusChange();
    await internals(plugin).runScheduledSync();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.invalidate).not.toHaveBeenCalled();
  });

  it("runs automatic Project sync when official Sync is confidently absent or disabled", async () => {
    const privateSurfaces: [string, unknown][] = [
      [
        "absent",
        {
          getEnabledPluginById: vi.fn(() => undefined),
          getPluginById: vi.fn(() => undefined),
        },
      ],
      [
        "disabled",
        {
          getEnabledPluginById: vi.fn(() => undefined),
          getPluginById: vi.fn(() => ({
            enabled: false,
            instance: makeSyncHarness({
              newServerFiles: [{ path: "Tasks/Remote task.md" }],
            }).instance,
          })),
        },
      ],
    ];

    for (const [surfaceName, internalPlugins] of privateSurfaces) {
      const services = makeServices();
      services.projectSync.sync.mockResolvedValueOnce(emptyResult());
      runtime.settings.current = defaultSettings({
        autoRefreshToggle: true,
        projectSyncEnabled: true,
      });
      const plugin = makePlugin(services, vi.fn(), internalPlugins);

      await internals(plugin).runScheduledSync();

      expect(services.todoist.syncMetadata, surfaceName).toHaveBeenCalledOnce();
      expect(services.projectSync.sync, surfaceName).toHaveBeenCalledOnce();
    }
  });

  it("skips automatic Project sync for an enabled but malformed private Sync surface", async () => {
    const services = makeServices();
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services, vi.fn(), {
      getEnabledPluginById: vi.fn(() => ({ getStatus: () => "syncing" })),
    });

    await internals(plugin).runScheduledSync();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("keeps one scheduled promise pending through incoming Sync and resumes after settling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({
      coreStatus: "syncing",
      newServerFiles: [{ path: "Tasks/Work/Remote task.md" }],
      syncStatus: "Downloading Tasks/Work/Remote task.md",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    const first = internals(plugin).runScheduledSync();
    const second = internals(plugin).runScheduledSync();
    expect(second).toBe(first);
    await flushPromises();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    sync.instance.newServerFiles = [];
    sync.instance.syncStatus = "Uploading Tasks/Work/Local task.md";
    sync.emitStatusChange();
    await flushPromises();
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    sync.instance.syncStatus = "Fully synced";
    sync.emitStatusChange();
    await vi.advanceTimersByTimeAsync(749);
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("ends an invalidated in-flight Project sync and retries only after the next full interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    const firstProjection = deferred<ProjectSyncResult | null>();
    services.projectSync.sync
      .mockImplementationOnce(async () => await firstProjection.promise)
      .mockResolvedValueOnce(emptyResult());
    runtime.loadData.mockResolvedValueOnce(
      defaultSettings({
        autoRefreshInterval: 30,
        autoRefreshToggle: true,
        projectSyncEnabled: true,
        projectSyncMappings: [
          {
            folder: "Tasks/Work",
            id: "mapping-work",
            includeSubprojects: true,
            previousFolders: [],
            project: { projectId: "work", projectName: "Work" },
          },
        ],
      }),
    );
    const plugin = makePlugin(services);
    const gate = (
      plugin as unknown as {
        obsidianSyncGate: {
          isPermitCurrent(permit: { generation: number }): boolean;
          monitor<T>(operation: () => Promise<T>): Promise<T>;
          waitForSafePermit(): Promise<{ generation: number } | null>;
        };
      }
    ).obsidianSyncGate;
    const permit = { generation: 1 };
    let permitCurrent = true;
    vi.spyOn(gate, "waitForSafePermit").mockResolvedValue(permit);
    vi.spyOn(gate, "monitor").mockImplementation(async (operation) => await operation());
    vi.spyOn(gate, "isPermitCurrent").mockImplementation(() => permitCurrent);
    await plugin.onload();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
      expect(services.projectSync.sync).toHaveBeenCalledOnce();
    });

    permitCurrent = false;
    firstProjection.resolve(emptyResult());
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();

    // The gate polls at 250 ms; this reaches the first poll after the restarted settle deadline.
    await vi.advanceTimersByTimeAsync(2);

    expect(services.todoist.syncMetadata).toHaveBeenCalledTimes(2);
    // The new cycle sees the invalid permit and ends without another Project sync.
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled incoming-Sync wait when Project sync is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Work/Remote task.md" }],
      syncStatus: "Downloading Tasks/Work/Remote task.md",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    const scheduled = internals(plugin).runScheduledSync();
    await flushPromises();
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    await plugin.writeOptions({ projectSyncEnabled: false });
    await vi.advanceTimersByTimeAsync(250);
    await scheduled;

    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("restarts the Sync settle window after late mapped Vault activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    const stored = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          id: "mapping-work",
          project: { projectId: "work", projectName: "Work" },
          folder: "Tasks/Work",
          includeSubprojects: true,
          previousFolders: [],
        },
      ],
    });
    runtime.loadData.mockResolvedValueOnce(stored);
    runtime.settings.current = stored;
    const sync = makeSyncHarness({ syncStatus: "Fully synced" });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);
    await plugin.onload();
    services.projectSync.invalidate.mockClear();

    const scheduled = internals(plugin).runScheduledSync();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    vaultActivityListener("modify")({ path: "Tasks/Work/Remote task.md" });
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    // The gate polls at 250 ms; this reaches the first poll after the restarted settle deadline.
    await vi.advanceTimersByTimeAsync(2);
    await scheduled;

    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("invalidates Project sync when an ancestor of a mapped folder is renamed", async () => {
    const services = makeServices();
    const stored = defaultSettings({
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          id: "mapping-work",
          project: { projectId: "work", projectName: "Work" },
          folder: "Tasks/Work",
          includeSubprojects: true,
          previousFolders: [],
        },
      ],
    });
    runtime.loadData.mockResolvedValueOnce(stored);
    runtime.settings.current = stored;
    const plugin = makePlugin(services);
    await plugin.onload();
    services.projectSync.invalidate.mockClear();

    vaultActivityListener("rename")({ path: "Archived Tasks" }, "Tasks");

    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
  });

  it("does not treat an exact path-scoped plugin mutation as external Sync activity", async () => {
    const services = makeServices();
    const stored = defaultSettings({
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          id: "mapping-work",
          project: { projectId: "work", projectName: "Work" },
          folder: "Tasks/Work",
          includeSubprojects: true,
          previousFolders: [],
        },
      ],
    });
    runtime.loadData.mockResolvedValueOnce(stored);
    runtime.settings.current = stored;
    const plugin = makePlugin(services);
    await plugin.onload();
    services.projectSync.invalidate.mockClear();
    const modify = vaultActivityListener("modify");

    const result = await plugin.runAutomaticProjectProjection(async () => {
      return await plugin.runProjectSyncVaultMutation(["Tasks/Work/Task.md"], async () => {
        modify({ path: "Tasks/Work/Task.md" });
        return 42;
      });
    });

    expect(result).toEqual({ performed: true, value: 42 });
    expect(services.projectSync.invalidate).not.toHaveBeenCalled();

    const interrupted = await plugin.runAutomaticProjectProjection(async (assertValid) => {
      modify({ path: "Tasks/Work/Task.md" });
      assertValid();
      return 99;
    });

    expect(interrupted).toEqual({ performed: false });
    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
  });

  it("invalidates an automatic task projection when incoming Sync starts during it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    runtime.settings.current = defaultSettings({ projectSyncEnabled: true });
    const sync = makeSyncHarness({
      syncStatus: "Fully synced",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    const projection = plugin.runAutomaticProjectProjection(async () => {
      sync.instance.newServerFiles = [{ path: "Tasks/Work/Remote task.md" }];
      sync.instance.syncStatus = "Downloading Tasks/Work/Remote task.md";
      sync.emitStatusChange();
      return 42;
    });
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const result = await projection;

    expect(result).toEqual({ performed: false });
    expect(services.projectSync.invalidate).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping scheduled ticks into one refresh", async () => {
    const services = makeServices();
    const todoistSync = deferred<boolean>();
    services.todoist.syncMetadata.mockImplementationOnce(async () => await todoistSync.promise);
    services.projectSync.sync.mockResolvedValueOnce(emptyResult());
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    const first = internals(plugin).runScheduledSync();
    const second = internals(plugin).runScheduledSync();
    await vi.waitFor(() => expect(services.todoist.syncMetadata).toHaveBeenCalledOnce());

    expect(second).toBe(first);
    todoistSync.resolve(true);
    await Promise.all([first, second]);

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.todoist.sync).not.toHaveBeenCalled();
    expect(services.projectSync.sync).toHaveBeenCalledOnce();
  });

  it("refreshes only shared metadata when Project sync is disabled", async () => {
    const services = makeServices();
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: false,
    });
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.todoist.sync).not.toHaveBeenCalled();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("does not run Project sync when the metadata refresh fails", async () => {
    const services = makeServices();
    services.todoist.syncMetadata.mockResolvedValueOnce(false);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const plugin = makePlugin(services);

    await internals(plugin).runScheduledSync();

    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.todoist.sync).not.toHaveBeenCalled();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
  });

  it("waits for incoming official Sync before a manual Project projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const services = makeServices();
    services.projectSync.getConfig.mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [],
    });
    const result = emptyResult();
    services.projectSync.sync.mockResolvedValue(result);
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: false,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Work/Remote task.md" }],
      syncStatus: "Downloading Tasks/Work/Remote task.md",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    await plugin.updateApiToken("token");
    const manual = plugin.syncProjectFolderNow();
    await flushPromises();

    expect(services.todoist.initialize).toHaveBeenCalledOnce();
    expect(services.todoist.sync).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();
    expect(services.todoist.syncMetadata).not.toHaveBeenCalled();

    sync.instance.newServerFiles = [];
    sync.instance.syncStatus = "Fully synced";
    sync.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    await manual;

    expect(services.projectSync.sync).toHaveBeenCalledOnce();
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

  it("cancels a scheduled incoming-Sync wait after unload", async () => {
    const services = makeServices();
    runtime.settings.current = defaultSettings({
      autoRefreshToggle: true,
      projectSyncEnabled: true,
    });
    const sync = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Work/Remote task.md" }],
      syncStatus: "Downloading Tasks/Work/Remote task.md",
    });
    const plugin = makePlugin(services, vi.fn(), sync.internalPlugins);

    const scheduled = internals(plugin).runScheduledSync();
    await flushPromises();
    expect(services.todoist.syncMetadata).toHaveBeenCalledOnce();
    expect(services.projectSync.sync).not.toHaveBeenCalled();

    plugin.onunload();
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

  it("migrates version 5 settings to the fail-safe unmanaged-content default", async () => {
    const services = makeServices();
    const onLayoutReady = vi.fn();
    const stored = defaultSettings({ version: 5 });
    delete stored.projectSyncPreserveUnmanagedItems;
    runtime.loadData.mockResolvedValueOnce(stored);
    const plugin = makePlugin(services, onLayoutReady);

    await plugin.onload();
    const [layoutReady] = onLayoutReady.mock.calls[0] as [() => Promise<void>];
    await layoutReady();

    expect(runtime.settings.current).toMatchObject({
      projectSyncPreserveUnmanagedItems: true,
      version: 6,
    });
    const lastSave = runtime.saveData.mock.calls[runtime.saveData.mock.calls.length - 1]?.[0];
    expect(lastSave).toMatchObject({
      projectSyncPreserveUnmanagedItems: true,
      version: 6,
    });
  });
});
