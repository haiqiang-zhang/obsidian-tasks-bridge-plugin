import {
  type Editor,
  type EditorPosition,
  type FuzzyMatch,
  FuzzySuggestModal,
  type MarkdownFileInfo,
  MarkdownView,
  Notice,
  renderResults,
} from "obsidian";

import type { MakeCommand } from "@/commands";
import { t } from "@/i18n";
import type { Translations } from "@/i18n/translation";
import type TodoistPlugin from "@/index";
import { makeCreationTimeMarker } from "@/project-sync/creationTime";
import { makeProjectTaskBlock } from "@/project-sync/document";
import { QUERY_CODE_BLOCK } from "@/query/injector";
import type { EmbeddableProjectTask } from "@/services/projectTaskCommands";

const DEFAULT_QUERY_FILTER = "today | overdue";
const INSERT_ORIGIN = "tasks-bridge-insert-block";
const SHORT_TASK_ID_LENGTH = 6;

type EditorRange = {
  from: EditorPosition;
  to: EditorPosition;
  fromOffset: number;
  toOffset: number;
};

type ProjectTaskPickerItem = EmbeddableProjectTask & {
  current: boolean;
  detail: string;
  searchText: string;
};

export const insertQueryBlock: MakeCommand = (_plugin, i18n) => ({
  name: i18n.insertQueryBlock,
  editorCheckCallback: (checking, editor, context) => {
    if (!isFocusedMarkdownCommandContext(context)) {
      return false;
    }
    if (!checking) {
      insertQueryAtObsidianSelection(editor);
    }
    return true;
  },
});

export const insertProjectTaskBlock: MakeCommand = (plugin, i18n) => ({
  name: i18n.insertProjectTaskBlock,
  editorCheckCallback: (checking, editor, context) => {
    if (!isFocusedMarkdownCommandContext(context)) {
      return false;
    }
    if (!checking) {
      openProjectTaskPicker(plugin, editor, context.file?.path ?? "");
    }
    return true;
  },
});

const isFocusedMarkdownCommandContext = (
  context: MarkdownView | MarkdownFileInfo,
): context is MarkdownView =>
  context instanceof MarkdownView && context.containerEl.win === window.activeWindow;

const insertQueryAtObsidianSelection = (editor: Editor): void => {
  const content = editor.getValue();
  const selected = editor.getSelection();
  const normalizedFilter = normalizeQueryFilter(selected);
  const filter = normalizedFilter.length > 0 ? normalizedFilter : DEFAULT_QUERY_FILTER;
  const block = withDocumentLineEndings(makeQueryBlock(filter), content);
  editor.replaceSelection(makeEditorBlockInsertion(editor, block), INSERT_ORIGIN);
  editor.focus();
};

const openProjectTaskPicker = (
  plugin: TodoistPlugin,
  editor: Editor,
  currentFilePath: string,
): void => {
  const pickerI18n = t().projectTaskPicker;
  const tasks = plugin.services.projectTasks.listEmbeddableTasks();
  if (tasks.length === 0) {
    new Notice(pickerI18n.notices.noTasks);
    return;
  }

  const initialQuery = normalizePickerQuery(editor.getSelection());
  const items = makeProjectTaskPickerItems(tasks, currentFilePath, pickerI18n);
  const modal = new ProjectTaskSuggestModal(plugin, items, initialQuery, pickerI18n, (task) => {
    if (!isTaskStillEmbeddable(plugin, task.id)) {
      new Notice(pickerI18n.notices.contextChanged);
      return;
    }

    editor.replaceSelection(
      makeEditorBlockInsertion(
        editor,
        withDocumentLineEndings(makeProjectTaskBlock(task.id), editor.getValue()),
      ),
      INSERT_ORIGIN,
    );
    editor.focus();
  });
  modal.open();
};

const isTaskStillEmbeddable = (plugin: TodoistPlugin, taskId: string): boolean =>
  plugin.services.projectTasks.listEmbeddableTasks().some((task) => task.id === taskId);

export const makeQueryBlock = (filter: string): string =>
  `\`\`\`${QUERY_CODE_BLOCK}\nfilter: ${JSON.stringify(filter)}\n\`\`\``;

export const normalizeQueryFilter = (selection: string): string =>
  selection
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();

export const makeStandaloneBlockInsertion = (
  content: string,
  range: EditorRange,
  block: string,
): string => {
  const before = content.slice(0, range.fromOffset);
  const after = content.slice(range.toOffset);
  const lineEnding = preferredLineEnding(content);
  const prefix = missingLineBreaksBefore(before, lineEnding);
  const suffix = missingLineBreaksAfter(after, lineEnding);
  return `${prefix}${block}${suffix}`;
};

const makeEditorBlockInsertion = (editor: Editor, block: string): string =>
  makeStandaloneBlockInsertion(editor.getValue(), readObsidianSelection(editor), block);

const readObsidianSelection = (editor: Editor): EditorRange => {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  return {
    from,
    to,
    fromOffset: editor.posToOffset(from),
    toOffset: editor.posToOffset(to),
  };
};

const missingLineBreaksBefore = (before: string, lineEnding: string): string => {
  if (before.length === 0) {
    return "";
  }
  return lineEnding.repeat(Math.max(0, 2 - countTrailingLineBreaks(before)));
};

const missingLineBreaksAfter = (after: string, lineEnding: string): string => {
  if (after.length === 0) {
    return lineEnding;
  }
  return lineEnding.repeat(Math.max(0, 2 - countLeadingLineBreaks(after)));
};

const preferredLineEnding = (content: string): "\n" | "\r\n" =>
  content.includes("\r\n") ? "\r\n" : "\n";

const withDocumentLineEndings = (block: string, content: string): string => {
  const lineEnding = preferredLineEnding(content);
  return lineEnding === "\n" ? block : block.replace(/\n/gu, lineEnding);
};

const countTrailingLineBreaks = (value: string): number => {
  const match = value.match(/(?:\r?\n)+$/u)?.[0];
  return match === undefined ? 0 : countLineBreaks(match);
};

const countLeadingLineBreaks = (value: string): number => {
  const match = value.match(/^(?:\r?\n)+/u)?.[0];
  return match === undefined ? 0 : countLineBreaks(match);
};

const countLineBreaks = (value: string): number => value.split("\n").length - 1;

const normalizePickerQuery = (selection: string): string => selection.replace(/\s+/gu, " ").trim();

const makeProjectTaskPickerItems = (
  tasks: readonly EmbeddableProjectTask[],
  currentFilePath: string,
  i18n: Translations["projectTaskPicker"],
): ProjectTaskPickerItem[] => {
  const collisionGroups = new Map<string, EmbeddableProjectTask[]>();
  for (const task of tasks) {
    const key = pickerCollisionKey(task);
    collisionGroups.set(key, [...(collisionGroups.get(key) ?? []), task]);
  }

  return tasks
    .map((task) => {
      const current = task.filePath === currentFilePath;
      const collision = (collisionGroups.get(pickerCollisionKey(task))?.length ?? 0) > 1;
      const location = formatTaskLocation(task);
      const detailParts = [
        location || task.filePath,
        task.status === "active" ? i18n.activeLabel : i18n.completedLabel,
        ...(current ? [i18n.currentLabel] : []),
        ...(collision ? [taskDisambiguator(task, collisionGroups)] : []),
      ];
      const detail = detailParts.join(" · ");
      return {
        ...task,
        current,
        detail,
        searchText: `${task.content} ${detail}`,
      };
    })
    .sort(comparePickerItems);
};

const pickerCollisionKey = (task: EmbeddableProjectTask): string =>
  JSON.stringify([
    normalizePickerCollisionText(task.content),
    task.projectPath.map(normalizePickerCollisionText),
    task.section === undefined ? "" : normalizePickerCollisionText(task.section),
  ]);

const normalizePickerCollisionText = (value: string): string =>
  value.normalize("NFC").toLocaleLowerCase("en-US");

const formatTaskLocation = (task: EmbeddableProjectTask): string => {
  const project = task.projectPath.join(" / ");
  return task.section === undefined ? project : `${project} / ${task.section}`;
};

const taskDisambiguator = (
  task: EmbeddableProjectTask,
  collisionGroups: ReadonlyMap<string, readonly EmbeddableProjectTask[]>,
): string => {
  const siblings = collisionGroups.get(pickerCollisionKey(task)) ?? [];
  const createdAt = makeCreationTimeMarker(task.createdAt);
  if (
    createdAt !== undefined &&
    siblings.filter((candidate) => makeCreationTimeMarker(candidate.createdAt) === createdAt)
      .length === 1
  ) {
    return createdAt;
  }
  const indistinguishableSiblings = siblings.filter(
    (candidate) => makeCreationTimeMarker(candidate.createdAt) === createdAt,
  );
  return `…${shortestUniqueTaskIdSuffix(task.id, indistinguishableSiblings)}`;
};

const shortestUniqueTaskIdSuffix = (
  taskId: string,
  siblings: readonly EmbeddableProjectTask[],
): string => {
  const maximumLength = Math.max(...siblings.map(({ id }) => id.length));
  const minimumLength = Math.min(SHORT_TASK_ID_LENGTH, maximumLength);
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    const suffixes = siblings.map(({ id }) => id.slice(-length));
    if (new Set(suffixes).size === suffixes.length) {
      return taskId.slice(-length);
    }
  }
  return taskId;
};

const comparePickerItems = (left: ProjectTaskPickerItem, right: ProjectTaskPickerItem): number => {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }
  if (left.status !== right.status) {
    return left.status === "active" ? -1 : 1;
  }
  return (
    left.content.localeCompare(right.content, undefined, { numeric: true, sensitivity: "base" }) ||
    left.detail.localeCompare(right.detail, undefined, { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
};

class ProjectTaskSuggestModal extends FuzzySuggestModal<ProjectTaskPickerItem> {
  private readonly items: ProjectTaskPickerItem[];
  private readonly choose: (task: ProjectTaskPickerItem) => void;

  constructor(
    plugin: TodoistPlugin,
    items: ProjectTaskPickerItem[],
    initialQuery: string,
    i18n: Translations["projectTaskPicker"],
    choose: (task: ProjectTaskPickerItem) => void,
  ) {
    super(plugin.app);
    this.items = items;
    this.choose = choose;
    this.setTitle(i18n.title);
    this.setPlaceholder(i18n.search.placeholder);
    this.inputEl.setAttribute("aria-label", i18n.search.label);
    this.inputEl.value = initialQuery;
    this.emptyStateText = i18n.emptyState;
  }

  getItems(): ProjectTaskPickerItem[] {
    return this.items;
  }

  getItemText(item: ProjectTaskPickerItem): string {
    return item.searchText;
  }

  renderSuggestion(match: FuzzyMatch<ProjectTaskPickerItem>, el: HTMLElement): void {
    const titleEl = el.createDiv();
    renderResults(titleEl, match.item.content, match.match);
    const detailEl = el.createEl("small");
    renderResults(detailEl, match.item.detail, match.match, match.item.content.length + 1);
  }

  onChooseItem(item: ProjectTaskPickerItem, _event: MouseEvent | KeyboardEvent): void {
    this.choose(item);
  }
}
