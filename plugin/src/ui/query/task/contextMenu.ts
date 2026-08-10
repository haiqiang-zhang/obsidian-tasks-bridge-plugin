import type { Point } from "obsidian";
import { Menu } from "obsidian";

import type { Task } from "@/data/task";
import { t } from "@/i18n";
import type TodoistPlugin from "@/index";
import { todoistTaskAppUrl, todoistTaskWebUrl } from "@/todoist/taskLinks";

type TaskContext = {
  task: Task;
  plugin: TodoistPlugin;
};

export function showTaskContext(ctx: TaskContext, position: Point) {
  const i18n = t().query.contextMenu;
  const menu = new Menu();

  if (ctx.task.completedAt === undefined) {
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(i18n.completeTaskLabel)
        .setIcon("check-small")
        .onClick(async () => await ctx.plugin.services.todoist.actions.closeTask(ctx.task.id)),
    );
  }

  menu
    .addItem((menuItem) =>
      menuItem
        .setTitle(i18n.openTaskInAppLabel)
        .setIcon("popup-open")
        .onClick(() => {
          openExternal(todoistTaskAppUrl(ctx.task.id));
        }),
    )
    .addItem((menuItem) =>
      menuItem
        .setTitle(i18n.openTaskInBrowserLabel)
        .setIcon("popup-open")
        .onClick(() => openExternal(todoistTaskWebUrl(ctx.task.project.id, ctx.task.id))),
    )
    .showAtPosition(position);
}

// A bit hacky, but in order to simulate clicking a link
// we create a unparented DOM element, dispatch an event,
// then remove the link. Using electron's openExternal doesn't
// work on mobile unfortunately.
function openExternal(url: string): void {
  const link = document.createElement("a");
  link.href = url;

  const clickEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: window,
  });

  link.dispatchEvent(clickEvent);
  link.remove();
}
