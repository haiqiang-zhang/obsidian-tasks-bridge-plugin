import { describe, expect, it } from "vitest";

import { makeProject, makeSection, makeTask } from "@/factories/data";

import { getGroupedTaskTrees, getTaskTrees } from "./taskTrees";

describe("getTaskTrees", () => {
  it("sorts roots and every level of descendants before building the tree", () => {
    const tasks = [
      makeTask("later-child", { parentId: "parent", order: 30 }),
      makeTask("later-root", { order: 40 }),
      makeTask("earlier-child", { parentId: "parent", order: 20 }),
      makeTask("parent", { order: 10 }),
      makeTask("earlier-root", { order: 0 }),
    ];

    const trees = getTaskTrees(tasks, ["order"]);

    expect(trees.map((tree) => tree.id)).toEqual(["earlier-root", "parent", "later-root"]);
    expect(trees[1]?.children.map((tree) => tree.id)).toEqual(["earlier-child", "later-child"]);
    expect(tasks.map((task) => task.id)).toEqual([
      "later-child",
      "later-root",
      "earlier-child",
      "parent",
      "earlier-root",
    ]);
  });
});

describe("getGroupedTaskTrees", () => {
  it("groups a complete recursive tree using only its root section", () => {
    const project = makeProject("project", { name: "Project" });
    const rootSection = makeSection("root-section", {
      projectId: project.id,
      name: "Root section",
      sectionOrder: 1,
    });
    const childSection = makeSection("child-section", {
      projectId: project.id,
      name: "Child section",
      sectionOrder: 2,
    });

    const groups = getGroupedTaskTrees(
      [
        makeTask("grandchild", {
          parentId: "child",
          project,
          section: childSection,
          order: 30,
        }),
        makeTask("child", {
          parentId: "parent",
          project,
          section: undefined,
          order: 20,
        }),
        makeTask("parent", { project, section: rootSection, order: 10 }),
        makeTask("other-root", { project, section: childSection, order: 40 }),
      ],
      "section",
      ["order"],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.header).toBe("Project / Root section");
    expect(groups[0]?.trees).toMatchObject([
      {
        id: "parent",
        children: [
          {
            id: "child",
            children: [{ id: "grandchild", children: [] }],
          },
        ],
      },
    ]);
    expect(groups[1]?.header).toBe("Project / Child section");
    expect(groups[1]?.trees).toMatchObject([{ id: "other-root", children: [] }]);
  });

  it("does not promote a child to a separate priority group", () => {
    const groups = getGroupedTaskTrees(
      [makeTask("child", { parentId: "parent", priority: 4 }), makeTask("parent", { priority: 1 })],
      "priority",
      undefined,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.header).toBe("Priority 4");
    expect(groups[0]?.trees).toMatchObject([
      {
        id: "parent",
        children: [{ id: "child", children: [] }],
      },
    ]);
  });
});
