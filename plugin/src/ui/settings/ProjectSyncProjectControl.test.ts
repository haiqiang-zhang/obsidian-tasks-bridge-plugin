import { describe, expect, it } from "vitest";

import { makeProject } from "@/factories/data";
import { buildProjectOptions } from "@/ui/settings/ProjectSyncProjectControl";

describe("buildProjectOptions", () => {
  it("orders projects hierarchically and includes breadcrumbs", () => {
    const root = makeProject("root", { name: "Work", childOrder: 2 });
    const firstChild = makeProject("first-child", {
      name: "Planning",
      parentId: root.id,
      childOrder: 1,
    });
    const secondChild = makeProject("second-child", {
      name: "Planning",
      parentId: root.id,
      childOrder: 2,
    });
    const otherRoot = makeProject("other-root", { name: "Personal", childOrder: 1 });

    const options = buildProjectOptions([secondChild, root, otherRoot, firstChild]);

    expect(options.map(({ project }) => project.id)).toEqual([
      "other-root",
      "root",
      "first-child",
      "second-child",
    ]);
    expect(options[2].label).toContain("Work / Planning");
    expect(options[2].label.startsWith("\u00a0\u00a0")).toBe(true);
    expect(options[2].label).not.toBe(options[3].label);
    expect(options[2].label).toContain("first-child");
    expect(options[3].label).toContain("second-child");
  });

  it("keeps orphaned and cyclic project metadata selectable without looping", () => {
    const orphan = makeProject("orphan", { name: "Orphan", parentId: "missing" });
    const cycleA = makeProject("cycle-a", { name: "Cycle A", parentId: "cycle-b" });
    const cycleB = makeProject("cycle-b", { name: "Cycle B", parentId: "cycle-a" });

    const options = buildProjectOptions([cycleB, orphan, cycleA]);

    expect(options.map(({ project }) => project.id).sort()).toEqual([
      "cycle-a",
      "cycle-b",
      "orphan",
    ]);
  });
});
