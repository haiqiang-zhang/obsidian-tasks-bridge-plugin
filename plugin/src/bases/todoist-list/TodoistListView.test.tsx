import type { BasesAllOptions, BasesPropertyId, BasesViewConfig, QueryController } from "obsidian";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeProject } from "@/factories/data";

import type { TodoistListProps } from "./TodoistList";
import {
  createTasksListViewRegistration,
  TASKS_LIST_VIEW_ID,
  TASKS_LIST_VIEW_NAME,
  type TasksListView,
} from "./TodoistListView";
import type {
  TodoistListActions,
  TodoistListModel,
  TodoistListProjectContext,
  TodoistListProjectContextSource,
} from "./types";

const runtime = vi.hoisted(() => ({
  buildModel: vi.fn(),
  createRoot: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock("obsidian", () => ({
  BasesView: class {
    public readonly app: unknown;
    public readonly config: unknown;
    public readonly data: unknown;

    public constructor(controller: { app: unknown; config: unknown; data: unknown }) {
      this.app = controller.app;
      this.config = controller.config;
      this.data = controller.data;
    }

    public onunload(): void {}
  },
  setIcon: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: runtime.createRoot,
}));

vi.mock("./model", () => ({
  buildTodoistListModel: runtime.buildModel,
}));

const emptyModel = (): TodoistListModel => ({
  groups: [],
  projects: [],
  counts: { active: 0, completed: 0, unavailable: 0 },
  taskCount: 0,
  diagnostics: {
    ignoredNonManaged: 0,
    ignoredDuplicateTaskNotes: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  },
});

const actions = (): TodoistListActions => ({
  isReady: vi.fn(() => true),
  completeTask: vi.fn(async () => ({ projection: Promise.resolve() })),
  reopenTask: vi.fn(async () => ({ projection: Promise.resolve() })),
  editTask: vi.fn(),
});

const projectContext = (): TodoistListProjectContextSource => ({
  getConfig: vi.fn(() => ({ enabled: true, preserveUnmanagedItems: true, mappings: [] })),
  getProjects: vi.fn(() => []),
  getContext: vi.fn(() => null),
  subscribeContext: vi.fn(() => () => undefined),
});

const mutableProjectContext = (initialContext: TodoistListProjectContext | null = null) => {
  let context = initialContext;
  const listeners = new Set<() => void>();
  const source: TodoistListProjectContextSource = {
    getConfig: vi.fn(() => ({ enabled: true, preserveUnmanagedItems: true, mappings: [] })),
    getProjects: vi.fn(() => []),
    getContext: vi.fn(() => context),
    subscribeContext: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  return {
    source,
    publish: (nextContext: TodoistListProjectContext | null) => {
      context = nextContext;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const makeController = (
  projectOverviewCollapsed = false,
  completionHeatmapRange: unknown = "last-3-months",
  rootProjectId?: string,
) => {
  const groupedData = [{ entries: [], hasKey: () => false }];
  const config = {
    get: vi.fn((key: string) => {
      if (key === "todoistDensity") {
        return "compact";
      }
      if (key === "todoistShowDescriptions") {
        return false;
      }
      if (key === "tasksProjectOverviewCollapsed") {
        return projectOverviewCollapsed;
      }
      if (key === "tasksCompletionHeatmapRange") {
        return completionHeatmapRange;
      }
      if (key === "todoistRootProjectId") {
        return rootProjectId;
      }
      return undefined;
    }),
    getDisplayName: vi.fn((propertyId: BasesPropertyId) => `Display ${propertyId}`),
    getOrder: vi.fn(() => ["note.todoist_priority"] as BasesPropertyId[]),
    set: vi.fn(),
  };
  const workspace = {
    openLinkText: vi.fn(async () => undefined),
    trigger: vi.fn(),
  };
  const controller = {
    app: { workspace },
    config,
    data: { groupedData },
  } as unknown as QueryController;
  return { config, controller, groupedData, workspace };
};

describe("TasksListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.buildModel.mockReturnValue(emptyModel());
    runtime.createRoot.mockReturnValue({ render: runtime.render, unmount: runtime.unmount });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers an official Bases view with Tasks-prefixed identity and native options", () => {
    const registration = createTasksListViewRegistration(actions(), projectContext());

    expect(TASKS_LIST_VIEW_ID).toBe("tasks-list");
    expect(TASKS_LIST_VIEW_NAME).toBe("Tasks List");
    expect(registration).toMatchObject({ name: "Tasks List", icon: "lucide-list-tree" });
    expect(registration.options?.({} as BasesViewConfig)).toEqual([
      {
        type: "group",
        displayName: "Project scope",
        items: [
          expect.objectContaining({
            type: "dropdown",
            key: "todoistRootProjectId",
            displayName: "Root project",
            options: {
              __tasks_bridge_all_synchronized_projects__: "All synchronized projects",
            },
          }),
        ],
      },
      {
        type: "group",
        displayName: "Appearance",
        items: [
          expect.objectContaining({ key: "todoistDensity", displayName: "Density" }),
          expect.objectContaining({
            key: "todoistShowDescriptions",
            displayName: "Show descriptions",
          }),
          expect.objectContaining({ key: "todoistShowSections", displayName: "Show sections" }),
        ],
      },
    ]);
  });

  it("builds stable root options with full hierarchy labels from project context", () => {
    const context = projectContext();
    vi.mocked(context.getContext).mockReturnValue({
      scopes: [
        {
          mappingId: "mapping",
          rootProjectId: "root",
          projects: [
            {
              id: "root",
              parentId: null,
              name: "Work",
              childOrder: 0,
            },
            {
              id: "child",
              parentId: "root",
              name: "Planning",
              childOrder: 0,
            },
          ],
          tasks: [],
        },
      ],
    });

    const registration = createTasksListViewRegistration(actions(), context);
    const options = registration.options?.({} as BasesViewConfig) ?? [];
    const rootDropdown = (options[0] as { items: BasesAllOptions[] }).items[0] as {
      options: Record<string, string>;
    };

    expect(rootDropdown.options).toEqual({
      __tasks_bridge_all_synchronized_projects__: "All synchronized projects",
      root: "Work",
      child: "Work / Planning",
    });
  });

  it("falls back to configured live hierarchies before project context is available", () => {
    const context = projectContext();
    const root = makeProject("root", { name: "Work", childOrder: 0 });
    const child = makeProject("child", {
      name: "Planning",
      parentId: root.id,
      childOrder: 0,
    });
    const unrelated = makeProject("other", { name: "Personal", childOrder: 1 });
    vi.mocked(context.getProjects).mockReturnValue([unrelated, child, root]);
    vi.mocked(context.getConfig).mockReturnValue({
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [
        {
          id: "mapping",
          project: { projectId: root.id, projectName: root.name },
          folder: "Tasks",
          includeSubprojects: true,
          previousFolders: [],
        },
      ],
    });

    const registration = createTasksListViewRegistration(actions(), context);
    const options = registration.options?.({} as BasesViewConfig) ?? [];
    const rootDropdown = (options[0] as { items: BasesAllOptions[] }).items[0] as {
      options: Record<string, string>;
    };

    expect(rootDropdown.options).toEqual({
      __tasks_bridge_all_synchronized_projects__: "All synchronized projects",
      root: "Work",
      child: "Work / Planning",
    });
  });

  it("keeps an unavailable saved project visible when Obsidian supplies the latest config", () => {
    const registration = createTasksListViewRegistration(actions(), projectContext());
    const optionsCallback = registration.options as unknown as (
      config?: BasesViewConfig,
    ) => BasesAllOptions[];
    const options = optionsCallback({
      get: vi.fn((key: string) => (key === "todoistRootProjectId" ? "missing" : undefined)),
    } as unknown as BasesViewConfig);
    const rootDropdown = (options[0] as { items: BasesAllOptions[] }).items[0] as {
      options: Record<string, string>;
    };

    expect(rootDropdown.options.missing).toBe("Unavailable project (missing)");
  });

  it("consumes grouped Base data and persists its root through the view config", async () => {
    const { config, controller, groupedData, workspace } = makeController(true);
    const parentEl = document.createElement("div");
    const registration = createTasksListViewRegistration(actions(), projectContext());
    const view = registration.factory(controller, parentEl) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    expect(runtime.buildModel).toHaveBeenCalledWith(groupedData, {
      order: ["note.todoist_priority"],
      getDisplayName: expect.any(Function),
      projectContext: null,
    });
    const element = runtime.render.mock.calls[0]?.[0] as ReactElement<TodoistListProps>;
    expect(element.props.options).toEqual({
      density: "compact",
      showDescriptions: false,
      showSections: true,
    });
    expect(element.props.projectOverviewCollapsed).toBe(true);
    expect(element.props.completionHeatmapRange).toBe("last-3-months");

    element.props.onProjectOverviewCollapsedChange(true);
    expect(config.set).toHaveBeenCalledWith("tasksProjectOverviewCollapsed", true);
    element.props.onCompletionHeatmapRangeChange("year:2025");
    expect(config.set).toHaveBeenCalledWith("tasksCompletionHeatmapRange", "year:2025");

    element.props.navigation.openFile("Todoist/task.md", true);
    expect(workspace.openLinkText).toHaveBeenCalledWith("Todoist/task.md", "", true);

    const targetEl = document.createElement("a");
    const event = new MouseEvent("mouseover");
    element.props.navigation.hoverFile("Todoist/task.md", targetEl, event);
    expect(workspace.trigger).toHaveBeenCalledWith(
      "hover-link",
      expect.objectContaining({
        event,
        source: "tasks-list",
        targetEl,
        linktext: "Todoist/task.md",
      }),
    );

    view.onunload();
    expect(runtime.unmount).toHaveBeenCalledOnce();
    expect(parentEl).toBeEmptyDOMElement();
  });

  it("maps the native all-projects sentinel back to a null list scope", async () => {
    const { controller } = makeController(
      false,
      "last-year",
      "__tasks_bridge_all_synchronized_projects__",
    );
    const parentEl = document.createElement("div");
    const view = createTasksListViewRegistration(actions(), projectContext()).factory(
      controller,
      parentEl,
    ) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    const element = runtime.render.mock.calls[0]?.[0] as ReactElement<TodoistListProps>;
    expect(element.props.rootProjectId).toBeNull();
    view.onunload();
  });

  it("rerenders the existing Base result when project context becomes available", async () => {
    const { controller, groupedData } = makeController();
    const parentEl = document.createElement("div");
    const context = mutableProjectContext();
    const view = createTasksListViewRegistration(actions(), context.source).factory(
      controller,
      parentEl,
    ) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledOnce();
    expect(runtime.buildModel).toHaveBeenLastCalledWith(
      groupedData,
      expect.objectContaining({ projectContext: null }),
    );

    const nextContext: TodoistListProjectContext = {
      scopes: [],
    };
    context.publish(nextContext);
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledTimes(2);
    expect(runtime.buildModel).toHaveBeenLastCalledWith(
      groupedData,
      expect.objectContaining({ projectContext: nextContext }),
    );

    view.onunload();
    context.publish(null);
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledTimes(2);
  });

  it("waits for the first Base result before rendering a context update", async () => {
    const { controller, groupedData } = makeController();
    const parentEl = document.createElement("div");
    const context = mutableProjectContext();
    const view = createTasksListViewRegistration(actions(), context.source).factory(
      controller,
      parentEl,
    ) as TasksListView;
    const nextContext: TodoistListProjectContext = { scopes: [] };

    context.publish(nextContext);
    await Promise.resolve();

    expect(runtime.render).not.toHaveBeenCalled();
    expect(runtime.buildModel).not.toHaveBeenCalled();

    view.onDataUpdated();
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledOnce();
    expect(runtime.buildModel).toHaveBeenCalledWith(
      groupedData,
      expect.objectContaining({ projectContext: nextContext }),
    );

    view.onunload();
  });

  it("falls back to Last year when the persisted heatmap range is invalid", async () => {
    const { controller } = makeController(false, "unsupported-range");
    const parentEl = document.createElement("div");
    const view = createTasksListViewRegistration(actions(), projectContext()).factory(
      controller,
      parentEl,
    ) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    const element = runtime.render.mock.calls[0]?.[0] as ReactElement<TodoistListProps>;
    expect(element.props.completionHeatmapRange).toBe("last-year");
    view.onunload();
  });

  it("coalesces pending updates and skips a queued render after unload", async () => {
    const { controller } = makeController();
    const parentEl = document.createElement("div");
    const view = createTasksListViewRegistration(actions(), projectContext()).factory(
      controller,
      parentEl,
    ) as TasksListView;

    view.onDataUpdated();
    view.onDataUpdated();

    view.onunload();
    await Promise.resolve();

    expect(runtime.render).not.toHaveBeenCalled();
    expect(runtime.unmount).toHaveBeenCalledOnce();
  });
});
