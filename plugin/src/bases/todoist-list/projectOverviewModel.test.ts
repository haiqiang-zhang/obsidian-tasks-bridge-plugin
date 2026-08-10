import { describe, expect, it } from "vitest";

import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";

import { buildProjectOverviewModel } from "./projectOverviewModel";

type Scope = ProjectSyncStatisticsSnapshot["scopes"][number];
type StatisticsProject = Scope["projects"][number];

const project = (
  id: string,
  parentId: string | null,
  childOrder: number,
  active = 0,
  completed = 0,
  name = id,
): StatisticsProject => ({
  id,
  parentId,
  name,
  childOrder,
  directCounts: { active, completed },
});

const scope = (mappingId: string, rootProjectId: string, projects: StatisticsProject[]): Scope => ({
  mappingId,
  rootProjectId,
  includeSubprojects: true,
  projects,
});

const snapshot = (scopes: Scope[]): ProjectSyncStatisticsSnapshot => ({
  syncedAt: "2026-08-10T06:30:00.000Z",
  scopes,
});

describe("buildProjectOverviewModel", () => {
  it("builds a root-child-grandchild tree with direct and inclusive statistics", () => {
    const model = buildProjectOverviewModel(
      snapshot([
        scope("study", "root", [
          project("grandchild", "child", 0, 1, 2, "Grandchild"),
          project("root", null, 0, 2, 1, "Root"),
          project("zero", "root", 2, 0, 0, "Zero tasks"),
          project("child", "root", 1, 3, 1, "Child"),
        ]),
      ]),
      "root",
    );

    expect(model).not.toBeNull();
    expect(model?.roots[0]).toMatchObject({
      id: "root",
      directCounts: { active: 2, completed: 1 },
      counts: { active: 6, completed: 4 },
      taskCount: 10,
      projectCount: 4,
      completionRate: 0.4,
    });
    expect(model?.roots[0]?.children.map(({ id }) => id)).toEqual(["child", "zero"]);
    expect(model?.roots[0]?.children[0]?.children[0]).toMatchObject({
      id: "grandchild",
      pathIds: ["root", "child", "grandchild"],
      pathNames: ["Root", "Child", "Grandchild"],
    });
    expect(model?.roots[0]?.children[1]).toMatchObject({
      id: "zero",
      directCounts: { active: 0, completed: 0 },
      counts: { active: 0, completed: 0 },
      taskCount: 0,
      projectCount: 1,
      completionRate: null,
    });
    expect(model?.projectOptions.map(({ id }) => id)).toEqual([
      "root",
      "child",
      "grandchild",
      "zero",
    ]);
  });

  it("crops an arbitrary child to that project and all of its descendants", () => {
    const model = buildProjectOverviewModel(
      snapshot([
        scope("study", "root", [
          project("root", null, 0, 1, 0, "Root"),
          project("sibling", "root", 0, 4, 0, "Sibling"),
          project("child", "root", 1, 2, 1, "Child"),
          project("grandchild", "child", 0, 0, 2, "Grandchild"),
        ]),
      ]),
      "child",
    );

    expect(model).toMatchObject({
      rootProjectId: "child",
      rootAvailable: true,
      counts: { active: 2, completed: 3 },
      taskCount: 5,
      projectCount: 2,
      completionRate: 0.6,
    });
    expect(model?.roots.map(({ id }) => id)).toEqual(["child"]);
    expect(model?.roots[0]?.children.map(({ id }) => id)).toEqual(["grandchild"]);
    expect(model?.projectOptions.map(({ id }) => id)).toEqual([
      "root",
      "sibling",
      "child",
      "grandchild",
    ]);
  });

  it("shows every mapping root for the all-projects selection and sorts roots stably", () => {
    const completeSnapshot = snapshot([
      scope("later", "work", [project("work", null, 4, 2, 0, "Work")]),
      scope("first", "personal", [project("personal", null, 1, 0, 3, "Personal")]),
    ]);
    const model = buildProjectOverviewModel(completeSnapshot, null);

    expect(model).toMatchObject({
      rootProjectId: null,
      rootAvailable: true,
      counts: { active: 2, completed: 3 },
      taskCount: 5,
      projectCount: 2,
      completionRate: 0.6,
    });
    expect(model?.roots.map(({ id }) => id)).toEqual(["personal", "work"]);
    expect(model?.projectOptions.map(({ id }) => id)).toEqual(["personal", "work"]);

    const selectedSecondMapping = buildProjectOverviewModel(completeSnapshot, "work");
    expect(selectedSecondMapping).toMatchObject({
      rootAvailable: true,
      counts: { active: 2, completed: 0 },
      taskCount: 2,
      projectCount: 1,
    });
    expect(selectedSecondMapping?.roots.map(({ id }) => id)).toEqual(["work"]);
  });

  it("reports a missing selected root without discarding the project options", () => {
    const model = buildProjectOverviewModel(
      snapshot([scope("study", "root", [project("root", null, 0, 1, 1, "Root")])]),
      "missing",
    );

    expect(model).toMatchObject({
      rootAvailable: false,
      roots: [],
      counts: { active: 0, completed: 0 },
      taskCount: 0,
      projectCount: 0,
      completionRate: null,
    });
    expect(model?.projectOptions.map(({ id }) => id)).toEqual(["root"]);
  });

  it("keeps duplicate project names distinct by ID", () => {
    const model = buildProjectOverviewModel(
      snapshot([
        scope("study", "root", [
          project("root", null, 0, 0, 0, "Root"),
          project("alpha", "root", 0, 1, 0, "Duplicate"),
          project("beta", "root", 0, 0, 1, "Duplicate"),
        ]),
      ]),
      "root",
    );

    expect(model?.roots[0]?.children.map(({ id }) => id)).toEqual(["alpha", "beta"]);
    expect(model?.projectOptions.map(({ id }) => id)).toEqual(["root", "alpha", "beta"]);
  });

  it("ignores duplicate, orphaned, and cyclic projects without mutating the snapshot", () => {
    const input = snapshot([
      scope("study", "root", [
        project("root", "outside-scope", 0, 1, 0, "Root"),
        project("valid", "root", 0, 0, 1, "Valid"),
        project("valid", "root", 9, 99, 99, "Duplicate ignored"),
        project("orphan", "missing", 0, 5, 5, "Orphan"),
        project("cycle-a", "cycle-b", 0, 5, 5, "Cycle A"),
        project("cycle-b", "cycle-a", 0, 5, 5, "Cycle B"),
      ]),
    ]);
    const before = JSON.stringify(input);

    const model = buildProjectOverviewModel(input, null);

    expect(model?.roots[0]).toMatchObject({
      id: "root",
      counts: { active: 1, completed: 1 },
      projectCount: 2,
    });
    expect(model?.projectOptions.map(({ id }) => id)).toEqual(["root", "valid"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns null when no completed Project Sync snapshot exists", () => {
    expect(buildProjectOverviewModel(null, null)).toBeNull();
  });
});
