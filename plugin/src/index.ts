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
} from "@/bases/todoist-list";
import { registerCommands } from "@/commands";
import { QueryCache } from "@/data/queryCache";
import type { CompletedTasksProgress } from "@/data/subscriptions";
import type { Task } from "@/data/task";
import { secondsToMillis } from "@/infra/time";
import type { ProjectSyncConfig, ProjectSyncResult } from "@/project-sync";
import { QueryInjector } from "@/query/injector";
import { makeServices, type Services } from "@/services";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";
import {
  normalizeAutoRefreshInterval,
  normalizeSettings,
  type Settings,
  useSettingsStore,
} from "@/settings";
import { SettingsTab } from "@/ui/settings";

const hexadecimalRadix = 16;
const byteHexWidth = 2;

type AsyncGeneration = {
  apiToken: number;
  projectSyncConfig: number;
};

// biome-ignore lint/style/noDefaultExport: We must use default export for Obsidian plugins
export default class TodoistPlugin extends Plugin {
  public readonly services: Services;
  public readonly queryCache = new QueryCache();

  private saveQueue: Promise<void> = Promise.resolve();
  private apiTokenUpdateQueue: Promise<void> = Promise.resolve();
  private apiTokenGeneration = 0;
  private projectSyncConfigGeneration = 0;
  private autoRefreshIntervalId: number | undefined;
  private scheduledSyncInFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(app: App, pluginManifest: PluginManifest) {
    super(app, pluginManifest);
    this.services = makeServices(this);
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
      createTasksListViewRegistration(this.makeTodoistListActions()),
    );
    this.registerMarkdownCodeBlockProcessor(
      "todoist",
      queryInjector.onNewBlock.bind(queryInjector),
    );
    this.addSettingTab(new SettingsTab(this.app, this));

    registerCommands(this);
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
          await this.services.projectTasks.completeTask({
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
          await this.services.projectTasks.reopenTask({
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

  onunload(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearAutoRefreshSchedule();
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
    const storedData: unknown = await this.loadData();
    if (this.disposed) {
      return;
    }
    const queryCache = isRecord(storedData) ? storedData.queryCache : undefined;
    const options = normalizeSettings(storedData);

    this.queryCache.load(queryCache);
    useSettingsStore.setState(options, true);

    this.applyProjectSyncConfig();

    await this.persistData();
  }

  async writeOptions(update: Partial<Settings>): Promise<void> {
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
    const nextSettings = useSettingsStore.getState();
    this.applyProjectSyncConfig();
    if (
      previousSettings.autoRefreshToggle !== nextSettings.autoRefreshToggle ||
      previousSettings.autoRefreshInterval !== nextSettings.autoRefreshInterval
    ) {
      this.applyAutoRefreshSchedule();
    }
    await this.persistData();
  }

  async syncProjectFolderNow(): Promise<ProjectSyncResult | null> {
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
        new Notice(t().notices.projectSyncDisabled);
        return null;
      }

      await this.compactSettledProjectSyncRoots(result);
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
    await this.persistData();
  }

  async completeTaskInAllQueryCaches(taskId: TaskId, completedAt: Date): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.queryCache.completeTaskInAll(taskId, completedAt)) {
      return;
    }
    await this.persistData();
  }

  async removeTaskFromAllQueryCaches(taskId: TaskId, updatedAt: Date): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.queryCache.removeTaskFromAll(taskId, updatedAt)) {
      return;
    }
    await this.persistData();
  }

  async updateApiToken(token: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const generation: AsyncGeneration = {
      apiToken: ++this.apiTokenGeneration,
      projectSyncConfig: this.projectSyncConfigGeneration,
    };
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
      await this.persistData();
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
      // Full sync keeps the original query-block mode on the same shared Auto-refresh schedule.
      // Its return value still lets Project sync avoid projecting against stale project metadata.
      const metadataSucceeded = await this.services.todoist.sync();
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

      const result = await this.services.projectSync.sync();
      if (!this.isAsyncGenerationCurrent(generation) || result === null) {
        return;
      }
      await this.compactSettledProjectSyncRoots(result);
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

    const interval = useSettingsStore.getState().autoRefreshInterval;
    const intervalId = window.setInterval(() => {
      if (this.isAutoRefreshEnabled()) {
        void this.runScheduledSync();
      }
    }, secondsToMillis(interval));
    this.autoRefreshIntervalId = intervalId;
    this.registerInterval(intervalId);
  }

  private clearAutoRefreshSchedule(): void {
    if (this.autoRefreshIntervalId === undefined) {
      return;
    }
    window.clearInterval(this.autoRefreshIntervalId);
    this.autoRefreshIntervalId = undefined;
  }

  private isAutoRefreshEnabled(): boolean {
    const settings = useSettingsStore.getState();
    return (
      settings.autoRefreshToggle &&
      Number.isFinite(settings.autoRefreshInterval) &&
      settings.autoRefreshInterval > 0
    );
  }

  private async syncProjectFolderInBackground(generation: AsyncGeneration): Promise<void> {
    if (!this.isAsyncGenerationCurrent(generation)) {
      return;
    }

    try {
      const result = await this.services.projectSync.sync();
      if (!this.isAsyncGenerationCurrent(generation) || result === null) {
        return;
      }
      await this.compactSettledProjectSyncRoots(result);
      this.reportBackgroundProjectSyncConflicts(result, "Startup");
    } catch (error: unknown) {
      if (!this.isAsyncGenerationCurrent(generation)) {
        return;
      }
      console.error("Todoist project sync failed:", error);
    }
  }

  private applyProjectSyncConfig(): void {
    const config = projectSyncConfigFromSettings(useSettingsStore.getState());
    if (!isSameProjectSyncConfig(this.services.projectSync.getConfig(), config)) {
      this.projectSyncConfigGeneration++;
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
      await this.persistData();
    }
  }

  private persistData(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const pendingWrite = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) {
          return;
        }
        await this.saveData({
          ...useSettingsStore.getState(),
          queryCache: this.queryCache.serialize(),
        });
      });

    this.saveQueue = pendingWrite;
    return pendingWrite;
  }

  private static readonly settingsVersion = 3;

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
    if (!this.isApiTokenGenerationCurrent(generation.apiToken)) {
      return;
    }

    if (this.isAsyncGenerationCurrent(generation)) {
      await this.syncProjectFolderInBackground(generation);
    }
  }

  private async compactSettledProjectSyncRoots(result: ProjectSyncResult): Promise<void> {
    if (result.settledMappingIds.length === 0 || this.disposed) {
      return;
    }
    const settled = new Set(result.settledMappingIds);
    const current = useSettingsStore.getState().projectSyncMappings;
    if (!current.some((mapping) => settled.has(mapping.id) && mapping.previousFolders.length > 0)) {
      return;
    }

    try {
      await this.writeOptions({
        projectSyncMappings: current.map((mapping) =>
          settled.has(mapping.id) ? { ...mapping, previousFolders: [] } : mapping,
        ),
      });
    } catch (error: unknown) {
      console.error("Failed to compact settled Todoist project roots:", error);
    }
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
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
