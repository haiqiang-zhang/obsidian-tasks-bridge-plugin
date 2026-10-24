import { describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";

import { MANAGED_BODY_END, MANAGED_BODY_START, makeProjectTaskBlock } from "./document";
import {
  findManagedTaskFileById,
  isManagedHeaderSection,
  readTaskCardModel,
} from "./taskCardInjector";

type FakeFile = { path: string };

const makePlugin = (
  files: FakeFile[],
  identities: Readonly<Record<string, string>>,
  key = "todoist_task_id",
) => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const getMarkdownFiles = vi.fn(() => files);
  const plugin = {
    app: {
      metadataCache: {
        getFileCache: (file: FakeFile) => ({
          frontmatter: identities[file.path] === undefined ? {} : { [key]: identities[file.path] },
        }),
      },
      vault: {
        getFileByPath: (path: string) => byPath.get(path) ?? null,
        getMarkdownFiles,
      },
    },
  } as unknown as TodoistPlugin;
  return { getMarkdownFiles, plugin };
};

describe("project task block file resolution", () => {
  it("resolves native task documents using the canonical task id property", () => {
    const target = { path: "Projects/Task.task.md" };
    const { plugin } = makePlugin([target], { [target.path]: "task-1" }, "task id");
    expect(findManagedTaskFileById(plugin, "task-1", "Dashboard.md")).toBe(target);
  });

  it("resolves the containing managed note by the block identity", () => {
    const source = { path: "Projects/Task.md" };
    const { getMarkdownFiles, plugin } = makePlugin([source], {
      [source.path]: "task-1",
    });

    expect(findManagedTaskFileById(plugin, "task-1", source.path)).toBe(source);
    expect(getMarkdownFiles).toHaveBeenCalledOnce();
  });

  it("uses task_id to resolve a project task block embedded in another note", () => {
    const source = { path: "Dashboard.md" };
    const target = { path: "Projects/Task.md" };
    const { plugin } = makePlugin([source, target], {
      [target.path]: "task-2",
    });

    expect(findManagedTaskFileById(plugin, "task-2", source.path)).toBe(target);
  });

  it("refuses to choose between duplicate immutable IDs", () => {
    const source = { path: "Dashboard.md" };
    const first = { path: "Projects/First.md" };
    const second = { path: "Projects/Second.md" };
    const { plugin } = makePlugin([source, first, second], {
      [first.path]: "duplicate",
      [second.path]: "duplicate",
    });

    expect(findManagedTaskFileById(plugin, "duplicate", source.path)).toBeNull();
  });

  it("also rejects a duplicate when the containing note has the requested ID", () => {
    const source = { path: "Projects/First.md" };
    const duplicate = { path: "Projects/Second.md" };
    const { plugin } = makePlugin([source, duplicate], {
      [source.path]: "duplicate",
      [duplicate.path]: "duplicate",
    });

    expect(findManagedTaskFileById(plugin, "duplicate", source.path)).toBeNull();
  });
});

describe("task file header data", () => {
  it("reads the schedule and native property links without a Markdown block", () => {
    const file = { path: "Projects/Task.task.md" };
    const { plugin } = makePlugin([file], { [file.path]: "task-1" }, "task id");
    vi.spyOn(plugin.app.metadataCache, "getFileCache").mockReturnValue({
      frontmatter: {
        "task id": "task-1",
        content: "Task",
        description: "Description",
        status: "active",
        completed: false,
        url: "https://app.todoist.com/app/task/task-1",
        "due date": "2026-10-25",
        "due datetime": "2026-10-25T09:00:00+08:00",
        "due timezone": "Asia/Shanghai",
        recurring: true,
        deadline: "2026-10-30",
        duration: 30,
        "duration unit": "minute",
        "project path": ["Study", "Database"],
      },
    });
    expect(readTaskCardModel(plugin, file as never)).toMatchObject({
      taskId: "task-1",
      dueDate: "2026-10-25",
      dueDatetime: "2026-10-25T09:00:00+08:00",
      dueTimezone: "Asia/Shanghai",
      recurring: true,
      deadline: "2026-10-30",
      duration: 30,
      durationUnit: "minute",
      projectPath: ["Study", "Database"],
    });
  });

  it("only marks the matching historical generated block, preserving explicit body embeds", () => {
    const block = makeProjectTaskBlock("task-1");
    const text = [MANAGED_BODY_START, block, MANAGED_BODY_END, "", block].join("\n");
    expect(isManagedHeaderSection({ text, lineStart: 1, lineEnd: 3 }, "task-1")).toBe(true);
    expect(isManagedHeaderSection({ text, lineStart: 6, lineEnd: 8 }, "task-1")).toBe(false);
    expect(isManagedHeaderSection({ text, lineStart: 1, lineEnd: 3 }, "task-2")).toBe(false);
    expect(
      isManagedHeaderSection(
        { text: `${text}\n${MANAGED_BODY_START}`, lineStart: 1, lineEnd: 3 },
        "task-1",
      ),
    ).toBe(false);
  });
});
