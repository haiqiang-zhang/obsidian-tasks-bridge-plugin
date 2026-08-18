import { describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";

import { findManagedTaskFileById } from "./taskCardInjector";

type FakeFile = { path: string };

const makePlugin = (files: FakeFile[], identities: Readonly<Record<string, string>>) => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const getMarkdownFiles = vi.fn(() => files);
  const plugin = {
    app: {
      metadataCache: {
        getFileCache: (file: FakeFile) => ({
          frontmatter:
            identities[file.path] === undefined ? {} : { todoist_task_id: identities[file.path] },
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
