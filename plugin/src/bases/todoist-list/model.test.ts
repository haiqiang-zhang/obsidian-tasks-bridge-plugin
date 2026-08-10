import type { BasesEntry, BasesEntryGroup, BasesPropertyId, Value } from "obsidian";
import { describe, expect, it } from "vitest";

import { buildTodoistListModel, scopeTodoistListGroups } from "./model";

type EntryOptions = {
  managed?: boolean;
  content?: string;
  status?: string;
  completed?: boolean;
  projectId?: string;
  projectName?: string;
  projectIdPath?: string[];
  projectPath?: string[];
  parentTaskId?: string;
  sectionId?: string;
  sectionName?: string;
  description?: string;
  labels?: string[];
  priority?: string;
  dueDate?: string;
};

const primitive = (value: string | number | boolean): Value =>
  ({
    isTruthy: () => Boolean(value),
    toString: () => String(value),
  }) as unknown as Value;

// This mirrors the Bases NullValue contract: absent properties are falsy Values, not JavaScript
// null, and their diagnostic string representation is the literal text "null".
const nullValue = (): Value =>
  ({
    isTruthy: () => false,
    toString: () => "null",
  }) as unknown as Value;

const list = (values: string[]): Value =>
  ({
    get: (index: number) => primitive(values[index] ?? ""),
    isTruthy: () => values.length > 0,
    length: () => values.length,
    toString: () => values.join(", "),
  }) as unknown as Value;

const makeEntry = (id: string, options: EntryOptions = {}): BasesEntry => {
  const projectId = options.projectId ?? "root";
  const projectName = options.projectName ?? "Root";
  const values = new Map<BasesPropertyId, Value>([
    ["note.todoist_sync_managed", primitive(options.managed ?? true)],
    ["note.todoist_task_id", primitive(id)],
    ["note.todoist_content", primitive(options.content ?? id)],
    ["note.todoist_description", primitive(options.description ?? "")],
    ["note.todoist_status", primitive(options.status ?? "active")],
    ["note.todoist_completed", primitive(options.completed ?? false)],
    ["note.todoist_project_id", primitive(projectId)],
    ["note.todoist_project", primitive(projectName)],
    ["note.todoist_project_id_path", list(options.projectIdPath ?? [projectId])],
    ["note.todoist_project_path", list(options.projectPath ?? [projectName])],
    ["note.todoist_labels", list(options.labels ?? [])],
  ]);

  const optionalValues: [BasesPropertyId, string | undefined][] = [
    ["note.todoist_parent_task_id", options.parentTaskId],
    ["note.todoist_section_id", options.sectionId],
    ["note.todoist_section", options.sectionName],
    ["note.todoist_priority", options.priority],
    ["note.todoist_due_date", options.dueDate],
  ];
  for (const [property, value] of optionalValues) {
    if (value !== undefined) {
      values.set(property, primitive(value));
    }
  }

  return {
    file: {
      name: `${id}.md`,
      path: `Todoist/${id}.md`,
    },
    getValue: (propertyId: BasesPropertyId) => values.get(propertyId) ?? nullValue(),
  } as unknown as BasesEntry;
};

const makeGroup = (entries: BasesEntry[], label?: string): BasesEntryGroup =>
  ({
    entries,
    hasKey: () => label !== undefined,
    key: label === undefined ? undefined : primitive(label),
  }) as BasesEntryGroup;

const build = (groups: BasesEntryGroup[], order: BasesPropertyId[] = []) =>
  buildTodoistListModel(groups, {
    order,
    getDisplayName: (propertyId) => `Display ${propertyId.split(".")[1]}`,
  });

describe("buildTodoistListModel", () => {
  it("builds project, section, task, and subtask hierarchy with recursive counts", () => {
    const model = build([
      makeGroup([
        makeEntry("child-project-task", {
          projectId: "networking",
          projectName: "Networking",
          projectIdPath: ["root", "networking"],
          projectPath: ["Study", "Networking"],
          sectionId: "section-1",
          sectionName: "Lectures",
        }),
        makeEntry("parent", {
          content: "Parent task",
          projectName: "Study",
          projectPath: ["Study"],
        }),
        makeEntry("subtask", {
          parentTaskId: "parent",
          projectName: "Study",
          projectPath: ["Study"],
          status: "completed",
          completed: true,
        }),
      ]),
    ]);

    expect(model.taskCount).toBe(3);
    expect(model.counts).toEqual({ active: 2, completed: 1, unavailable: 0 });
    const root = model.groups[0]?.projects[0];
    expect(root?.name).toBe("Study");
    expect(root?.tasks[0]?.id).toBe("parent");
    expect(root?.tasks[0]?.children.map(({ id }) => id)).toEqual(["subtask"]);
    expect(root?.projects[0]?.name).toBe("Networking");
    expect(root?.projects[0]?.sections[0]?.name).toBe("Lectures");
    expect(root?.projects[0]?.sections[0]?.tasks[0]?.id).toBe("child-project-task");
  });

  it("uses project IDs rather than duplicate names and exposes arbitrary roots", () => {
    const model = build([
      makeGroup([
        makeEntry("alpha", {
          projectId: "alpha-project",
          projectName: "Duplicate",
          projectIdPath: ["root", "alpha-project"],
          projectPath: ["Root", "Duplicate"],
        }),
        makeEntry("beta", {
          projectId: "beta-project",
          projectName: "Duplicate",
          projectIdPath: ["root", "beta-project"],
          projectPath: ["Root", "Duplicate"],
        }),
      ]),
    ]);

    expect(model.projects.map(({ id }) => id)).toEqual(["root", "alpha-project", "beta-project"]);
    const scoped = scopeTodoistListGroups(model.groups, "beta-project");
    expect(scoped[0]?.projects).toHaveLength(1);
    expect(scoped[0]?.projects[0]?.id).toBe("beta-project");
    expect(scoped[0]?.counts.active).toBe(1);
  });

  it("preserves Base group and entry order and reads metadata in property order", () => {
    const model = build(
      [
        makeGroup(
          [
            makeEntry("second", { dueDate: "2026-08-12", labels: ["work"] }),
            makeEntry("first", { dueDate: "2026-08-11", labels: ["urgent"] }),
          ],
          "Active",
        ),
        makeGroup([makeEntry("done", { completed: true, status: "completed" })], "Completed"),
      ],
      ["note.todoist_labels", "note.todoist_due_date"],
    );

    expect(model.groups.map(({ label }) => label)).toEqual(["Active", "Completed"]);
    expect(model.groups[0]?.projects[0]?.tasks.map(({ id }) => id)).toEqual(["second", "first"]);
    expect(model.groups[0]?.projects[0]?.tasks[0]?.metadata).toMatchObject([
      { propertyId: "note.todoist_labels", values: ["work"] },
      { propertyId: "note.todoist_due_date", values: ["2026-08-12"] },
    ]);
  });

  it("preserves Base order across child projects, sections, and unsectioned tasks", () => {
    const model = build([
      makeGroup([
        makeEntry("child-project-task", {
          projectId: "child",
          projectName: "Child",
          projectIdPath: ["root", "child"],
          projectPath: ["Root", "Child"],
        }),
        makeEntry("section-task", { sectionId: "section", sectionName: "Section" }),
        makeEntry("direct-task"),
      ]),
    ]);
    const root = model.groups[0]?.projects[0];
    const itemLabel = (item: NonNullable<typeof root>["items"][number]): string => {
      if (item.kind === "project") {
        return `project:${item.project.id}`;
      }
      if (item.kind === "section") {
        return `section:${item.section.key}`;
      }
      return `task:${item.task.id}`;
    };
    const labels = root?.items.map(itemLabel);
    const flatLabels = root?.flatItems.map(itemLabel);

    expect(labels).toEqual(["project:child", "section:section", "task:direct-task"]);
    expect(flatLabels).toEqual(["project:child", "task:section-task", "task:direct-task"]);
  });

  it("ignores non-managed and malformed entries and reports diagnostics", () => {
    const malformed = makeEntry("malformed", {
      projectIdPath: ["root", "child"],
      projectPath: ["Root"],
    });
    const model = build([
      makeGroup([
        makeEntry("plain", { managed: false }),
        malformed,
        makeEntry("valid"),
        makeEntry("valid"),
      ]),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toMatchObject({
      ignoredNonManaged: 1,
      ignoredInvalid: 2,
    });
  });

  it("reports zero tasks when every managed note is invalid", () => {
    const model = build([
      makeGroup([
        makeEntry("invalid-only", {
          projectIdPath: ["root", "child"],
          projectPath: ["Root"],
        }),
      ]),
    ]);

    expect(model.taskCount).toBe(0);
    expect(model.diagnostics.ignoredInvalid).toBe(1);
  });

  it("does not retain ghost projects from a path that conflicts after a new segment", () => {
    const model = build([
      makeGroup([
        makeEntry("valid-root"),
        makeEntry("conflicting-path", {
          projectId: "root",
          projectName: "Root",
          projectIdPath: ["ghost", "root"],
          projectPath: ["Ghost", "Root"],
        }),
      ]),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.projects.map(({ id }) => id)).toEqual(["root"]);
    expect(model.groups[0]?.projects.map(({ id }) => id)).toEqual(["root"]);
    expect(model.diagnostics).toMatchObject({ ignoredInvalid: 1, hierarchyWarnings: 1 });
  });

  it("keeps missing-parent and cyclic tasks reachable with warnings", () => {
    const model = build([
      makeGroup([
        makeEntry("missing", { parentTaskId: "not-in-base" }),
        makeEntry("cycle-a", { parentTaskId: "cycle-b" }),
        makeEntry("cycle-b", { parentTaskId: "cycle-a" }),
      ]),
    ]);
    const tasks = model.groups[0]?.projects[0]?.tasks ?? [];

    expect(tasks.map(({ id }) => id)).toEqual(["missing", "cycle-a", "cycle-b"]);
    expect(tasks.map(({ hierarchyWarning }) => hierarchyWarning)).toEqual([
      "missing-parent",
      "cycle",
      "cycle",
    ]);
    expect(model.diagnostics.hierarchyWarnings).toBe(3);
  });

  it("does not interpret Bases NullValue strings as parent or section metadata", () => {
    const model = build([makeGroup([makeEntry("ordinary-task")])]);
    const project = model.groups[0]?.projects[0];

    expect(project?.tasks.map(({ id }) => id)).toEqual(["ordinary-task"]);
    expect(project?.sections).toEqual([]);
    expect(project?.tasks[0]?.parentTaskId).toBeUndefined();
    expect(model.diagnostics.hierarchyWarnings).toBe(0);
  });
});
