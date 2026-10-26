import { type App, normalizePath } from "obsidian";

import startupCss from "@/styles/taskDocumentStartup.css?raw";

const snippetName = "tasks-bridge-mobile-startup";
const storageKey = "tasks-bridge:mobile-startup-styles:v1";
const ownershipHeader = "/* Tasks Bridge mobile startup guard. Managed by Tasks Bridge. */";
// Native configuration saves debounce for about one second; leave margin for the disk write.
const persistenceConfirmationDelayMs = 2000;

type NativeCustomCss = {
  getSnippetPath: (name: string) => unknown;
  getSnippetsFolder: () => unknown;
  readSnippets: () => unknown;
  enabledSnippets: { has: (name: string) => unknown };
  setCssEnabledStatus: (name: string, enabled: boolean) => unknown;
};

type Installation = { path: string; source: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getCustomCss = (app: App): NativeCustomCss | null => {
  const candidate: unknown = Reflect.get(app, "customCss");
  if (
    !isRecord(candidate) ||
    typeof candidate.getSnippetPath !== "function" ||
    typeof candidate.getSnippetsFolder !== "function" ||
    typeof candidate.readSnippets !== "function" ||
    typeof candidate.setCssEnabledStatus !== "function" ||
    !isRecord(candidate.enabledSnippets) ||
    typeof candidate.enabledSnippets.has !== "function"
  ) {
    return null;
  }
  return candidate as NativeCustomCss;
};

const readInstallation = (value: unknown, path: string): Installation | null =>
  isRecord(value) &&
  value.path === path &&
  typeof value.source === "string" &&
  value.source.startsWith(ownershipHeader)
    ? { path, source: value.source }
    : null;

/** Native snippets load before community plugins during the next mobile startup. */
export class TaskDocumentStartupStyles {
  private readonly app: App;
  private started = false;
  private disposed = false;
  private confirmationDelay: { id: number; resolve: () => void } | undefined;

  constructor(app: App) {
    this.app = app;
  }

  public start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.app.workspace.onLayoutReady(() => {
      void this.install().catch((error: unknown) => {
        if (!this.disposed) {
          console.warn(
            "Tasks Bridge: unable to prepare mobile startup styles; retrying next launch.",
            error,
          );
        }
      });
    });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.confirmationDelay !== undefined) {
      window.clearTimeout(this.confirmationDelay.id);
      this.confirmationDelay.resolve();
      this.confirmationDelay = undefined;
    }
  }

  private async install(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const customCss = getCustomCss(this.app);
    if (customCss === null) {
      return;
    }
    const rawFolder = customCss.getSnippetsFolder();
    const rawPath = customCss.getSnippetPath(snippetName);
    if (
      typeof rawFolder !== "string" ||
      typeof rawPath !== "string" ||
      rawFolder === "" ||
      normalizePath(rawPath) !== normalizePath(`${rawFolder}/${snippetName}.css`) ||
      !startupCss.startsWith(ownershipHeader)
    ) {
      return;
    }
    const folder = normalizePath(rawFolder);
    const path = normalizePath(rawPath);
    const installation = readInstallation(this.app.loadLocalStorage(storageKey), path);
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(path);
    if (this.disposed) {
      return;
    }
    const current = exists ? await adapter.read(path) : undefined;
    if (this.disposed) {
      return;
    }
    // An ownership comment alone cannot distinguish an old release from a user's edits.
    if (current !== undefined && current !== startupCss && current !== installation?.source) {
      console.warn(
        "Tasks Bridge: preserving the existing mobile startup snippet because its contents differ.",
      );
      return;
    }
    const changed = current !== startupCss;
    if (changed) {
      if (!(await adapter.exists(folder))) {
        if (this.disposed) {
          return;
        }
        await adapter.mkdir(folder);
      }
      if (this.disposed) {
        return;
      }
      await adapter.write(path, startupCss);
      if (this.disposed) {
        return;
      }
    }
    if (changed || installation === null) {
      await customCss.readSnippets();
      if (this.disposed) {
        return;
      }
    }
    if (installation === null) {
      if (customCss.enabledSnippets.has(snippetName) !== true) {
        await customCss.setCssEnabledStatus(snippetName, true);
        if (this.disposed) {
          return;
        }
      }
      // Native setConfig returns before writing and swallows persistence failures. Confirm the
      // actual setting once, then at most once more after its debounced save has had time to run.
      let persisted = await this.isEnabledOnDisk();
      if (this.disposed) {
        return;
      }
      if (!persisted) {
        await new Promise<void>((resolve) => {
          const id = window.setTimeout(resolve, persistenceConfirmationDelayMs);
          this.confirmationDelay = { id, resolve };
        });
        this.confirmationDelay = undefined;
        if (this.disposed) {
          return;
        }
        persisted = await this.isEnabledOnDisk();
      }
      if (this.disposed) {
        return;
      }
      if (!persisted || customCss.enabledSnippets.has(snippetName) !== true) {
        console.warn("Tasks Bridge: mobile startup styles were not saved; retrying next launch.");
        return;
      }
    }
    if (installation?.source !== startupCss) {
      this.app.saveLocalStorage(storageKey, { path, source: startupCss } satisfies Installation);
    }
  }

  private async isEnabledOnDisk(): Promise<boolean> {
    const path = normalizePath(`${this.app.vault.configDir}/appearance.json`);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path)) || this.disposed) {
      return false;
    }
    const value: unknown = JSON.parse(await adapter.read(path));
    return (
      isRecord(value) &&
      Array.isArray(value.enabledCssSnippets) &&
      value.enabledCssSnippets.includes(snippetName)
    );
  }
}
