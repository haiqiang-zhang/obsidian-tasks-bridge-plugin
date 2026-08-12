import { setLanguage, t } from "@/i18n";
import "@/styles/main.scss";
import type { PluginManifest } from "obsidian";
import { type App, Notice, Plugin } from "obsidian";

import { TodoistApiClient } from "@/api";
import type { TaskId } from "@/api/domain/task";
import { ObsidianFetcher } from "@/api/fetcher";
import {
  createTasksListViewRegistration,
  TASKS_LIST_VIEW_ID,
  type TodoistListActions,
  type TodoistListProjectStatisticsSource,
} from "@/bases/todoist-list";
import { registerCommands } from "@/commands";
import { QueryCache } from "@/data/queryCache";
import type { CompletedTasksProgress } from "@/data/subscriptions";
import type { Task } from "@/data/task";
import { ObsidianSyncActivityGate } from "@/infra/obsidianSyncGate";
import { secondsToMillis } from "@/infra/time";
import {
  isProjectSyncPath,
  ProjectSyncActivityTracker,
  type ProjectSyncConfig,
  type ProjectSyncResult,
} from "@/project-sync";
import { QueryInjector } from "@/query/injector";
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

type AsyncGeneration = {
  apiToken: number;
  projectSyncConfig: number;
};

// biome-ignore lint/style/noDefaultExport: We must use default export for Obsidian plugins
export default class TodoistPlugin extends Plugin {
  public readonly services: Services;
  public readonly queryCache = new QueryCache();

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

  constructor(app: App, pluginManifest: PluginManifest) {
    super(app, pluginManifest);
    this.services = makeServices(this);
    this.obsidianSyncGate = new ObsidianSyncActivityGate(app, {
      onInbound: () => this.services.projectSync.invalidate(),
    });
  }

  async onload() {
    setLanguage(document.documentElement.lang);
    await this.loadOptions();
    if (this.disposed) {
      return;
    }
    await this.bindQueryCacheToCurrentCredential();
    if (this.disposed) {
      return;
    }

    const queryInjector = new QueryInjector(this);
    this.registerBasesView(
      TASKS_LIST_VIEW_ID,
      createTasksListViewRegistration(
        this.makeTodoistListActions(),
        this.makeTodoistListProjectStatisticsSource(),
      ),
    );
    this.registerMarkdownCodeBlockProcessor(
      "todoist",
      queryInjector.onNewBlock.bind(queryInjector),
    );
    this.addSettingTab(new SettingsTab(this.app, this));

    registerCommands(this);
    this.registerProjectSyncVaultActivityListeners();
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
        new Notice(t().notices.migrationFailed);
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
          new Notice(t().editTaskModal.projectionErrorNotice);
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
          new Notice(t().editTaskModal.projectionErrorNotice);
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

  private makeTodoistListProjectStatisticsSource(): TodoistListProjectStatisticsSource {
    return {
      getConfig: () => this.services.projectSync.getConfig(),
      getProjects: () => this.services.projectSync.listProjects(),
      getSnapshot: () => this.services.projectSync.getStatisticsSnapshot(),
      getStatus: () => this.services.projectSync.getStatus(),
      isConfigured: () => this.services.projectSync.getConfig().mappings.length > 0,
      subscribe: (listener) => this.services.projectSync.subscribe(() => listener()),
    };
  }

  onunload(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearAutoRefreshSchedule();
    this.obsidianSyncGate.dispose();
    this.apiTokenGeneration++;
    this.projectSyncConfigGeneration++;
    this.services.todoist.reset();
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

      const localQueryCache = this.app.loadLocalStorage(queryCacheStorageKey);
      const legacyQueryCache = isRecord(storedData) ? storedData.queryCache : undefined;
      this.queryCache.load(localQueryCache ?? legacyQueryCache);
      if (localQueryCache === null && legacyQueryCache !== undefined) {
        await this.persistQueryCache();
      }

      const options = normalizeSettings(storedData);
      useSettingsStore.setState(options, true);
      this.applyProjectSyncConfig();

      if (!hasCanonicalStoredSettings(storedData, options)) {
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
      const nextSettings = normalizeSettings(
        mergeExternalStoredSettings(storedData, previousSettings),
      );
      const credentialSettingsChanged = hasDifferentCredentialSettings(
        previousSettings,
        nextSettings,
      );
      useSettingsStore.setState(nextSettings, true);
      this.applySettingsRuntime(previousSettings);
      if (credentialSettingsChanged) {
        this.reloadApiClientAfterExternalSettingsChange();
      }

      if (
        restoreAfterOlderSettingsOperation ||
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
      if (!this.isAsyncGenerationCurrent(generation)) {
        return null;
      }

      const result = await this.services.projectSync.sync();
      if (!this.isAsyncGenerationCurrent(generation)) {
        return null;
      }
      if (result === null) {
        new Notice(
          this.services.projectSync.getConfig().enabled
            ? t().notices.projectSyncInterrupted
            : t().notices.projectSyncDisabled,
        );
        return null;
      }

      this.logProjectSyncConflicts(result, "Manual");
      new Notice(
        t().notices.projectSyncComplete(
          result.created,
          result.updated,
          result.moved,
          result.stale,
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
      new Notice(t().notices.projectSyncFailed(message));
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

  private persistSettings(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    return this.saveData({ ...useSettingsStore.getState() });
  }

  private persistQueryCache(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.app.saveLocalStorage(queryCacheStorageKey, this.queryCache.serialize());
    return Promise.resolve();
  }

  private static readonly settingsVersion = 5;

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
      t().notices.projectSyncComplete(
        result.created,
        result.updated,
        result.moved,
        result.stale,
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
    this.registerEvent(this.app.vault.on("delete", (file) => record(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.recordProjectSyncVaultActivity(oldPath, file.path);
      }),
    );
  }

  private recordProjectSyncVaultActivity(...paths: string[]): void {
    this.services.projectSync.notifyLocalProjectionChanges(paths);
    const mappings = useSettingsStore.getState().projectSyncMappings;
    const relevantPaths = paths.filter((path) => isProjectSyncPath(path, mappings));
    if (relevantPaths.length > 0 && this.projectSyncActivity.recordVaultActivity(relevantPaths)) {
      // Abort an automatic reconcile whose snapshot was captured before this external change.
      // Exact-path suppression above prevents this plugin's own writes from invalidating itself.
      this.services.projectSync.invalidate();
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const hasCanonicalStoredSettings = (storedData: unknown, settings: Settings): boolean =>
  isRecord(storedData) && JSON.stringify(storedData) === JSON.stringify(settings);

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
  mappings: settings.projectSyncMappings,
});

const isSameProjectSyncConfig = (left: ProjectSyncConfig, right: ProjectSyncConfig): boolean =>
  left.enabled === right.enabled &&
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
  const digest = await globalThis.crypto.subtle.digest("SHA-256", tokenBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(byteHexWidth, "0"),
  ).join("");
};

class AutomaticProjectProjectionInvalidatedError extends Error {}
