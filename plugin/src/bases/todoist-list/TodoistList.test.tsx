import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    { id: "root", name: "Root", pathIds: ["root"], pathNames: ["Root"] },
    ...(root.projects.map((project) => ({
      id: project.id,
      name: project.name,
      pathIds: project.pathIds,
      pathNames: project.pathNames,
    })) ?? []),
  ],
  counts: root.counts,
  taskCount: root.counts.active + root.counts.completed + root.counts.unavailable,
  diagnostics: { ignoredNonManaged: 0, ignoredInvalid: 0, hierarchyWarnings: 0 },
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

const renderList = (
  model: TodoistListModel,
  actions = makeActions(),
  navigation = makeNavigation(),
  onRootProjectChange = vi.fn(),
  rootProjectId: string | null = null,
) => {
  const makeElement = (currentModel: TodoistListModel) => (
    <TodoistList
      actions={actions}
      model={currentModel}
      navigation={navigation}
      onRootProjectChange={onRootProjectChange}
      options={{ density: "comfortable", showDescriptions: true, showSections: true }}
      rootProjectId={rootProjectId}
    />
  );
  const rendered = render(makeElement(model));
  return {
    ...rendered,
    actions,
    navigation,
    onRootProjectChange,
    rerenderList: (nextModel: TodoistListModel) => rendered.rerender(makeElement(nextModel)),
  };
};

describe("TodoistList", () => {
  it("selects any project as the persisted presentation root", () => {
    const childTask = makeTask("child", "active", {
      content: "Child-only task",
      projectId: "child-project",
      projectName: "Child",
      projectIdPath: ["root", "child-project"],
      projectPath: ["Root", "Child"],
    });
    const child = makeProject("child-project", "Child", [childTask]);
    const root = makeProject("root", "Root", [makeTask("root-task")], [child]);
    const { onRootProjectChange } = renderList(makeModel(root));

    fireEvent.click(screen.getByRole("button", { name: "Root: All Todoist projects" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Todoist projects" }), {
      target: { value: "child" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Root / Child" }));

    expect(onRootProjectChange).toHaveBeenCalledWith("child-project");
    expect(screen.getByText("Child-only task")).toBeInTheDocument();
    expect(screen.queryByText("Task root-task")).not.toBeInTheDocument();
    expect(screen.getByText("Root", { selector: ".todoist-bases-root-badge" })).toBeInTheDocument();
  });

  it("expands and collapses project and task branches", () => {
    const parent = makeTask("parent", "active", {
      children: [makeTask("subtask", "active", { content: "Nested task" })],
    });
    renderList(makeModel(makeProject("root", "Root", [parent])));

    fireEvent.click(screen.getByRole("button", { name: "Collapse project Root" }));
    expect(screen.queryByText("Task parent")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand project Root" }));
    expect(screen.getByText("Task parent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse subtasks for Task parent" }));
    expect(screen.queryByText("Nested task")).not.toBeInTheDocument();
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
    fireEvent.click(complete);
    expect(await screen.findByText(projectionError.message)).toBeInTheDocument();
    await waitFor(() => expect(complete).toBeDisabled());
    expect(complete.closest("span")).toHaveAttribute(
      "title",
      "Todoist was updated. Waiting for Project sync before another action.",
    );
    fireEvent.click(complete);
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
    fireEvent.click(reopen);

    await waitFor(() =>
      expect(reopen.closest("span")).toHaveAttribute(
        "title",
        "Todoist was updated. Waiting for Project sync before another action.",
      ),
    );
    expect(reopen.closest("span")).not.toHaveAttribute("data-loading");
    expect(reopen).toBeDisabled();

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
    fireEvent.click(reopen);
    await waitFor(() => expect(reopen.closest("span")).toHaveAttribute("data-loading", "true"));

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
    fireEvent.click(reopen);
    await waitFor(() => expect(reopen.closest("span")).not.toHaveAttribute("data-loading"));

    await act(async () => projection.reject(new Error("Projection refresh failed")));
    expect(await screen.findByText("Projection refresh failed")).toBeInTheDocument();
    expect(reopen.closest("span")).not.toHaveAttribute("data-loading");
    expect(reopen).toBeDisabled();

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
      diagnostics: { ignoredNonManaged: 4, ignoredInvalid: 0, hierarchyWarnings: 0 },
    };
    renderList(model);

    expect(
      screen.getByText("No Todoist Project Sync tasks were found in this Base."),
    ).toBeInTheDocument();
    expect(screen.getByText("4 non-managed notes were ignored.")).toBeInTheDocument();
  });

  it("keeps an unavailable configured root scoped instead of showing other projects", () => {
    const model = makeModel(makeProject("root", "Root", [makeTask("other-task")]));
    renderList(model, makeActions(), makeNavigation(), vi.fn(), "filtered-project");

    expect(
      screen.getByText("The selected root project is not available in this Base."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No tasks under this project match the Base filters."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Task other-task")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Root: Unavailable project" })).toBeInTheDocument();
  });
});
