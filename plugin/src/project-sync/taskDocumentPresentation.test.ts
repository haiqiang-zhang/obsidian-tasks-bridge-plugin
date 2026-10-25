import { type App, type EventRef, MarkdownView, type WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TASK_DOCUMENT_BADGE_CLASS,
  TASK_DOCUMENT_BREADCRUMB_CLASS,
  TASK_DOCUMENT_VIEW_CLASS,
  TaskDocumentPresentation,
} from "./taskDocumentPresentation";

const makeHarness = () => {
  const listeners = new Map<string, (() => void)[]>();
  const register = (scope: string) => (event: string, listener: () => void) => {
    const key = `${scope}:${event}`;
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    return {} as EventRef;
  };
  const markdownLeaves: WorkspaceLeaf[] = [];
  const explorerLeaves: WorkspaceLeaf[] = [];
  const layoutReady: (() => void)[] = [];
  const app = {
    workspace: {
      getLeavesOfType: (type: string) => (type === "markdown" ? markdownLeaves : explorerLeaves),
      on: register("workspace"),
      onLayoutReady: (callback: () => void) => layoutReady.push(callback),
    },
    vault: { on: register("vault") },
  } as unknown as App;
  const presentation = new TaskDocumentPresentation(app);
  const registerEvent = vi.fn();
  const addExplorer = (doc = document) => {
    // Obsidian installs its DOM helpers in each popout realm; jsdom's iframe needs that shim too.
    if (doc.defaultView !== null && doc.defaultView !== window) {
      Object.defineProperty(doc.defaultView.HTMLElement.prototype, "createDiv", {
        configurable: true,
        value: HTMLElement.prototype.createDiv,
      });
    }
    const container = doc.createElement("div");
    doc.body.append(container);
    const leaf = { view: { containerEl: container } } as unknown as WorkspaceLeaf;
    explorerLeaves.push(leaf);
    return { container, leaf };
  };
  const addMarkdown = (path: string, doc = document) => {
    const containerEl = doc.createElement("div");
    const properties = doc.createElement("div");
    properties.className = "metadata-container";
    properties.textContent = "todoist_task_id: fixture";
    const source = doc.createElement("div");
    source.className = "cm-line";
    source.textContent = "---\ntodoist_task_id: fixture\n---";
    containerEl.append(properties, source);
    doc.body.append(containerEl);
    const view = Object.assign(Object.create(MarkdownView.prototype), {
      containerEl,
      file: { path },
    }) as MarkdownView;
    const leaf = { view } as unknown as WorkspaceLeaf;
    markdownLeaves.push(leaf);
    return { containerEl, leaf, view };
  };
  return {
    addExplorer,
    addMarkdown,
    emit: (scope: string, event: string) => {
      for (const listener of listeners.get(`${scope}:${event}`) ?? []) {
        listener();
      }
    },
    explorerLeaves,
    presentation,
    registerEvent,
    start: () => {
      presentation.start(registerEvent);
      for (const callback of layoutReady) {
        callback();
      }
    },
  };
};

const addRow = (container: HTMLElement, path: string) => {
  const row = container.ownerDocument.createElement("div");
  row.className = "nav-file-title";
  row.dataset.path = path;
  const label = row.ownerDocument.createElement("span");
  label.className = "nav-file-title-content";
  const filename = path.slice(path.lastIndexOf("/") + 1);
  label.textContent = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  row.append(label);
  container.append(row);
  return row;
};

const rowLabel = (row: HTMLElement): HTMLElement => {
  const label = row.querySelector<HTMLElement>(".nav-file-title-content");
  if (label === null) {
    throw new Error("Explorer label is missing");
  }
  return label;
};

const flush = async () => {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(150);
};

const addBreadcrumb = (container: HTMLElement, name: string): HTMLElement => {
  const header = container.ownerDocument.createElement("div");
  header.className = "view-header-title-container";
  const label = container.ownerDocument.createElement("div");
  label.className = "view-header-title";
  label.setAttribute("contenteditable", "true");
  label.textContent = name;
  header.append(label);
  container.prepend(header);
  return label;
};

describe("native task document presentation", () => {
  const active: TaskDocumentPresentation[] = [];

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    for (const presentation of active.splice(0)) {
      presentation.dispose();
    }
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("recognizes a restored task view when its native document becomes ready after layout", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    harness.start();
    await flush();

    const native = harness.addMarkdown("Projects/Restored.task.md");
    const label = addBreadcrumb(native.containerEl, "Restored.task");
    harness.presentation.requestRefresh();
    await flush();

    expect(native.containerEl).toHaveClass(TASK_DOCUMENT_VIEW_CLASS);
    expect(label).toHaveAttribute("data-tasks-bridge-title", "Restored");
    expect(label.textContent).toBe("Restored.task");
  });

  it("ignores late document readiness after disposal", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    harness.start();
    await flush();
    harness.presentation.dispose();

    const native = harness.addMarkdown("Projects/Restored.task.md");
    harness.presentation.requestRefresh();
    await flush();

    expect(native.containerEl).not.toHaveClass(TASK_DOCUMENT_VIEW_CLASS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shortens the breadcrumb visually while preserving native rename text and user edits", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const native = harness.addMarkdown("Projects/Example.v2.task.md");
    const label = addBreadcrumb(native.containerEl, "Example.v2.task");
    harness.start();
    await flush();

    expect(label).toHaveAttribute("data-tasks-bridge-title", "Example.v2");
    expect(label).toHaveClass(TASK_DOCUMENT_BREADCRUMB_CLASS);
    expect(label.textContent).toBe("Example.v2.task");
    label.focus();
    label.textContent = "New name.task";
    await flush();
    expect(label.textContent).toBe("New name.task");
    expect(label).not.toHaveAttribute("data-tasks-bridge-title");

    Object.assign(native.view.file ?? {}, { path: "Projects/New name.task.md" });
    label.blur();
    harness.emit("vault", "rename");
    await flush();
    expect(label).toHaveAttribute("data-tasks-bridge-title", "New name");
    expect(label.textContent).toBe("New name.task");
    harness.presentation.dispose();
    expect(label.textContent).toBe("New name.task");
    expect(label).not.toHaveClass(TASK_DOCUMENT_BREADCRUMB_CLASS);
    expect(label).not.toHaveAttribute("data-tasks-bridge-title");
  });

  it("tracks native breadcrumb redraws and removes shortening when a pane opens an ordinary note", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const native = harness.addMarkdown("Projects/Example.task.md");
    const label = addBreadcrumb(native.containerEl, "Example.task");
    harness.start();
    await flush();

    const text = label.firstChild;
    if (text === null) {
      throw new Error("Native breadcrumb text is missing");
    }
    text.textContent = "Native redraw";
    await flush();
    expect(label).not.toHaveAttribute("data-tasks-bridge-title");
    label.textContent = "Example.task";
    await flush();
    expect(label).toHaveAttribute("data-tasks-bridge-title", "Example");
    expect(vi.getTimerCount()).toBe(0);

    Object.assign(native.view.file ?? {}, { path: "Notes/Example.md" });
    harness.emit("workspace", "file-open");
    await flush();
    expect(label).not.toHaveClass(TASK_DOCUMENT_BREADCRUMB_CLASS);
    expect(label.textContent).toBe("Example.task");
    label.textContent = "Example";
    await flush();
    expect(label.textContent).toBe("Example");
    expect(label).not.toHaveAttribute("data-tasks-bridge-title");
  });

  it("uses the native badge and hides only the task suffix without replacing native label elements", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const task = addRow(container, "Projects/Task.task.md");
    const ordinary = addRow(container, "Notes/Task.md");
    const custom = addRow(container, "Projects/Task.task");
    const taskView = harness.addMarkdown(task.dataset.path ?? "");
    const ordinaryView = harness.addMarkdown(ordinary.dataset.path ?? "");
    const originalTaskContent = taskView.containerEl.innerHTML;
    const label = task.firstElementChild;

    harness.start();
    await flush();

    expect(task.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toHaveTextContent("TASK");
    expect(task.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toHaveClass("nav-file-tag");
    expect(task.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).not.toHaveAttribute("style");
    expect(task.firstElementChild).toBe(label);
    expect(label).toHaveTextContent(/^Task$/);
    expect(task.dataset.path).toBe("Projects/Task.task.md");
    expect(rowLabel(ordinary)).toHaveTextContent(/^Task$/);
    expect(rowLabel(custom)).toHaveTextContent(/^Task.task$/);
    expect(ordinary.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(custom.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(taskView.containerEl).toHaveClass(TASK_DOCUMENT_VIEW_CLASS);
    expect(ordinaryView.containerEl).not.toHaveClass(TASK_DOCUMENT_VIEW_CLASS);
    expect(taskView.containerEl.innerHTML).toBe(originalTaskContent);
  });

  it("handles new and recycled explorer rows and removes task styling when an open file is renamed", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const row = addRow(container, "Projects/Task.task.md");
    const taskView = harness.addMarkdown("Projects/Task.task.md");
    harness.start();
    await flush();

    const created = addRow(container, "Projects/New.task.md");
    row.dataset.path = "Notes/Ordinary.md";
    Object.assign(taskView.view.file ?? {}, { path: "Notes/Ordinary.md" });
    harness.emit("vault", "rename");
    await flush();

    expect(created.querySelectorAll(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toHaveLength(1);
    expect(row.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(taskView.containerEl).not.toHaveClass(TASK_DOCUMENT_VIEW_CLASS);

    created.replaceChildren(document.createElement("span"));
    await flush();
    expect(created.querySelectorAll(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reapplies the shortened label after native text-node redraws without looping", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const row = addRow(container, "Projects/Example.v2.task.md");
    const label = rowLabel(row);
    harness.start();
    await flush();

    expect(label).toHaveTextContent(/^Example.v2$/);
    const text = label.firstChild;
    if (text === null) {
      throw new Error("Native label text is missing");
    }
    text.nodeValue = "Example.v2.task";
    await flush();

    expect(label).toHaveTextContent(/^Example.v2$/);
    expect(row.querySelectorAll(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves native rename text and highlighted label markup untouched", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const renamed = addRow(container, "Projects/Example.task.md");
    const highlighted = addRow(container, "Projects/Highlighted.task.md");
    const highlight = document.createElement("span");
    highlight.className = "search-result-file-matched-text";
    highlight.textContent = "Highlighted";
    rowLabel(highlighted).replaceChildren(highlight, document.createTextNode(".task"));
    harness.start();
    await flush();

    expect(rowLabel(highlighted).firstElementChild).toBe(highlight);
    expect(rowLabel(highlighted)).toHaveTextContent(/^Highlighted.task$/);
    const label = rowLabel(renamed);
    label.setAttribute("contenteditable", "true");
    label.textContent = "User rename in progress.task";
    await flush();
    expect(label).toHaveTextContent(/^User rename in progress.task$/);

    harness.presentation.dispose();
    expect(label).toHaveTextContent(/^User rename in progress.task$/);
    expect(rowLabel(highlighted).firstElementChild).toBe(highlight);
  });

  it("restores the native filename synchronously when rename starts, then leaves typing alone", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const row = addRow(container, "Projects/Example.task.md");
    const label = rowLabel(row);
    harness.start();
    await flush();

    expect(label).toHaveTextContent(/^Example$/);
    label.setAttribute("contenteditable", "true");
    const range = document.createRange();
    range.selectNodeContents(label);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    label.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // A native Enter/blur save now sees the original basename, even before any timers flush.
    expect(label).toHaveTextContent(/^Example.task$/);
    expect(selection?.toString()).toBe("Example.task");
    label.textContent = "New title.task";
    await flush();
    label.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(label).toHaveTextContent(/^New title.task$/);
    harness.presentation.dispose();
    expect(label).toHaveTextContent(/^New title.task$/);
  });

  it("restores the filename on the first editable transition when a background window emits no focus", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const row = addRow(container, "Projects/Background.task.md");
    const label = rowLabel(row);
    harness.start();
    await flush();

    label.setAttribute("contenteditable", "true");
    // Native Enter is a later input task: the mutation observer runs before that input can save.
    await Promise.resolve();
    expect(label).toHaveTextContent(/^Background.task$/);
    label.textContent = "User input after rename starts";
    await flush();
    expect(label).toHaveTextContent(/^User input after rename starts$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes decoration after native rename completes and restores only the new name on unload", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const row = addRow(container, "Projects/Before.task.md");
    const label = rowLabel(row);
    harness.start();
    await flush();

    label.setAttribute("contenteditable", "true");
    label.textContent = "After.task";
    row.dataset.path = "Projects/After.task.md";
    await flush();
    expect(label).toHaveTextContent(/^After.task$/);
    label.removeAttribute("contenteditable");
    await flush();
    expect(label).toHaveTextContent(/^After$/);

    harness.presentation.dispose();
    expect(label).toHaveTextContent(/^After.task$/);
    expect(row.dataset.path).toBe("Projects/After.task.md");
    expect(row.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
  });

  it("does not restore a stale name when a row is recycled or edited before unload", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    const { container } = harness.addExplorer();
    const moved = addRow(container, "Projects/Before.task.md");
    const edited = addRow(container, "Projects/Edited.task.md");
    const unchanged = addRow(container, "Projects/Unchanged.task.md");
    harness.start();
    await flush();

    moved.dataset.path = "Notes/Other.md";
    rowLabel(moved).textContent = "Other";
    rowLabel(edited).textContent = "External label";
    // Dispose before the observer runs: cleanup itself must validate current path and text.
    harness.presentation.dispose();

    expect(rowLabel(moved)).toHaveTextContent(/^Other$/);
    expect(rowLabel(edited)).toHaveTextContent(/^External label$/);
    expect(rowLabel(unchanged)).toHaveTextContent(/^Unchanged.task$/);
  });

  it("uses each popout document and cleans detached explorers and all owned decorations on unload", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    harness.start();
    await flush();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const popout = iframe.contentDocument;
    if (popout === null) {
      throw new Error("The popout document was not created");
    }
    const { container, leaf } = harness.addExplorer(popout);
    const row = addRow(container, "Projects/Popout.task.md");
    const taskView = harness.addMarkdown("Projects/Popout.task.md", popout);
    harness.emit("workspace", "window-open");
    await flush();

    const badge = row.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`);
    expect(badge?.ownerDocument).toBe(popout);
    expect(taskView.containerEl).toHaveClass(TASK_DOCUMENT_VIEW_CLASS);

    harness.explorerLeaves.splice(harness.explorerLeaves.indexOf(leaf), 1);
    harness.emit("workspace", "layout-change");
    await flush();
    expect(row.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(rowLabel(row)).toHaveTextContent(/^Popout.task$/);

    const mainExplorer = harness.addExplorer();
    const mainRow = addRow(mainExplorer.container, "Projects/Main.task.md");
    harness.emit("workspace", "layout-change");
    await flush();
    expect(mainRow.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).not.toBeNull();

    harness.presentation.dispose();
    expect(mainRow.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(rowLabel(mainRow)).toHaveTextContent(/^Main.task$/);
    expect(taskView.containerEl).not.toHaveClass(TASK_DOCUMENT_VIEW_CLASS);
    addRow(container, "Projects/AfterUnload.task.md");
    harness.emit("workspace", "file-open");
    await flush();
    expect(container.querySelector(`.${TASK_DOCUMENT_BADGE_CLASS}`)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not react to editor mutations outside the file explorer", async () => {
    const harness = makeHarness();
    active.push(harness.presentation);
    harness.addExplorer();
    const taskView = harness.addMarkdown("Projects/Task.task.md");
    harness.start();
    await flush();

    taskView.containerEl.append(document.createElement("div"));
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
    harness.presentation.start(harness.registerEvent);
    expect(harness.registerEvent).toHaveBeenCalledTimes(8);
  });
});
