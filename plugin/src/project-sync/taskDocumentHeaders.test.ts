import { act } from "@testing-library/react";
import {
  type CachedMetadata,
  type Component,
  type EventRef,
  MarkdownView,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";
import type { ProjectTaskCardActions, ProjectTaskCardModel } from "@/ui/projectTaskCard";

import { TaskDocumentHeaders } from "./taskDocumentHeaders";

const rendered = vi.hoisted(() => ({
  props: [] as { actions: ProjectTaskCardActions; task: ProjectTaskCardModel }[],
}));

vi.mock("@/ui/projectTaskHeader", () => ({
  ProjectTaskHeader: (props: { actions: ProjectTaskCardActions; task: ProjectTaskCardModel }) => {
    rendered.props.push(props);
    return createElement("div", { "data-task-id": props.task.taskId }, props.task.content);
  },
}));

const hostSelector = ".tasks-bridge-task-header-host";
const contentClass = "tasks-bridge-task-content";

const taskProperties = (id: string, content = "Task title"): Record<string, unknown> => ({
  "task id": id,
  content,
  description: "Task description",
  status: "active",
  completed: false,
  "project path": ["Study"],
  labels: [],
  priority: "P2",
  url: `https://app.todoist.com/app/task/${id}`,
});

const makeHarness = () => {
  const listeners = new Map<string, (() => void)[]>();
  const register = (scope: string) => (event: string, listener: () => void) => {
    const key = `${scope}:${event}`;
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    return {} as EventRef;
  };
  const files: TFile[] = [];
  const caches = new Map<string, CachedMetadata>();
  const leaves: WorkspaceLeaf[] = [];
  const layoutReady: (() => void)[] = [];
  const services = {
    projectTasks: {
      setCompleted: vi.fn(async () => ({ projection: Promise.resolve() })),
      loadEditableTask: vi.fn(async () => ({ id: "task-1" })),
      updateTask: vi.fn(async () => ({ projection: Promise.resolve() })),
    },
    modals: { taskEdit: vi.fn() },
  };
  const openLinkText = vi.fn(async () => undefined);
  const getMarkdownFiles = vi.fn(() => files);
  const plugin = {
    app: {
      workspace: {
        getLeavesOfType: () => leaves,
        on: register("workspace"),
        onLayoutReady: (callback: () => void) => layoutReady.push(callback),
        openLinkText,
      },
      vault: { getMarkdownFiles, on: register("vault") },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file.path),
        getFirstLinkpathDest: (path: string) => files.find((file) => file.path === path) ?? null,
        on: register("metadata"),
      },
    },
    services,
  } as unknown as TodoistPlugin;
  const headers = new TaskDocumentHeaders(plugin);
  const registerEvent = vi.fn();
  const addFile = (path: string, frontmatter?: Record<string, unknown>) => {
    const file = { path, extension: "md" } as TFile;
    files.push(file);
    if (frontmatter !== undefined) {
      caches.set(path, { frontmatter } as CachedMetadata);
    }
    return file;
  };
  const addView = (file: TFile, doc = document) => {
    if (doc.defaultView !== null && doc.defaultView !== window) {
      Object.defineProperty(doc.defaultView.HTMLElement.prototype, "createDiv", {
        configurable: true,
        value: HTMLElement.prototype.createDiv,
      });
    }
    const containerEl = doc.createElement("div");
    const contentEl = doc.createElement("div");
    const source = doc.createElement("div");
    source.className = "markdown-source-view mod-cm6";
    const sourceEditor = doc.createElement("div");
    sourceEditor.className = "cm-editor";
    const sourceScroller = doc.createElement("div");
    sourceScroller.className = "cm-scroller";
    const sourceSizer = doc.createElement("div");
    sourceSizer.className = "cm-sizer";
    const inlineTitle = doc.createElement("div");
    inlineTitle.className = "inline-title";
    inlineTitle.textContent = "Example.task";
    const properties = doc.createElement("div");
    properties.className = "metadata-container";
    const contentContainer = doc.createElement("div");
    contentContainer.className = "cm-contentContainer";
    const editor = doc.createElement("div");
    editor.className = "cm-content";
    editor.textContent = "User-owned Markdown body";
    contentContainer.append(editor);
    sourceSizer.append(inlineTitle, properties, contentContainer);
    sourceScroller.append(sourceSizer);
    sourceEditor.append(sourceScroller);
    source.append(sourceEditor);
    const reading = doc.createElement("div");
    reading.className = "markdown-reading-view";
    const previewScroller = doc.createElement("div");
    previewScroller.className = "markdown-preview-view";
    const previewSizer = doc.createElement("div");
    previewSizer.className = "markdown-preview-sizer";
    const previewHeader = doc.createElement("div");
    previewHeader.className = "mod-header";
    const previewBody = doc.createElement("div");
    previewBody.className = "el-p";
    previewBody.textContent = "Rendered user-owned Markdown body";
    previewSizer.append(previewHeader, previewBody);
    previewScroller.append(previewSizer);
    reading.append(previewScroller);
    reading.style.display = "none";
    contentEl.append(source, reading);
    containerEl.append(contentEl);
    doc.body.append(containerEl);
    const children = new Set<Component>();
    let mode: "source" | "preview" = "source";
    const view = Object.assign(Object.create(MarkdownView.prototype), {
      file,
      containerEl,
      contentEl,
      getMode: () => mode,
      onResize: vi.fn(),
      addChild: vi.fn((child: Component) => {
        children.add(child);
        child.onload();
        return child;
      }),
      removeChild: vi.fn((child: Component) => {
        if (children.delete(child)) {
          child.onunload();
        }
        return child;
      }),
    }) as MarkdownView;
    const leaf = { view } as unknown as WorkspaceLeaf;
    leaves.push(leaf);
    return {
      children,
      containerEl,
      contentEl,
      contentContainer,
      editor,
      inlineTitle,
      leaf,
      previewBody,
      previewHeader,
      previewScroller,
      previewSizer,
      properties,
      reading,
      source,
      sourceEditor,
      sourceScroller,
      sourceSizer,
      view,
      setMode: (next: "source" | "preview") => {
        mode = next;
        source.style.display = mode === "source" ? "" : "none";
        reading.style.display = mode === "preview" ? "" : "none";
      },
    };
  };
  return {
    addFile,
    addView,
    caches,
    emit: (scope: string, event: string) => {
      for (const listener of listeners.get(`${scope}:${event}`) ?? []) {
        listener();
      }
    },
    files,
    getMarkdownFiles,
    headers,
    leaves,
    openLinkText,
    registerEvent,
    services,
    start: () => {
      headers.start(registerEvent);
      for (const callback of layoutReady) {
        callback();
      }
    },
  };
};

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
};

const latestProps = () => {
  const props = rendered.props[rendered.props.length - 1];
  if (props === undefined) {
    throw new Error("No task header was rendered");
  }
  return props;
};

describe("native task document headers", () => {
  const active: TaskDocumentHeaders[] = [];

  beforeEach(() => {
    rendered.props.length = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      for (const headers of active.splice(0)) {
        headers.dispose();
      }
    });
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const setup = () => {
    const harness = makeHarness();
    active.push(harness.headers);
    return harness;
  };

  it("mounts inside the source scroll surface before native metadata without changing the editor", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    const editorHtml = native.contentContainer.innerHTML;
    const readingHtml = native.reading.innerHTML;

    harness.start();
    await flush();

    const host = native.contentEl.querySelector(hostSelector);
    expect(native.sourceSizer.firstElementChild).toBe(host);
    expect(host).toHaveTextContent("Task title");
    expect(host?.nextElementSibling).toBe(native.inlineTitle);
    expect(native.contentEl.firstElementChild).toBe(native.source);
    expect(native.source.nextElementSibling).toBe(native.reading);
    expect(native.contentContainer.innerHTML).toBe(editorHtml);
    expect(native.reading.innerHTML).toBe(readingHtml);
    expect(native.source.firstElementChild).toBe(native.sourceEditor);
    expect(native.sourceScroller.firstElementChild).toBe(native.sourceSizer);
    expect(native.contentContainer.firstElementChild).toBe(native.editor);
    expect(native.editor.contains(host)).toBe(false);
    expect(native.reading.style.display).toBe("none");
    expect(native.contentEl).toHaveClass(contentClass);
    expect(native.children.size).toBe(1);
    expect(latestProps().task).toMatchObject({ taskId: "task-1", filePath: file.path });
  });

  it.each([
    "source",
    "preview",
  ] as const)("initializes a restored %s document that becomes available after layout readiness", async (mode) => {
    const harness = setup();
    const file = harness.addFile("Projects/Restored.task.md", taskProperties("restored"));
    harness.start();
    await flush();
    expect(rendered.props).toHaveLength(0);

    const native = harness.addView(file);
    native.setMode(mode);
    const originalBody = native.editor.textContent;
    // The native editor/Markdown renderer finishes after the initial workspace events.
    harness.headers.requestRefresh();
    await flush();

    const host = native.contentEl.querySelector(hostSelector);
    expect(host).toHaveTextContent("Task title");
    expect(host?.parentElement).toBe(mode === "source" ? native.sourceSizer : native.previewHeader);
    expect(native.contentEl).toHaveClass(contentClass);
    expect(native.editor.textContent).toBe(originalBody);
    harness.headers.requestRefresh();
    await flush();
    expect(native.children.size).toBe(1);
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);
  });

  it("waits for metadata after native document readiness without requiring an edit", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Restored.task.md");
    const native = harness.addView(file);
    harness.start();
    harness.headers.requestRefresh();
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();

    harness.caches.set(file.path, { frontmatter: taskProperties("restored") } as CachedMetadata);
    harness.emit("metadata", "resolved");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toHaveTextContent("Task title");
    expect(native.contentEl).toHaveClass(contentClass);
  });

  it("moves the same header between native scrolling surfaces when mode styles change", async () => {
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Example.task.md", taskProperties("task-1")),
    );
    harness.start();
    await flush();
    const host = native.sourceSizer.querySelector(hostSelector);
    const renderedContent = host?.firstElementChild;
    const renderCount = rendered.props.length;

    native.setMode("preview");
    await flush();
    expect(native.previewHeader.firstElementChild).toBe(host);
    expect(native.previewScroller.firstElementChild).toBe(native.previewSizer);
    expect(native.previewSizer.firstElementChild).toBe(native.previewHeader);
    expect(native.previewHeader.nextElementSibling).toBe(native.previewBody);
    expect(native.sourceSizer.querySelector(hostSelector)).toBeNull();
    expect(host?.firstElementChild).toBe(renderedContent);
    expect(native.source.style.display).toBe("none");
    expect(native.reading.style.display).toBe("");

    native.setMode("source");
    await flush();
    expect(native.sourceSizer.firstElementChild).toBe(host);
    expect(native.previewScroller.firstElementChild).toBe(native.previewSizer);
    expect(native.previewHeader.querySelector(hostSelector)).toBeNull();
    expect(native.contentContainer.firstElementChild).toBe(native.editor);
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);
    expect(host?.firstElementChild).toBe(renderedContent);
    expect(rendered.props).toHaveLength(renderCount);
    expect(native.children.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mounts in the native reading header section when the task opens in preview mode", async () => {
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Example.task.md", taskProperties("task-1")),
    );
    native.setMode("preview");
    harness.start();
    await flush();

    const host = native.contentEl.querySelector(hostSelector);
    expect(native.previewHeader.firstElementChild).toBe(host);
    expect(native.previewScroller.firstElementChild).toBe(native.previewSizer);
    expect(native.previewScroller.lastElementChild).toBe(native.previewSizer);
    expect(native.previewSizer.firstElementChild).toBe(native.previewHeader);
    expect(native.previewSizer.lastElementChild).toBe(native.previewBody);
    expect(native.sourceSizer.querySelector(hostSelector)).toBeNull();
    expect(native.previewBody.textContent).toBe("Rendered user-owned Markdown body");
  });

  it("moves the same host into a rebuilt native reading header without adding preview sections", async () => {
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Example.task.md", taskProperties("task-1")),
    );
    native.setMode("preview");
    harness.start();
    await flush();
    const host = native.previewHeader.querySelector(hostSelector);
    const controls = host?.firstElementChild;
    const replacementHeader = document.createElement("div");
    replacementHeader.className = "mod-header";
    native.previewHeader.replaceWith(replacementHeader);
    await flush();

    expect(replacementHeader.firstElementChild).toBe(host);
    expect(host?.firstElementChild).toBe(controls);
    expect([...native.previewSizer.children]).toEqual([replacementHeader, native.previewBody]);
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);
    expect(native.children.size).toBe(1);
    expect(native.previewBody.textContent).toBe("Rendered user-owned Markdown body");
  });

  it("moves the existing host into a rebuilt native source sizer without recreating its controls", async () => {
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Example.task.md", taskProperties("task-1")),
    );
    harness.start();
    await flush();
    const host = native.sourceSizer.querySelector(hostSelector);
    const controls = host?.firstElementChild;
    const newSizer = document.createElement("div");
    newSizer.className = "cm-sizer";
    newSizer.append(native.inlineTitle, native.properties, native.contentContainer);
    native.sourceSizer.replaceWith(newSizer);
    await flush();

    expect(newSizer.firstElementChild).toBe(host);
    expect(host?.firstElementChild).toBe(controls);
    expect(native.contentContainer.firstElementChild).toBe(native.editor);
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);
    expect(native.children.size).toBe(1);
  });

  it("ignores ordinary notes, non-Markdown deferred views, and invalid task metadata", async () => {
    const harness = setup();
    const paths = [
      ["Notes/Ordinary.md", taskProperties("ordinary")],
      ["Projects/Missing.task.md", undefined],
      ["Projects/Invalid.task.md", { ...taskProperties("invalid"), status: "invalid" }],
      ["Projects/No ID.task.md", { content: "Missing immutable ID" }],
      ["Projects/Conflict.task.md", { ...taskProperties("conflict"), todoist_task_id: "other" }],
    ] as const;
    const views = paths.map(([path, properties]) =>
      harness.addView(harness.addFile(path, properties)),
    );
    const deferred = {
      view: { file: harness.addFile("Projects/Deferred.task.md", taskProperties("deferred")) },
    };
    harness.leaves.push(deferred as unknown as WorkspaceLeaf);

    harness.start();
    await flush();

    expect(rendered.props).toHaveLength(0);
    for (const native of views) {
      expect(native.contentEl.querySelector(hostSelector)).toBeNull();
      expect(native.contentEl).not.toHaveClass(contentClass);
    }
    expect("contentEl" in deferred.view).toBe(false);
  });

  it("updates metadata in the existing host and coalesces workspace refresh events", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    harness.start();
    await flush();
    const host = native.contentEl.querySelector(hostSelector);
    harness.getMarkdownFiles.mockClear();

    harness.caches.set(file.path, {
      frontmatter: {
        ...taskProperties("task-1", "Updated title"),
        completed: true,
        status: "completed",
      },
    } as CachedMetadata);
    harness.emit("metadata", "changed");
    harness.emit("workspace", "layout-change");
    harness.emit("workspace", "active-leaf-change");
    await flush();

    expect(native.contentEl.querySelector(hostSelector)).toBe(host);
    expect(host).toHaveTextContent("Updated title");
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);
    expect(latestProps().task).toMatchObject({ completed: true, status: "completed" });
    expect(harness.getMarkdownFiles).toHaveBeenCalledOnce();
    const renders = rendered.props.length;
    harness.emit("metadata", "resolved");
    await flush();
    expect(rendered.props).toHaveLength(renders);
  });

  it("removes a header for duplicate immutable IDs anywhere in the vault and restores it after deletion", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    harness.start();
    await flush();

    const duplicate = harness.addFile("Unmanaged/Duplicate.md", taskProperties("task-1"));
    harness.emit("metadata", "resolved");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
    expect(native.contentEl).not.toHaveClass(contentClass);
    expect(native.children.size).toBe(0);

    harness.files.splice(harness.files.indexOf(duplicate), 1);
    harness.caches.delete(duplicate.path);
    harness.emit("vault", "delete");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toHaveTextContent("Task title");
    expect(native.children.size).toBe(1);
  });

  it("removes an existing header when its metadata becomes incomplete or conflicting", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    harness.start();
    await flush();

    harness.caches.set(file.path, { frontmatter: { content: "ID removed" } } as CachedMetadata);
    harness.emit("metadata", "changed");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();

    harness.caches.set(file.path, { frontmatter: taskProperties("task-1") } as CachedMetadata);
    harness.emit("metadata", "resolved");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).not.toBeNull();

    harness.caches.set(file.path, {
      frontmatter: { ...taskProperties("task-1"), todoist_status: "completed" },
    } as CachedMetadata);
    harness.emit("metadata", "changed");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
    expect(native.contentEl).not.toHaveClass(contentClass);
  });

  it("replaces the file header when a view opens another task and removes it for ordinary notes", async () => {
    const harness = setup();
    const first = harness.addFile("Projects/First.task.md", taskProperties("task-1", "First"));
    const second = harness.addFile("Projects/Second.task.md", taskProperties("task-2", "Second"));
    const ordinary = harness.addFile("Notes/Ordinary.md");
    const native = harness.addView(first);
    harness.start();
    await flush();
    const oldHost = native.contentEl.querySelector(hostSelector);

    native.view.file = second;
    harness.emit("workspace", "file-open");
    await flush();
    expect(oldHost?.isConnected).toBe(false);
    expect(native.contentEl.querySelector(hostSelector)).toHaveTextContent("Second");
    expect(latestProps().task.taskId).toBe("task-2");
    expect(native.children.size).toBe(1);

    native.view.file = ordinary;
    harness.emit("workspace", "file-open");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
    expect(native.contentEl).not.toHaveClass(contentClass);
    expect(native.contentContainer.firstElementChild).toBe(native.editor);
  });

  it("tracks renamed task paths and removes the header when the native task suffix is removed", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    harness.start();
    await flush();

    harness.caches.delete(file.path);
    file.path = "Projects/Renamed.task.md";
    harness.caches.set(file.path, { frontmatter: taskProperties("task-1") } as CachedMetadata);
    harness.emit("vault", "rename");
    await flush();
    expect(latestProps().task.filePath).toBe(file.path);
    expect(native.contentEl.querySelectorAll(hostSelector)).toHaveLength(1);

    file.path = "Projects/Renamed.md";
    harness.emit("vault", "rename");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
    expect(native.contentEl).not.toHaveClass(contentClass);
  });

  it("removes closed leaves and cancels pending work on plugin disposal", async () => {
    const harness = setup();
    const first = harness.addView(
      harness.addFile("Projects/First.task.md", taskProperties("task-1")),
    );
    const second = harness.addView(
      harness.addFile("Projects/Second.task.md", taskProperties("task-2")),
    );
    harness.start();
    harness.start();
    await flush();
    expect(harness.registerEvent).toHaveBeenCalledTimes(9);

    harness.leaves.splice(harness.leaves.indexOf(first.leaf), 1);
    harness.emit("workspace", "layout-change");
    await flush();
    expect(first.contentEl.querySelector(hostSelector)).toBeNull();
    expect(first.contentEl).not.toHaveClass(contentClass);

    harness.emit("metadata", "changed");
    await act(async () => harness.headers.dispose());
    await flush();
    expect(second.contentEl.querySelector(hostSelector)).toBeNull();
    expect(second.contentEl).not.toHaveClass(contentClass);
    expect(second.children.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    harness.emit("metadata", "resolved");
    harness.start();
    second.setMode("preview");
    await flush();
    expect(second.contentEl.querySelector(hostSelector)).toBeNull();
  });

  it("mounts and cleans up within a popout document", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const popoutDocument = iframe.contentDocument;
    if (popoutDocument === null) {
      throw new Error("Popout document is missing");
    }
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Popout.task.md", taskProperties("popout")),
      popoutDocument,
    );
    harness.start();
    harness.emit("workspace", "window-open");
    await flush();

    expect(native.contentEl.querySelector(hostSelector)?.ownerDocument).toBe(popoutDocument);
    expect(native.contentEl.querySelector(hostSelector)).toHaveTextContent("Task title");
    harness.leaves.length = 0;
    harness.emit("workspace", "window-close");
    await flush();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
    expect(native.contentEl).not.toHaveClass(contentClass);
  });

  it("disconnects its resize observer and cancels pending native layout work on unload", async () => {
    let notifyResize: (() => void) | undefined;
    let resizeFrame: FrameRequestCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      resizeFrame = callback;
      return 37;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const harness = setup();
    const native = harness.addView(
      harness.addFile("Projects/Example.task.md", taskProperties("task-1")),
    );
    harness.start();
    await flush();
    expect(observe).toHaveBeenCalledWith(native.contentEl.querySelector(hostSelector));
    resizeFrame?.(0);
    requestFrame.mockClear();
    vi.mocked(native.view.onResize).mockClear();

    notifyResize?.();
    notifyResize?.();
    expect(requestFrame).toHaveBeenCalledOnce();
    await act(async () => harness.headers.dispose());

    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledWith(37);
    expect(native.view.onResize).toHaveBeenCalledOnce();
    notifyResize?.();
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(native.contentEl.querySelector(hostSelector)).toBeNull();
  });

  it("forwards header actions to the existing task services with the native file reference", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    harness.addView(file);
    harness.start();
    await flush();
    const { actions } = latestProps();
    const reference = { id: "task-1", filePath: file.path };

    await actions.setCompleted(reference, true);
    await actions.edit(reference);
    await actions.open("Projects/Subtask.task.md");

    expect(harness.services.projectTasks.setCompleted).toHaveBeenCalledWith(reference, true);
    expect(harness.services.projectTasks.loadEditableTask).toHaveBeenCalledWith(reference);
    expect(harness.services.modals.taskEdit).toHaveBeenCalledWith(
      expect.objectContaining({ task: { id: "task-1" }, projectPath: "Study" }),
    );
    expect(harness.openLinkText).toHaveBeenCalledWith("Projects/Subtask.task.md", file.path, false);
  });

  it("does not open a delayed edit dialog after the user leaves that task", async () => {
    const harness = setup();
    const file = harness.addFile("Projects/Example.task.md", taskProperties("task-1"));
    const native = harness.addView(file);
    harness.start();
    await flush();
    let resolveTask: ((task: { id: string }) => void) | undefined;
    harness.services.projectTasks.loadEditableTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTask = resolve;
        }),
    );
    const editing = latestProps().actions.edit({ id: "task-1", filePath: file.path });
    native.view.file = harness.addFile("Notes/Other.md");
    harness.emit("workspace", "file-open");
    await flush();
    resolveTask?.({ id: "task-1" });
    await editing;
    expect(harness.services.modals.taskEdit).not.toHaveBeenCalled();
  });
});
