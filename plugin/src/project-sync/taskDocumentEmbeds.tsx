import { load as loadYaml } from "js-yaml";
import {
  getFrontMatterInfo,
  type MarkdownPostProcessorContext,
  MarkdownRenderChild,
  parseLinktext,
  type TFile,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type TodoistPlugin from "@/index";
import { RenderChildContext } from "@/ui/context";
import { ProjectTaskCard, type ProjectTaskCardModel } from "@/ui/projectTaskCard";

import {
  hasManagedTaskBody,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  readManagedNoteIdentity,
  readManagedTaskIdentityMarker,
} from "./document";
import { findManagedTaskFileById, readTaskCardModel } from "./taskCardInjector";

import "./taskDocumentEmbeds.scss";

const embedSelector = ".internal-embed[src]";
const embedClass = "tasks-bridge-task-embed";
const cardClass = "tasks-bridge-task-embed-card";
const refreshDelayMs = 50;

/** Render whole-file task embeds through the public Markdown postprocessor lifecycle. */
export class TaskDocumentEmbeds {
  private readonly plugin: TodoistPlugin;
  private readonly children = new Map<HTMLElement, TaskDocumentEmbedRenderer>();
  private disposed = false;

  constructor(plugin: TodoistPlugin) {
    this.plugin = plugin;
  }

  public onPostProcessor(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (this.disposed) {
      return;
    }
    const candidates = [
      ...(el.matches(embedSelector) ? [el] : []),
      ...el.querySelectorAll<HTMLElement>(embedSelector),
    ];
    for (const embed of candidates) {
      // A nested embed's own source section supplies its correct relative-link context.
      const enclosingEmbed = embed.parentElement?.closest(embedSelector);
      if (enclosingEmbed !== undefined && enclosingEmbed !== null && el.contains(enclosingEmbed)) {
        continue;
      }
      if (
        this.children.has(embed) ||
        resolveWholeTaskEmbed(this.plugin, embed, ctx.sourcePath) === null
      ) {
        continue;
      }
      const child = new TaskDocumentEmbedRenderer(embed, this.plugin, ctx.sourcePath, () => {
        this.children.delete(embed);
      });
      this.children.set(embed, child);
      ctx.addChild(child);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const child of this.children.values()) {
      child.unload();
    }
    this.children.clear();
  }
}

const resolveWholeTaskEmbed = (
  plugin: TodoistPlugin,
  embed: HTMLElement,
  sourcePath: string,
): TFile | null => {
  const source = embed.getAttribute("src");
  if (source === null || embed.dataset.type === "heading" || embed.dataset.type === "block") {
    return null;
  }
  const link = parseLinktext(source);
  if (link.path === "" || link.subpath !== "") {
    return null;
  }
  const file = plugin.app.metadataCache.getFirstLinkpathDest(link.path, sourcePath);
  return file?.path.endsWith(".task.md") === true ? file : null;
};

const hasSourceOnlyIdentity = (content: string, taskId: string): boolean => {
  const info = getFrontMatterInfo(content);
  if (!info.exists || !hasManagedTaskBody(content, info.contentStart, taskId)) {
    return false;
  }
  try {
    const frontmatter: unknown = loadYaml(info.frontmatter);
    if (
      typeof frontmatter !== "object" ||
      frontmatter === null ||
      Array.isArray(frontmatter) ||
      readManagedNoteIdentity(frontmatter as Record<string, unknown>)?.taskId !== taskId
    ) {
      return false;
    }
    const start = content.indexOf(MANAGED_BODY_START) + MANAGED_BODY_START.length;
    const end = content.indexOf(MANAGED_BODY_END);
    return readManagedTaskIdentityMarker(content.slice(start, end).trim())?.taskId === taskId;
  } catch {
    return false;
  }
};

class TaskDocumentEmbedRenderer extends MarkdownRenderChild {
  private readonly plugin: TodoistPlugin;
  private readonly sourcePath: string;
  private readonly onDispose: () => void;
  private model: ProjectTaskCardModel | null = null;
  private signature: string | undefined;
  private root: Root | undefined;
  private host: HTMLElement | undefined;
  private observer: MutationObserver | undefined;
  private timer: number | undefined;
  private generation = 0;
  private linkSource: string | null;
  private disposed = false;

  constructor(
    embed: HTMLElement,
    plugin: TodoistPlugin,
    sourcePath: string,
    onDispose: () => void,
  ) {
    super(embed);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.onDispose = onDispose;
    this.linkSource = embed.getAttribute("src");
  }

  public onload(): void {
    const { metadataCache, vault } = this.plugin.app;
    const refresh = () => this.schedule();
    this.registerEvent(metadataCache.on("changed", refresh));
    this.registerEvent(metadataCache.on("resolved", refresh));
    this.registerEvent(vault.on("rename", refresh));
    this.registerEvent(vault.on("delete", refresh));
    const win = this.containerEl.ownerDocument.defaultView;
    if (win !== null) {
      this.observer = new win.MutationObserver(() => {
        if (this.disposed) {
          return;
        }
        const source = this.containerEl.getAttribute("src");
        if (
          source !== this.linkSource ||
          resolveWholeTaskEmbed(this.plugin, this.containerEl, this.sourcePath) === null
        ) {
          this.linkSource = source;
          this.generation++;
          this.model = null;
          this.clearCard();
          this.schedule();
        } else {
          this.mountCard();
        }
      });
      this.observer.observe(this.containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-type"],
      });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) {
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, refreshDelayMs);
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    const file = resolveWholeTaskEmbed(this.plugin, this.containerEl, this.sourcePath);
    const candidate = file === null ? null : readTaskCardModel(this.plugin, file);
    if (
      file === null ||
      candidate === null ||
      findManagedTaskFileById(this.plugin, candidate.taskId, file.path)?.path !== file.path
    ) {
      this.model = null;
      this.clearCard();
      return;
    }
    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      if (this.disposed || generation !== this.generation) {
        return;
      }
      if (
        resolveWholeTaskEmbed(this.plugin, this.containerEl, this.sourcePath)?.path !== file.path ||
        !hasSourceOnlyIdentity(content, candidate.taskId)
      ) {
        this.model = null;
        this.clearCard();
        return;
      }
      this.model = candidate;
      this.mountCard();
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.model = null;
        this.clearCard();
      }
    }
  }

  private mountCard(): void {
    if (this.disposed || this.model === null) {
      return;
    }
    // Native embeds render asynchronously, including when the postprocessor receives a detached
    // source section. Keep our card outside the native preview's virtualized Markdown sections.
    const content = this.containerEl.querySelector<HTMLElement>(":scope > .markdown-embed-content");
    if (content?.querySelector(":scope > .markdown-preview-view") === null || content === null) {
      return;
    }
    if (this.host?.parentElement !== content) {
      this.clearCard();
      this.host = content.createDiv({ cls: cardClass });
      content.prepend(this.host);
      this.root = createRoot(this.host);
    }
    this.containerEl.classList.add(embedClass);
    const signature = JSON.stringify(this.model);
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.root?.render(
      <RenderChildContext.Provider value={this}>
        <ProjectTaskCard
          key={this.model.taskId}
          task={this.model}
          actions={{
            setCompleted: async (reference, completed) =>
              await this.plugin.services.projectTasks.setCompleted(reference, completed),
            edit: async (reference) => {
              const task = await this.plugin.services.projectTasks.loadEditableTask(reference);
              if (this.disposed || this.model?.taskId !== reference.id) {
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
              await this.plugin.app.workspace.openLinkText(
                filePath,
                this.model?.filePath ?? this.sourcePath,
                false,
              );
            },
          }}
        />
      </RenderChildContext.Provider>,
    );
  }

  private clearCard(): void {
    this.root?.unmount();
    this.root = undefined;
    this.host?.remove();
    this.host = undefined;
    this.signature = undefined;
    this.containerEl.classList.remove(embedClass);
  }

  public onunload(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation++;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
    }
    this.observer?.disconnect();
    this.clearCard();
    this.onDispose();
  }
}
