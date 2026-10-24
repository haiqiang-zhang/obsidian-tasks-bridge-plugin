import { type App, type EventRef, MarkdownView } from "obsidian";

export const TASK_DOCUMENT_VIEW_CLASS = "tasks-bridge-task-document";
export const TASK_DOCUMENT_BADGE_CLASS = "tasks-bridge-task-file-badge";
export const TASK_DOCUMENT_BREADCRUMB_CLASS = "tasks-bridge-task-breadcrumb";

const explorerRowSelector = ".nav-file-title[data-path]";
const explorerLabelSelector = ".nav-file-title-content";
const presentationDelayMs = 50;

const isTaskDocument = (path: string | undefined): boolean => path?.endsWith(".task.md") === true;

type TaskLabelDecoration = {
  row: HTMLElement;
  path: string;
  original: string;
  replacement: string;
};

type TaskBreadcrumbDecoration = {
  view: MarkdownView;
  observer: MutationObserver;
  labels: Set<HTMLElement>;
};

/** Presentation only: task documents remain native Markdown files, views, and metadata. */
export class TaskDocumentPresentation {
  private readonly app: App;
  private readonly explorers = new Map<HTMLElement, MutationObserver>();
  private readonly explorerRenameListeners = new Map<HTMLElement, (event: FocusEvent) => void>();
  private readonly decoratedViews = new Set<HTMLElement>();
  private readonly decoratedLabels = new Map<HTMLElement, TaskLabelDecoration>();
  private readonly breadcrumbs = new Map<HTMLElement, TaskBreadcrumbDecoration>();
  private readonly pendingElements = new Set<Element>();
  private refreshLayout = false;
  private timer: number | undefined;
  private started = false;
  private disposed = false;

  constructor(app: App) {
    this.app = app;
  }

  public start(registerEvent: (eventRef: EventRef) => void): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const refresh = () => this.scheduleLayoutRefresh();
    registerEvent(this.app.workspace.on("file-open", refresh));
    registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    registerEvent(this.app.workspace.on("layout-change", refresh));
    registerEvent(this.app.workspace.on("window-open", refresh));
    registerEvent(this.app.workspace.on("window-close", refresh));
    registerEvent(this.app.vault.on("create", refresh));
    registerEvent(this.app.vault.on("rename", refresh));
    registerEvent(this.app.vault.on("delete", refresh));
    this.app.workspace.onLayoutReady(refresh);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [container, observer] of this.explorers) {
      this.removeExplorer(container, observer);
    }
    for (const [label, decoration] of this.decoratedLabels) {
      this.restoreLabel(label, decoration);
    }
    for (const decoration of this.breadcrumbs.values()) {
      this.removeBreadcrumb(decoration);
    }
    this.breadcrumbs.clear();
    for (const container of this.decoratedViews) {
      container.classList.remove(TASK_DOCUMENT_VIEW_CLASS);
    }
    this.explorers.clear();
    this.explorerRenameListeners.clear();
    this.decoratedViews.clear();
    this.decoratedLabels.clear();
    this.pendingElements.clear();
  }

  private scheduleLayoutRefresh(): void {
    if (this.disposed) {
      return;
    }
    this.refreshLayout = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) {
      return;
    }
    // Background popout windows may suspend animation frames; a bounded timer still updates them.
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, presentationDelayMs);
  }

  private flush(): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshLayout) {
      this.refreshLayout = false;
      this.updateMarkdownViews();
      this.updateExplorers();
    }
    const rows = new Set<HTMLElement>();
    for (const [label, decoration] of this.decoratedLabels) {
      if (!label.isConnected || !decoration.row.contains(label)) {
        this.decoratedLabels.delete(label);
      }
    }
    for (const element of this.pendingElements) {
      if (!element.isConnected) {
        continue;
      }
      if (element.matches(explorerRowSelector)) {
        rows.add(element as HTMLElement);
      }
      for (const row of element.querySelectorAll<HTMLElement>(explorerRowSelector)) {
        rows.add(row);
      }
    }
    this.pendingElements.clear();
    for (const row of rows) {
      this.updateExplorerRow(row);
    }
  }

  private updateMarkdownViews(): void {
    const currentViews = new Set<HTMLElement>();
    const currentBreadcrumbs = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      const isTask = isTaskDocument(view.file?.path);
      view.containerEl.classList.toggle(TASK_DOCUMENT_VIEW_CLASS, isTask);
      if (isTask) {
        currentViews.add(view.containerEl);
        const header = view.containerEl.querySelector<HTMLElement>(".view-header-title-container");
        if (header !== null) {
          currentBreadcrumbs.add(header);
          this.updateBreadcrumb(view, header);
        }
      }
    }
    for (const [header, decoration] of this.breadcrumbs) {
      if (!currentBreadcrumbs.has(header)) {
        this.removeBreadcrumb(decoration);
        this.breadcrumbs.delete(header);
      }
    }
    for (const container of this.decoratedViews) {
      if (!currentViews.has(container)) {
        container.classList.remove(TASK_DOCUMENT_VIEW_CLASS);
      }
    }
    this.decoratedViews.clear();
    for (const container of currentViews) {
      this.decoratedViews.add(container);
    }
  }

  private updateBreadcrumb(view: MarkdownView, header: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    let decoration = this.breadcrumbs.get(header);
    if (decoration === undefined) {
      const win = header.ownerDocument.defaultView;
      if (win === null) {
        return;
      }
      const observer = new win.MutationObserver(() => this.updateBreadcrumb(view, header));
      // Observe only native title redraws, never the editor or our own display attributes.
      observer.observe(header, { childList: true, characterData: true, subtree: true });
      decoration = { view, observer, labels: new Set() };
      this.breadcrumbs.set(header, decoration);
    }
    const path = decoration.view.file?.path;
    const filename = path?.slice(path.lastIndexOf("/") + 1) ?? "";
    const shortName = filename.slice(0, -".task.md".length);
    const labels = new Set(header.querySelectorAll<HTMLElement>(".view-header-title"));
    for (const label of new Set([...decoration.labels, ...labels])) {
      const matches =
        labels.has(label) &&
        isTaskDocument(path) &&
        shortName !== "" &&
        label.childElementCount === 0 &&
        (label.textContent === filename || label.textContent === filename.slice(0, -".md".length));
      label.classList.toggle(TASK_DOCUMENT_BREADCRUMB_CLASS, matches);
      if (matches) {
        // This is an always-editable native rename field. Keep its real text intact at all times.
        label.setAttribute("data-tasks-bridge-title", shortName);
      } else {
        label.removeAttribute("data-tasks-bridge-title");
      }
    }
    decoration.labels = labels;
  }

  private removeBreadcrumb(decoration: TaskBreadcrumbDecoration): void {
    decoration.observer.disconnect();
    for (const label of decoration.labels) {
      label.classList.remove(TASK_DOCUMENT_BREADCRUMB_CLASS);
      label.removeAttribute("data-tasks-bridge-title");
    }
  }

  private updateExplorers(): void {
    const currentContainers = new Set(
      this.app.workspace
        .getLeavesOfType("file-explorer")
        .map((leaf) => leaf.view.containerEl)
        .filter((container) => !container.ownerDocument.defaultView?.closed),
    );
    for (const [container, observer] of this.explorers) {
      if (!currentContainers.has(container)) {
        this.removeExplorer(container, observer);
        this.explorers.delete(container);
      }
    }
    for (const container of currentContainers) {
      if (this.explorers.has(container)) {
        continue;
      }
      const viewWindow = container.ownerDocument.defaultView;
      if (viewWindow === null) {
        continue;
      }
      const observer = new viewWindow.MutationObserver((mutations) => {
        if (this.disposed) {
          return;
        }
        for (const mutation of mutations) {
          const target =
            mutation.target.nodeType === Node.ELEMENT_NODE
              ? (mutation.target as Element)
              : mutation.target.parentElement;
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "contenteditable" &&
            target?.matches(explorerLabelSelector)
          ) {
            // In background windows, native focus may not dispatch focusin. The first editable
            // transition still arrives before the next user-input task and safely restores our text.
            this.prepareNativeRenameLabel(target as HTMLElement);
          }
          const row = target?.closest(explorerRowSelector);
          if (row !== null && row !== undefined) {
            this.pendingElements.add(row);
          }
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              if (!element.classList.contains(TASK_DOCUMENT_BADGE_CLASS)) {
                this.pendingElements.add(element);
              }
            }
          }
        }
        if (this.pendingElements.size > 0) {
          this.schedule();
        }
      });
      observer.observe(container, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-path", "contenteditable"],
      });
      const onRenameFocus = (event: FocusEvent) => this.prepareNativeRename(event);
      container.addEventListener("focusin", onRenameFocus, true);
      this.explorerRenameListeners.set(container, onRenameFocus);
      this.explorers.set(container, observer);
      this.pendingElements.add(container);
    }
  }

  private prepareNativeRename(event: FocusEvent): void {
    const target = event.target as Node | null;
    if (target?.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const label = (target as Element).closest<HTMLElement>(explorerLabelSelector);
    if (label !== null) {
      this.prepareNativeRenameLabel(label);
    }
  }

  private prepareNativeRenameLabel(label: HTMLElement): void {
    const decoration = this.decoratedLabels.get(label);
    if (
      decoration === undefined ||
      !this.isRenaming(decoration.row) ||
      decoration.row.dataset.path !== decoration.path ||
      label.childElementCount > 0 ||
      label.textContent !== decoration.replacement
    ) {
      return;
    }
    // Native Explorer starts rename using its existing label text. Restore our display-only
    // shortening synchronously on initial focus, before any user input or save can occur.
    const selection = label.ownerDocument.defaultView?.getSelection();
    const selectedLabel =
      selection !== null &&
      selection !== undefined &&
      selection.rangeCount > 0 &&
      label.contains(selection.getRangeAt(0).commonAncestorContainer);
    label.textContent = decoration.original;
    this.decoratedLabels.delete(label);
    if (selectedLabel) {
      const range = label.ownerDocument.createRange();
      range.selectNodeContents(label);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  private updateExplorerRow(row: HTMLElement): void {
    const badges = [...row.querySelectorAll<HTMLElement>(`.${TASK_DOCUMENT_BADGE_CLASS}`)];
    if (!isTaskDocument(row.dataset.path)) {
      for (const badge of badges) {
        badge.remove();
      }
      this.removeRowLabels(row);
      return;
    }
    if (this.isRenaming(row)) {
      return;
    }
    this.updateExplorerLabel(row);
    if (badges.length === 0) {
      const badge = row.createDiv({
        cls: `nav-file-tag ${TASK_DOCUMENT_BADGE_CLASS}`,
        text: "TASK",
      });
      badge.setAttribute("aria-label", "Tasks Bridge task");
    }
    badges[0]?.classList.add("nav-file-tag");
    for (const duplicate of badges.slice(1)) {
      duplicate.remove();
    }
  }

  private isRenaming(row: HTMLElement): boolean {
    const editable = '[contenteditable]:not([contenteditable="false"])';
    return (
      row.isContentEditable ||
      row.closest(editable) !== null ||
      row.querySelector(`${editable}, input, textarea`) !== null
    );
  }

  private updateExplorerLabel(row: HTMLElement): void {
    const path = row.dataset.path;
    const label = row.querySelector<HTMLElement>(explorerLabelSelector);
    if (path === undefined || label === null) {
      return;
    }
    const previous = this.decoratedLabels.get(label);
    if (previous !== undefined && previous.path !== path) {
      // Native Explorer recycles rows during rename/move. An old path must never restore its name.
      this.decoratedLabels.delete(label);
    }
    // Search highlights and native rename controls own their markup and must remain intact.
    if (label.childElementCount > 0 || this.isRenaming(row)) {
      return;
    }
    const filename = path.slice(path.lastIndexOf("/") + 1);
    const original = label.textContent ?? "";
    const replacement = filename.slice(0, -".task.md".length);
    if (
      replacement === "" ||
      (original !== filename && original !== filename.slice(0, -".md".length))
    ) {
      if (original !== previous?.replacement) {
        this.decoratedLabels.delete(label);
      }
      return;
    }
    this.decoratedLabels.set(label, { row, path, original, replacement });
    label.textContent = replacement;
  }

  private restoreLabel(label: HTMLElement, decoration: TaskLabelDecoration): void {
    if (
      decoration.row.dataset.path === decoration.path &&
      decoration.row.contains(label) &&
      label.childElementCount === 0 &&
      label.textContent === decoration.replacement &&
      !this.isRenaming(decoration.row)
    ) {
      label.textContent = decoration.original;
    }
  }

  private removeRowLabels(row: HTMLElement): void {
    for (const [label, decoration] of this.decoratedLabels) {
      if (decoration.row === row) {
        this.restoreLabel(label, decoration);
        this.decoratedLabels.delete(label);
      }
    }
  }

  private removeExplorer(container: HTMLElement, observer: MutationObserver): void {
    observer.disconnect();
    const onRenameFocus = this.explorerRenameListeners.get(container);
    if (onRenameFocus !== undefined) {
      container.removeEventListener("focusin", onRenameFocus, true);
      this.explorerRenameListeners.delete(container);
    }
    for (const [label, decoration] of this.decoratedLabels) {
      if (container.contains(decoration.row)) {
        this.restoreLabel(label, decoration);
        this.decoratedLabels.delete(label);
      }
    }
    for (const element of this.pendingElements) {
      if (container.contains(element)) {
        this.pendingElements.delete(element);
      }
    }
    for (const badge of container.querySelectorAll(`.${TASK_DOCUMENT_BADGE_CLASS}`)) {
      badge.remove();
    }
  }
}
