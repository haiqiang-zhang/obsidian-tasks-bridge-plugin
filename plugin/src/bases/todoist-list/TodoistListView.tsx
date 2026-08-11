import {
  BasesView,
  type BasesViewRegistration,
  type HoverParent,
  type HoverPopover,
  type QueryController,
  type ViewOption,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";

import { type CompletionHeatmapRange, isCompletionHeatmapRange } from "./completionHeatmapModel";
import { buildTodoistListModel } from "./model";
import { TodoistList } from "./TodoistList";
import type {
  TodoistListActions,
  TodoistListNavigation,
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

export const tasksListViewOptions = (): ViewOption[] => [
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
];

export const createTasksListViewRegistration = (
  actions: TodoistListActions,
  projectStatistics: TodoistListProjectStatisticsSource,
): BasesViewRegistration => ({
  name: TASKS_LIST_VIEW_NAME,
  icon: "lucide-list-tree",
  factory: (controller, containerEl) =>
    new TasksListView(controller, containerEl, actions, projectStatistics),
  options: tasksListViewOptions,
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
    const rootProjectId = readOptionalString(this.config.get(rootProjectConfigKey));
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
        onRootProjectChange={(projectId) => this.config.set(rootProjectConfigKey, projectId)}
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

const readCompletionHeatmapRange = (value: unknown): CompletionHeatmapRange =>
  isCompletionHeatmapRange(value) ? value : defaultCompletionHeatmapRange;
