import type { Command as ObsidianCommand } from "obsidian";

import {
  addTask,
  addTaskWithPageInContent,
  addTaskWithPageInDescription,
} from "@/commands/addTask";
import { insertProjectTaskBlock, insertQueryBlock } from "@/commands/insertBlocks";
import { t } from "@/i18n";
import type { Translations } from "@/i18n/translation";
import type TodoistPlugin from "@/index";
import { debug } from "@/log";

export type MakeCommand = (
  plugin: TodoistPlugin,
  i18n: Translations["commands"],
) => Omit<ObsidianCommand, "id" | "callback"> & {
  callback?: () => void | Promise<void>;
};

const syncCommand: MakeCommand = (plugin: TodoistPlugin, i18n: Translations["commands"]) => {
  return {
    name: i18n.sync,
    callback: async () => {
      debug("Synchronizing Todoist queries and projects");
      await plugin.syncProjectFolderNow();
    },
  };
};

const commands = {
  sync: syncCommand,
  "insert-query-block": insertQueryBlock,
  "insert-project-task-block": insertProjectTaskBlock,
  "add-task": addTask,
  "add-task-page-content": addTaskWithPageInContent,
  "add-task-page-description": addTaskWithPageInDescription,
};

export type CommandId = keyof typeof commands;
export type FireableCommandId = "add-task" | "add-task-page-content" | "add-task-page-description";

export const registerCommands = (plugin: TodoistPlugin) => {
  const i18n = t().commands;
  for (const [id, make] of Object.entries(commands)) {
    plugin.addCommand({ id, ...make(plugin, i18n) });
  }
};

export const fireCommand = <K extends FireableCommandId>(id: K, plugin: TodoistPlugin) => {
  const i18n = t().commands;
  const make = commands[id];
  const result = make(plugin, i18n).callback?.();
  if (result instanceof Promise) {
    void result.catch((error: unknown) => {
      console.error(`Failed to execute command '${id}':`, error);
    });
  }
};
