import type { MarkdownPostProcessorContext, TFile } from "obsidian";
import { MarkdownRenderChild, normalizePath } from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type TodoistPlugin from "@/index";
import {
  hasManagedTaskBody,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  readManagedNoteIdentity,
  readProjectTaskBlockIdentity,
} from "@/project-sync/document";
import { readTaskProperty } from "@/project-sync/properties";
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
    if (model !== null) {
      this.markFileHeaderBlock(model, el, ctx);
    }
    this.mountModel(model, el, ctx);
  }

  public onLegacyBlock(_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const file = this.plugin.app.vault.getFileByPath(normalizePath(ctx.sourcePath));
    const model = file === null ? null : readTaskCardModel(this.plugin, file);
    if (model !== null) {
      this.markFileHeaderBlock(model, el, ctx);
    }
    this.mountModel(model, el, ctx);
  }

  private markFileHeaderBlock(
    model: ProjectTaskCardModel,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): void {
    if (
      ctx.sourcePath !== model.filePath ||
      !ctx.sourcePath.endsWith(".task.md") ||
      el.closest(".markdown-embed") !== null
    ) {
      return;
    }
    const section = ctx.getSectionInfo(el);
    if (section === null || !isManagedHeaderSection(section, model.taskId)) {
      return;
    }
    // Keep explicit blocks in other notes and user-written blocks outside the managed region.
    el.classList.add("tasks-bridge-managed-header-block");
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

export const isManagedHeaderSection = (
  section: { text: string; lineStart: number; lineEnd: number },
  taskId: string,
): boolean => {
  const lines = section.text.split(/\r?\n/);
  const start = lines.indexOf(MANAGED_BODY_START);
  const end = lines.indexOf(MANAGED_BODY_END);
  return (
    start >= 0 &&
    section.lineStart > start &&
    section.lineEnd < end &&
    hasManagedTaskBody(section.text, 0, taskId)
  );
};

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

export const readTaskCardModel = (
  plugin: TodoistPlugin,
  file: TFile,
  seen = new Set<string>(),
  blockTaskId?: string,
  rootFrontmatter?: Record<string, unknown>,
): ProjectTaskCardModel | null => {
  if (seen.has(file.path)) {
    return null;
  }
  seen.add(file.path);
  const cache = plugin.app.metadataCache.getFileCache(file);
  // A restored native document can be hydrated before the Vault's metadata index. Its caller
  // may supply validated local frontmatter for the root; linked children still use native caches.
  const frontmatter = rootFrontmatter ?? cache?.frontmatter;
  if (frontmatter === undefined) {
    return null;
  }
  const noteIdentity = readManagedNoteIdentity(frontmatter);
  if (blockTaskId !== undefined && (noteIdentity === null || noteIdentity.taskId !== blockTaskId)) {
    return null;
  }
  const identity = blockTaskId === undefined ? noteIdentity : { taskId: blockTaskId };
  if (identity === null) {
    return null;
  }
  const content = readString(readTaskProperty(frontmatter, "todoist_content"));
  const status = readTaskProperty(frontmatter, "todoist_status");
  const url = readString(readTaskProperty(frontmatter, "todoist_url"));
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

  const completed = readTaskProperty(frontmatter, "todoist_completed");
  const subtaskKey = "subtasks" in frontmatter ? "subtasks" : "todoist_subtasks";
  return {
    completed: typeof completed === "boolean" ? completed : status === "completed",
    content,
    description: readString(readTaskProperty(frontmatter, "todoist_description"), true) ?? "",
    filePath: file.path,
    dueDate: readString(readTaskProperty(frontmatter, "todoist_due_date")),
    dueDatetime: readString(readTaskProperty(frontmatter, "todoist_due_datetime")),
    dueTimezone: readString(readTaskProperty(frontmatter, "todoist_due_timezone")),
    recurring: readTaskProperty(frontmatter, "todoist_due_is_recurring") === true,
    deadline: readString(readTaskProperty(frontmatter, "todoist_deadline")),
    duration: readNumber(readTaskProperty(frontmatter, "todoist_duration")),
    durationUnit: readString(readTaskProperty(frontmatter, "todoist_duration_unit")),
    labels: readStringList(readTaskProperty(frontmatter, "todoist_labels")),
    priority: readString(readTaskProperty(frontmatter, "todoist_priority")) ?? "P4",
    projectPath: readStringList(readTaskProperty(frontmatter, "todoist_project_path")),
    section: readString(readTaskProperty(frontmatter, "todoist_section")),
    status,
    subtasks: (cache?.frontmatterLinks ?? [])
      .filter(({ key }) => key === subtaskKey || key.startsWith(`${subtaskKey}.`))
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

export const collectTaskCardPaths = (task: ProjectTaskCardModel): Set<string> => {
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

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
