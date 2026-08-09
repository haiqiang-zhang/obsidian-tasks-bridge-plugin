import { setLanguage, t } from "@/i18n";
import "@/styles/main.scss";
import type { PluginManifest } from "obsidian";
import { type App, Notice, Plugin } from "obsidian";

import { TodoistApiClient } from "@/api";
import type { TaskId } from "@/api/domain/task";
import { ObsidianFetcher } from "@/api/fetcher";
import { registerCommands } from "@/commands";
import { QueryCache } from "@/data/queryCache";
import type { Task } from "@/data/task";
import { secondsToMillis } from "@/infra/time";
import { QueryInjector } from "@/query/injector";
import { makeServices, type Services } from "@/services";
import { type Settings, useSettingsStore } from "@/settings";
import { SettingsTab } from "@/ui/settings";

// biome-ignore lint/style/noMagicNumbers: 600 seconds is easily recognizable as 10 minutes
const metadataSyncIntervalMs = secondsToMillis(600);
const hexadecimalRadix = 16;
const byteHexWidth = 2;

// biome-ignore lint/style/noDefaultExport: We must use default export for Obsidian plugins
export default class TodoistPlugin extends Plugin {
  public readonly services: Services;
  public readonly queryCache = new QueryCache();

  private saveQueue: Promise<void> = Promise.resolve();

  constructor(app: App, pluginManifest: PluginManifest) {
    super(app, pluginManifest);
    this.services = makeServices(this);
  }

  async onload() {
    setLanguage(document.documentElement.lang);
    await this.loadOptions();
    await this.bindQueryCacheToCurrentCredential();

    const queryInjector = new QueryInjector(this);
    this.registerMarkdownCodeBlockProcessor(
      "todoist",
      queryInjector.onNewBlock.bind(queryInjector),
    );
    this.addSettingTab(new SettingsTab(this.app, this));

    registerCommands(this);

    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.applyMigrations();
      } catch (error: unknown) {
        console.error("Failed to apply migrations:", error);
        new Notice(t().notices.migrationFailed);
      }
      await this.loadApiClient();
    });

    this.registerInterval(
      window.setInterval(async () => {
        await this.services.todoist.sync();
      }, metadataSyncIntervalMs),
    );
  }

  private async loadApiClient(): Promise<void> {
    const accessor = this.services.token;
    const token = await accessor.read();

    if (token !== null) {
      await this.services.todoist.initialize(new TodoistApiClient(token, new ObsidianFetcher()));
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
    const { queryCache, ...options } = isRecord(storedData) ? storedData : {};

    this.queryCache.load(queryCache);

    useSettingsStore.setState((old) => {
      return {
        ...old,
        ...(options as Partial<Settings>),
      };
    }, true);

    await this.persistData();
  }

  async writeOptions(update: Partial<Settings>): Promise<void> {
    useSettingsStore.setState(update);
    await this.persistData();
  }

  async writeQueryCache(filter: string, tasks: Task[], updatedAt: Date): Promise<void> {
    if (!this.queryCache.set(filter, tasks, updatedAt)) {
      return;
    }
    await this.persistData();
  }

  async removeTaskFromAllQueryCaches(taskId: TaskId, updatedAt: Date): Promise<void> {
    if (!this.queryCache.removeTaskFromAll(taskId, updatedAt)) {
      return;
    }
    await this.persistData();
  }

  async updateApiToken(token: string): Promise<void> {
    await this.services.token.write(token);
    const fingerprint = await fingerprintCredential(token);
    const credentialChanged = this.queryCache.bindCredential(fingerprint);

    if (credentialChanged) {
      this.services.todoist.reset();
    }

    const initialization = this.services.todoist.initialize(
      new TodoistApiClient(token, new ObsidianFetcher()),
    );

    if (credentialChanged) {
      await this.persistData();
    }

    await initialization;
  }

  private async bindQueryCacheToCurrentCredential(): Promise<void> {
    const token = await this.services.token.read();
    const fingerprint = token === null ? null : await fingerprintCredential(token);

    if (this.queryCache.bindCredential(fingerprint)) {
      await this.persistData();
    }
  }

  private persistData(): Promise<void> {
    const pendingWrite = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await this.saveData({
          ...useSettingsStore.getState(),
          queryCache: this.queryCache.serialize(),
        });
      });

    this.saveQueue = pendingWrite;
    return pendingWrite;
  }

  private static readonly settingsVersion = 1;

  private async applyMigrations(): Promise<void> {
    const migrations: Record<number, () => Promise<void>> = {
      1: async () => {
        // Migration from 0 -> 1: migrate token to secrets
        await this.services.token.migrateStorage("file", "secrets");
      },
    };

    for (
      let version = useSettingsStore.getState().version;
      version < TodoistPlugin.settingsVersion;
      version++
    ) {
      const nextVersion = version + 1;
      const migration = migrations[nextVersion];
      if (!migration) {
        throw new Error(`No migration defined for version ${version} -> ${nextVersion}`);
      }

      await migration();

      await this.writeOptions({ version: nextVersion });
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const fingerprintCredential = async (token: string): Promise<string> => {
  const tokenBytes = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", tokenBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(byteHexWidth, "0"),
  ).join("");
};
