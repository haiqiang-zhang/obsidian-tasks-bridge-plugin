import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDocumentStartupStyles } from "./taskDocumentStartupStyles";

const css = vi.hoisted(
  () =>
    "/* Tasks Bridge mobile startup guard. Managed by Tasks Bridge. */\n.test { display: none; }\n",
);
vi.mock("@/styles/taskDocumentStartup.css?raw", () => ({ default: css }));

const snippetName = "tasks-bridge-mobile-startup";
const storageKey = "tasks-bridge:mobile-startup-styles:v1";
const oldCss = css.replace(".test", ".previous");

const makeHarness = (configDir = ".obsidian") => {
  const folder = `${configDir}/snippets`;
  const path = `${folder}/${snippetName}.css`;
  const appearancePath = `${configDir}/appearance.json`;
  const files = new Map<string, string>();
  const directories = new Set<string>([configDir]);
  const storage = new Map<string, unknown>();
  const ready: (() => void)[] = [];
  const enabledSnippets = new Set<string>(["user-theme"]);
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || directories.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error("Missing file");
      }
      return value;
    }),
    mkdir: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    write: vi.fn(async (path: string, source: string) => {
      files.set(path, source);
    }),
  };
  const customCss = {
    getSnippetPath: vi.fn(() => path),
    getSnippetsFolder: vi.fn(() => folder),
    readSnippets: vi.fn(async (): Promise<void> => undefined),
    enabledSnippets,
    setCssEnabledStatus: vi.fn(async (name: string, enabled: boolean) => {
      if (enabled) {
        enabledSnippets.add(name);
      } else {
        enabledSnippets.delete(name);
      }
      files.set(appearancePath, JSON.stringify({ enabledCssSnippets: [...enabledSnippets] }));
    }),
  };
  const app = {
    vault: { configDir, adapter },
    workspace: { onLayoutReady: vi.fn((callback: () => void) => ready.push(callback)) },
    customCss: customCss as unknown,
    loadLocalStorage: vi.fn((key: string): unknown => storage.get(key) ?? null),
    saveLocalStorage: vi.fn((key: string, value: unknown) => {
      storage.set(key, value);
    }),
  };
  const create = () => new TaskDocumentStartupStyles(app as unknown as App);
  const helper = create();
  return {
    adapter,
    app,
    appearancePath,
    create,
    customCss,
    directories,
    files,
    folder,
    helper,
    path,
    ready,
    storage,
    installed: (source = css) => storage.set(storageKey, { path, source }),
    layoutReady: () => {
      for (const callback of ready.splice(0)) {
        callback();
      }
    },
  };
};

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("persistent native task startup styles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("installs after layout readiness using the native snippet loader and preserves other snippets", async () => {
    const harness = makeHarness();
    harness.files.set(`${harness.folder}/user-theme.css`, "/* Personal theme */");
    harness.helper.start();
    harness.helper.start();
    await flush();
    expect(harness.app.workspace.onLayoutReady).toHaveBeenCalledOnce();
    expect(harness.adapter.exists).not.toHaveBeenCalled();

    harness.layoutReady();
    await flush();
    expect(harness.adapter.mkdir).toHaveBeenCalledExactlyOnceWith(harness.folder);
    expect(harness.adapter.write).toHaveBeenCalledExactlyOnceWith(harness.path, css);
    expect(harness.customCss.readSnippets).toHaveBeenCalledOnce();
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledExactlyOnceWith(
      snippetName,
      true,
    );
    expect(harness.customCss.enabledSnippets.has("user-theme")).toBe(true);
    expect(harness.files.get(`${harness.folder}/user-theme.css`)).toBe("/* Personal theme */");
    expect(harness.storage.get(storageKey)).toEqual({ path: harness.path, source: css });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not rewrite the snippet, native settings, or local marker on an unchanged relaunch", async () => {
    const harness = makeHarness();
    harness.files.set(harness.path, css);
    harness.installed();
    harness.customCss.enabledSnippets.add(snippetName);
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.read).toHaveBeenCalledExactlyOnceWith(harness.path);
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(harness.adapter.mkdir).not.toHaveBeenCalled();
    expect(harness.customCss.readSnippets).not.toHaveBeenCalled();
    expect(harness.customCss.setCssEnabledStatus).not.toHaveBeenCalled();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("enables an existing matching snippet once on a fresh device without rewriting its bytes", async () => {
    const harness = makeHarness();
    harness.files.set(harness.path, css);
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledOnce();
    expect(harness.app.saveLocalStorage).toHaveBeenCalledOnce();

    harness.helper.dispose();
    harness.create().start();
    harness.layoutReady();
    await flush();
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledOnce();
    expect(harness.app.saveLocalStorage).toHaveBeenCalledOnce();
    expect(harness.customCss.readSnippets).toHaveBeenCalledOnce();
  });

  it("uses the configured native snippet and appearance paths", async () => {
    const harness = makeHarness("Settings/Obsidian Mobile");
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.write).toHaveBeenCalledExactlyOnceWith(harness.path, css);
    expect(harness.adapter.read).toHaveBeenCalledWith(harness.appearancePath);
    expect(harness.app.saveLocalStorage).toHaveBeenCalledWith(storageKey, {
      path: harness.path,
      source: css,
    });
  });

  it.each([
    ["foreign", "/* My own file */"],
    ["user-edited", `${css}\n/* Personal changes */`],
  ])("preserves a same-name %s snippet including one retaining the ownership header", async (_name, source) => {
    const harness = makeHarness();
    harness.files.set(harness.path, source);
    harness.installed();
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.files.get(harness.path)).toBe(source);
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(harness.customCss.readSnippets).not.toHaveBeenCalled();
    expect(harness.customCss.setCssEnabledStatus).not.toHaveBeenCalled();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("respects a user's disabled snippet after successful installation", async () => {
    const harness = makeHarness();
    harness.files.set(harness.path, css);
    harness.installed();
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.customCss.enabledSnippets.has(snippetName)).toBe(false);
    expect(harness.customCss.setCssEnabledStatus).not.toHaveBeenCalled();
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("updates known unedited installed CSS while preserving a user's disabled setting", async () => {
    const harness = makeHarness();
    harness.files.set(harness.path, oldCss);
    harness.directories.add(harness.folder);
    harness.installed(oldCss);
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.write).toHaveBeenCalledExactlyOnceWith(harness.path, css);
    expect(harness.customCss.readSnippets).toHaveBeenCalledOnce();
    expect(harness.customCss.setCssEnabledStatus).not.toHaveBeenCalled();
    expect(harness.storage.get(storageKey)).toEqual({ path: harness.path, source: css });
  });

  it.each([
    undefined,
    {},
    { enabledSnippets: new Set() },
  ])("does nothing when the native bridge is unsupported: %j", async (bridge) => {
    const harness = makeHarness();
    harness.app.customCss = bridge;
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.exists).not.toHaveBeenCalled();
    expect(harness.app.loadLocalStorage).not.toHaveBeenCalled();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("rejects an unexpected native snippet path", async () => {
    const harness = makeHarness();
    harness.customCss.getSnippetPath.mockReturnValue("Some note.md");
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.exists).not.toHaveBeenCalled();
    expect(harness.adapter.write).not.toHaveBeenCalled();
  });

  it.each([
    "read",
    "write",
    "readSnippets",
    "enable",
  ] as const)("catches %s failure and retries on the next launch", async (stage) => {
    const harness = makeHarness();
    const failure = new Error("Unavailable");
    if (stage === "read") {
      harness.files.set(harness.path, css);
      harness.adapter.read.mockRejectedValueOnce(failure);
    } else if (stage === "write") {
      harness.adapter.write.mockRejectedValueOnce(failure);
    } else if (stage === "readSnippets") {
      harness.customCss.readSnippets.mockRejectedValueOnce(failure);
    } else {
      harness.customCss.setCssEnabledStatus.mockRejectedValueOnce(failure);
    }
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    harness.create().start();
    harness.layoutReady();
    await flush();
    expect(harness.storage.get(storageKey)).toEqual({ path: harness.path, source: css });
  });

  it("waits once for native settings persistence before recording successful activation", async () => {
    const harness = makeHarness();
    harness.customCss.setCssEnabledStatus.mockImplementationOnce(async () => {
      harness.customCss.enabledSnippets.add(snippetName);
    });
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
    harness.files.set(
      harness.appearancePath,
      JSON.stringify({ enabledCssSnippets: [snippetName] }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.app.saveLocalStorage).toHaveBeenCalledOnce();
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not record success when native configuration persistence fails silently", async () => {
    const harness = makeHarness();
    harness.customCss.setCssEnabledStatus.mockImplementationOnce(async () => {
      harness.customCss.enabledSnippets.add(snippetName);
    });
    harness.helper.start();
    harness.layoutReady();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mutate anything when disposed before layout readiness", async () => {
    const harness = makeHarness();
    harness.helper.start();
    harness.helper.dispose();
    harness.layoutReady();
    await flush();
    expect(harness.adapter.exists).not.toHaveBeenCalled();
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("cancels the bounded confirmation delay on disposal", async () => {
    const harness = makeHarness();
    harness.customCss.setCssEnabledStatus.mockImplementationOnce(async () => {
      harness.customCss.enabledSnippets.add(snippetName);
    });
    harness.helper.start();
    harness.layoutReady();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    harness.helper.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });

  it.each([
    "read",
    "write",
    "readSnippets",
    "enable",
  ] as const)("stops later mutations when disposed during %s", async (stage) => {
    const harness = makeHarness();
    const pending = deferred();
    if (stage === "read") {
      harness.files.set(harness.path, css);
      harness.adapter.read.mockImplementationOnce(async () => {
        await pending.promise;
        return css;
      });
    } else if (stage === "write") {
      harness.adapter.write.mockImplementationOnce(async () => pending.promise);
    } else if (stage === "readSnippets") {
      harness.customCss.readSnippets.mockImplementationOnce(async () => pending.promise);
    } else {
      harness.customCss.setCssEnabledStatus.mockImplementationOnce(async () => pending.promise);
    }
    harness.helper.start();
    harness.layoutReady();
    await flush();
    const writesBeforeDisposal = harness.adapter.write.mock.calls.length;
    const enablesBeforeDisposal = harness.customCss.setCssEnabledStatus.mock.calls.length;
    harness.helper.dispose();
    pending.resolve();
    await flush();
    expect(harness.adapter.write).toHaveBeenCalledTimes(writesBeforeDisposal);
    expect(harness.customCss.setCssEnabledStatus).toHaveBeenCalledTimes(enablesBeforeDisposal);
    expect(harness.app.saveLocalStorage).not.toHaveBeenCalled();
  });
});
