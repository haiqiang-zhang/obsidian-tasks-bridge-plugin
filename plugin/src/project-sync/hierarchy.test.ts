import { describe, expect, it } from "vitest";

import { makeProject } from "@/factories/data";

import { projectHierarchyPath, projectNamePath, selectProjectHierarchy } from "./hierarchy";

describe("selectProjectHierarchy", () => {
  it("returns the selected project and descendants in stable tree order", () => {
    const root = makeProject("root", { name: "Root", childOrder: 0 });
    const later = makeProject("later", {
      name: "Later",
      parentId: root.id,
      childOrder: 2,
    });
    const earlier = makeProject("earlier", {
      name: "Earlier",
      parentId: root.id,
      childOrder: 1,
    });
    const grandchild = makeProject("grandchild", {
      name: "Grandchild",
      parentId: earlier.id,
    });
    const unrelated = makeProject("unrelated", { name: "Unrelated" });

    expect(
      selectProjectHierarchy([later, unrelated, grandchild, root, earlier], root.id, true).map(
        ({ id }) => id,
      ),
    ).toEqual(["root", "earlier", "grandchild", "later"]);
  });

  it("returns only the selected project when hierarchy sync is disabled", () => {
    const root = makeProject("root");
    const child = makeProject("child", { parentId: root.id });

    expect(selectProjectHierarchy([root, child], root.id, false)).toEqual([root]);
  });

  it("rejects a cycle reachable from the selected project", () => {
    const root = makeProject("root", { parentId: "child" });
    const child = makeProject("child", { parentId: root.id });

    expect(() => selectProjectHierarchy([root, child], root.id, true)).toThrow("cycle");
  });
});

describe("projectHierarchyPath", () => {
  it("derives parallel project ID and name paths from one hierarchy", () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const grandchild = makeProject("grandchild", {
      name: "Grandchild",
      parentId: child.id,
    });
    const projects = new Map(
      [grandchild, root, child].map((project) => [project.id, project] as const),
    );

    expect(projectHierarchyPath(grandchild.id, projects)).toEqual({
      ids: [root.id, child.id, grandchild.id],
      names: [root.name, child.name, grandchild.name],
    });
    expect(projectNamePath(grandchild.id, projects)).toEqual([
      root.name,
      child.name,
      grandchild.name,
    ]);
  });

  it("starts at the first available project when an ancestor is outside the snapshot", () => {
    const root = makeProject("root", { name: "Root", parentId: "outside" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const projects = new Map([root, child].map((project) => [project.id, project] as const));

    expect(projectHierarchyPath(child.id, projects)).toEqual({
      ids: [root.id, child.id],
      names: [root.name, child.name],
    });
  });

  it("rejects a cycle while deriving project paths", () => {
    const root = makeProject("root", { parentId: "child" });
    const child = makeProject("child", { parentId: root.id });
    const projects = new Map([root, child].map((project) => [project.id, project] as const));

    expect(() => projectHierarchyPath(root.id, projects)).toThrow("cycle");
  });
});
