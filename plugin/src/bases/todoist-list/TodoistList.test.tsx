import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSyncStatisticsSnapshot, ProjectSyncStatus } from "@/project-sync";

import { todoistListProjectScopeKey } from "./model";
import { TodoistList } from "./TodoistList";
import type {
  TodoistListActions,
  TodoistListModel,
  TodoistListMutationResult,
  TodoistListNavigation,
  TodoistListProject,
  TodoistListTaskNode,
  TodoistListTaskStatus,
} from "./types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const makeTask = (
  id: string,
  status: TodoistListTaskStatus = "active",
  overrides: Partial<TodoistListTaskNode> = {},
): TodoistListTaskNode => ({
  id,
  scopeKey: `task:${id}`,
  rootProjectId: "root",
  filePath: `Todoist/${id}.md`,
  fileName: `${id}.md`,
  content: `Task ${id}`,
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
  children: [],
  ...overrides,
});

const makeProject = (
  id: string,
  name: string,
  tasks: TodoistListTaskNode[],
  projects: TodoistListProject[] = [],
): TodoistListProject => {
  const ownActive = tasks.filter(({ status }) => status === "active").length;
  const ownCompleted = tasks.filter(({ status }) => status === "completed").length;
  const ownUnavailable = tasks.length - ownActive - ownCompleted;
  const childCounts = projects.reduce(
    (counts, project) => ({
      active: counts.active + project.counts.active,
      completed: counts.completed + project.counts.completed,
      unavailable: counts.unavailable + project.counts.unavailable,
    }),
    { active: 0, completed: 0, unavailable: 0 },
  );
  const project: TodoistListProject = {
    id,
    scopeKey: todoistListProjectScopeKey("mapping-root", "root", id),
    name,
    pathIds: id === "root" ? ["root"] : ["root", id],
    pathNames: id === "root" ? ["Root"] : ["Root", name],
    projects,
    tasks,
    sections: [],
    items: [],
    flatItems: [],
    counts: {
      active: ownActive + childCounts.active,
      completed: ownCompleted + childCounts.completed,
      unavailable: ownUnavailable + childCounts.unavailable,
    },
  };
  project.items = [
    ...tasks.map((task) => ({ kind: "task" as const, task })),
    ...projects.map((child) => ({ kind: "project" as const, project: child })),
  ];
  project.flatItems = [...project.items];
  return project;
};

const makeModel = (root: TodoistListProject): TodoistListModel => ({
  groups: [
    {
      key: "group:0:Active",
      label: "Active",
      projects: [root],
      counts: root.counts,
    },
  ],
  projects: [
    {
      id: "root",
      scopeKey: root.scopeKey,
      name: "Root",
      pathIds: ["root"],
      pathNames: ["Root"],
    },
    ...(root.projects.map((project) => ({
      id: project.id,
      scopeKey: project.scopeKey,
      name: project.name,
      pathIds: project.pathIds,
      pathNames: project.pathNames,
    })) ?? []),
  ],
  counts: root.counts,
  taskCount: root.counts.active + root.counts.completed + root.counts.unavailable,
  diagnostics: {
    ignoredNonManaged: 0,
    ignoredDuplicateTaskNotes: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  },
});

const makeActions = (ready = true): TodoistListActions => ({
  isReady: vi.fn(() => ready),
  completeTask: vi.fn().mockResolvedValue({ projection: Promise.resolve() }),
  reopenTask: vi.fn().mockResolvedValue({ projection: Promise.resolve() }),
  editTask: vi.fn(),
});

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const makeNavigation = (): TodoistListNavigation => ({
  openFile: vi.fn(),
  hoverFile: vi.fn(),
});

type ProjectStatistics = ProjectSyncStatisticsSnapshot["scopes"][number]["projects"][number];

const makeProjectStatistics = (
  id: string,
  parentId: string | null,
  childOrder: number,
  active: number,
  completed: number,
  name = id,
): ProjectStatistics => ({
  id,
  parentId,
  name,
  childOrder,
  directCounts: { active, completed },
  directCompletionEvents: [],
});

const makeStatisticsSnapshot = (
  projects: ProjectStatistics[],
  syncedAt = "2026-08-10T06:30:00.000Z",
): ProjectSyncStatisticsSnapshot => ({
  syncedAt,
  scopes: [
    {
      mappingId: "mapping-root",
      rootProjectId: "root",
      includeSubprojects: true,
      projects,
    },
  ],
});

const renderList = (
  model: TodoistListModel,
  actions = makeActions(),
  navigation = makeNavigation(),
  rootProjectId: string | null = null,
  projectStatisticsSnapshot: ProjectSyncStatisticsSnapshot | null = null,
  projectOverviewCollapsed = false,
  onProjectOverviewCollapsedChange = vi.fn(),
  projectSyncStatus: ProjectSyncStatus = { state: "idle" },
  projectSyncConfigured = true,
  expandProjectTasks = true,
) => {
  const makeElement = (
    currentModel: TodoistListModel,
    currentSnapshot = projectStatisticsSnapshot,
    currentOverviewCollapsed = projectOverviewCollapsed,
    currentRootProjectId = rootProjectId,
  ) => (
    <TodoistList
      actions={actions}
      completionHeatmapRange="last-year"
      model={currentModel}
      navigation={navigation}
      onCompletionHeatmapRangeChange={vi.fn()}
      onProjectOverviewCollapsedChange={onProjectOverviewCollapsedChange}
      options={{ density: "comfortable", showDescriptions: true, showSections: true }}
      projectOverviewCollapsed={currentOverviewCollapsed}
      projectSyncConfigured={projectSyncConfigured}
      projectSyncStatus={projectSyncStatus}
      projectStatisticsSnapshot={currentSnapshot}
      rootProjectId={currentRootProjectId}
    />
  );
  const rendered = render(makeElement(model));
  if (expandProjectTasks && model.taskCount > 0) {
    fireEvent.click(screen.getByRole("button", { name: "Expand all project tasks" }));
  }
  return {
    ...rendered,
    actions,
    navigation,
    onProjectOverviewCollapsedChange,
    rerenderList: (
      nextModel: TodoistListModel,
      nextSnapshot = projectStatisticsSnapshot,
      nextOverviewCollapsed = projectOverviewCollapsed,
      nextRootProjectId = rootProjectId,
    ) =>
      rendered.rerender(
        makeElement(nextModel, nextSnapshot, nextOverviewCollapsed, nextRootProjectId),
      ),
  };
};

describe("TodoistList", () => {
  it("keeps the content toolbar focused on counts and tree controls", () => {
    renderList(makeModel(makeProject("root", "Root", [makeTask("root-task")])), makeActions());

    expect(screen.queryByRole("button", { name: /^Root:/ })).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Visible in Base: 1 active, 0 completed, 0 unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand all project tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse all project tasks" })).toBeInTheDocument();
  });

  it("renders snapshot totals for the complete selected root hierarchy", () => {
    const snapshot = makeStatisticsSnapshot([
      makeProjectStatistics("grandchild", "child", 0, 0, 2, "Grandchild"),
      makeProjectStatistics("root", null, 0, 1, 0, "Root"),
      makeProjectStatistics("empty-child", "root", 2, 0, 0, "Empty child"),
      makeProjectStatistics("child", "root", 1, 0, 1, "Child"),
    ]);
    renderList(
      makeModel(makeProject("root", "Root", [makeTask("root-task")])),
      makeActions(),
      makeNavigation(),
      "root",
      snapshot,
    );

    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(overview).toHaveTextContent("4 projects · 4 tasks · 75% complete");
    expect(
      screen.getByLabelText("Visible in Base: 1 active, 0 completed, 0 unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "75% complete, 3 completed of 4 tasks" }),
    ).toBeInTheDocument();

    const rootRow = screen
      .getByText("Root", { selector: ".todoist-bases-project-name" })
      .closest(".todoist-bases-project-row");
    expect(rootRow).toHaveTextContent("3 / 4 completed·75%");
    expect(screen.getByRole("progressbar", { name: "Root completion" })).toHaveAttribute(
      "value",
      "3",
    );
    expect(screen.getByRole("progressbar", { name: "Root completion" })).toHaveAttribute(
      "max",
      "4",
    );
  });

  it("renders a configured zero-task child exposed only by the statistics snapshot", () => {
    const snapshot = makeStatisticsSnapshot([
      makeProjectStatistics("root", null, 0, 1, 0, "Root"),
      makeProjectStatistics("empty-child", "root", 0, 0, 0, "Empty child"),
    ]);
    renderList(
      makeModel(makeProject("root", "Root", [makeTask("root-task")])),
      makeActions(),
      makeNavigation(),
      "empty-child",
      snapshot,
    );

    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(overview).toHaveTextContent("1 project · No tasks");
    expect(screen.getByRole("img", { name: "No tasks to calculate completion" })).toBeVisible();
    expect(
      screen.queryByText("The selected root project is no longer available."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("No tasks under this project match the Base filters."),
    ).toBeInTheDocument();
  });

  it("forwards the controlled Project Overview collapse state", () => {
    const onProjectOverviewCollapsedChange = vi.fn();
    const snapshot = makeStatisticsSnapshot([makeProjectStatistics("root", null, 0, 1, 0, "Root")]);
    const model = makeModel(makeProject("root", "Root", [makeTask("root-task")]));
    const { rerenderList } = renderList(
      model,
      makeActions(),
      makeNavigation(),
      "root",
      snapshot,
      false,
      onProjectOverviewCollapsedChange,
    );

    const toggle = screen.getByRole("button", { name: /Project overview/ });
    fireEvent.click(toggle);
    expect(onProjectOverviewCollapsedChange).toHaveBeenCalledOnce();
    expect(onProjectOverviewCollapsedChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    rerenderList(model, snapshot, true, "root");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("refreshes Project Overview when a newer statistics snapshot arrives", () => {
    const initialSnapshot = makeStatisticsSnapshot(
      [makeProjectStatistics("root", null, 0, 1, 0, "Root")],
      "2026-08-10T06:30:00.000Z",
    );
    const refreshedSnapshot = makeStatisticsSnapshot(
      [
        makeProjectStatistics("root", null, 0, 0, 1, "Root"),
        makeProjectStatistics("new-child", "root", 0, 0, 1, "New child"),
      ],
      "2026-08-10T06:45:00.000Z",
    );
    const model = makeModel(makeProject("root", "Root", [makeTask("root-task")]));
    const { rerenderList } = renderList(
      model,
      makeActions(),
      makeNavigation(),
      "root",
      initialSnapshot,
    );

    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(overview).toHaveTextContent("1 project · 1 task · 0% complete");
    expect(overview.querySelector('time[datetime="2026-08-10T06:30:00.000Z"]')).not.toBeNull();

    rerenderList(model, refreshedSnapshot, false, "root");
    expect(overview).toHaveTextContent("2 projects · 2 tasks · 100% complete");
    expect(
      screen.getByRole("img", { name: "100% complete, 2 completed of 2 tasks" }),
    ).toBeInTheDocument();
    expect(overview.querySelector('time[datetime="2026-08-10T06:45:00.000Z"]')).not.toBeNull();
  });

  it("follows an externally changed root across statistics and Base rows", () => {
    const childTask = makeTask("child-task", "active", {
      projectId: "child-project",
      projectName: "Child",
      projectIdPath: ["root", "child-project"],
      projectPath: ["Root", "Child"],
    });
    const child = makeProject("child-project", "Child", [childTask]);
    const root = makeProject("root", "Root", [makeTask("root-task")], [child]);
    const model = makeModel(root);
    const snapshot = makeStatisticsSnapshot([
      makeProjectStatistics("root", null, 0, 1, 0, "Root"),
      makeProjectStatistics("child-project", "root", 0, 1, 0, "Child"),
    ]);
    const { rerenderList } = renderList(model, makeActions(), makeNavigation(), "root", snapshot);

    expect(screen.getByText("Task root-task")).toBeInTheDocument();
    rerenderList(model, snapshot, false, "child-project");

    expect(screen.queryByText("Task root-task")).not.toBeInTheDocument();
    expect(screen.getByText("Task child-task")).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(overview).toHaveTextContent("1 project · 1 task · 0% complete");
    expect(
      screen.getByRole("img", { name: "0% complete, 0 completed of 1 tasks" }),
    ).toBeInTheDocument();
  });

  it("uses the configured project as the presentation root", () => {
    const childTask = makeTask("child", "active", {
      content: "Child-only task",
      projectId: "child-project",
      projectName: "Child",
      projectIdPath: ["root", "child-project"],
      projectPath: ["Root", "Child"],
    });
    const child = makeProject("child-project", "Child", [childTask]);
    const root = makeProject("root", "Root", [makeTask("root-task")], [child]);
    renderList(makeModel(root), makeActions(), makeNavigation(), "child-project");

    expect(screen.getByText("Child-only task")).toBeInTheDocument();
    expect(screen.queryByText("Task root-task")).not.toBeInTheDocument();
    expect(
      screen.getByText("Root / Child", {
        selector: ".todoist-bases-project-overview-scope",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Root", { selector: ".todoist-bases-root-badge" })).toBeInTheDocument();
  });

  it("keeps project hierarchy visible while each project's tasks default to collapsed", () => {
    const parent = makeTask("parent", "active", {
      children: [makeTask("subtask", "active", { content: "Nested task" })],
    });
    const child = makeProject("child", "Child", [makeTask("child-task")]);
    renderList(
      makeModel(makeProject("root", "Root", [parent], [child])),
      makeActions(),
      makeNavigation(),
      null,
      null,
      false,
      vi.fn(),
      { state: "idle" },
      true,
      false,
    );

    expect(screen.getByText("Root", { selector: ".todoist-bases-project-name" })).toBeVisible();
    expect(screen.getByText("Child", { selector: ".todoist-bases-project-name" })).toBeVisible();
    expect(screen.queryByText("Task parent")).not.toBeInTheDocument();
    expect(screen.queryByText("Task child-task")).not.toBeInTheDocument();

    const rootDisclosure = screen.getByRole("button", { name: "Show tasks in project Root" });
    const rootTaskContentId = rootDisclosure.getAttribute("aria-controls");
    expect(rootTaskContentId).not.toBeNull();
    const rootTaskContent = document.getElementById(rootTaskContentId ?? "");
    expect(rootTaskContent).toHaveClass("todoist-bases-project-children");
    expect(rootTaskContent).not.toHaveTextContent("Task parent");
    expect(rootTaskContent).toHaveTextContent("Child");

    fireEvent.click(rootDisclosure);
    expect(rootDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(rootDisclosure).toHaveAttribute("aria-controls", rootTaskContentId);
    expect(screen.getByText("Task parent")).toBeInTheDocument();
    expect(rootTaskContent).toHaveTextContent("Task parent");
    fireEvent.click(screen.getByRole("button", { name: "Collapse subtasks for Task parent" }));
    expect(screen.queryByText("Nested task")).not.toBeInTheDocument();

    fireEvent.click(rootDisclosure);
    expect(rootDisclosure).toHaveAttribute("aria-expanded", "false");
    expect(rootDisclosure).toHaveAttribute("aria-controls", rootTaskContentId);
    expect(rootTaskContent).not.toHaveTextContent("Task parent");
    expect(rootTaskContent).toHaveTextContent("Child");
    expect(screen.queryByText("Task parent")).not.toBeInTheDocument();
    expect(screen.getByText("Child", { selector: ".todoist-bases-project-name" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show tasks in project Child" }));
    expect(screen.getByText("Task child-task")).toBeVisible();
  });

  it("expands and collapses every project's tasks without hiding project rows", () => {
    const child = makeProject("child", "Child", [makeTask("child-task")]);
    renderList(
      makeModel(makeProject("root", "Root", [makeTask("root-task")], [child])),
      makeActions(),
      makeNavigation(),
      null,
      null,
      false,
      vi.fn(),
      { state: "idle" },
      true,
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand all project tasks" }));
    expect(screen.getByText("Task root-task")).toBeVisible();
    expect(screen.getByText("Task child-task")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all project tasks" }));
    expect(screen.queryByText("Task root-task")).not.toBeInTheDocument();
    expect(screen.queryByText("Task child-task")).not.toBeInTheDocument();
    expect(screen.getByText("Root", { selector: ".todoist-bases-project-name" })).toBeVisible();
    expect(screen.getByText("Child", { selector: ".todoist-bases-project-name" })).toBeVisible();
  });

  it("does not offer a task disclosure for a project that only contains child projects", () => {
    const child = makeProject("child", "Child", [makeTask("child-task")]);
    const root = makeProject("root", "Root", [], [child]);
    renderList(
      makeModel(root),
      makeActions(),
      makeNavigation(),
      null,
      null,
      false,
      vi.fn(),
      { state: "idle" },
      true,
      false,
    );

    expect(screen.getByText("Child", { selector: ".todoist-bases-project-name" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Show tasks in project Root" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show tasks in project Child" })).toBeEnabled();
  });

  it("shows an empty project statistic without exposing a misleading progress value", () => {
    const empty = makeProject("empty", "Empty", []);
    renderList(makeModel(empty), makeActions(), makeNavigation(), null, null, false, vi.fn(), {
      state: "idle",
    });

    const row = screen
      .getByText("Empty", { selector: ".todoist-bases-project-name" })
      .closest(".todoist-bases-project-row");
    expect(row).toHaveTextContent("No tasks");
    expect(row?.querySelector(".todoist-bases-project-progress")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Empty completion" })).not.toBeInTheDocument();
  });

  it("renders a snapshot-only project hierarchy even when the Base has no task rows", () => {
    const scopeKey = (id: string) => todoistListProjectScopeKey("mapping-root", "root", id);
    const emptyChild = makeProject("empty-child", "Empty child", []);
    emptyChild.scopeKey = scopeKey("empty-child");
    emptyChild.pathIds = ["root", "empty-child"];
    emptyChild.pathNames = ["Root", "Empty child"];
    const root = makeProject("root", "Root", [], [emptyChild]);
    root.scopeKey = scopeKey("root");
    const model = makeModel(root);
    model.groups[0] = {
      key: "group:snapshot:ungrouped",
      synthetic: true,
      projects: [root],
      counts: { active: 0, completed: 0, unavailable: 0 },
    };
    model.taskCount = 0;
    model.counts = { active: 0, completed: 0, unavailable: 0 };
    const snapshot = makeStatisticsSnapshot([
      makeProjectStatistics("root", null, 0, 0, 0, "Root"),
      makeProjectStatistics("empty-child", "root", 0, 0, 0, "Empty child"),
    ]);

    renderList(model, makeActions(), makeNavigation(), null, snapshot, false, vi.fn(), {
      state: "idle",
    });

    expect(screen.getByText("Root", { selector: ".todoist-bases-project-name" })).toBeVisible();
    expect(
      screen.getByText("Empty child", { selector: ".todoist-bases-project-name" }),
    ).toBeVisible();
    expect(
      screen.queryByText("No Todoist Project Sync tasks were found in this Base."),
    ).not.toBeInTheDocument();
  });

  it("renders mixed hierarchy branches in the Base-provided order", () => {
    const child = makeProject("child-project", "Child", [makeTask("child-task")]);
    const direct = makeTask("direct-task");
    const sectionTask = makeTask("section-task");
    const root = makeProject("root", "Root", [direct], [child]);
    const section = {
      key: "section",
      id: "section",
      name: "Section",
      tasks: [sectionTask],
      counts: { active: 1, completed: 0, unavailable: 0 },
    };
    root.sections = [section];
    root.items = [
      { kind: "project", project: child },
      { kind: "section", section },
      { kind: "task", task: direct },
    ];
    root.flatItems = [
      { kind: "project", project: child },
      { kind: "task", task: sectionTask },
      { kind: "task", task: direct },
    ];
    root.counts.active++;
    renderList(makeModel(root));

    const childName = screen.getByText("Child", { selector: ".todoist-bases-project-name" });
    const sectionName = screen.getByText("Section", {
      selector: ".todoist-bases-section-row span",
    });
    const directName = screen.getByRole("link", { name: "Task direct-task" });
    expect(
      childName.compareDocumentPosition(sectionName) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      sectionName.compareDocumentPosition(directName) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("passes the full task record to complete, reopen, and edit callbacks", async () => {
    const active = makeTask("active");
    const completed = makeTask("completed", "completed");
    const actions = makeActions();
    renderList(makeModel(makeProject("root", "Root", [active, completed])), actions);

    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task active" }));
    await waitFor(() =>
      expect(actions.editTask).toHaveBeenCalledWith(expect.objectContaining(active)),
    );
    const activeCheckbox = screen.getByRole("checkbox", { name: "Complete task: Task active" });
    await waitFor(() => expect(activeCheckbox).toBeEnabled());
    fireEvent.click(activeCheckbox);
    fireEvent.click(screen.getByRole("checkbox", { name: "Reopen task: Task completed" }));

    await waitFor(() => {
      expect(actions.completeTask).toHaveBeenCalledWith(expect.objectContaining(active));
      expect(actions.reopenTask).toHaveBeenCalledWith(expect.objectContaining(completed));
    });
    const completedEdit = screen.getByRole("button", { name: "Edit task: Task completed" });
    expect(completedEdit).toBeDisabled();
    expect(completedEdit).toHaveAttribute("title", "Reopen before editing.");
  });

  it("shows pending de-completion intent and disables completion until status converges", () => {
    const actions = makeActions();
    const pendingReopen = makeTask("pending-reopen", "completed", { completed: false });
    renderList(makeModel(makeProject("root", "Root", [pendingReopen])), actions);

    const checkbox = screen.getByRole("checkbox", {
      name: "Complete task: Task pending-reopen",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(checkbox.closest("span")).toHaveAttribute(
      "title",
      "Waiting for Todoist status to match this note.",
    );
    fireEvent.click(checkbox);
    expect(actions.completeTask).not.toHaveBeenCalled();
    expect(actions.reopenTask).not.toHaveBeenCalled();
  });

  it("uses Obsidian's native spinner for pending task actions", async () => {
    const edit = deferred<void>();
    const completion = deferred<TodoistListMutationResult>();
    const actions = makeActions();
    vi.mocked(actions.editTask).mockReturnValue(edit.promise);
    vi.mocked(actions.completeTask).mockReturnValue(completion.promise);
    renderList(makeModel(makeProject("root", "Root", [makeTask("active")])), actions);

    const editButton = screen.getByRole("button", { name: "Edit task: Task active" });
    fireEvent.click(editButton);
    await waitFor(() => expect(editButton.querySelector(".loader-spinner")).toBeInTheDocument());
    expect(editButton.querySelector(".is-loading")).not.toBeInTheDocument();

    await act(async () => edit.resolve());
    await waitFor(() =>
      expect(editButton.querySelector(".loader-spinner")).not.toBeInTheDocument(),
    );

    const checkbox = screen.getByRole("checkbox", { name: "Complete task: Task active" });
    const actionWrapper = checkbox.closest(".todoist-bases-task-action-wrap");
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(actionWrapper?.querySelector(".loader-spinner")).toBeInTheDocument(),
    );
    expect(actionWrapper?.querySelector(".is-loading")).not.toBeInTheDocument();
    expect(actionWrapper).toHaveAttribute("data-loading", "true");
    expect(actionWrapper).toHaveAttribute("aria-busy", "true");
    expect(actionWrapper?.querySelector('input[type="checkbox"]')).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Completing task: Task active" })).toHaveAttribute(
      "data-icon-size",
      "xs",
    );

    await act(async () => completion.resolve({ projection: Promise.resolve() }));
    await waitFor(() => {
      expect(actionWrapper?.querySelector(".loader-spinner")).not.toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "Complete task: Task active" }),
      ).toBeInTheDocument();
    });
  });

  it("refreshes readiness without requiring a Base data update", () => {
    vi.useFakeTimers();
    let ready = false;
    const actions = makeActions();
    vi.mocked(actions.isReady).mockImplementation(() => ready);
    renderList(makeModel(makeProject("root", "Root", [makeTask("active")])), actions);
    const checkbox = screen.getByRole("checkbox", { name: "Complete task: Task active" });
    expect(checkbox).toBeDisabled();

    ready = true;
    act(() => vi.advanceTimersByTime(1000));
    expect(checkbox).toBeEnabled();
  });

  it("keeps stale tasks read-only and surfaces exact action errors", async () => {
    const stale = makeTask("stale", "stale");
    const active = makeTask("active");
    const actions = makeActions();
    vi.mocked(actions.completeTask).mockRejectedValue(
      new Error("Todoist updated, but the local note refresh was deferred."),
    );
    renderList(makeModel(makeProject("root", "Root", [stale, active])), actions);

    expect(screen.getByRole("checkbox", { name: "Complete task: Task stale" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete task: Task active" }));
    expect(
      await screen.findByText("Todoist updated, but the local note refresh was deferred."),
    ).toBeInTheDocument();
  });

  it("locks a remotely mutated row until its projected status changes", async () => {
    const active = makeTask("active");
    const actions = makeActions();
    const projectionError = Object.assign(
      new Error("Todoist was updated, but the Vault projection could not be refreshed"),
      { remoteMutationSucceeded: true as const },
    );
    vi.mocked(actions.completeTask).mockRejectedValue(projectionError);
    const { rerenderList } = renderList(makeModel(makeProject("root", "Root", [active])), actions);

    const complete = screen.getByRole("checkbox", { name: "Complete task: Task active" });
    const completionSlot = complete.closest(".todoist-bases-task-action-wrap");
    fireEvent.click(complete);
    expect(await screen.findByText(projectionError.message)).toBeInTheDocument();
    const lockedComplete = await screen.findByRole("checkbox", {
      name: "Complete task: Task active",
    });
    expect(lockedComplete).toBeDisabled();
    expect(completionSlot).toHaveAttribute(
      "title",
      "Todoist was updated. Waiting for Project sync before another action.",
    );
    fireEvent.click(lockedComplete);
    expect(actions.completeTask).toHaveBeenCalledOnce();

    const completed = makeTask("active", "completed");
    rerenderList(makeModel(makeProject("root", "Root", [completed])));
    const reopen = screen.getByRole("checkbox", { name: "Reopen task: Task active" });
    await waitFor(() => expect(reopen).toBeEnabled());
  });

  it("ends remote loading while projection is pending and unlocks after Base confirms the state", async () => {
    const projection = deferred<void>();
    const completed = makeTask("completed", "completed");
    const actions = makeActions();
    vi.mocked(actions.reopenTask).mockResolvedValue({ projection: projection.promise });
    const { rerenderList } = renderList(
      makeModel(makeProject("root", "Root", [completed])),
      actions,
    );

    const reopen = screen.getByRole("checkbox", { name: "Reopen task: Task completed" });
    const completionSlot = reopen.closest(".todoist-bases-task-action-wrap");
    fireEvent.click(reopen);

    await waitFor(() =>
      expect(completionSlot).toHaveAttribute(
        "title",
        "Todoist was updated. Waiting for Project sync before another action.",
      ),
    );
    expect(completionSlot).not.toHaveAttribute("data-loading");
    expect(screen.getByRole("checkbox", { name: "Reopen task: Task completed" })).toBeDisabled();

    rerenderList(makeModel(makeProject("root", "Root", [makeTask("completed", "active")])));
    const complete = screen.getByRole("checkbox", { name: "Complete task: Task completed" });
    await waitFor(() => expect(complete).toBeEnabled());
    expect(complete.closest("span")).not.toHaveAttribute("data-loading");

    await act(async () => projection.resolve());
  });

  it("ignores a late remote failure after Base status supersedes the pending action", async () => {
    const remote = deferred<TodoistListMutationResult>();
    const completed = makeTask("completed", "completed");
    const actions = makeActions();
    vi.mocked(actions.reopenTask).mockReturnValue(remote.promise);
    const { rerenderList } = renderList(
      makeModel(makeProject("root", "Root", [completed])),
      actions,
    );

    const reopen = screen.getByRole("checkbox", { name: "Reopen task: Task completed" });
    const completionSlot = reopen.closest(".todoist-bases-task-action-wrap");
    fireEvent.click(reopen);
    await waitFor(() => expect(completionSlot).toHaveAttribute("data-loading", "true"));
    expect(
      screen.queryByRole("checkbox", { name: "Reopen task: Task completed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Reopening task: Task completed" })).toHaveAttribute(
      "data-icon-size",
      "xs",
    );

    rerenderList(makeModel(makeProject("root", "Root", [makeTask("completed", "active")])));
    const complete = screen.getByRole("checkbox", { name: "Complete task: Task completed" });
    await waitFor(() => expect(complete).toBeEnabled());
    expect(complete.closest("span")).not.toHaveAttribute("data-loading");

    await act(async () => remote.reject(new Error("Late reopen failure")));
    expect(screen.queryByText("Late reopen failure")).not.toBeInTheDocument();
    expect(complete.closest("span")).not.toHaveAttribute("data-loading");
    expect(complete).toBeEnabled();
  });

  it("shows projection failure without a spinner and clears it after Base confirms the state", async () => {
    const projection = deferred<void>();
    const completed = makeTask("completed", "completed");
    const actions = makeActions();
    vi.mocked(actions.reopenTask).mockResolvedValue({ projection: projection.promise });
    const { rerenderList } = renderList(
      makeModel(makeProject("root", "Root", [completed])),
      actions,
    );

    const reopen = screen.getByRole("checkbox", { name: "Reopen task: Task completed" });
    const completionSlot = reopen.closest(".todoist-bases-task-action-wrap");
    fireEvent.click(reopen);
    await waitFor(() => expect(completionSlot).not.toHaveAttribute("data-loading"));

    await act(async () => projection.reject(new Error("Projection refresh failed")));
    expect(await screen.findByText("Projection refresh failed")).toBeInTheDocument();
    expect(completionSlot).not.toHaveAttribute("data-loading");
    expect(screen.getByRole("checkbox", { name: "Reopen task: Task completed" })).toBeDisabled();

    rerenderList(makeModel(makeProject("root", "Root", [makeTask("completed", "active")])));
    const complete = screen.getByRole("checkbox", { name: "Complete task: Task completed" });
    await waitFor(() => expect(complete).toBeEnabled());
    expect(screen.queryByText("Projection refresh failed")).not.toBeInTheDocument();
  });

  it("opens and previews the backing Markdown note", () => {
    const navigation = makeNavigation();
    renderList(
      makeModel(makeProject("root", "Root", [makeTask("open-me")])),
      makeActions(),
      navigation,
    );
    const link = screen.getByRole("link", { name: "Task open-me" });

    fireEvent.mouseEnter(link);
    fireEvent.click(link, { metaKey: true });

    expect(navigation.hoverFile).toHaveBeenCalledWith(
      "Todoist/open-me.md",
      link,
      expect.any(MouseEvent),
    );
    expect(navigation.openFile).toHaveBeenCalledWith("Todoist/open-me.md", true);
  });

  it("explains when a Base contains only non-managed notes", () => {
    const model: TodoistListModel = {
      groups: [
        { key: "group:0:all", projects: [], counts: { active: 0, completed: 0, unavailable: 0 } },
      ],
      projects: [],
      counts: { active: 0, completed: 0, unavailable: 0 },
      taskCount: 0,
      diagnostics: {
        ignoredNonManaged: 4,
        ignoredDuplicateTaskNotes: 0,
        ignoredInvalid: 0,
        hierarchyWarnings: 0,
      },
    };
    renderList(model);

    expect(
      screen.getByText("No Todoist Project Sync tasks were found in this Base."),
    ).toBeInTheDocument();
    expect(screen.getByText("4 non-managed notes were ignored.")).toBeInTheDocument();
  });

  it("distinguishes duplicate task notes from invalid Todoist notes", () => {
    const model = makeModel(makeProject("root", "Root", [makeTask("valid")]));
    model.diagnostics = {
      ignoredNonManaged: 0,
      ignoredDuplicateTaskNotes: 76,
      ignoredInvalid: 2,
      hierarchyWarnings: 0,
    };

    renderList(model);

    expect(
      screen.getByText("76 duplicate Todoist task notes ignored; 2 invalid Todoist notes ignored."),
    ).toBeInTheDocument();
  });

  it("keeps an unavailable configured root scoped instead of showing other projects", () => {
    const model = makeModel(makeProject("root", "Root", [makeTask("other-task")]));
    renderList(model, makeActions(), makeNavigation(), "filtered-project");

    expect(
      screen.getByText(
        "The selected root project is no longer available. Open Configure view and choose another Root project.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No tasks under this project match the Base filters."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open Configure view to choose another Root project, or adjust the Base filters.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Task other-task")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset root" })).not.toBeInTheDocument();
  });
});
