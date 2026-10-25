import { type EventRef, MarkdownRenderChild, MarkdownView } from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type TodoistPlugin from "@/index";
import { readManagedNoteIdentity } from "@/project-sync/document";
import { readTaskCardModel } from "@/project-sync/taskCardInjector";
import { RenderChildContext } from "@/ui/context";
import type { ProjectTaskCardModel } from "@/ui/projectTaskCard";
import { ProjectTaskHeader } from "@/ui/projectTaskHeader";

const contentClass = "tasks-bridge-task-content";
const hostClass = "tasks-bridge-task-header-host";
const backgroundRefreshDelayMs = 50;

/** Adds a file-level header without replacing the native Markdown view or editor. */
export class TaskDocumentHeaders {
  private readonly headers = new Map<MarkdownView, TaskDocumentHeaderRenderer>();
  private refreshPending = false;
  private backgroundTimer: number | undefined;
  private started = false;
  private disposed = false;

  private readonly plugin: TodoistPlugin;

  constructor(plugin: TodoistPlugin) {
    this.plugin = plugin;
  }

  public start(registerEvent: (eventRef: EventRef) => void): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const refresh = () => this.schedule();
    const { workspace, vault, metadataCache } = this.plugin.app;
    registerEvent(workspace.on("file-open", refresh));
    registerEvent(workspace.on("active-leaf-change", refresh));
    registerEvent(workspace.on("layout-change", refresh));
    registerEvent(workspace.on("window-open", refresh));
    registerEvent(workspace.on("window-close", refresh));
    registerEvent(vault.on("rename", refresh));
    registerEvent(vault.on("delete", refresh));
    registerEvent(
      metadataCache.on("changed", (file) => {
        if (
          file.path.endsWith(".task.md") &&
          workspace
            .getLeavesOfType("markdown")
            .some((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path)
        ) {
          this.schedule();
        } else {
          this.scheduleBackground();
        }
      }),
    );
    registerEvent(metadataCache.on("resolved", refresh));
    workspace.onLayoutReady(refresh);
    this.schedule();
  }

  /** Native document hydration can finish after the restored workspace's initial scan. */
  public requestRefresh(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    if (this.backgroundTimer !== undefined) {
      window.clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
    if (this.refreshPending) {
      return;
    }
    this.refreshPending = true;
    // Native metadata can render in the same turn as file hydration. Coalesce that turn's
    // events before the next paint without a timer that background windows can throttle.
    queueMicrotask(() => {
      this.refreshPending = false;
      this.refresh();
    });
  }

  private scheduleBackground(): void {
    if (this.disposed || this.refreshPending || this.backgroundTimer !== undefined) {
      return;
    }
    // Indexing other notes may emit one event per event-loop turn. Preserve bounded batching
    // for duplicate IDs and linked subtasks without delaying an open task's native metadata.
    this.backgroundTimer = window.setTimeout(() => {
      this.backgroundTimer = undefined;
      this.refresh();
    }, backgroundRefreshDelayMs);
  }

  private refresh(): void {
    if (this.disposed) {
      return;
    }
    const { workspace, vault, metadataCache } = this.plugin.app;
    const counts = new Map<string, number>();
    for (const file of vault.getMarkdownFiles()) {
      const identity = readManagedNoteIdentity(metadataCache.getFileCache(file)?.frontmatter ?? {});
      if (identity !== null) {
        counts.set(identity.taskId, (counts.get(identity.taskId) ?? 0) + 1);
      }
    }
    const current = new Set<MarkdownView>();
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      // Deferred leaves are intentionally left alone; Obsidian loads them when opened.
      if (!(view instanceof MarkdownView) || !view.file?.path.endsWith(".task.md")) {
        continue;
      }
      const model = readTaskCardModel(this.plugin, view.file);
      if (model === null || counts.get(model.taskId) !== 1) {
        continue;
      }
      current.add(view);
      const existing = this.headers.get(view);
      if (
        existing !== undefined &&
        existing.taskId === model.taskId &&
        existing.filePath === model.filePath
      ) {
        existing.update(model);
      } else {
        this.remove(view);
        const host = view.contentEl.createDiv({ cls: hostClass });
        view.contentEl.prepend(host);
        view.contentEl.classList.add(contentClass);
        const renderer = new TaskDocumentHeaderRenderer(host, this.plugin, view, model);
        this.headers.set(view, renderer);
        view.addChild(renderer);
      }
    }
    for (const view of this.headers.keys()) {
      if (!current.has(view)) {
        this.remove(view);
      }
    }
  }

  private remove(view: MarkdownView): void {
    const renderer = this.headers.get(view);
    if (renderer === undefined) {
      return;
    }
    view.removeChild(renderer);
    this.headers.delete(view);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.backgroundTimer !== undefined) {
      window.clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
    for (const view of this.headers.keys()) {
      this.remove(view);
    }
  }
}

class TaskDocumentHeaderRenderer extends MarkdownRenderChild {
  private root: Root | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private placementObserver: MutationObserver | undefined;
  private resizeFrame: number | undefined;
  private disposed = false;
  private signature: string;
  public readonly taskId: string;
  public readonly filePath: string;

  private readonly plugin: TodoistPlugin;
  private readonly view: MarkdownView;
  private model: ProjectTaskCardModel;

  constructor(
    container: HTMLElement,
    plugin: TodoistPlugin,
    view: MarkdownView,
    model: ProjectTaskCardModel,
  ) {
    super(container);
    this.plugin = plugin;
    this.view = view;
    this.model = model;
    this.taskId = model.taskId;
    this.filePath = model.filePath;
    this.signature = JSON.stringify(model);
  }

  public onload(): void {
    this.root = createRoot(this.containerEl);
    this.placeHeader();
    this.render();
    const win = this.containerEl.ownerDocument.defaultView;
    if (win !== null) {
      // Modes can switch without replacing MarkdownView. Native mode roots may also be rebuilt.
      // The header lives beside the native title/Properties, outside CodeMirror's editable DOM.
      this.placementObserver = new win.MutationObserver(() => this.placeHeader());
      this.placementObserver.observe(this.view.contentEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
    if (win !== null && typeof win.ResizeObserver === "function") {
      this.resizeObserver = new win.ResizeObserver(() => {
        if (this.disposed || this.resizeFrame !== undefined) {
          return;
        }
        this.resizeFrame = win.requestAnimationFrame(() => {
          this.resizeFrame = undefined;
          if (!this.disposed) {
            this.view.onResize();
          }
        });
      });
      this.resizeObserver.observe(this.containerEl);
    }
  }

  private placeHeader(): void {
    if (this.disposed || this.view.file?.path !== this.filePath) {
      return;
    }
    const selector =
      this.view.getMode() === "preview"
        ? ":scope > .markdown-reading-view > .markdown-preview-view > .markdown-preview-sizer > .mod-header"
        : ":scope > .markdown-source-view > .cm-editor > .cm-scroller > .cm-sizer";
    const parent = this.view.contentEl.querySelector<HTMLElement>(selector);
    if (parent !== null && this.containerEl.parentElement !== parent) {
      parent.prepend(this.containerEl);
    }
  }

  public update(model: ProjectTaskCardModel): void {
    const signature = JSON.stringify(model);
    if (signature === this.signature || this.disposed) {
      return;
    }
    this.signature = signature;
    this.model = model;
    this.render();
  }

  private render(): void {
    this.root?.render(
      <RenderChildContext.Provider value={this}>
        <ProjectTaskHeader
          key={this.model.taskId}
          task={this.model}
          actions={{
            setCompleted: async (reference, completed) =>
              await this.plugin.services.projectTasks.setCompleted(reference, completed),
            edit: async (reference) => {
              const task = await this.plugin.services.projectTasks.loadEditableTask(reference);
              if (this.disposed || this.view.file?.path !== this.filePath) {
                return;
              }
              this.plugin.services.modals.taskEdit({
                task,
                projectPath: this.model.projectPath.join(" / "),
                sectionName: this.model.section,
                onSubmit: async (params) => {
                  await this.plugin.services.projectTasks.updateTask(reference, params);
                },
              });
            },
            open: async (filePath) => {
              await this.plugin.app.workspace.openLinkText(filePath, this.filePath, false);
            },
          }}
        />
      </RenderChildContext.Provider>,
    );
  }

  public onunload(): void {
    this.disposed = true;
    this.placementObserver?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== undefined) {
      this.containerEl.ownerDocument.defaultView?.cancelAnimationFrame(this.resizeFrame);
    }
    this.root?.unmount();
    this.containerEl.remove();
    this.view.contentEl.classList.remove(contentClass);
    this.view.onResize();
  }
}
