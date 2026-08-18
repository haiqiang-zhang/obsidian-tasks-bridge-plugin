import { describe, expect, it } from "vitest";

import type { CompletionHeatmapEvent } from "./completionHeatmapModel";
import { buildProjectOverviewModel } from "./projectOverviewModel";
import type {
  TodoistListCounts,
  TodoistListGroup,
  TodoistListProject,
  TodoistListSection,
  TodoistListTaskNode,
  TodoistListTaskStatus,
} from "./types";

const completionEvent = (
  taskId: string,
  completedAt = "2026-08-10T06:00:00.000Z",
): CompletionHeatmapEvent => ({
  id: `base:task:${taskId}`,
  completedAt,
});

const task = (
  id: string,
  status: TodoistListTaskStatus = "active",
  completedAt?: string,
  children: TodoistListTaskNode[] = [],
): TodoistListTaskNode =>
  ({
    id,
    scopeKey: `task:${id}`,
    rootProjectId: "root",
    filePath: `Tasks/${id}.md`,
    fileName: `${id}.md`,
    content: id,
    description: "",
    status,
    completed: status === "completed",
    projectId: "root",
    projectName: "Root",
    projectIdPath: ["root"],
    projectPath: ["Root"],
    labels: [],
    dueIsRecurring: false,
    metadata: [],
    completedAt,
    children,
  }) as TodoistListTaskNode;

const counts = (active: number, completed: number, unavailable = 0): TodoistListCounts => ({
  active,
  completed,
  unavailable,
});

const section = (id: string, tasks: TodoistListTaskNode[]): TodoistListSection => ({
  key: id,
  id,
  name: id,
  tasks,
  counts: counts(0, 0),
});

const project = (
  id: string,
  options: {
    scopeKey?: string;
    name?: string;
    tasks?: TodoistListTaskNode[];
    sections?: TodoistListSection[];
    projects?: TodoistListProject[];
    counts?: TodoistListCounts;
  } = {},
): TodoistListProject => {
  const tasks = options.tasks ?? [];
  const sections = options.sections ?? [];
  const projects = options.projects ?? [];
  return {
    id,
    scopeKey: options.scopeKey ?? `project:${id}`,
    name: options.name ?? id,
    pathIds: [id],
    pathNames: [options.name ?? id],
    projects,
    tasks,
    sections,
    items: [],
    flatItems: [],
    counts: options.counts ?? counts(0, 0),
  };
};

const group = (
  key: string,
  projects: TodoistListProject[],
  groupCounts: TodoistListCounts,
): TodoistListGroup => ({ key, projects, counts: groupCounts });

describe("buildProjectOverviewModel", () => {
  it("derives totals from the supplied Base groups and counts repeated project containers once", () => {
    const completedAt = "2026-08-10T06:00:00.000Z";
    const completedEvent = completionEvent("done", completedAt);
    const model = buildProjectOverviewModel([
      group(
        "active",
        [
          project("root", {
            scopeKey: "project:mapping:root",
            tasks: [task("active")],
            counts: counts(1, 0),
          }),
        ],
        counts(1, 0),
      ),
      group(
        "completed",
        [
          project("root", {
            scopeKey: "project:mapping:root",
            tasks: [task("done", "completed", completedAt)],
            counts: counts(0, 1),
          }),
        ],
        counts(0, 1),
      ),
    ]);

    expect(model).toMatchObject({
      counts: { active: 1, completed: 1 },
      taskCount: 2,
      projectCount: 1,
      completionRate: 0.5,
    });
    expect(model.completionEvents).toEqual([completedEvent]);
  });

  it("uses an already root-scoped Base result without restoring sibling projects", () => {
    const childCompletedAt = "2026-08-10T07:00:00.000Z";
    const childEvent = completionEvent("child-task", childCompletedAt);
    const model = buildProjectOverviewModel([
      group(
        "selected-child",
        [
          project("child", {
            scopeKey: "project:mapping:child",
            tasks: [task("child-task", "completed", childCompletedAt)],
            counts: counts(0, 1),
          }),
        ],
        counts(0, 1),
      ),
    ]);

    expect(model).toMatchObject({
      counts: { active: 0, completed: 1 },
      taskCount: 1,
      projectCount: 1,
      completionRate: 1,
    });
    expect(model.completionEvents).toEqual([childEvent]);
  });

  it("returns zero statistics when no files match the Base filters", () => {
    const model = buildProjectOverviewModel([]);

    expect(model).toEqual({
      counts: { active: 0, completed: 0, unavailable: 0 },
      completionEvents: [],
      taskCount: 0,
      projectCount: 0,
      completionRate: null,
    });
  });

  it("synthesizes heatmap events only from Base-visible task completion timestamps", () => {
    const parentAt = "2026-08-10T01:00:00.000Z";
    const subtaskAt = "2026-08-10T02:00:00.000Z";
    const sectionAt = "2026-08-10T03:00:00.000Z";
    const childProjectAt = "2026-08-10T04:00:00.000Z";
    const duplicateAt = "2026-08-10T05:00:00.000Z";
    const root = project("root", {
      tasks: [task("parent", "completed", parentAt, [task("subtask", "completed", subtaskAt)])],
      sections: [
        section("section", [
          task("section-task", "completed", sectionAt),
          task("duplicate", "completed", duplicateAt),
        ]),
      ],
      projects: [
        project("child", {
          tasks: [
            task("child-task", "completed", childProjectAt),
            task("duplicate", "completed", "2026-08-11T05:00:00.000Z"),
            task("missing-date", "completed"),
          ],
        }),
      ],
    });

    const model = buildProjectOverviewModel([group("visible", [root], counts(0, 6))]);

    expect(model.completionEvents).toEqual(
      expect.arrayContaining([
        completionEvent("parent", parentAt),
        completionEvent("subtask", subtaskAt),
        completionEvent("section-task", sectionAt),
        completionEvent("child-task", childProjectAt),
      ]),
    );
    expect(model.completionEvents).toHaveLength(5);
    expect(model.completionEvents.filter(({ id }) => id === "base:task:duplicate")).toHaveLength(1);
    expect(model.completionEvents.some(({ id }) => id === "base:task:missing-date")).toBe(false);
  });

  it("includes unavailable Base rows in Total but not the completion denominator", () => {
    const unavailable = task("unavailable", "stale");
    const model = buildProjectOverviewModel([
      group(
        "unavailable",
        [project("root", { tasks: [unavailable], counts: counts(0, 0, 1) })],
        counts(0, 0, 1),
      ),
    ]);

    expect(model).toMatchObject({
      counts: { active: 0, completed: 0, unavailable: 1 },
      taskCount: 1,
      projectCount: 1,
      completionRate: null,
    });
  });
});
