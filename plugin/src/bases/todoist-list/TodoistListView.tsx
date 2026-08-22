import {
  type BasesAllOptions,
  BasesView,
  type BasesViewConfig,
  type BasesViewRegistration,
  type HoverParent,
  type HoverPopover,
  type QueryController,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import { selectProjectHierarchy } from "@/project-sync";

import { type CompletionHeatmapRange, isCompletionHeatmapRange } from "./completionHeatmapModel";
import { buildTodoistListModel } from "./model";
import { TodoistList } from "./TodoistList";
import type {
  TodoistListActions,
  TodoistListNavigation,
  TodoistListProjectContext,
  TodoistListProjectContextSource,
  TodoistListProjectOption,
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
  projectContext: TodoistListProjectContextSource,
  config?: BasesViewConfig,
): BasesAllOptions[] => [
  {
    type: "group",
    displayName: "Project scope",
    items: [
      {
        type: "dropdown",
        key: rootProjectConfigKey,
        displayName: "Root project",
        default: allSynchronizedProjectsValue,
        options: buildRootProjectDropdownOptions(projectContext, config),
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
  projectContext: TodoistListProjectContextSource,
): BasesViewRegistration => ({
  name: TASKS_LIST_VIEW_NAME,
  icon: "lucide-list-tree",
  factory: (controller, containerEl) =>
    new TasksListView(controller, containerEl, actions, projectContext),
  // Obsidian 1.11.4 declares this callback without an argument, while newer API declarations pass
  // the current view config. An optional argument supports both and lets us preserve an unavailable
  // saved selection in newer Obsidian versions.
  options: (config: BasesViewConfig) => tasksListViewOptions(projectContext, config),
});

export class TasksListView extends BasesView implements HoverParent {
  public readonly type = TASKS_LIST_VIEW_ID;
  public hoverPopover: HoverPopover | null = null;

  private readonly actions: TodoistListActions;
  private readonly containerEl: HTMLDivElement;
  private readonly projectContext: TodoistListProjectContextSource;
  private readonly reactRoot: Root;
  private readonly unsubscribeProjectContext: () => void;
  private readonly viewWindow: Window;
  private dataAvailable = false;
  private renderQueued = false;
  private unloaded = false;

  public constructor(
    controller: QueryController,
    parentEl: HTMLElement,
    actions: TodoistListActions,
    projectContext: TodoistListProjectContextSource,
  ) {
    super(controller);
    this.actions = actions;
    this.projectContext = projectContext;
    this.viewWindow = parentEl.ownerDocument.defaultView ?? window;
    this.containerEl = parentEl.createDiv({ cls: "todoist-bases-list-container" });
    this.reactRoot = createRoot(this.containerEl);
    this.unsubscribeProjectContext = projectContext.subscribeContext(() => {
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
    this.unsubscribeProjectContext();
    this.reactRoot.unmount();
    this.containerEl.remove();
  }

  private renderCurrentData(): void {
    const projectContext = this.projectContext.getContext();
    const model = buildTodoistListModel(this.data.groupedData, {
      order: this.config.getOrder(),
      getDisplayName: (propertyId) => this.config.getDisplayName(propertyId),
      projectContext,
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
        layoutContainerEl={this.containerEl}
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
        rootProjectOptions={collectRootProjectOptions(this.projectContext, projectContext)}
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
  projectContext: TodoistListProjectContextSource,
  config?: BasesViewConfig,
): Record<string, string> => {
  const options: Record<string, string> = {
    [allSynchronizedProjectsValue]: "All synchronized projects",
  };
  const projects = collectRootProjectOptions(projectContext);
  for (const project of projects) {
    options[project.id] = project.pathNames.join(" / ");
  }

  const selectedProjectId =
    config === undefined || typeof config.get !== "function"
      ? null
      : readRootProjectId(config.get(rootProjectConfigKey));
  if (selectedProjectId !== null && options[selectedProjectId] === undefined) {
    options[selectedProjectId] = `Unavailable project (${selectedProjectId})`;
  }
  return options;
};

const collectRootProjectOptions = (
  projectContext: TodoistListProjectContextSource,
  currentContext: TodoistListProjectContext | null = projectContext.getContext(),
): TodoistListProjectOption[] => {
  const liveProjects = [...projectContext.getProjects()];
  if (currentContext !== null) {
    const liveById = new Map(liveProjects.map((project) => [project.id, project]));
    const result: TodoistListProjectOption[] = [];
    const seen = new Set<string>();
    for (const scope of currentContext.scopes) {
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

  const configured = projectContext.getConfig().mappings;
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
