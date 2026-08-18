import type { Command, Editor, EditorPosition } from "obsidian";
import { MarkdownView, Notice } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Translations } from "@/i18n/translation";
import type TodoistPlugin from "@/index";
import type { EmbeddableProjectTask } from "@/services/projectTaskCommands";

import {
  insertProjectTaskBlock,
  insertQueryBlock,
  makeQueryBlock,
  makeStandaloneBlockInsertion,
  normalizeQueryFilter,
} from "./insertBlocks";

const pickerI18n: Translations["projectTaskPicker"] = {
  title: "Insert project task",
  search: {
    label: "Search synced project tasks",
    placeholder: "Search by task, project, or section",
  },
  emptyState: "No matching project tasks",
  currentLabel: "Current",
  activeLabel: "Active",
  completedLabel: "Completed",
  notices: {
    noTasks: "No synced project tasks",
    contextChanged: "The note changed",
  },
};

vi.mock("@/i18n", () => ({
  t: () => ({ projectTaskPicker: pickerI18n }),
}));

vi.mock("obsidian", async (importOriginal) => {
  const original = await importOriginal<typeof import("obsidian")>();
  return { ...original, Notice: vi.fn() };
});

const commandI18n = {
  sync: "Sync",
  insertQueryBlock: "Insert query block",
  insertProjectTaskBlock: "Insert project task block",
  addTask: "Add task",
  addTaskPageContent: "Add task with page in content",
  addTaskPageDescription: "Add task with page in description",
} satisfies Translations["commands"];

const activeTask = (overrides: Partial<EmbeddableProjectTask> = {}): EmbeddableProjectTask => ({
  id: "6hGr78cXw24jQC7W",
  filePath: "Task Projects/Work/Write report.md",
  content: "Write report",
  projectPath: ["Work", "Launch"],
  section: "Next",
  status: "active",
  createdAt: "2026-08-18T06:47:00.000Z",
  ...overrides,
});

describe("insert block commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "activeWindow", { configurable: true, value: window });
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("inserts a working query example through Obsidian's editor selection", () => {
    const editor = new FakeEditor("");
    const command = insertQueryBlock(makePlugin([]), commandI18n);

    execute(command, editor);

    expect(editor.value).toBe(`${makeQueryBlock("today | overdue")}\n`);
    expect(editor.selection).toBe("");
    expect(editor.cursorOffset).toBe(editor.value.length);
    expect(editor.editCount).toBe(1);
    expect(editor.focusCount).toBe(1);
  });

  it("uses the editor supplied by Obsidian without resolving an active target itself", () => {
    const editor = new FakeEditor("Body", 2);
    const plugin = {
      get app(): never {
        throw new Error("The command must not inspect workspace state");
      },
    } as unknown as TodoistPlugin;

    execute(insertQueryBlock(plugin, commandI18n), editor);

    expect(editor.value).toBe(`Bo\n\n${makeQueryBlock("today | overdue")}\n\ndy`);
    expect(editor.editCount).toBe(1);
  });

  it("is unavailable when Settings is focused in another Obsidian window", () => {
    const editor = new FakeEditor("Body", 2);
    const listEmbeddableTasks = vi.fn(() => [activeTask()]);
    const plugin = makePluginFromCatalog(listEmbeddableTasks);
    const context = makeMarkdownCommandContext(editor, "Notes/Current.md", {} as Window);

    for (const command of [
      insertQueryBlock(plugin, commandI18n),
      insertProjectTaskBlock(plugin, commandI18n),
    ]) {
      expect(command.editorCheckCallback?.(true, editor.asEditor(), context)).toBe(false);
      expect(command.editorCheckCallback?.(false, editor.asEditor(), context)).toBe(false);
    }

    expect(editor.value).toBe("Body");
    expect(editor.editCount).toBe(0);
    expect(editor.focusCount).toBe(0);
    expect(listEmbeddableTasks).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).toBeNull();
  });

  it("checks both insert commands without editor, catalog, notice, or modal side effects", () => {
    const editor = new FakeEditor("Body", 2);
    const listEmbeddableTasks = vi.fn(() => [activeTask()]);
    const plugin = makePluginFromCatalog(listEmbeddableTasks);
    const context = makeMarkdownCommandContext(editor);

    for (const command of [
      insertQueryBlock(plugin, commandI18n),
      insertProjectTaskBlock(plugin, commandI18n),
    ]) {
      expect(command.editorCheckCallback?.(true, editor.asEditor(), context)).toBe(true);
    }

    expect(editor.value).toBe("Body");
    expect(editor.editCount).toBe(0);
    expect(editor.focusCount).toBe(0);
    expect(listEmbeddableTasks).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).toBeNull();
  });

  it("rechecks focus before execution and refuses a command after focus moves to Settings", () => {
    const editor = new FakeEditor("Body", 2);
    const listEmbeddableTasks = vi.fn(() => [activeTask()]);
    const plugin = makePluginFromCatalog(listEmbeddableTasks);
    const context = makeMarkdownCommandContext(editor);
    const commands = [
      insertQueryBlock(plugin, commandI18n),
      insertProjectTaskBlock(plugin, commandI18n),
    ];

    for (const command of commands) {
      expect(command.editorCheckCallback?.(true, editor.asEditor(), context)).toBe(true);
    }

    Object.defineProperty(window, "activeWindow", {
      configurable: true,
      value: {} as Window,
    });

    for (const command of commands) {
      expect(command.editorCheckCallback?.(false, editor.asEditor(), context)).toBe(false);
    }

    expect(editor.value).toBe("Body");
    expect(editor.editCount).toBe(0);
    expect(editor.focusCount).toBe(0);
    expect(listEmbeddableTasks).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).toBeNull();
  });

  it("is unavailable for an editor context that is not a Markdown view", () => {
    const editor = new FakeEditor("Body", 2);
    const listEmbeddableTasks = vi.fn(() => [activeTask()]);
    const plugin = makePluginFromCatalog(listEmbeddableTasks);
    const fileInfo = { file: { path: "Notes/Current.md" } };

    for (const command of [
      insertQueryBlock(plugin, commandI18n),
      insertProjectTaskBlock(plugin, commandI18n),
    ]) {
      expect(
        command.editorCheckCallback?.(
          true,
          editor.asEditor(),
          fileInfo as Parameters<NonNullable<Command["editorCheckCallback"]>>[2],
        ),
      ).toBe(false);
      expect(
        command.editorCheckCallback?.(
          false,
          editor.asEditor(),
          fileInfo as Parameters<NonNullable<Command["editorCheckCallback"]>>[2],
        ),
      ).toBe(false);
    }

    expect(editor.editCount).toBe(0);
    expect(listEmbeddableTasks).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).toBeNull();
  });

  it("turns a multiline selection into safely quoted YAML and moves after the block", () => {
    const source = '  today\n  & "next" \\ path  ';
    const editor = new FakeEditor(source, 0, source.length);
    const command = insertQueryBlock(makePlugin([]), commandI18n);

    execute(command, editor);

    expect(normalizeQueryFilter(source)).toBe('today & "next" \\ path');
    expect(editor.value).toBe(`${makeQueryBlock('today & "next" \\ path')}\n`);
    expect(editor.cursorOffset).toBe(editor.value.length);
    expect(editor.editCount).toBe(1);
  });

  it("lets Obsidian insert at the active editor caret", () => {
    const editor = new FakeEditor("BeforeAfter", 6);
    const plugin = makePlugin([]);

    execute(insertQueryBlock(plugin, commandI18n), editor);

    expect(editor.value).toBe(`Before\n\n${makeQueryBlock("today | overdue")}\n\nAfter`);
    expect(editor.cursorOffset).toBe(editor.value.indexOf("After"));
  });

  it("preserves CRLF line endings while Obsidian owns the caret", () => {
    const source = "Before\r\nAfter";
    const editor = new FakeEditor(source, source.indexOf("After"));

    execute(insertQueryBlock(makePlugin([]), commandI18n), editor);

    expect(editor.value).toBe(
      `Before\r\n\r\n${makeQueryBlock("today | overdue").replace(/\n/gu, "\r\n")}\r\n\r\nAfter`,
    );
    expect(editor.value).not.toMatch(/(?<!\r)\n/u);
  });

  it("keeps fences standalone without removing existing whitespace", () => {
    const block = makeQueryBlock("today");
    expect(
      makeStandaloneBlockInsertion("beforeAFTER", rangeForOffsets("beforeAFTER", 6, 6), block),
    ).toBe(`\n\n${block}\n\n`);
    expect(
      makeStandaloneBlockInsertion(
        "before\n\n\nAFTER",
        rangeForOffsets("before\n\n\nAFTER", 6, 6),
        block,
      ),
    ).toBe(`\n\n${block}`);
  });

  it("opens a local picker, prioritizes the current task, and inserts one quoted task ID", () => {
    const selected = "report";
    const editor = new FakeEditor(selected, 0, selected.length);
    const current = activeTask({ filePath: "Notes/Current.md", status: "completed" });
    const plugin = makePlugin([
      activeTask({ id: "active-other", content: "Other report" }),
      current,
    ]);
    const command = insertProjectTaskBlock(plugin, commandI18n);

    execute(command, editor);

    const input = document.querySelector<HTMLInputElement>(".prompt-input");
    expect(input?.value).toBe(selected);
    const suggestions = [...document.querySelectorAll<HTMLButtonElement>(".suggestion-item")];
    expect(suggestions[0]).toHaveTextContent("Write report");
    expect(suggestions[0]).toHaveTextContent("Current");
    expect(editor.editCount).toBe(0);

    suggestions[0]?.click();

    expect(editor.value).toBe('```tasks-bridge-project-task\ntask_id: "6hGr78cXw24jQC7W"\n```\n');
    expect(editor.editCount).toBe(1);
    expect(editor.focusCount).toBe(1);
  });

  it("does not change the note when the task picker is cancelled", () => {
    const editor = new FakeEditor("Keep this", 0, 4);
    const plugin = makePlugin([activeTask()]);
    const command = insertProjectTaskBlock(plugin, commandI18n);

    execute(command, editor);
    document.querySelector<HTMLElement>(".modal-container")?.remove();

    expect(editor.value).toBe("Keep this");
    expect(editor.selection).toBe("Keep");
    expect(editor.editCount).toBe(0);
  });

  it("finds tasks by project metadata without applying detail offsets to the title", () => {
    const selected = "Launch";
    const editor = new FakeEditor(selected, 0, selected.length);
    const plugin = makePlugin([activeTask()]);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);

    const suggestion = document.querySelector<HTMLElement>(".suggestion-item");
    expect(suggestion).toHaveTextContent("Write report");
    expect(suggestion).toHaveTextContent("Work / Launch / Next");
    expect(suggestion?.firstElementChild?.querySelector("mark")).toBeNull();
    expect(suggestion?.querySelector("small mark")).toHaveTextContent("Launch");
    expect(editor.value).toBe(selected);
    expect(editor.editCount).toBe(0);
  });

  it("uses Obsidian's current selection when the picker resolves", () => {
    const editor = new FakeEditor("");
    const plugin = makePlugin([activeTask()]);
    const command = insertProjectTaskBlock(plugin, commandI18n);

    execute(command, editor);
    editor.replaceExternally("Changed elsewhere");
    document.querySelector<HTMLButtonElement>(".suggestion-item")?.click();

    expect(editor.value).toBe(
      '```tasks-bridge-project-task\ntask_id: "6hGr78cXw24jQC7W"\n```\n\nChanged elsewhere',
    );
    expect(editor.editCount).toBe(1);
  });

  it("refuses to insert if the selected synchronized task becomes ambiguous", () => {
    const editor = new FakeEditor("");
    const tasks = [activeTask()];
    const plugin = makePlugin(tasks);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);
    tasks.length = 0;
    document.querySelector<HTMLButtonElement>(".suggestion-item")?.click();

    expect(editor.value).toBe("");
    expect(editor.editCount).toBe(0);
    expect(Notice).toHaveBeenCalledWith(pickerI18n.notices.contextChanged);
  });

  it("shows a native notice when no synchronized project task is available", () => {
    const editor = new FakeEditor("");
    const command = insertProjectTaskBlock(makePlugin([]), commandI18n);

    execute(command, editor);

    expect(Notice).toHaveBeenCalledWith(pickerI18n.notices.noTasks);
    expect(document.querySelector(".modal-container")).toBeNull();
    expect(editor.editCount).toBe(0);
  });

  it("disambiguates identical task labels with creation time and only then a short ID", () => {
    const editor = new FakeEditor("");
    const plugin = makePlugin([
      activeTask({ id: "task-first", createdAt: "2026-08-18T06:47:00.000Z" }),
      activeTask({ id: "alpha-one-abcdef", createdAt: "2026-08-18T07:12:00.000Z" }),
      activeTask({ id: "beta-two-abcdef", createdAt: "2026-08-18T07:12:00.000Z" }),
    ]);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);

    const details = [...document.querySelectorAll(".suggestion-item small")].map(
      (element) => element.textContent ?? "",
    );
    expect(details.some((detail) => detail.includes("2026-08-18 06.47.00Z"))).toBe(true);
    const idDetails = details.filter((detail) => detail.includes("…"));
    expect(idDetails).toHaveLength(2);
    expect(new Set(idDetails).size).toBe(2);
    expect(idDetails.every((detail) => !detail.endsWith("…abcdef"))).toBe(true);
  });

  it("uses canonical seconds before task IDs for duplicates created in the same minute", () => {
    const editor = new FakeEditor("");
    const plugin = makePlugin([
      activeTask({
        id: "first-second",
        filePath: "Task Projects/Work/First.md",
        createdAt: "2026-08-18T06:47:01.000Z",
      }),
      activeTask({
        id: "second-second",
        filePath: "Task Projects/Work/Second.md",
        createdAt: "2026-08-18T14:47:02.123+08:00",
      }),
    ]);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);

    const details = [...document.querySelectorAll(".suggestion-item small")].map(
      (element) => element.textContent ?? "",
    );
    expect(details.some((detail) => detail.includes("2026-08-18 06.47.01Z"))).toBe(true);
    expect(details.some((detail) => detail.includes("2026-08-18 06.47.02.123Z"))).toBe(true);
    expect(details.every((detail) => !detail.includes("…"))).toBe(true);
  });

  it("falls back to task IDs instead of displaying malformed creation timestamps", () => {
    const editor = new FakeEditor("");
    const plugin = makePlugin([
      activeTask({
        id: "malformed-first",
        filePath: "Task Projects/Work/First.md",
        createdAt: "2026-99-99T99:99:99Z",
      }),
      activeTask({
        id: "malformed-second",
        filePath: "Task Projects/Work/Second.md",
        createdAt: "not-a-timestamp",
      }),
    ]);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);

    const details = [...document.querySelectorAll(".suggestion-item small")].map(
      (element) => element.textContent ?? "",
    );
    expect(details).toHaveLength(2);
    expect(details.every((detail) => detail.includes("…"))).toBe(true);
    expect(details.join(" ")).not.toContain("2026-99-99");
    expect(details.join(" ")).not.toContain("not-a-timestamp");
  });

  it("groups canonically equivalent Unicode task, project, and section labels", () => {
    const editor = new FakeEditor("");
    const plugin = makePlugin([
      activeTask({
        id: "unicode-first",
        filePath: "Task Projects/Work/First.md",
        content: "Café",
        projectPath: ["Résumé"],
        section: "Déjà",
        createdAt: "2026-08-18T06:47:01.000Z",
      }),
      activeTask({
        id: "unicode-second",
        filePath: "Task Projects/Work/Second.md",
        content: "Café",
        projectPath: ["Résumé"],
        section: "Déjà",
        createdAt: "2026-08-18T06:47:02.000Z",
      }),
    ]);

    execute(insertProjectTaskBlock(plugin, commandI18n), editor);

    const details = [...document.querySelectorAll(".suggestion-item small")].map(
      (element) => element.textContent ?? "",
    );
    expect(details.some((detail) => detail.includes("2026-08-18 06.47.01Z"))).toBe(true);
    expect(details.some((detail) => detail.includes("2026-08-18 06.47.02Z"))).toBe(true);
    expect(details.every((detail) => !detail.includes("…"))).toBe(true);
  });
});

const makePlugin = (tasks: readonly EmbeddableProjectTask[]): TodoistPlugin => {
  return makePluginFromCatalog(() => [...tasks]);
};

const makePluginFromCatalog = (
  listEmbeddableTasks: () => EmbeddableProjectTask[],
): TodoistPlugin => {
  return {
    app: {},
    services: {
      projectTasks: {
        listEmbeddableTasks,
      },
    },
  } as unknown as TodoistPlugin;
};

const execute = (
  command: Omit<Command, "id">,
  editor: FakeEditor,
  filePath = "Notes/Current.md",
): void => {
  const context = makeMarkdownCommandContext(editor, filePath);
  expect(command.editorCheckCallback).toEqual(expect.any(Function));
  expect(command.editorCheckCallback?.(true, editor.asEditor(), context)).toBe(true);
  expect(command.editorCheckCallback?.(false, editor.asEditor(), context)).toBe(true);
};

const makeMarkdownCommandContext = (
  editor: FakeEditor,
  filePath = "Notes/Current.md",
  contextWindow: Window = window,
): MarkdownView => {
  const containerEl = document.createElement("div");
  Object.defineProperty(containerEl, "win", { value: contextWindow });
  return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
    app: {},
    containerEl,
    editor: editor.asEditor(),
    file: { path: filePath, extension: "md" },
  }) as unknown as MarkdownView;
};

const rangeForOffsets = (content: string, fromOffset: number, toOffset: number) => {
  const editor = new FakeEditor(content, fromOffset, toOffset);
  return {
    from: editor.offsetToPosition(fromOffset),
    to: editor.offsetToPosition(toOffset),
    fromOffset,
    toOffset,
  };
};

class FakeEditor {
  public editCount = 0;
  public focusCount = 0;
  public value: string;
  private anchorOffset: number;
  private headOffset: number;

  constructor(value: string, anchorOffset = 0, headOffset = anchorOffset) {
    this.value = value;
    this.anchorOffset = anchorOffset;
    this.headOffset = headOffset;
  }

  get selection(): string {
    const [from, to] = this.sortedOffsets();
    return this.value.slice(from, to);
  }

  get cursorOffset(): number {
    return this.headOffset;
  }

  asEditor(): Editor {
    return this as unknown as Editor;
  }

  getValue(): string {
    return this.value;
  }

  getSelection(): string {
    return this.selection;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.value.slice(this.positionToOffset(from), this.positionToOffset(to));
  }

  getCursor(side: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    const [from, to] = this.sortedOffsets();
    if (side === "from") {
      return this.offsetToPosition(from);
    }
    if (side === "to") {
      return this.offsetToPosition(to);
    }
    return this.offsetToPosition(side === "anchor" ? this.anchorOffset : this.headOffset);
  }

  posToOffset(position: EditorPosition): number {
    return this.positionToOffset(position);
  }

  offsetToPos(offset: number): EditorPosition {
    return this.offsetToPosition(offset);
  }

  replaceSelection(replacement: string, origin?: string): void {
    this.replaceRange(replacement, this.getCursor("from"), this.getCursor("to"), origin);
  }

  replaceRange(
    replacement: string,
    from: EditorPosition,
    to: EditorPosition = from,
    _origin?: string,
  ): void {
    const fromOffset = this.positionToOffset(from);
    const toOffset = this.positionToOffset(to);
    this.value = `${this.value.slice(0, fromOffset)}${replacement}${this.value.slice(toOffset)}`;
    this.anchorOffset = fromOffset + replacement.length;
    this.headOffset = this.anchorOffset;
    this.editCount += 1;
  }

  setCursor(position: EditorPosition | number, ch?: number): void {
    const offset =
      typeof position === "number"
        ? this.positionToOffset({ line: position, ch: ch ?? 0 })
        : this.positionToOffset(position);
    this.anchorOffset = offset;
    this.headOffset = offset;
  }

  setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
    this.anchorOffset = this.positionToOffset(anchor);
    this.headOffset = this.positionToOffset(head);
  }

  focus(): void {
    this.focusCount += 1;
  }

  replaceExternally(content: string): void {
    this.value = content;
    this.anchorOffset = 0;
    this.headOffset = 0;
  }

  offsetToPosition(offset: number): EditorPosition {
    const bounded = Math.max(0, Math.min(offset, this.value.length));
    const before = this.value.slice(0, bounded);
    const lines = before.split("\n");
    return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
  }

  private positionToOffset(position: EditorPosition): number {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
      offset += (lines[line]?.length ?? 0) + 1;
    }
    return Math.max(0, Math.min(offset + position.ch, this.value.length));
  }

  private sortedOffsets(): readonly [number, number] {
    return this.anchorOffset <= this.headOffset
      ? [this.anchorOffset, this.headOffset]
      : [this.headOffset, this.anchorOffset];
  }
}
