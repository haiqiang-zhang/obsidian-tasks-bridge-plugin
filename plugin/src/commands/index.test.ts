import type { Command } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";

vi.mock("@/commands/addTask", () => ({
  addTask: (_plugin: TodoistPlugin, i18n: { addTask: string }) => ({
    name: i18n.addTask,
    callback: vi.fn(),
  }),
  addTaskWithPageInContent: (_plugin: TodoistPlugin, i18n: { addTaskPageContent: string }) => ({
    name: i18n.addTaskPageContent,
    callback: vi.fn(),
  }),
  addTaskWithPageInDescription: (
    _plugin: TodoistPlugin,
    i18n: { addTaskPageDescription: string },
  ) => ({
    name: i18n.addTaskPageDescription,
    callback: vi.fn(),
  }),
}));

vi.mock("@/i18n", () => ({
  t: () => ({
    commands: {
      sync: "Sync",
      insertQueryBlock: "Insert query block",
      insertProjectTaskBlock: "Insert project task block",
      addTask: "Add task",
      addTaskPageContent: "Add task with current page in task content",
      addTaskPageDescription: "Add task with current page in task description",
    },
  }),
}));

vi.mock("@/log", () => ({ debug: vi.fn() }));

import { registerCommands } from "@/commands";

describe("command registration", () => {
  it("registers one unified Sync command that runs both synchronization modes", async () => {
    const registered: Command[] = [];
    const syncProjectFolderNow = vi.fn(async () => null);
    const plugin = {
      addCommand: vi.fn((command: Command) => registered.push(command)),
      syncProjectFolderNow,
    } as unknown as TodoistPlugin;

    registerCommands(plugin);

    expect(registered.map(({ id }) => id)).toEqual([
      "sync",
      "insert-query-block",
      "insert-project-task-block",
      "add-task",
      "add-task-page-content",
      "add-task-page-description",
    ]);
    expect(registered.map(({ id }) => id)).not.toContain("todoist-sync");
    expect(registered.map(({ id }) => id)).not.toContain("todoist-project-sync");

    const sync = registered.find(({ id }) => id === "sync");
    expect(sync).toMatchObject({ id: "sync", name: "Sync" });

    await sync?.callback?.();

    expect(syncProjectFolderNow).toHaveBeenCalledOnce();
  });

  it("registers both insert commands with Obsidian's official editor command API", () => {
    const registered: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => registered.push(command)),
    } as unknown as TodoistPlugin;

    registerCommands(plugin);

    for (const id of ["insert-query-block", "insert-project-task-block"] as const) {
      const command = registered.find((candidate) => candidate.id === id);
      expect(command?.editorCheckCallback).toEqual(expect.any(Function));
      expect(command?.callback).toBeUndefined();
      expect(command?.checkCallback).toBeUndefined();
      expect(command?.editorCallback).toBeUndefined();
      expect(command?.hotkeys).toBeUndefined();
    }
  });
});
