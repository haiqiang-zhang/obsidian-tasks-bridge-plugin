import {
  BasesView,
  type BasesViewConfig,
  type BasesViewRegistration,
  type HoverParent,
  type HoverPopover,
  type QueryController,
  type ViewOption,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";
import { selectProjectHierarchy } from "@/project-sync";

import { type CompletionHeatmapRange, isCompletionHeatmapRange } from "./completionHeatmapModel";
import { buildTodoistListModel } from "./model";
import { TodoistList } from "./TodoistList";
import type {
  TodoistListActions,
  TodoistListNavigation,
  TodoistListProjectOption,
  TodoistListProjectStatisticsSource,
  TodoistListViewOptions,
} from "./types";
import "./styles.scss";

export const TASKS_LIST_VIEW_ID = "tasks-list";
export const TASKS_LIST_VIEW_NAME = "Tasks List";

const rootProjectConfigKey = "todoistRootProjectId";
const densityConfigKey = "todoistDensity";
const showDescriptionsConfigKey = "todoistShowDescriptions";
const showSectionsConfigKey = "todoistShowSections";
const projectOverviewCollapsedConfigKey = "tasksProjectOverviewCollapsed";
const completionHeatmapRangeConfigKey = "tasksCompletionHeatmapRange";
const defaultCompletionHeatmapRange: CompletionHeatmapRange = "last-year";
const allSynchronizedProjectsValue = "__tasks_bridge_all_synchronized_projects__";

export const tasksListViewOptions = (
  projectStatistics: TodoistListProjectStatisticsSource,
  config?: BasesViewConfig,
): ViewOption[] => [
  {
    type: "group",
    displayName: "Project scope",
    items: [
      {
        type: "dropdown",
        key: rootProjectConfigKey,
        displayName: "Root project",
        default: allSynchronizedProjectsValue,
        options: buildRootProjectDropdownOptions(projectStatistics, config),
      },
    ],
  },
  {
    type: "group",
    displayName: "Appearance",
    items: [
      {
        type: "dropdown",
        key: densityConfigKey,
        displayName: "Density",
        default: "comfortable",
        options: {
          comfortable: "Comfortable",
          compact: "Compact",
        },
      },
      {
        type: "toggle",
        key: showDescriptionsConfigKey,
        displayName: "Show descriptions",
        default: true,
      },
      {
        type: "toggle",
        key: showSectionsConfigKey,
        displayName: "Show sections",
        default: true,
      },
    ],
  },
];

export const createTasksListViewRegistration = (
  actions: TodoistListActions,
  projectStatistics: TodoistListProjectStatisticsSource,
): BasesViewRegistration => ({
  name: TASKS_LIST_VIEW_NAME,
  icon: "lucide-list-tree",
  factory: (controller, containerEl) =>
    new TasksListView(controller, containerEl, actions, projectStatistics),
  // Obsidian 1.11.4 declares this callback without an argument, while newer API declarations pass
  // the current view config. An optional argument supports both and lets us preserve an unavailable
  // saved selection in newer Obsidian versions.
  options: (config?: BasesViewConfig) => tasksListViewOptions(projectStatistics, config),
});

export class TasksListView extends BasesView implements HoverParent {
  public readonly type = TASKS_LIST_VIEW_ID;
  public hoverPopover: HoverPopover | null = null;

  private readonly actions: TodoistListActions;
  private readonly containerEl: HTMLDivElement;
  private readonly projectStatistics: TodoistListProjectStatisticsSource;
  private readonly reactRoot: Root;
  private readonly unsubscribeProjectStatistics: () => void;
  private readonly viewWindow: Window;
  private projectStatisticsSnapshot: ProjectSyncStatisticsSnapshot | null;
  private dataAvailable = false;
  private renderQueued = false;
  private unloaded = false;

  public constructor(
    controller: QueryController,
    parentEl: HTMLElement,
    actions: TodoistListActions,
    projectStatistics: TodoistListProjectStatisticsSource,
  ) {
    super(controller);
    this.actions = actions;
    this.projectStatistics = projectStatistics;
    this.projectStatisticsSnapshot = projectStatistics.getSnapshot();
    const ownerDocument = parentEl.ownerDocument;
    this.viewWindow = ownerDocument.defaultView ?? window;
    this.containerEl = ownerDocument.createElement("div");
    this.containerEl.className = "todoist-bases-list-container";
    parentEl.append(this.containerEl);
    this.reactRoot = createRoot(this.containerEl);
    this.unsubscribeProjectStatistics = projectStatistics.subscribe(() => {
      this.projectStatisticsSnapshot = this.projectStatistics.getSnapshot();
      if (this.dataAvailable) {
        this.queueRender();
      }
    });
  }

  public onDataUpdated(): void {
    this.dataAvailable = true;
    this.queueRender();
  }

  private queueRender(): void {
    if (this.renderQueued || this.unloaded) {
      return;
    }
    // Background and unfocused Electron windows may suspend requestAnimationFrame indefinitely.
    // A microtask still coalesces synchronous Base updates without delaying the first render.
    this.renderQueued = true;
    this.viewWindow.queueMicrotask(() => {
      this.renderQueued = false;
      if (this.unloaded) {
        return;
      }
      this.renderCurrentData();
    });
  }

  public override onunload(): void {
    this.unloaded = true;
    this.unsubscribeProjectStatistics();
    this.reactRoot.unmount();
    this.containerEl.remove();
  }

  private renderCurrentData(): void {
    const model = buildTodoistListModel(this.data.groupedData, {
      order: this.config.getOrder(),
      getDisplayName: (propertyId) => this.config.getDisplayName(propertyId),
    });
    const rootProjectId = readRootProjectId(this.config.get(rootProjectConfigKey));
    const projectOverviewCollapsed = this.config.get(projectOverviewCollapsedConfigKey) === true;
    const completionHeatmapRange = readCompletionHeatmapRange(
      this.config.get(completionHeatmapRangeConfigKey),
    );
    const options = this.readOptions();
    const navigation: TodoistListNavigation = {
      openFile: (filePath, newLeaf) => {
        void this.app.workspace.openLinkText(filePath, "", newLeaf);
      },
      hoverFile: (filePath, targetEl, event) => {
        this.app.workspace.trigger("hover-link", {
          event,
          source: TASKS_LIST_VIEW_ID,
          hoverParent: this,
          targetEl,
          linktext: filePath,
        });
      },
    };

    this.reactRoot.render(
      <TodoistList
        actions={this.actions}
        model={model}
        navigation={navigation}
        onProjectOverviewCollapsedChange={(collapsed) =>
          this.config.set(projectOverviewCollapsedConfigKey, collapsed)
        }
        completionHeatmapRange={completionHeatmapRange}
        onCompletionHeatmapRangeChange={(range) =>
          this.config.set(completionHeatmapRangeConfigKey, range)
        }
        options={options}
        projectOverviewCollapsed={projectOverviewCollapsed}
        projectSyncConfigured={this.projectStatistics.isConfigured()}
        projectSyncStatus={this.projectStatistics.getStatus()}
        projectStatisticsSnapshot={this.projectStatisticsSnapshot}
        rootProjectId={rootProjectId}
      />,
    );
  }

  private readOptions(): TodoistListViewOptions {
    const density = this.config.get(densityConfigKey);
    return {
      density: density === "compact" ? "compact" : "comfortable",
      showDescriptions: this.config.get(showDescriptionsConfigKey) !== false,
      showSections: this.config.get(showSectionsConfigKey) !== false,
    };
  }
}

const readOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const readRootProjectId = (value: unknown): string | null => {
  const projectId = readOptionalString(value);
  return projectId === allSynchronizedProjectsValue ? null : projectId;
};

const buildRootProjectDropdownOptions = (
  projectStatistics: TodoistListProjectStatisticsSource,
  config?: BasesViewConfig,
): Record<string, string> => {
  const options: Record<string, string> = {
    [allSynchronizedProjectsValue]: "All synchronized projects",
  };
  const projects = collectRootProjectOptions(projectStatistics);
  for (const project of projects) {
    options[project.id] = project.pathNames.join(" / ");
  }

  const selectedProjectId =
    config === undefined ? null : readRootProjectId(config.get(rootProjectConfigKey));
  if (selectedProjectId !== null && options[selectedProjectId] === undefined) {
    options[selectedProjectId] = `Unavailable project (${selectedProjectId})`;
  }
  return options;
};

const collectRootProjectOptions = (
  projectStatistics: TodoistListProjectStatisticsSource,
): TodoistListProjectOption[] => {
  const liveProjects = [...projectStatistics.getProjects()];
  const snapshot = projectStatistics.getSnapshot();
  if (snapshot !== null) {
    const liveById = new Map(liveProjects.map((project) => [project.id, project]));
    const result: TodoistListProjectOption[] = [];
    const seen = new Set<string>();
    for (const scope of snapshot.scopes) {
      const scopeById = new Map(scope.projects.map((project) => [project.id, project]));
      for (const project of scope.projects) {
        if (seen.has(project.id)) {
          continue;
        }
        seen.add(project.id);
        const pathNames = resolveProjectPathNames(project.id, liveById, scopeById);
        result.push({
          id: project.id,
          scopeKey: project.id,
          name: project.name,
          pathIds: [],
          pathNames: pathNames.length > 0 ? pathNames : [project.name],
        });
      }
    }
    return result;
  }

  const configured = projectStatistics.getConfig().mappings;
  const liveById = new Map(liveProjects.map((project) => [project.id, project]));
  const result: TodoistListProjectOption[] = [];
  const seen = new Set<string>();
  for (const mapping of configured) {
    const configuredProject = mapping.project;
    if (configuredProject === null) {
      continue;
    }
    const root = liveById.get(configuredProject.projectId);
    const selected =
      root === undefined
        ? []
        : selectProjectHierarchy(liveProjects, root.id, mapping.includeSubprojects);
    const candidates =
      selected.length > 0
        ? selected
        : [{ id: configuredProject.projectId, name: configuredProject.projectName }];
    for (const project of candidates) {
      if (seen.has(project.id)) {
        continue;
      }
      seen.add(project.id);
      const pathNames = resolveProjectPathNames(project.id, liveById);
      result.push({
        id: project.id,
        scopeKey: project.id,
        name: project.name,
        pathIds: [],
        pathNames: pathNames.length > 0 ? pathNames : [project.name],
      });
    }
  }
  return result;
};

type ProjectPathNode = { id: string; name: string; parentId: string | null };

const resolveProjectPathNames = (
  projectId: string,
  primary: ReadonlyMap<string, ProjectPathNode>,
  fallback: ReadonlyMap<string, ProjectPathNode> = new Map(),
): string[] => {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = primary.get(projectId) ?? fallback.get(projectId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current.name);
    current =
      current.parentId === null
        ? undefined
        : (primary.get(current.parentId) ?? fallback.get(current.parentId));
  }
  return path.reverse();
};

const readCompletionHeatmapRange = (value: unknown): CompletionHeatmapRange =>
  isCompletionHeatmapRange(value) ? value : defaultCompletionHeatmapRange;
