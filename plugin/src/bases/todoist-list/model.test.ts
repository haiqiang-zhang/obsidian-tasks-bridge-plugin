import type { BasesEntry, BasesEntryGroup, BasesPropertyId, Value } from "obsidian";
import { describe, expect, it } from "vitest";

import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";

import { buildTodoistListModel, scopeTodoistListGroups } from "./model";

type EntryOptions = {
  taskId?: string | null;
  projectCatalog?: boolean;
  managed?: boolean;
  mappingId?: string;
  rootProjectId?: string;
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
  const rootProjectId = options.rootProjectId ?? options.projectIdPath?.[0] ?? "root";
  const values = new Map<BasesPropertyId, Value>([
    ["note.tasks_bridge_project_catalog_managed", primitive(options.projectCatalog ?? false)],
    ["note.todoist_sync_managed", primitive(options.managed ?? true)],
    ["note.todoist_sync_root_id", primitive(rootProjectId)],
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

  if (options.taskId !== null) {
    values.set("note.todoist_task_id", primitive(options.taskId ?? id));
  }

  if (options.mappingId !== undefined) {
    values.set("note.todoist_sync_mapping_id", primitive(options.mappingId));
  }

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
      extension: "md",
      name: `${id}.md`,
      path: `Todoist/${id}.md`,
    },
    getValue: (propertyId: BasesPropertyId) => values.get(propertyId) ?? nullValue(),
  } as unknown as BasesEntry;
};

const moveEntry = (entry: BasesEntry, suffix: string): BasesEntry => {
  Object.assign(entry.file, {
    basename: `${entry.file.basename ?? entry.file.name.replace(/\.md$/u, "")} ${suffix}`,
    name: `${entry.file.name.replace(/\.md$/u, "")} ${suffix}.md`,
    path: entry.file.path.replace(/\.md$/u, ` ${suffix}.md`),
  });
  return entry;
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

type StatisticsProject = ProjectSyncStatisticsSnapshot["scopes"][number]["projects"][number];

const statisticsProject = (
  id: string,
  name: string,
  parentId: string | null,
  childOrder = 0,
): StatisticsProject => ({
  id,
  name,
  parentId,
  childOrder,
  directCounts: { active: 0, completed: 0 },
  directCompletionEvents: [],
});

const statisticsSnapshot = (
  scopes: {
    mappingId: string;
    rootProjectId: string;
    projects: StatisticsProject[];
  }[],
): ProjectSyncStatisticsSnapshot => ({
  syncedAt: "2026-08-13T12:00:00.000Z",
  scopes: scopes.map((scope) => ({ ...scope, includeSubprojects: true })),
});

const buildWithSnapshot = (
  groups: BasesEntryGroup[],
  projectStatisticsSnapshot: ProjectSyncStatisticsSnapshot,
) =>
  buildTodoistListModel(groups, {
    order: [],
    projectStatisticsSnapshot,
  });

describe("buildTodoistListModel", () => {
  it("merges a zero-task snapshot child into the first Base group that observes its scope", () => {
    const model = buildWithSnapshot(
      [makeGroup([makeEntry("root-task", { mappingId: "mapping" })], "Active")],
      statisticsSnapshot([
        {
          mappingId: "mapping",
          rootProjectId: "root",
          projects: [
            statisticsProject("root", "Root", null),
            statisticsProject("empty-child", "Empty child", "root"),
          ],
        },
      ]),
    );

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.projects[0]?.projects).toMatchObject([
      { id: "empty-child", name: "Empty child", counts: { active: 0, completed: 0 } },
    ]);
    expect(model.taskCount).toBe(1);
    expect(model.groups[0]?.counts).toEqual({ active: 1, completed: 0, unavailable: 0 });
  });

  it("creates one synthetic hierarchy group for snapshot scopes with no Base entries", () => {
    const model = buildWithSnapshot(
      [makeGroup([], "Active")],
      statisticsSnapshot([
        {
          mappingId: "mapping",
          rootProjectId: "root",
          projects: [
            statisticsProject("root", "Root", null),
            statisticsProject("empty-child", "Empty child", "root"),
          ],
        },
      ]),
    );

    expect(model.groups).toHaveLength(2);
    expect(model.groups[0]).toMatchObject({ label: "Active", projects: [] });
    expect(model.groups[1]).toMatchObject({
      key: "group:snapshot:ungrouped",
      synthetic: true,
      counts: { active: 0, completed: 0, unavailable: 0 },
    });
    expect(model.groups[1]?.projects[0]?.projects[0]?.id).toBe("empty-child");
    expect(model.taskCount).toBe(0);
  });

  it("assigns snapshot-only descendants once without copying them across Base groups", () => {
    const snapshot = statisticsSnapshot([
      {
        mappingId: "mapping",
        rootProjectId: "root",
        projects: [
          statisticsProject("root", "Root", null),
          statisticsProject("empty-child", "Empty child", "root"),
        ],
      },
    ]);
    const model = buildWithSnapshot(
      [
        makeGroup([makeEntry("active", { mappingId: "mapping" })], "Active"),
        makeGroup(
          [makeEntry("completed", { mappingId: "mapping", status: "completed", completed: true })],
          "Completed",
        ),
      ],
      snapshot,
    );

    expect(model.groups[0]?.projects[0]?.projects.map(({ id }) => id)).toEqual(["empty-child"]);
    expect(model.groups[1]?.projects[0]?.projects).toEqual([]);
    expect(model.groups.map(({ counts }) => counts)).toEqual([
      { active: 1, completed: 0, unavailable: 0 },
      { active: 0, completed: 1, unavailable: 0 },
    ]);
    expect(model.taskCount).toBe(2);
  });

  it("does not inject a project into an earlier group when that project has tasks in a later group", () => {
    const model = buildWithSnapshot(
      [
        makeGroup([makeEntry("root-task", { mappingId: "mapping" })], "Root tasks"),
        makeGroup(
          [
            makeEntry("child-task", {
              mappingId: "mapping",
              projectId: "child",
              projectName: "Child",
              projectIdPath: ["root", "child"],
              projectPath: ["Root", "Child"],
            }),
          ],
          "Child tasks",
        ),
      ],
      statisticsSnapshot([
        {
          mappingId: "mapping",
          rootProjectId: "root",
          projects: [
            statisticsProject("root", "Root", null),
            statisticsProject("child", "Child", "root"),
          ],
        },
      ]),
    );

    expect(model.groups[0]?.projects[0]?.projects).toEqual([]);
    expect(model.groups[1]?.projects[0]?.projects[0]?.tasks.map(({ id }) => id)).toEqual([
      "child-task",
    ]);
    expect(model.groups.map(({ counts }) => counts)).toEqual([
      { active: 1, completed: 0, unavailable: 0 },
      { active: 1, completed: 0, unavailable: 0 },
    ]);
  });

  it("inserts missing snapshot ancestors around a Base task whose local path is incomplete", () => {
    const model = buildWithSnapshot(
      [
        makeGroup([
          makeEntry("child-task", {
            mappingId: "mapping",
            rootProjectId: "root",
            projectId: "child",
            projectName: "Child",
            projectIdPath: ["child"],
            projectPath: ["Child"],
          }),
        ]),
      ],
      statisticsSnapshot([
        {
          mappingId: "mapping",
          rootProjectId: "root",
          projects: [
            statisticsProject("root", "Root", null),
            statisticsProject("child", "Child", "root"),
          ],
        },
      ]),
    );

    const root = model.groups[0]?.projects[0];
    expect(root?.id).toBe("root");
    expect(root?.projects[0]).toMatchObject({
      id: "child",
      pathIds: ["root", "child"],
      pathNames: ["Root", "Child"],
    });
    expect(root?.projects[0]?.tasks.map(({ id }) => id)).toEqual(["child-task"]);
    expect(model.taskCount).toBe(1);
  });

  it("keeps duplicate raw project IDs distinct by mapping scope when merging snapshots", () => {
    const model = buildWithSnapshot(
      [makeGroup([])],
      statisticsSnapshot([
        {
          mappingId: "first",
          rootProjectId: "shared",
          projects: [statisticsProject("shared", "First shared", null)],
        },
        {
          mappingId: "second",
          rootProjectId: "shared",
          projects: [statisticsProject("shared", "Second shared", null)],
        },
      ]),
    );

    const projects = model.groups.find(({ synthetic }) => synthetic)?.projects ?? [];
    expect(projects.map(({ id }) => id)).toEqual(["shared", "shared"]);
    expect(projects.map(({ name }) => name)).toEqual(["First shared", "Second shared"]);
    expect(new Set(projects.map(({ scopeKey }) => scopeKey)).size).toBe(2);
    expect(model.projects).toHaveLength(2);
  });

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

  it("reports duplicate task notes separately from non-managed and malformed entries", () => {
    const malformed = makeEntry("malformed", {
      projectIdPath: ["root", "child"],
      projectPath: ["Root"],
    });
    const model = build([
      makeGroup([
        makeEntry("plain", { managed: false, taskId: null }),
        malformed,
        makeEntry("valid"),
        moveEntry(makeEntry("valid"), "(2)"),
      ]),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toMatchObject({
      ignoredNonManaged: 1,
      ignoredDuplicateTaskNotes: 1,
      ignoredInvalid: 1,
    });
  });

  it("silently excludes Project Catalog Markdown from broad Base results", () => {
    const model = build([
      makeGroup([
        makeEntry("catalog", { managed: false, projectCatalog: true }),
        makeEntry("task"),
      ]),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toEqual({
      ignoredNonManaged: 0,
      ignoredDuplicateTaskNotes: 0,
      ignoredInvalid: 0,
      hierarchyWarnings: 0,
    });
  });

  it("deduplicates task identities across separate Base groups", () => {
    const model = build([
      makeGroup([makeEntry("same-task")], "First"),
      makeGroup([moveEntry(makeEntry("same-task"), "(2)")], "Second"),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.groups[0]?.projects[0]?.tasks.map(({ id }) => id)).toEqual(["same-task"]);
    expect(model.groups[1]?.projects).toEqual([]);
    expect(model.diagnostics).toMatchObject({
      ignoredDuplicateTaskNotes: 1,
      ignoredInvalid: 0,
    });
  });

  it("deduplicates only matching mapping, root, and task identities", () => {
    const model = build([
      makeGroup([
        makeEntry("same-task", { mappingId: "mapping-a", rootProjectId: "root-a" }),
        moveEntry(
          makeEntry("same-task", { mappingId: "mapping-a", rootProjectId: "root-a" }),
          "duplicate",
        ),
        moveEntry(
          makeEntry("same-task", {
            mappingId: "mapping-b",
            rootProjectId: "root-b",
            projectName: "Other mapping",
            projectPath: ["Other mapping"],
          }),
          "other mapping",
        ),
        moveEntry(
          makeEntry("same-task", {
            mappingId: "mapping-a",
            rootProjectId: "root-c",
            projectName: "Other root",
            projectPath: ["Other root"],
          }),
          "other root",
        ),
      ]),
    ]);

    expect(model.taskCount).toBe(3);
    expect(model.diagnostics.ignoredDuplicateTaskNotes).toBe(1);
    expect(model.groups[0]?.projects).toHaveLength(3);
    expect(new Set(model.groups[0]?.projects.map(({ scopeKey }) => scopeKey)).size).toBe(3);
    const tasks = model.groups[0]?.projects.flatMap(({ tasks }) => tasks) ?? [];
    expect(tasks.map(({ id }) => id)).toEqual(["same-task", "same-task", "same-task"]);
    expect(new Set(tasks.map(({ scopeKey }) => scopeKey)).size).toBe(3);
  });

  it("scopes legacy mappingless task identities by root", () => {
    const model = build([
      makeGroup([
        makeEntry("legacy", { rootProjectId: "root-a" }),
        moveEntry(makeEntry("legacy", { rootProjectId: "root-a" }), "duplicate"),
        moveEntry(
          makeEntry("legacy", {
            rootProjectId: "root-b",
            projectName: "Other root",
            projectPath: ["Other root"],
          }),
          "other root",
        ),
      ]),
    ]);

    expect(model.taskCount).toBe(2);
    expect(model.diagnostics.ignoredDuplicateTaskNotes).toBe(1);
    expect(new Set(model.groups[0]?.projects.map(({ scopeKey }) => scopeKey)).size).toBe(2);
  });

  it("does not diagnose one Base entry repeated across groups as a duplicate note", () => {
    const entry = makeEntry("one-note");
    const model = build([makeGroup([entry], "First"), makeGroup([entry], "Second")]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toMatchObject({
      ignoredDuplicateTaskNotes: 0,
      ignoredInvalid: 0,
    });
  });

  it("uses a valid duplicate as the representative when an earlier copy is malformed", () => {
    const model = build([
      makeGroup([
        makeEntry("same-task", {
          projectIdPath: ["root", "child"],
          projectPath: ["Root"],
        }),
        moveEntry(makeEntry("same-task"), "(2)"),
      ]),
    ]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toMatchObject({
      ignoredDuplicateTaskNotes: 1,
      ignoredInvalid: 1,
    });
  });

  it("silently excludes non-Markdown Base entries from note diagnostics", () => {
    const baseEntry = makeEntry("workspace");
    Object.assign(baseEntry.file, {
      extension: "base",
      name: "workspace.base",
      path: "Todoist/workspace.base",
    });

    const model = build([makeGroup([baseEntry, makeEntry("valid")])]);

    expect(model.taskCount).toBe(1);
    expect(model.diagnostics).toMatchObject({
      ignoredNonManaged: 0,
      ignoredDuplicateTaskNotes: 0,
      ignoredInvalid: 0,
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
          rootProjectId: "root",
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

  it("isolates project hierarchy conflicts to their mapping and root scope", () => {
    const model = build([
      makeGroup([
        makeEntry("scope-a", {
          mappingId: "mapping-a",
          rootProjectId: "root-a",
          projectId: "shared",
          projectName: "Shared A",
          projectIdPath: ["root", "shared"],
          projectPath: ["Root A", "Shared A"],
        }),
        moveEntry(
          makeEntry("scope-b", {
            mappingId: "mapping-b",
            rootProjectId: "root-b",
            projectId: "shared",
            projectName: "Shared B",
            projectIdPath: ["root", "shared"],
            projectPath: ["Root B", "Shared B"],
          }),
          "other scope",
        ),
      ]),
    ]);

    expect(model.taskCount).toBe(2);
    expect(model.diagnostics.hierarchyWarnings).toBe(0);
    const sharedProjects = model.projects.filter(({ id }) => id === "shared");
    expect(sharedProjects).toHaveLength(2);
    expect(sharedProjects[0]?.scopeKey).not.toBe(sharedProjects[1]?.scopeKey);
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
