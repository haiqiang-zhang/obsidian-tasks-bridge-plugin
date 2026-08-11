import type { BasesPropertyId, QueryController } from "obsidian";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSyncStatisticsSnapshot, ProjectSyncStatus } from "@/project-sync";

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
  TodoistListProjectStatisticsSource,
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
  diagnostics: { ignoredNonManaged: 0, ignoredInvalid: 0, hierarchyWarnings: 0 },
});

const actions = (): TodoistListActions => ({
  isReady: vi.fn(() => true),
  completeTask: vi.fn(async () => ({ projection: Promise.resolve() })),
  reopenTask: vi.fn(async () => ({ projection: Promise.resolve() })),
  editTask: vi.fn(),
});

const projectStatistics = (): TodoistListProjectStatisticsSource => ({
  getSnapshot: vi.fn(() => null),
  getStatus: vi.fn((): ProjectSyncStatus => ({ state: "idle" })),
  isConfigured: vi.fn(() => true),
  subscribe: vi.fn(() => () => undefined),
});

const observableProjectStatistics = (
  initialSnapshot: ProjectSyncStatisticsSnapshot | null = null,
) => {
  let snapshot = initialSnapshot;
  let status: ProjectSyncStatus = { state: "idle" };
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const source: TodoistListProjectStatisticsSource = {
    getSnapshot: vi.fn(() => snapshot),
    getStatus: vi.fn(() => status),
    isConfigured: vi.fn(() => true),
    subscribe: vi.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    }),
  };

  return {
    source,
    unsubscribe,
    publish: (
      nextSnapshot: ProjectSyncStatisticsSnapshot | null,
      nextStatus: ProjectSyncStatus = status,
    ) => {
      snapshot = nextSnapshot;
      status = nextStatus;
      listener?.();
    },
  };
};

const makeController = (
  projectOverviewCollapsed = false,
  completionHeatmapRange: unknown = "last-3-months",
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
    const registration = createTasksListViewRegistration(actions(), projectStatistics());

    expect(TASKS_LIST_VIEW_ID).toBe("tasks-list");
    expect(TASKS_LIST_VIEW_NAME).toBe("Tasks List");
    expect(registration).toMatchObject({ name: "Tasks List", icon: "lucide-list-tree" });
    expect(registration.options?.()).toEqual([
      expect.objectContaining({ key: "todoistDensity", displayName: "Density" }),
      expect.objectContaining({
        key: "todoistShowDescriptions",
        displayName: "Show descriptions",
      }),
      expect.objectContaining({ key: "todoistShowSections", displayName: "Show sections" }),
    ]);
  });

  it("consumes grouped Base data and persists its root through the view config", async () => {
    const { config, controller, groupedData, workspace } = makeController(true);
    const parentEl = document.createElement("div");
    const registration = createTasksListViewRegistration(actions(), projectStatistics());
    const view = registration.factory(controller, parentEl) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    expect(runtime.buildModel).toHaveBeenCalledWith(groupedData, {
      order: ["note.todoist_priority"],
      getDisplayName: expect.any(Function),
    });
    const element = runtime.render.mock.calls[0]?.[0] as ReactElement<TodoistListProps>;
    expect(element.props.options).toEqual({
      density: "compact",
      showDescriptions: false,
      showSections: true,
    });
    expect(element.props.projectOverviewCollapsed).toBe(true);
    expect(element.props.completionHeatmapRange).toBe("last-3-months");
    expect(element.props.projectSyncConfigured).toBe(true);
    expect(element.props.projectSyncStatus).toEqual({ state: "idle" });

    element.props.onRootProjectChange("child-project");
    expect(config.set).toHaveBeenCalledWith("todoistRootProjectId", "child-project");
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

  it("rerenders a data-ready view with the latest statistics and unsubscribes on unload", async () => {
    const { controller } = makeController();
    const parentEl = document.createElement("div");
    const statistics = observableProjectStatistics();
    const view = createTasksListViewRegistration(actions(), statistics.source).factory(
      controller,
      parentEl,
    ) as TasksListView;

    view.onDataUpdated();
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledOnce();
    const initialElement = runtime.render.mock.calls[0]?.[0] as ReactElement<TodoistListProps>;
    expect(initialElement.props.projectStatisticsSnapshot).toBeNull();

    const firstSnapshot: ProjectSyncStatisticsSnapshot = {
      syncedAt: "2026-08-10T06:00:00.000Z",
      scopes: [],
    };
    const latestSnapshot: ProjectSyncStatisticsSnapshot = {
      syncedAt: "2026-08-10T07:00:00.000Z",
      scopes: [],
    };
    statistics.publish(firstSnapshot, {
      state: "syncing",
      startedAt: "2026-08-10T06:00:00.000Z",
    });
    statistics.publish(latestSnapshot, {
      state: "success",
      completedAt: "2026-08-10T07:00:00.000Z",
      result: {
        created: 0,
        updated: 0,
        moved: 0,
        unchanged: 0,
        stale: 0,
        outOfScope: 0,
        deferred: 0,
        conflicts: [],
        settledMappingIds: [],
      },
    });
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledTimes(2);
    const updatedElement = runtime.render.mock.calls[1]?.[0] as ReactElement<TodoistListProps>;
    expect(updatedElement.props.projectStatisticsSnapshot).toBe(latestSnapshot);
    expect(updatedElement.props.projectSyncStatus.state).toBe("success");

    view.onunload();
    expect(statistics.unsubscribe).toHaveBeenCalledOnce();

    statistics.publish({
      syncedAt: "2026-08-10T08:00:00.000Z",
      scopes: [],
    });
    await Promise.resolve();

    expect(runtime.render).toHaveBeenCalledTimes(2);
  });

  it("falls back to Last year when the persisted heatmap range is invalid", async () => {
    const { controller } = makeController(false, "unsupported-range");
    const parentEl = document.createElement("div");
    const view = createTasksListViewRegistration(actions(), projectStatistics()).factory(
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
    const view = createTasksListViewRegistration(actions(), projectStatistics()).factory(
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
