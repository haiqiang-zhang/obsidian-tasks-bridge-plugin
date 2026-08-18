import type { MarkdownPostProcessorContext, TFile } from "obsidian";
import { MarkdownRenderChild, normalizePath } from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type TodoistPlugin from "@/index";
import { readManagedNoteIdentity, readProjectTaskBlockIdentity } from "@/project-sync/document";
import { RenderChildContext } from "@/ui/context";
import { ProjectTaskCard, type ProjectTaskCardModel } from "@/ui/projectTaskCard";

export class ProjectTaskCardInjector {
  private readonly plugin: TodoistPlugin;

  constructor(plugin: TodoistPlugin) {
    this.plugin = plugin;
  }

  public onNewBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const identity = readProjectTaskBlockIdentity(source);
    if (identity === null) {
      el.createDiv({
        cls: "tasks-bridge-note-card-error",
        text: 'This project task block needs one valid "task_id" field.',
      });
      return;
    }

    const file = findManagedTaskFileById(this.plugin, identity.taskId, ctx.sourcePath);
    const model =
      file === null ? null : readTaskCardModel(this.plugin, file, new Set(), identity.taskId);
    this.mountModel(model, el, ctx);
  }

  public onLegacyBlock(_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const file = this.plugin.app.vault.getFileByPath(normalizePath(ctx.sourcePath));
    const model = file === null ? null : readTaskCardModel(this.plugin, file);
    this.mountModel(model, el, ctx);
  }

  private mountModel(
    model: ProjectTaskCardModel | null,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): void {
    if (model === null) {
      el.createDiv({
        cls: "tasks-bridge-note-card-error",
        text: "This managed task is unavailable. Run Project sync to repair it.",
      });
      return;
    }

    const child = new ProjectTaskCardRenderer(el, this.plugin, model);
    ctx.addChild(child);
  }
}

class ProjectTaskCardRenderer extends MarkdownRenderChild {
  private readonly plugin: TodoistPlugin;
  private model: ProjectTaskCardModel;
  private readonly root: Root;

  constructor(container: HTMLElement, plugin: TodoistPlugin, model: ProjectTaskCardModel) {
    super(container);
    this.plugin = plugin;
    this.model = model;
    this.root = createRoot(container);
  }

  public onload(): void {
    this.render();
    this.registerEvent(
      this.plugin.app.metadataCache.on("changed", (file) => {
        if (!collectTaskCardPaths(this.model).has(file.path)) {
          return;
        }
        const rootFile = this.plugin.app.vault.getFileByPath(this.model.filePath);
        const nextModel =
          rootFile === null
            ? null
            : readTaskCardModel(this.plugin, rootFile, new Set(), this.model.taskId);
        if (nextModel === null) {
          return;
        }
        this.model = nextModel;
        this.render();
      }),
    );
  }

  private render(): void {
    this.root.render(
      <RenderChildContext.Provider value={this}>
        <ProjectTaskCard
          task={this.model}
          actions={{
            setCompleted: async (reference, completed) =>
              await this.plugin.services.projectTasks.setCompleted(reference, completed),
            edit: async (reference) => {
              const task = await this.plugin.services.projectTasks.loadEditableTask(reference);
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
              await this.plugin.app.workspace.openLinkText(filePath, this.model.filePath, false);
            },
          }}
        />
      </RenderChildContext.Provider>,
    );
  }

  public onunload(): void {
    this.root.unmount();
  }
}

const readTaskCardModel = (
  plugin: TodoistPlugin,
  file: TFile,
  seen = new Set<string>(),
  blockTaskId?: string,
): ProjectTaskCardModel | null => {
  if (seen.has(file.path)) {
    return null;
  }
  seen.add(file.path);
  const cache = plugin.app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;
  if (frontmatter === undefined) {
    return null;
  }
  const noteIdentity = readManagedNoteIdentity(frontmatter);
  if (blockTaskId !== undefined && (noteIdentity === null || noteIdentity.taskId !== blockTaskId)) {
    return null;
  }
  const identity = blockTaskId === undefined ? noteIdentity : { taskId: blockTaskId };
  const content = readString(frontmatter.todoist_content);
  const status = frontmatter.todoist_status;
  const url = readString(frontmatter.todoist_url);
  if (
    identity === null ||
    content === undefined ||
    url === undefined ||
    (status !== "active" &&
      status !== "completed" &&
      status !== "stale" &&
      status !== "out_of_scope")
  ) {
    return null;
  }

  return {
    completed:
      typeof frontmatter.todoist_completed === "boolean"
        ? frontmatter.todoist_completed
        : status === "completed",
    content,
    description: readString(frontmatter.todoist_description, true) ?? "",
    filePath: file.path,
    labels: readStringList(frontmatter.todoist_labels),
    priority: readString(frontmatter.todoist_priority) ?? "P4",
    projectPath: readStringList(frontmatter.todoist_project_path),
    section: readString(frontmatter.todoist_section),
    status,
    subtasks: (cache?.frontmatterLinks ?? [])
      .filter(({ key }) => key === "todoist_subtasks" || key.startsWith("todoist_subtasks."))
      .flatMap(({ link }) => {
        const childFile = plugin.app.metadataCache.getFirstLinkpathDest(link, file.path);
        if (childFile === null) {
          return [];
        }
        const child = readTaskCardModel(plugin, childFile, new Set(seen));
        return child === null ? [] : [child];
      }),
    taskId: identity.taskId,
    url,
  };
};

/** Resolve a canonical project-task block by its own ID, independent of the containing note. */
export const findManagedTaskFileById = (
  plugin: TodoistPlugin,
  taskId: string,
  preferredPath: string,
): TFile | null => {
  const preferred = plugin.app.vault.getFileByPath(normalizePath(preferredPath));
  const preferredIdentity =
    preferred === null
      ? null
      : readManagedNoteIdentity(
          plugin.app.metadataCache.getFileCache(preferred)?.frontmatter ?? {},
        );
  let match: TFile | null = preferredIdentity?.taskId === taskId ? preferred : null;
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (file.path === preferred?.path) {
      continue;
    }
    const identity = readManagedNoteIdentity(
      plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {},
    );
    if (identity?.taskId !== taskId) {
      continue;
    }
    // Duplicate immutable IDs are a Project sync conflict, including when one copy contains this
    // block. Refuse to render an arbitrary copy until Project sync restores a unique projection.
    if (match !== null) {
      return null;
    }
    match = file;
  }
  return match;
};

const collectTaskCardPaths = (task: ProjectTaskCardModel): Set<string> => {
  const paths = new Set<string>();
  const visit = (current: ProjectTaskCardModel): void => {
    paths.add(current.filePath);
    for (const child of current.subtasks) {
      visit(child);
    }
  };
  visit(task);
  return paths;
};

const readString = (value: unknown, allowEmpty = false): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const result = value.trim();
  return result === "" && !allowEmpty ? undefined : result;
};

const readStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
