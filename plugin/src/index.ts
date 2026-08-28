import { uiText } from "@/uiText";
import "@/styles/main.scss";
import type { PluginManifest } from "obsidian";
import { type App, Notice, normalizePath, Plugin } from "obsidian";

import { TodoistApiClient } from "@/api";
import type { TaskId } from "@/api/domain/task";
import { ObsidianFetcher } from "@/api/fetcher";
import {
  createTasksListViewRegistration,
  TASKS_LIST_VIEW_ID,
  type TodoistListActions,
  type TodoistListProjectContextSource,
} from "@/bases/todoist-list";
import { registerCommands } from "@/commands";
import type { DataAccessor } from "@/data/hydrate";
import { QueryCache } from "@/data/queryCache";
import type { CompletedTasksProgress } from "@/data/subscriptions";
import type { Task } from "@/data/task";
import { ObsidianSyncActivityGate } from "@/infra/obsidianSyncGate";
import { secondsToMillis } from "@/infra/time";
import {
  cloneProjectCatalog,
  decodeProjectSyncFolderOwnershipRegistry,
  emptyProjectSyncFolderOwnershipRegistry,
  isProjectSyncPath,
  LEGACY_PROJECT_TASK_CODE_BLOCK,
  listOwnedFolders,
  type ManagedFolderCreation,
  type ManagedFolderRelocation,
  mergeProjectCatalogCollections,
  mergeProjectSyncFolderOwnershipRegistries,
  PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY,
  PROJECT_TASK_CODE_BLOCK,
  type ProjectCatalog,
  type ProjectCatalogCollection,
  type ProjectCatalogStorage,
  ProjectSyncActivityTracker,
  type ProjectSyncConfig,
  type ProjectSyncFolderOwnershipOpaqueData,
  type ProjectSyncFolderOwnershipRegistry,
  type ProjectSyncFolderOwnershipStorage,
  type ProjectSyncResult,
  readProjectCatalogCollection,
  recordCreatedFolders as recordCreatedFolderOwnership,
  releaseOwnedFolderPaths as releaseFolderOwnership,
  relocateOwnedFolders as relocateFolderOwnership,
  withProjectCatalogCollection,
  withProjectSyncFolderOwnershipRegistry,
} from "@/project-sync";
import { ProjectTaskCardInjector } from "@/project-sync/taskCardInjector";
import { LEGACY_QUERY_CODE_BLOCK, QUERY_CODE_BLOCK, QueryInjector } from "@/query/injector";
import { makeServices, type Services } from "@/services";
import {
  type ProjectTaskAutomaticProjectionResult,
  ProjectTaskProjectionError,
} from "@/services/projectTaskCommands";
import {
  normalizeAutoRefreshInterval,
  normalizeSettings,
  type Settings,
  useSettingsStore,
} from "@/settings";
import { SettingsTab } from "@/ui/settings";

const hexadecimalRadix = 16;
const byteHexWidth = 2;
const queryCacheStorageKey = "tasks-bridge:query-cache:v2";
const projectSyncFolderOwnershipStorageKey = "tasks-bridge:project-sync-folder-ownership:v2";
const projectSyncFolderOwnershipRetryInitialMs = 1000;
const projectSyncFolderOwnershipRetryMaximumMs = 30_000;

type AsyncGeneration = {
  apiToken: number;
  projectSyncConfig: number;
};

// biome-ignore lint/style/noDefaultExport: We must use default export for Obsidian plugins
export default class TodoistPlugin extends Plugin {
  public readonly services: Services;
  public readonly queryCache = new QueryCache();
  public readonly projectCatalogStorage: ProjectCatalogStorage;
  public readonly projectSyncFolderOwnershipStorage: ProjectSyncFolderOwnershipStorage;

  private settingsQueue: Promise<void> = Promise.resolve();
  private settingsOperationGeneration = 0;
  private completedSettingsOperationGeneration = 0;
  private apiTokenUpdateQueue: Promise<void> = Promise.resolve();
  private apiTokenGeneration = 0;
  private projectSyncConfigGeneration = 0;
  private autoRefreshTimeoutId: number | undefined;
  private autoRefreshScheduleGeneration = 0;
  private scheduledSyncInFlight: Promise<void> | undefined;
  private manualProjectSyncInFlightCount = 0;
  private readonly projectSyncActivity = new ProjectSyncActivityTracker();
  private readonly obsidianSyncGate: ObsidianSyncActivityGate;
  private disposed = false;
  private projectCatalogs: ProjectCatalogCollection = {};
  private projectSyncFolderOwnership: ProjectSyncFolderOwnershipRegistry =
    emptyProjectSyncFolderOwnershipRegistry();
  private projectSyncFolderOwnershipOpaque: ProjectSyncFolderOwnershipOpaqueData | undefined;
  private projectSyncFolderOwnershipNeedsPersist = false;
  private projectSyncFolderOwnershipShadowIsOpaque = false;
  private projectSyncFolderOwnershipRetryTimeoutId: number | undefined;
  private projectSyncFolderOwnershipRetryDelayMs = projectSyncFolderOwnershipRetryInitialMs;

  constructor(app: App, pluginManifest: PluginManifest) {
    super(app, pluginManifest);
    this.projectCatalogStorage = {
      getCatalog: (mappingId) => {
        const catalog = this.projectCatalogs[mappingId];
        return catalog === undefined ? null : cloneProjectCatalog(catalog);
      },
      persistCatalogs: async (catalogs) => await this.persistProjectCatalogs(catalogs),
    };
    this.projectSyncFolderOwnershipStorage = {
      listOwnedFolders: (mappingId) =>
        this.projectSyncFolderOwnershipShadowIsOpaque
          ? []
          : listOwnedFolders(this.projectSyncFolderOwnership, mappingId),
      recordCreatedFolder: async (input) => await this.persistCreatedFolders([input]),
      recordCreatedFolders: async (inputs) => await this.persistCreatedFolders(inputs),
      relocateOwnedFolders: async (inputs) => await this.persistRelocatedFolders(inputs),
      releaseOwnedFolderPath: async (mappingId, path) =>
        await this.persistReleasedFolderPaths(mappingId, [path]),
      releaseOwnedFolderPaths: async (mappingId, paths) =>
        await this.persistReleasedFolderPaths(mappingId, paths),
    };
    this.services = makeServices(this);
    this.obsidianSyncGate = new ObsidianSyncActivityGate(app, {
      onInbound: () => this.services.projectSync.invalidate(),
    });
  }

  async onload() {
    await this.loadOptions();
    if (this.disposed) {
      return;
    }
    await this.bindQueryCacheToCurrentCredential();
    if (this.disposed) {
      return;
    }

    const queryInjector = new QueryInjector(this);
    const projectTaskCardInjector = new ProjectTaskCardInjector(this);
    this.registerBasesView(
      TASKS_LIST_VIEW_ID,
      createTasksListViewRegistration(
        this.makeTodoistListActions(),
        this.makeTodoistListProjectContextSource(),
      ),
    );
    this.registerMarkdownCodeBlockProcessor(
      QUERY_CODE_BLOCK,
      queryInjector.onNewBlock.bind(queryInjector),
    );
    this.registerMarkdownCodeBlockProcessor(
      PROJECT_TASK_CODE_BLOCK,
      projectTaskCardInjector.onNewBlock.bind(projectTaskCardInjector),
    );
    // Keep the old names readable for users who have not migrated their notes yet. All generated
    // content and documentation use the canonical Tasks Bridge names above.
    this.registerMarkdownCodeBlockProcessor(
      LEGACY_QUERY_CODE_BLOCK,
      queryInjector.onNewBlock.bind(queryInjector),
    );
    this.registerMarkdownCodeBlockProcessor(
      LEGACY_PROJECT_TASK_CODE_BLOCK,
      projectTaskCardInjector.onLegacyBlock.bind(projectTaskCardInjector),
    );
    this.addSettingTab(new SettingsTab(this.app, this));

    registerCommands(this);
    this.registerProjectSyncVaultActivityListeners();
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        this.services.projectTaskProperties.handleMetadataChange(file, cache);
      }),
    );
    try {
      await this.services.projectSync.refreshStatisticsFromLocalProjection();
    } catch (error: unknown) {
      console.error("Failed to load the local Project Overview projection:", error);
    }
    if (this.disposed) {
      return;
    }
    this.obsidianSyncGate.start((eventRef) => this.registerEvent(eventRef));
    this.applyAutoRefreshSchedule();

    this.app.workspace.onLayoutReady(async () => {
      if (this.disposed) {
        return;
      }

      try {
        await this.applyMigrations();
      } catch (error: unknown) {
        if (this.disposed) {
          return;
        }
        console.error("Failed to apply migrations:", error);
        new Notice(uiText.notices.migrationFailed);
      }

      if (this.disposed) {
        return;
      }
      await this.loadApiClient();
    });
  }

  private makeTodoistListActions(): TodoistListActions {
    return {
      isReady: () => this.services.projectTasks.isReady(),
      completeTask: async (task) => {
        try {
          return await this.services.projectTasks.completeTask({
            id: task.id,
            filePath: task.filePath,
          });
        } catch (error: unknown) {
          if (!(error instanceof ProjectTaskProjectionError)) {
            throw error;
          }
          console.error("Todoist task completed, but Project sync failed", error.projectionCause);
          new Notice(uiText.editTaskModal.projectionErrorNotice);
          throw error;
        }
      },
      reopenTask: async (task) => {
        try {
          return await this.services.projectTasks.reopenTask({
            id: task.id,
            filePath: task.filePath,
          });
        } catch (error: unknown) {
          if (!(error instanceof ProjectTaskProjectionError)) {
            throw error;
          }
          console.error("Todoist task reopened, but Project sync failed", error.projectionCause);
          new Notice(uiText.editTaskModal.projectionErrorNotice);
          throw error;
        }
      },
      editTask: async (task) => {
        const reference = { id: task.id, filePath: task.filePath };
        const currentTask = await this.services.projectTasks.loadEditableTask(reference);
        this.services.modals.taskEdit({
          task: currentTask,
          projectPath: task.projectPath.join(" / "),
          sectionName: task.sectionName,
          onSubmit: async (params) => {
            await this.services.projectTasks.updateTask(reference, params);
          },
        });
      },
    };
  }

  private makeTodoistListProjectContextSource(): TodoistListProjectContextSource {
    return {
      getConfig: () => this.services.projectSync.getConfig(),
      getProjects: () => this.services.projectSync.listProjects(),
      getContext: () => {
        const config = this.services.projectSync.getConfig();
        const scopes = config.mappings.flatMap((mapping) => {
          const catalog = this.projectCatalogStorage.getCatalog(mapping.id);
          if (
            mapping.project === null ||
            catalog === null ||
            catalog.rootProjectId !== mapping.project.projectId ||
            catalog.includeSubprojects !== mapping.includeSubprojects
          ) {
            return [];
          }

          return [
            {
              mappingId: catalog.mappingId,
              rootProjectId: catalog.rootProjectId,
              projects: catalog.projects.map((project) => ({ ...project })),
              tasks: catalog.tasks.map((task) => ({ ...task })),
            },
          ];
        });
        return scopes.length === 0 ? null : { scopes };
      },
      subscribeContext: (listener) => this.services.projectSync.subscribe(() => listener()),
    };
  }

  onunload(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearAutoRefreshSchedule();
    this.clearProjectSyncFolderOwnershipRetry();
    this.obsidianSyncGate.dispose();
    this.apiTokenGeneration++;
    this.projectSyncConfigGeneration++;
    this.services.todoist.reset();
    this.services.projectTaskProperties.dispose();
    this.services.projectSync.dispose();
  }

  private async loadApiClient(): Promise<void> {
    const generation = this.captureAsyncGeneration();
    const accessor = this.services.token;
    const token = await accessor.read();
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    if (token !== null) {
      await this.initializeApiClient(token, generation);
      return;
    }

    this.services.modals.onboarding({
      onTokenSubmit: async (token) => {
        await this.updateApiToken(token);
      },
    });
  }

  async loadOptions(): Promise<void> {
    const storedDataRead = this.loadData();
    await this.enqueueSettingsOperation(async () => {
      const storedData: unknown = await storedDataRead;
      if (this.disposed) {
        return;
      }

      const localQueryCache: unknown = this.app.loadLocalStorage(queryCacheStorageKey);
      const legacyQueryCache = isRecord(storedData) ? storedData.queryCache : undefined;
      this.queryCache.load(localQueryCache ?? legacyQueryCache);
      if (localQueryCache === null && legacyQueryCache !== undefined) {
        await this.persistQueryCache();
      }

      const options = normalizeSettings(storedData);
      this.projectCatalogs = readProjectCatalogCollection(storedData);
      const storedFolderOwnership = decodeProjectSyncFolderOwnershipRegistry(storedData);
      const localFolderOwnership = decodeProjectSyncFolderOwnershipRegistry(
        this.app.loadLocalStorage(projectSyncFolderOwnershipStorageKey),
      );
      this.projectSyncFolderOwnershipShadowIsOpaque = localFolderOwnership.status === "opaque";
      let folderOwnershipNeedsRestore = false;
      if (storedFolderOwnership.status === "opaque") {
        // A future or malformed synchronized schema must never be rewritten or interpreted as
        // deletion authority. Keep it byte-for-byte and disable folder cleanup until supported.
        this.projectSyncFolderOwnership = emptyProjectSyncFolderOwnershipRegistry();
        this.projectSyncFolderOwnershipOpaque = storedFolderOwnership.opaque;
        this.projectSyncFolderOwnershipNeedsPersist = false;
      } else if (this.projectSyncFolderOwnershipShadowIsOpaque) {
        // A downgraded plugin cannot safely interpret or overwrite a newer device-local safety
        // shadow. Keep synchronized data intact, but grant no folder-deletion authority.
        this.projectSyncFolderOwnership = storedFolderOwnership.registry;
        this.projectSyncFolderOwnershipOpaque = undefined;
        this.projectSyncFolderOwnershipNeedsPersist = false;
      } else {
        // Device-local storage is only a safety journal for revocations. Restoring active grants
        // after data.json was reset could make an unrelated same-path folder deletable.
        const localRevocations = hasFolderOwnershipRecoveryContext(storedData)
          ? folderOwnershipRevocationsOnly(localFolderOwnership.registry)
          : emptyProjectSyncFolderOwnershipRegistry();
        const mergedFolderOwnership = mergeProjectSyncFolderOwnershipRegistries(
          storedFolderOwnership.registry,
          localRevocations,
        );
        folderOwnershipNeedsRestore =
          JSON.stringify(mergedFolderOwnership) !== JSON.stringify(storedFolderOwnership.registry);
        this.projectSyncFolderOwnership = mergedFolderOwnership;
        this.projectSyncFolderOwnershipOpaque = undefined;
        this.projectSyncFolderOwnershipNeedsPersist = folderOwnershipNeedsRestore;
        if (
          !isEmptyProjectSyncFolderOwnershipRegistry(mergedFolderOwnership) ||
          localFolderOwnership.status !== "missing"
        ) {
          this.persistProjectSyncFolderOwnershipShadow();
        }
      }
      const folderOwnershipScopesRevoked =
        this.releaseProjectSyncFolderOwnershipOutsideSettings(options);
      useSettingsStore.setState(options, true);
      this.applyProjectSyncConfig();

      if (
        folderOwnershipNeedsRestore ||
        folderOwnershipScopesRevoked ||
        !hasCanonicalStoredSettings(storedData, options)
      ) {
        // Besides normalizing legacy settings, this removes the legacy queryCache field after it
        // has been migrated to vault-specific, device-local storage.
        await this.persistSettings();
      }
    });
  }

  async writeOptions(update: Partial<Settings>): Promise<void> {
    if (this.disposed) {
      return;
    }

    await this.enqueueSettingsOperation(async () => {
      if (this.disposed) {
        return;
      }

      const normalizedUpdate =
        update.autoRefreshInterval === undefined
          ? update
          : {
              ...update,
              autoRefreshInterval: normalizeAutoRefreshInterval(update.autoRefreshInterval),
            };
      const previousSettings = useSettingsStore.getState();
      useSettingsStore.setState(normalizedUpdate);
      this.releaseProjectSyncFolderOwnershipOutsideSettings(useSettingsStore.getState());
      this.applySettingsRuntime(previousSettings);
      await this.persistSettings();
    });
  }

  onExternalSettingsChange(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    // Start the read before queueing. If a local save was already in flight when Sync replaced
    // data.json, this captures Sync's version before that stale save can finish and overwrite it.
    const storedDataRead = this.loadData();
    const restoreAfterOlderSettingsOperation =
      this.completedSettingsOperationGeneration < this.settingsOperationGeneration;
    return this.enqueueSettingsOperation(async () => {
      const storedData: unknown = await storedDataRead;
      if (this.disposed) {
        return;
      }

      const previousSettings = useSettingsStore.getState();
      const externalCatalogs = readProjectCatalogCollection(storedData);
      const mergedCatalogs = mergeProjectCatalogCollections(this.projectCatalogs, externalCatalogs);
      const catalogsNeedRestore =
        JSON.stringify(mergedCatalogs) !== JSON.stringify(externalCatalogs);
      this.projectCatalogs = mergedCatalogs;
      const externalFolderOwnership = decodeProjectSyncFolderOwnershipRegistry(storedData);
      let folderOwnershipNeedsRestore = false;
      if (externalFolderOwnership.status === "opaque") {
        // An unsupported synchronized schema takes precedence over locally understood data. It is
        // preserved exactly and folder deletion authority is disabled, while the device-local
        // shadow remains available to a future compatible version.
        this.projectSyncFolderOwnership = emptyProjectSyncFolderOwnershipRegistry();
        this.projectSyncFolderOwnershipOpaque = externalFolderOwnership.opaque;
        this.projectSyncFolderOwnershipNeedsPersist = false;
      } else if (this.projectSyncFolderOwnershipOpaque !== undefined) {
        // A current process that already observed an unsupported newer schema must not replace it
        // with an older device's valid-but-stale envelope.
        folderOwnershipNeedsRestore = true;
        this.projectSyncFolderOwnershipNeedsPersist = true;
      } else if (this.projectSyncFolderOwnershipShadowIsOpaque) {
        // Do not merge or rewrite ownership while a newer local safety journal is present.
        this.projectSyncFolderOwnership = externalFolderOwnership.registry;
        this.projectSyncFolderOwnershipNeedsPersist = false;
      } else {
        const mergedFolderOwnership = mergeProjectSyncFolderOwnershipRegistries(
          this.projectSyncFolderOwnership,
          externalFolderOwnership.registry,
        );
        folderOwnershipNeedsRestore =
          JSON.stringify(mergedFolderOwnership) !==
          JSON.stringify(externalFolderOwnership.registry);
        this.projectSyncFolderOwnership = mergedFolderOwnership;
        this.projectSyncFolderOwnershipNeedsPersist ||= folderOwnershipNeedsRestore;
        if (!isEmptyProjectSyncFolderOwnershipRegistry(mergedFolderOwnership)) {
          this.persistProjectSyncFolderOwnershipShadow();
        }
      }
      const nextSettings = normalizeSettings(
        mergeExternalStoredSettings(storedData, previousSettings),
      );
      const credentialSettingsChanged = hasDifferentCredentialSettings(
        previousSettings,
        nextSettings,
      );
      const folderOwnershipScopesRevoked =
        this.releaseProjectSyncFolderOwnershipOutsideSettings(nextSettings);
      useSettingsStore.setState(nextSettings, true);
      this.applySettingsRuntime(previousSettings);
      this.services.projectSync.reloadStatisticsCatalogs();
      if (credentialSettingsChanged) {
        this.reloadApiClientAfterExternalSettingsChange();
      }

      if (
        restoreAfterOlderSettingsOperation ||
        catalogsNeedRestore ||
        folderOwnershipNeedsRestore ||
        folderOwnershipScopesRevoked ||
        !hasCanonicalStoredSettings(storedData, nextSettings)
      ) {
        // Restore the captured external version after any older in-flight local save and ensure a
        // legacy cache received from another device is not retained in the synchronized file.
        await this.persistSettings();
      }
    });
  }

  async syncProjectFolderNow(): Promise<ProjectSyncResult | null> {
    // A manual Project sync refreshes the same shared Todoist/Project data as the global
    // scheduler. Treat it as a cadence boundary so an old timeout cannot fire immediately after
    // the user-requested refresh completes.
    this.manualProjectSyncInFlightCount++;
    this.clearAutoRefreshTimer();
    try {
      return await this.performManualProjectSync();
    } finally {
      this.manualProjectSyncInFlightCount--;
      this.scheduleNextAutoRefresh(this.autoRefreshScheduleGeneration);
    }
  }

  private async performManualProjectSync(): Promise<ProjectSyncResult | null> {
    const generation = this.captureAsyncGeneration();
    if (!this.isAsyncGenerationCurrent(generation)) {
      return null;
    }

    try {
      await this.services.todoist.sync();
    } catch (error: unknown) {
      if (!this.isAsyncGenerationCurrent(generation)) {
        return null;
      }
      console.error("Failed to synchronize Todoist query blocks:", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(uiText.notices.querySyncFailed(message));
    }

    if (!this.isAsyncGenerationCurrent(generation)) {
      return null;
    }

    if (!this.services.projectSync.getConfig().enabled) {
      return null;
    }

    try {
      const permit = await this.obsidianSyncGate.waitForSafePermit(() =>
        this.isAsyncGenerationCurrent(generation),
      );
      if (permit === null || !this.obsidianSyncGate.isPermitCurrent(permit)) {
        return null;
      }

      const result = await this.obsidianSyncGate.monitor(
        async () => await this.services.projectSync.sync(),
      );
      if (!this.isAsyncGenerationCurrent(generation)) {
        return null;
      }
      if (result === null) {
        new Notice(uiText.notices.projectSyncInterrupted);
        return null;
      }

      this.logProjectSyncConflicts(result, "Manual");
      new Notice(
        uiText.notices.projectSyncComplete(
          result.created,
          result.updated,
          result.moved,
          result.deleted,
          result.conflicts.length,
        ),
      );
      return result;
    } catch (error: unknown) {
      if (!this.isAsyncGenerationCurrent(generation)) {
        return null;
      }
      console.error("Failed to synchronize the Todoist project folder:", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(uiText.notices.projectSyncFailed(message));
      return null;
    }
  }

  public async runAutomaticProjectProjection<T>(
    operation: (assertValid: () => void) => Promise<T>,
  ): Promise<ProjectTaskAutomaticProjectionResult<T>> {
    const asyncGeneration = this.captureAsyncGeneration();
    if (
      !this.isAsyncGenerationCurrent(asyncGeneration) ||
      !this.canRunAutomaticProjectProjection()
    ) {
      return { performed: false };
    }

    const permit = await this.obsidianSyncGate.waitForSafePermit(
      () =>
        this.isAsyncGenerationCurrent(asyncGeneration) && this.canRunAutomaticProjectProjection(),
    );
    if (permit === null) {
      return { performed: false };
    }

    const activityGeneration = this.projectSyncActivity.generation();
    const assertValid = () => {
      if (
        activityGeneration !== this.projectSyncActivity.generation() ||
        !this.isAsyncGenerationCurrent(asyncGeneration) ||
        !this.canRunAutomaticProjectProjection() ||
        !this.obsidianSyncGate.isPermitCurrent(permit)
      ) {
        throw new AutomaticProjectProjectionInvalidatedError();
      }
    };

    try {
      return await this.obsidianSyncGate.monitor(async () => {
        assertValid();
        const value = await operation(assertValid);
        assertValid();
        return { performed: true, value };
      });
    } catch (error: unknown) {
      if (error instanceof AutomaticProjectProjectionInvalidatedError) {
        return { performed: false };
      }
      throw error;
    }
  }

  public async runProjectSyncVaultMutation<T>(
    affectedPaths: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.projectSyncActivity.runInternalMutation(affectedPaths, operation);
  }

  async writeQueryCache(
    filter: string,
    tasks: Task[],
    updatedAt: Date,
    completedTasks = false,
    completedTasksProgress?: CompletedTasksProgress,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.queryCache.set(filter, tasks, updatedAt, completedTasks, completedTasksProgress)) {
      return;
    }
    await this.persistQueryCache();
  }

  async rebindQueryCacheMetadata(data: DataAccessor): Promise<void> {
    if (this.disposed || !this.queryCache.rebindMetadata(data)) {
      return;
    }
    await this.persistQueryCache();
  }

  async completeTaskInAllQueryCaches(taskId: TaskId, completedAt: Date): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.queryCache.completeTaskInAll(taskId, completedAt)) {
      return;
    }
    await this.persistQueryCache();
  }

  async removeTaskFromAllQueryCaches(taskId: TaskId, updatedAt: Date): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.queryCache.removeTaskFromAll(taskId, updatedAt)) {
      return;
    }
    await this.persistQueryCache();
  }

  async updateApiToken(token: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const generation: AsyncGeneration = {
      apiToken: ++this.apiTokenGeneration,
      projectSyncConfig: this.projectSyncConfigGeneration,
    };
    this.services.projectSync.clearStatisticsSnapshot();
    this.services.projectSync.invalidate();
    this.services.todoist.reset();

    const update = this.apiTokenUpdateQueue
      .catch(() => undefined)
      .then(async () => await this.performApiTokenUpdate(token, generation));
    this.apiTokenUpdateQueue = update.catch(() => undefined);
    await update;
  }

  private async performApiTokenUpdate(token: string, generation: AsyncGeneration): Promise<void> {
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    await this.services.token.write(token);
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    const fingerprint = await fingerprintCredential(token);
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    const credentialChanged = this.queryCache.bindCredential(fingerprint);

    if (credentialChanged) {
      await this.persistQueryCache();
      if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
        return;
      }
    }

    await this.initializeApiClient(token, generation);
  }

  private runScheduledSync(): Promise<void> {
    if (this.scheduledSyncInFlight !== undefined) {
      return this.scheduledSyncInFlight;
    }

    const scheduled = this.performScheduledSync().finally(() => {
      if (this.scheduledSyncInFlight === scheduled) {
        this.scheduledSyncInFlight = undefined;
      }
    });
    this.scheduledSyncInFlight = scheduled;
    return scheduled;
  }

  private async performScheduledSync(): Promise<void> {
    if (!this.isAutoRefreshEnabled() || !this.services.todoist.isReady()) {
      return;
    }
    const generation = this.captureAsyncGeneration();
    if (!this.isAsyncGenerationCurrent(generation)) {
      return;
    }

    try {
      // QueryRoot owns query-block timers (including per-block overrides). This scheduler owns
      // shared metadata and Project sync only, avoiding a second refresh of every mounted block.
      const metadataSucceeded = await this.services.todoist.syncMetadata();
      if (
        !metadataSucceeded ||
        !this.isAsyncGenerationCurrent(generation) ||
        !this.isAutoRefreshEnabled()
      ) {
        return;
      }
      if (!useSettingsStore.getState().projectSyncEnabled) {
        return;
      }

      const permit = await this.obsidianSyncGate.waitForSafePermit(
        () =>
          this.isAsyncGenerationCurrent(generation) &&
          this.isAutoRefreshEnabled() &&
          useSettingsStore.getState().projectSyncEnabled,
      );
      if (permit === null) {
        return;
      }

      const result = await this.obsidianSyncGate.monitor(async () => {
        if (!this.obsidianSyncGate.isPermitCurrent(permit)) {
          return null;
        }
        return await this.services.projectSync.sync();
      });
      if (
        !this.isAsyncGenerationCurrent(generation) ||
        !this.isAutoRefreshEnabled() ||
        !useSettingsStore.getState().projectSyncEnabled ||
        !this.obsidianSyncGate.isPermitCurrent(permit) ||
        result === null
      ) {
        // Deferral or invalidation ends this cycle. The one-shot scheduler starts the complete
        // interval only after this promise settles, so cancellation never causes an immediate
        // retry loop.
        return;
      }
      this.reportBackgroundProjectSyncConflicts(result, "Scheduled");
    } catch (error: unknown) {
      if (!this.isAsyncGenerationCurrent(generation)) {
        return;
      }
      console.error("Scheduled Todoist auto-refresh failed:", error);
    }
  }

  private applyAutoRefreshSchedule(): void {
    this.clearAutoRefreshSchedule();
    if (this.disposed || !this.isAutoRefreshEnabled()) {
      return;
    }

    this.scheduleNextAutoRefresh(this.autoRefreshScheduleGeneration);
  }

  private clearAutoRefreshSchedule(): void {
    // Invalidating the generation also prevents an older in-flight refresh from resurrecting
    // its timer after Auto-refresh is disabled, reconfigured, or the plugin is unloaded.
    this.autoRefreshScheduleGeneration++;
    this.clearAutoRefreshTimer();
  }

  private clearAutoRefreshTimer(): void {
    if (this.autoRefreshTimeoutId === undefined) {
      return;
    }
    window.clearTimeout(this.autoRefreshTimeoutId);
    this.autoRefreshTimeoutId = undefined;
  }

  private scheduleNextAutoRefresh(generation: number): void {
    if (!this.isAutoRefreshScheduleCurrent(generation)) {
      return;
    }

    // Every overlapping manual Project sync clears the old timeout. The last one to settle starts
    // one new complete interval, while an automatic cycle that is also active remains the other
    // boundary below.
    if (this.manualProjectSyncInFlightCount > 0) {
      return;
    }

    const inFlight = this.scheduledSyncInFlight;
    if (inFlight !== undefined) {
      const scheduleAfterSettlement = () => this.scheduleNextAutoRefresh(generation);
      // A settings change can replace the schedule while a refresh is already running. Wait for
      // that whole refresh (including an Obsidian Sync deferral) before starting the new gap.
      void inFlight.then(scheduleAfterSettlement, scheduleAfterSettlement);
      return;
    }

    if (this.autoRefreshTimeoutId !== undefined) {
      return;
    }

    const interval = useSettingsStore.getState().autoRefreshInterval;
    this.autoRefreshTimeoutId = window.setTimeout(() => {
      this.autoRefreshTimeoutId = undefined;
      if (!this.isAutoRefreshScheduleCurrent(generation)) {
        return;
      }

      const scheduled = this.runScheduledSync();
      const scheduleAfterSettlement = () => this.scheduleNextAutoRefresh(generation);
      void scheduled.then(scheduleAfterSettlement, scheduleAfterSettlement);
    }, secondsToMillis(interval));
  }

  private isAutoRefreshScheduleCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.autoRefreshScheduleGeneration &&
      this.isAutoRefreshEnabled()
    );
  }

  private isAutoRefreshEnabled(): boolean {
    const settings = useSettingsStore.getState();
    return (
      settings.autoRefreshToggle &&
      Number.isFinite(settings.autoRefreshInterval) &&
      settings.autoRefreshInterval > 0
    );
  }

  private canRunAutomaticProjectProjection(): boolean {
    return !this.disposed && useSettingsStore.getState().projectSyncEnabled;
  }

  private applyProjectSyncConfig(): void {
    const config = projectSyncConfigFromSettings(useSettingsStore.getState());
    if (!isSameProjectSyncConfig(this.services.projectSync.getConfig(), config)) {
      this.projectSyncConfigGeneration++;
      this.projectSyncActivity.recordActivity();
    }
    this.services.projectSync.setConfig(config);
  }

  private async bindQueryCacheToCurrentCredential(): Promise<void> {
    const generation = this.apiTokenGeneration;
    const token = await this.services.token.read();
    if (!this.isApiTokenGenerationCurrent(generation)) {
      return;
    }

    const fingerprint = token === null ? null : await fingerprintCredential(token);
    if (!this.isApiTokenGenerationCurrent(generation)) {
      return;
    }

    if (this.queryCache.bindCredential(fingerprint)) {
      await this.persistQueryCache();
    }
  }

  private reloadApiClientAfterExternalSettingsChange(): void {
    const generation: AsyncGeneration = {
      apiToken: ++this.apiTokenGeneration,
      projectSyncConfig: this.projectSyncConfigGeneration,
    };
    this.services.projectSync.clearStatisticsSnapshot();
    this.services.projectSync.invalidate();
    this.services.todoist.reset();

    void this.reloadApiClientForExternalSettings(generation).catch((error: unknown) => {
      if (this.isApiTokenGenerationCurrent(generation.apiToken)) {
        console.error("Failed to reload Todoist after an external settings change:", error);
      }
    });
  }

  private async reloadApiClientForExternalSettings(generation: AsyncGeneration): Promise<void> {
    const token = await this.services.token.read();
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    const fingerprint = token === null ? null : await fingerprintCredential(token);
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }
    if (this.queryCache.bindCredential(fingerprint)) {
      await this.persistQueryCache();
      if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
        return;
      }
    }

    if (token !== null) {
      await this.initializeApiClient(token, generation);
    }
  }

  private applySettingsRuntime(previousSettings: Settings): void {
    this.applyProjectSyncConfig();
    const nextSettings = useSettingsStore.getState();
    if (
      previousSettings.autoRefreshToggle !== nextSettings.autoRefreshToggle ||
      previousSettings.autoRefreshInterval !== nextSettings.autoRefreshInterval
    ) {
      this.applyAutoRefreshSchedule();
    }
  }

  private enqueueSettingsOperation(operation: () => Promise<void>): Promise<void> {
    const generation = ++this.settingsOperationGeneration;
    const pending = this.settingsQueue
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        this.completedSettingsOperationGeneration = Math.max(
          this.completedSettingsOperationGeneration,
          generation,
        );
      });
    this.settingsQueue = pending;
    return pending;
  }

  private async persistSettings(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      await this.saveData(
        withProjectSyncFolderOwnershipRegistry(
          withProjectCatalogCollection({ ...useSettingsStore.getState() }, this.projectCatalogs),
          this.projectSyncFolderOwnership,
          this.projectSyncFolderOwnershipOpaque,
        ),
      );
      this.projectSyncFolderOwnershipNeedsPersist = false;
      this.clearProjectSyncFolderOwnershipRetry();
    } catch (error: unknown) {
      if (this.projectSyncFolderOwnershipNeedsPersist) {
        this.scheduleProjectSyncFolderOwnershipRetry();
      }
      throw error;
    }
  }

  private persistProjectCatalogs(catalogs: readonly ProjectCatalog[]): Promise<void> {
    if (this.disposed || catalogs.length === 0) {
      return Promise.resolve();
    }

    return this.enqueueSettingsOperation(async () => {
      if (this.disposed) {
        return;
      }
      const incoming: Record<string, ProjectCatalog> = {};
      for (const catalog of catalogs) {
        incoming[catalog.mappingId] = catalog;
      }
      const merged = mergeProjectCatalogCollections(this.projectCatalogs, incoming);
      if (JSON.stringify(merged) === JSON.stringify(this.projectCatalogs)) {
        return;
      }
      this.projectCatalogs = merged;
      await this.persistSettings();
    });
  }

  private persistCreatedFolders(inputs: readonly ManagedFolderCreation[]): Promise<void> {
    if (
      this.disposed ||
      this.projectSyncFolderOwnershipOpaque !== undefined ||
      this.projectSyncFolderOwnershipShadowIsOpaque
    ) {
      return Promise.resolve();
    }
    return this.enqueueSettingsOperation(async () => {
      if (
        this.disposed ||
        this.projectSyncFolderOwnershipOpaque !== undefined ||
        this.projectSyncFolderOwnershipShadowIsOpaque
      ) {
        return;
      }
      const next = recordCreatedFolderOwnership(this.projectSyncFolderOwnership, inputs);
      if (JSON.stringify(next) !== JSON.stringify(this.projectSyncFolderOwnership)) {
        this.projectSyncFolderOwnership = next;
        this.markProjectSyncFolderOwnershipDirty();
      }
      if (this.projectSyncFolderOwnershipNeedsPersist) {
        await this.persistSettings();
      }
    });
  }

  private persistReleasedFolderPaths(mappingId: string, paths: readonly string[]): Promise<void> {
    if (
      this.disposed ||
      paths.length === 0 ||
      this.projectSyncFolderOwnershipOpaque !== undefined ||
      this.projectSyncFolderOwnershipShadowIsOpaque
    ) {
      return Promise.resolve();
    }
    return this.enqueueSettingsOperation(async () => {
      if (
        this.disposed ||
        this.projectSyncFolderOwnershipOpaque !== undefined ||
        this.projectSyncFolderOwnershipShadowIsOpaque
      ) {
        return;
      }
      const next = releaseFolderOwnership(this.projectSyncFolderOwnership, mappingId, paths);
      if (JSON.stringify(next) !== JSON.stringify(this.projectSyncFolderOwnership)) {
        this.projectSyncFolderOwnership = next;
        this.markProjectSyncFolderOwnershipDirty();
      }
      if (this.projectSyncFolderOwnershipNeedsPersist) {
        await this.persistSettings();
      }
    });
  }

  private persistRelocatedFolders(inputs: readonly ManagedFolderRelocation[]): Promise<void> {
    if (
      this.disposed ||
      inputs.length === 0 ||
      this.projectSyncFolderOwnershipOpaque !== undefined ||
      this.projectSyncFolderOwnershipShadowIsOpaque
    ) {
      return Promise.resolve();
    }
    return this.enqueueSettingsOperation(async () => {
      if (
        this.disposed ||
        this.projectSyncFolderOwnershipOpaque !== undefined ||
        this.projectSyncFolderOwnershipShadowIsOpaque
      ) {
        return;
      }
      const next = relocateFolderOwnership(this.projectSyncFolderOwnership, inputs);
      if (JSON.stringify(next) !== JSON.stringify(this.projectSyncFolderOwnership)) {
        this.projectSyncFolderOwnership = next;
        this.markProjectSyncFolderOwnershipDirty();
      }
      if (this.projectSyncFolderOwnershipNeedsPersist) {
        await this.persistSettings();
      }
    });
  }

  private persistReleasedFolderPathsAcrossMappings(paths: readonly string[]): Promise<void> {
    if (
      this.disposed ||
      paths.length === 0 ||
      this.projectSyncFolderOwnershipOpaque !== undefined ||
      this.projectSyncFolderOwnershipShadowIsOpaque
    ) {
      return Promise.resolve();
    }
    return this.enqueueSettingsOperation(async () => {
      if (
        this.disposed ||
        this.projectSyncFolderOwnershipOpaque !== undefined ||
        this.projectSyncFolderOwnershipShadowIsOpaque
      ) {
        return;
      }
      let next = this.projectSyncFolderOwnership;
      for (const mappingId of new Set(next.records.map(({ mappingId }) => mappingId))) {
        next = releaseFolderOwnership(next, mappingId, paths);
      }
      if (JSON.stringify(next) !== JSON.stringify(this.projectSyncFolderOwnership)) {
        this.projectSyncFolderOwnership = next;
        this.markProjectSyncFolderOwnershipDirty();
      }
      if (this.projectSyncFolderOwnershipNeedsPersist) {
        await this.persistSettings();
      }
    });
  }

  private markProjectSyncFolderOwnershipDirty(): void {
    this.projectSyncFolderOwnershipNeedsPersist = true;
    this.persistProjectSyncFolderOwnershipShadow();
  }

  private persistProjectSyncFolderOwnershipShadow(): void {
    if (this.projectSyncFolderOwnershipShadowIsOpaque) {
      return;
    }
    try {
      this.app.saveLocalStorage(
        projectSyncFolderOwnershipStorageKey,
        withProjectSyncFolderOwnershipRegistry(
          {},
          folderOwnershipRevocationsOnly(this.projectSyncFolderOwnership),
        ),
      );
    } catch (error: unknown) {
      // Local storage is a best-effort crash journal. Its quota must never prevent the
      // authoritative synchronized data.json save from proceeding.
      console.error("Failed to persist the Project sync folder safety journal:", error);
    }
  }

  private scheduleProjectSyncFolderOwnershipRetry(): void {
    if (
      this.disposed ||
      !this.projectSyncFolderOwnershipNeedsPersist ||
      this.projectSyncFolderOwnershipRetryTimeoutId !== undefined
    ) {
      return;
    }

    const delay = this.projectSyncFolderOwnershipRetryDelayMs;
    this.projectSyncFolderOwnershipRetryDelayMs = Math.min(
      delay * 2,
      projectSyncFolderOwnershipRetryMaximumMs,
    );
    this.projectSyncFolderOwnershipRetryTimeoutId = window.setTimeout(() => {
      this.projectSyncFolderOwnershipRetryTimeoutId = undefined;
      void this.enqueueSettingsOperation(async () => {
        if (!this.disposed && this.projectSyncFolderOwnershipNeedsPersist) {
          await this.persistSettings();
        }
      }).catch((error: unknown) => {
        if (!this.disposed) {
          console.error("Failed to retry Project sync folder ownership persistence:", error);
        }
      });
    }, delay);
  }

  private clearProjectSyncFolderOwnershipRetry(): void {
    if (this.projectSyncFolderOwnershipRetryTimeoutId !== undefined) {
      window.clearTimeout(this.projectSyncFolderOwnershipRetryTimeoutId);
      this.projectSyncFolderOwnershipRetryTimeoutId = undefined;
    }
    this.projectSyncFolderOwnershipRetryDelayMs = projectSyncFolderOwnershipRetryInitialMs;
  }

  private releaseProjectSyncFolderOwnershipOutsideSettings(next: Settings): boolean {
    if (
      this.projectSyncFolderOwnershipOpaque !== undefined ||
      this.projectSyncFolderOwnershipShadowIsOpaque
    ) {
      return false;
    }
    const activeScopes = new Map(
      next.projectSyncMappings.flatMap((mapping) =>
        mapping.project === null ? [] : [[mapping.id, mapping.project.projectId] as const],
      ),
    );
    let updated = this.projectSyncFolderOwnership;
    const pathsByMapping = new Map<string, string[]>();
    for (const ownership of updated.records) {
      if (activeScopes.get(ownership.mappingId) === ownership.rootProjectId) {
        continue;
      }
      const paths = pathsByMapping.get(ownership.mappingId) ?? [];
      paths.push(ownership.path);
      pathsByMapping.set(ownership.mappingId, paths);
    }
    for (const [mappingId, paths] of pathsByMapping) {
      updated = releaseFolderOwnership(updated, mappingId, paths);
    }
    if (JSON.stringify(updated) === JSON.stringify(this.projectSyncFolderOwnership)) {
      return false;
    }
    this.projectSyncFolderOwnership = updated;
    this.markProjectSyncFolderOwnershipDirty();
    return true;
  }

  private persistQueryCache(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.app.saveLocalStorage(queryCacheStorageKey, this.queryCache.serialize());
    return Promise.resolve();
  }

  private static readonly settingsVersion = 6;

  private async applyMigrations(): Promise<void> {
    const migrations: Record<number, () => Promise<void>> = {
      1: async () => {
        // Migration from 0 -> 1: migrate token to secrets
        await this.services.token.migrateStorage("file", "secrets");
      },
      2: async () => {
        // Project sync mappings are normalized while loading settings so stale legacy keys are
        // removed before they can be persisted again.
      },
      3: async () => {
        // Stable mapping IDs and prior projection roots are added by settings normalization.
      },
      4: async () => {
        // Retained so installations from settings version 3 can upgrade sequentially.
      },
      5: async () => {
        // The single-device writer assignment is retired. Settings normalization removes the
        // legacy field, and every updated device may now run inbound-aware automatic projection.
      },
      6: async () => {
        // Project sync now preserves unmanaged Vault content unless the user explicitly opts out.
        // Settings normalization supplies the fail-safe default for existing installations.
      },
    };

    for (
      let version = useSettingsStore.getState().version;
      version < TodoistPlugin.settingsVersion;
      version++
    ) {
      if (this.disposed) {
        return;
      }

      const nextVersion = version + 1;
      const migration = migrations[nextVersion];
      if (!migration) {
        throw new Error(`No migration defined for version ${version} -> ${nextVersion}`);
      }

      await migration();
      if (this.disposed) {
        return;
      }

      await this.writeOptions({ version: nextVersion });
    }
  }

  private async initializeApiClient(token: string, generation: AsyncGeneration): Promise<void> {
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    await this.services.todoist.initialize(new TodoistApiClient(token, new ObsidianFetcher()));
  }

  private captureAsyncGeneration(): AsyncGeneration {
    return {
      apiToken: this.apiTokenGeneration,
      projectSyncConfig: this.projectSyncConfigGeneration,
    };
  }

  private isApiTokenGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.apiTokenGeneration;
  }

  private isAsyncGenerationCurrent(generation: AsyncGeneration): boolean {
    return (
      this.isApiTokenGenerationCurrent(generation.apiToken) &&
      generation.projectSyncConfig === this.projectSyncConfigGeneration
    );
  }

  private reportBackgroundProjectSyncConflicts(result: ProjectSyncResult, origin: string): void {
    if (result.conflicts.length === 0 || this.disposed) {
      return;
    }

    this.logProjectSyncConflicts(result, origin);
    const actionableConflictCount = result.conflicts.length - result.deferred;
    if (actionableConflictCount <= 0) {
      return;
    }
    new Notice(
      uiText.notices.projectSyncComplete(
        result.created,
        result.updated,
        result.moved,
        result.deleted,
        actionableConflictCount,
      ),
    );
  }

  private logProjectSyncConflicts(result: ProjectSyncResult, origin: string): void {
    if (result.conflicts.length === 0 || this.disposed) {
      return;
    }

    console.warn(`${origin} Todoist project sync completed with conflicts:`, result.conflicts);
  }

  private registerProjectSyncVaultActivityListeners(): void {
    const record = (path: string) => this.recordProjectSyncVaultActivity(path);
    this.registerEvent(this.app.vault.on("create", (file) => record(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => record(file.path)));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.releaseFolderOwnershipAfterVaultReplacement(file.path);
        record(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const isExternal = this.recordProjectSyncVaultActivity(oldPath, file.path);
        if (isExternal && portableVaultPathKey(oldPath) !== portableVaultPathKey(file.path)) {
          this.releaseFolderOwnershipAfterVaultReplacement(oldPath);
        }
      }),
    );
  }

  private releaseFolderOwnershipAfterVaultReplacement(path: string): void {
    void this.persistReleasedFolderPathsAcrossMappings([path]).catch((error: unknown) => {
      if (!this.disposed) {
        console.error("Failed to release replaced Project sync folder ownership:", error);
      }
    });
  }

  private recordProjectSyncVaultActivity(...paths: string[]): boolean {
    this.services.projectSync.notifyLocalProjectionChanges(paths);
    const mappings = useSettingsStore.getState().projectSyncMappings;
    const relevantPaths = paths.filter((path) => isProjectSyncPath(path, mappings));
    if (relevantPaths.length === 0) {
      return true;
    }
    const isExternal = this.projectSyncActivity.recordVaultActivity(relevantPaths);
    if (isExternal) {
      // A late file event can arrive just after the Sync engine reports Fully synced. Restart the
      // settle window before allowing another projection. Exact-path suppression above keeps this
      // plugin's own writes (and their outbound upload) out of this path.
      this.obsidianSyncGate.recordExternalVaultActivity();
      this.services.projectSync.invalidate();
    }
    return isExternal;
  }
}

const portableVaultPathKey = (path: string): string =>
  normalizePath(path).normalize("NFC").toLocaleLowerCase("en-US");

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isEmptyProjectSyncFolderOwnershipRegistry = (
  registry: ProjectSyncFolderOwnershipRegistry,
): boolean =>
  registry.records.length === 0 &&
  registry.tombstones.length === 0 &&
  registry.pathTombstones.length === 0;

const folderOwnershipRevocationsOnly = (
  registry: ProjectSyncFolderOwnershipRegistry,
): ProjectSyncFolderOwnershipRegistry => ({
  records: [],
  tombstones: registry.tombstones,
  pathTombstones: registry.pathTombstones,
});

const hasFolderOwnershipRecoveryContext = (storedData: unknown): boolean =>
  isRecord(storedData) &&
  (typeof storedData.version === "number" || PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY in storedData);

const hasCanonicalStoredSettings = (storedData: unknown, settings: Settings): boolean => {
  if (!isRecord(storedData)) {
    return false;
  }
  const folderOwnership = decodeProjectSyncFolderOwnershipRegistry(storedData);
  return (
    JSON.stringify(storedData) ===
    JSON.stringify(
      withProjectSyncFolderOwnershipRegistry(
        withProjectCatalogCollection({ ...settings }, readProjectCatalogCollection(storedData)),
        folderOwnership.registry,
        folderOwnership.opaque,
      ),
    )
  );
};

const hasDifferentCredentialSettings = (left: Settings, right: Settings): boolean =>
  left.apiTokenSecretId !== right.apiTokenSecretId || left.tokenStorage !== right.tokenStorage;

const mergeExternalStoredSettings = (
  storedData: unknown,
  previousSettings: Settings,
): Record<string, unknown> => {
  if (!isRecord(storedData)) {
    return { ...previousSettings };
  }

  const merged: Record<string, unknown> = { ...previousSettings, ...storedData };
  delete merged.projectSyncCatalogs;
  delete merged[PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY];
  const externalVersion =
    typeof storedData.version === "number" && Number.isFinite(storedData.version)
      ? Math.max(0, Math.floor(storedData.version))
      : 0;
  merged.version = Math.max(previousSettings.version, externalVersion);

  // Preserve the legacy mapping migration path when an older device writes the old three-key
  // representation. Otherwise the current projectSyncMappings value would mask those keys.
  if (
    !("projectSyncMappings" in storedData) &&
    ("projectSyncFolder" in storedData ||
      "projectSyncProject" in storedData ||
      "projectSyncIncludeSubprojects" in storedData)
  ) {
    delete merged.projectSyncMappings;
  }

  return merged;
};

const projectSyncConfigFromSettings = (settings: Settings): ProjectSyncConfig => ({
  enabled: settings.projectSyncEnabled,
  preserveUnmanagedItems: settings.projectSyncPreserveUnmanagedItems,
  mappings: settings.projectSyncMappings,
});

const isSameProjectSyncConfig = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean =>
  left.enabled === right.enabled &&
  left.preserveUnmanagedItems === right.preserveUnmanagedItems &&
  left.mappings.length === right.mappings.length &&
  left.mappings.every((mapping, index) => {
    const other = right.mappings[index];
    return (
      mapping.folder === other.folder &&
      mapping.id === other.id &&
      mapping.includeSubprojects === other.includeSubprojects &&
      mapping.previousFolders.length === other.previousFolders.length &&
      mapping.previousFolders.every(
        (folder, folderIndex) => folder === other.previousFolders[folderIndex],
      ) &&
      mapping.project?.projectId === other.project?.projectId &&
      mapping.project?.projectName === other.project?.projectName
    );
  });

const fingerprintCredential = async (token: string): Promise<string> => {
  const tokenBytes = new TextEncoder().encode(token);
  const digest = await window.crypto.subtle.digest("SHA-256", tokenBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(byteHexWidth, "0"),
  ).join("");
};

class AutomaticProjectProjectionInvalidatedError extends Error {}
