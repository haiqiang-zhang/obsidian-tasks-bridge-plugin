import type React from "react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProjectSyncStatisticsSnapshot, ProjectSyncStatus } from "@/project-sync";
import { ObsidianIcon, ObsidianLoadingIcon } from "@/ui/components/obsidian-icon";

import type { CompletionHeatmapRange } from "./completionHeatmapModel";
import { scopeTodoistListGroups } from "./model";
import { ProjectOverview } from "./ProjectOverview";
import type { ProjectOverviewNode } from "./projectOverviewModel";
import { buildProjectOverviewModel } from "./projectOverviewModel";
import type {
  TodoistListActions,
  TodoistListCounts,
  TodoistListGroup,
  TodoistListMetadata,
  TodoistListModel,
  TodoistListNavigation,
  TodoistListProject,
  TodoistListProjectItem,
  TodoistListProjectOption,
  TodoistListSection,
  TodoistListTaskNode,
  TodoistListTaskRecord,
  TodoistListViewOptions,
} from "./types";

const readinessRefreshIntervalMs = 1000;
const percentageScale = 100;

export type TodoistListProps = {
  model: TodoistListModel;
  rootProjectId: string | null;
  options: TodoistListViewOptions;
  actions: TodoistListActions;
  navigation: TodoistListNavigation;
  projectStatisticsSnapshot: ProjectSyncStatisticsSnapshot | null;
  projectSyncConfigured: boolean;
  projectSyncStatus: ProjectSyncStatus;
  projectOverviewCollapsed: boolean;
  completionHeatmapRange: CompletionHeatmapRange;
  onProjectOverviewCollapsedChange: (collapsed: boolean) => void;
  onCompletionHeatmapRangeChange: (range: CompletionHeatmapRange) => void;
};

export const TodoistList: React.FC<TodoistListProps> = ({
  model,
  rootProjectId,
  options,
  actions,
  navigation,
  projectStatisticsSnapshot,
  projectSyncConfigured,
  projectSyncStatus,
  projectOverviewCollapsed,
  completionHeatmapRange,
  onProjectOverviewCollapsedChange,
  onCompletionHeatmapRangeChange,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(() => new Set());
  const [expandedProjectTasks, setExpandedProjectTasks] = useState<Set<string>>(() => new Set());
  const [overviewCollapsed, setOverviewCollapsed] = useState(projectOverviewCollapsed);
  const [heatmapRange, setHeatmapRange] = useState(completionHeatmapRange);
  const [ready, setReady] = useState(() => readReady(actions));

  useEffect(() => setOverviewCollapsed(projectOverviewCollapsed), [projectOverviewCollapsed]);
  useEffect(() => setHeatmapRange(completionHeatmapRange), [completionHeatmapRange]);
  useEffect(() => {
    const refresh = () => setReady(readReady(actions));
    refresh();
    const ownerWindow = listRef.current?.ownerDocument.defaultView ?? window;
    const interval = ownerWindow.setInterval(refresh, readinessRefreshIntervalMs);
    return () => ownerWindow.clearInterval(interval);
  }, [actions]);

  const projectOverviewModel = useMemo(
    () => buildProjectOverviewModel(projectStatisticsSnapshot, rootProjectId),
    [projectStatisticsSnapshot, rootProjectId],
  );
  const projectStatisticsByScopeKey = useMemo(
    () => indexProjectStatistics(projectOverviewModel?.roots ?? []),
    [projectOverviewModel],
  );
  const projectOptions = useMemo(
    () => mergeProjectOptions(projectOverviewModel?.projectOptions ?? [], model.projects),
    [projectOverviewModel, model.projects],
  );
  const rootAvailable =
    rootProjectId === null || projectOptions.some((project) => project.id === rootProjectId);
  const projectOverviewScopeLabel =
    rootProjectId === null
      ? "All synchronized projects"
      : (projectOptions.find((project) => project.id === rootProjectId)?.pathNames.join(" / ") ??
        "Selected root project");
  const scopedGroups = useMemo(
    () => scopeTodoistListGroups(model.groups, rootProjectId),
    [model.groups, rootProjectId],
  );
  const scopedCounts = useMemo(
    () =>
      scopedGroups.reduce<TodoistListCounts>(
        (counts, group) => ({
          active: counts.active + group.counts.active,
          completed: counts.completed + group.counts.completed,
          unavailable: counts.unavailable + group.counts.unavailable,
        }),
        { active: 0, completed: 0, unavailable: 0 },
      ),
    [scopedGroups],
  );

  const changeOverviewCollapsed = (nextCollapsed: boolean) => {
    setOverviewCollapsed(nextCollapsed);
    onProjectOverviewCollapsedChange(nextCollapsed);
  };

  const changeHeatmapRange = (nextRange: CompletionHeatmapRange) => {
    setHeatmapRange(nextRange);
    onCompletionHeatmapRangeChange(nextRange);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsedBranches((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleProjectTasks = (key: string) => {
    setExpandedProjectTasks((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const collapseAll = () => setExpandedProjectTasks(new Set());
  const expandAll = () => {
    setExpandedProjectTasks(collectProjectContentKeys(scopedGroups, options.showSections));
    setCollapsedBranches(new Set());
  };
  const scopedTaskCount = countTotal(scopedCounts);
  const hasScopedProjects = scopedGroups.some((group) => group.projects.length > 0);
  const diagnosticsMessage = makeDiagnosticsMessage(model);

  return (
    <div className="todoist-bases-list" data-density={options.density} ref={listRef}>
      <div className="todoist-bases-list-toolbar">
        <output
          className="todoist-bases-list-toolbar-summary"
          aria-label={`Visible in Base: ${countsLabel(scopedCounts)}`}
        >
          <span className="todoist-bases-list-toolbar-summary-label">Visible in Base</span>
          <span aria-hidden="true">·</span>
          <span>{scopedCounts.active} active</span>
          <span aria-hidden="true">·</span>
          <span>{scopedCounts.completed} completed</span>
          {scopedCounts.unavailable > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{scopedCounts.unavailable} unavailable</span>
            </>
          )}
        </output>
        <div className="todoist-bases-list-toolbar-actions">
          <button
            aria-label="Expand all project tasks"
            className="clickable-icon"
            onClick={expandAll}
            title="Expand all"
            type="button"
          >
            <ObsidianIcon id="lucide-chevrons-down" size="s" />
          </button>
          <button
            aria-label="Collapse all project tasks"
            className="clickable-icon"
            onClick={collapseAll}
            title="Collapse all"
            type="button"
          >
            <ObsidianIcon id="lucide-chevrons-up" size="s" />
          </button>
        </div>
      </div>

      <ProjectOverview
        collapsed={overviewCollapsed}
        completionHeatmapRange={heatmapRange}
        configured={projectSyncConfigured}
        model={projectOverviewModel}
        onCollapsedChange={changeOverviewCollapsed}
        onCompletionHeatmapRangeChange={changeHeatmapRange}
        scopeLabel={projectOverviewScopeLabel}
        status={projectSyncStatus}
      />

      {!rootAvailable && (
        <output className="todoist-bases-list-notice">
          <ObsidianIcon id="lucide-circle-alert" size="s" />
          <span>
            The selected root project is no longer available. Open Configure view and choose another
            Root project.
          </span>
        </output>
      )}

      {diagnosticsMessage !== null && (
        <output className="todoist-bases-list-notice">
          <ObsidianIcon id="lucide-info" size="s" />
          <span>{diagnosticsMessage}</span>
        </output>
      )}

      {!hasScopedProjects && model.taskCount === 0 && <EmptyState model={model} />}
      {!hasScopedProjects && model.taskCount > 0 && scopedTaskCount === 0 && (
        <div className="todoist-bases-list-empty">
          <ObsidianIcon id="lucide-list-filter" size="xl" />
          <strong>No tasks under this project match the Base filters.</strong>
          <span>
            Open Configure view to choose another Root project, or adjust the Base filters.
          </span>
        </div>
      )}
      {hasScopedProjects && (
        <div className="todoist-bases-list-groups">
          {scopedGroups.map((group) => (
            <GroupBranch
              actions={actions}
              collapsed={collapsedBranches}
              expandedProjectTasks={expandedProjectTasks}
              group={group}
              key={group.key}
              navigation={navigation}
              options={options}
              projectStatistics={projectStatisticsByScopeKey}
              ready={ready}
              rootIsSelected={rootProjectId !== null}
              toggleCollapsed={toggleCollapsed}
              toggleProjectTasks={toggleProjectTasks}
            />
          ))}
        </div>
      )}
    </div>
  );
};

type BranchProps = {
  actions: TodoistListActions;
  collapsed: ReadonlySet<string>;
  navigation: TodoistListNavigation;
  options: TodoistListViewOptions;
  ready: boolean;
  toggleCollapsed: (key: string) => void;
};

type ProjectContentProps = {
  expandedProjectTasks: ReadonlySet<string>;
  projectStatistics: ReadonlyMap<string, ProjectOverviewNode>;
  toggleProjectTasks: (key: string) => void;
};

const GroupBranch: React.FC<
  BranchProps &
    ProjectContentProps & {
      group: TodoistListGroup;
      rootIsSelected: boolean;
    }
> = ({ group, rootIsSelected, ...props }) => {
  if (group.projects.length === 0) {
    return null;
  }
  return (
    <section className="todoist-bases-list-group">
      {group.label !== undefined && (
        <header className="todoist-bases-list-group-header">
          <span>{group.label}</span>
          <span>{countTotal(group.counts)}</span>
        </header>
      )}
      <div className="todoist-bases-list-tree">
        {group.projects.map((project) => (
          <ProjectBranch
            {...props}
            depth={0}
            groupKey={group.key}
            key={project.scopeKey}
            project={project}
            rootIsSelected={rootIsSelected}
          />
        ))}
      </div>
    </section>
  );
};

const ProjectBranch: React.FC<
  BranchProps &
    ProjectContentProps & {
      depth: number;
      groupKey: string;
      project: TodoistListProject;
      rootIsSelected: boolean;
    }
> = ({
  actions,
  collapsed,
  depth,
  expandedProjectTasks,
  groupKey,
  navigation,
  options,
  project,
  projectStatistics,
  ready,
  rootIsSelected,
  toggleCollapsed,
  toggleProjectTasks,
}) => {
  const key = projectContentKey(groupKey, project.scopeKey);
  const taskContentId = `${useId()}-project-task-content`;
  const tasksExpanded = expandedProjectTasks.has(key);
  const childItems = options.showSections ? project.items : project.flatItems;
  const hasOwnContent = childItems.some((item) => item.kind !== "project");
  const visibleItems = childItems.filter((item) => item.kind === "project" || tasksExpanded);
  const taskDepth = depth + 1;
  const childProjectDepth = depth + 1;
  const statistics = projectRowStatistics(project, projectStatistics.get(project.scopeKey));

  return (
    <div
      className="todoist-bases-project"
      data-project-id={project.id}
      data-tasks-expanded={tasksExpanded || undefined}
    >
      <div className="todoist-bases-project-row" style={indentationStyle(depth)}>
        <DisclosureButton
          collapsed={!tasksExpanded}
          controlsId={taskContentId}
          disabled={!hasOwnContent}
          label={`${tasksExpanded ? "Hide" : "Show"} tasks in project ${project.name}`}
          onClick={() => toggleProjectTasks(key)}
        />
        <ObsidianIcon className="todoist-bases-project-icon" id="lucide-folder" size="s" />
        <span className="todoist-bases-project-main">
          <span className="todoist-bases-project-name" title={project.pathNames.join(" / ")}>
            {project.name}
          </span>
          {rootIsSelected && depth === 0 && <span className="todoist-bases-root-badge">Root</span>}
        </span>
        <ProjectRowStatistics name={project.name} statistics={statistics} />
      </div>
      {(hasOwnContent || visibleItems.length > 0) && (
        <div className="todoist-bases-project-children" id={taskContentId}>
          {visibleItems.map((item) => (
            <ProjectItemBranch
              actions={actions}
              collapsed={collapsed}
              expandedProjectTasks={expandedProjectTasks}
              groupKey={groupKey}
              item={item}
              key={projectItemKey(item)}
              navigation={navigation}
              options={options}
              projectStatistics={projectStatistics}
              projectDepth={childProjectDepth}
              projectScopeKey={project.scopeKey}
              ready={ready}
              rootIsSelected={rootIsSelected}
              taskDepth={taskDepth}
              toggleCollapsed={toggleCollapsed}
              toggleProjectTasks={toggleProjectTasks}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ProjectItemBranch: React.FC<
  BranchProps &
    ProjectContentProps & {
      item: TodoistListProjectItem;
      groupKey: string;
      projectDepth: number;
      projectScopeKey: string;
      rootIsSelected: boolean;
      taskDepth: number;
    }
> = ({
  actions,
  collapsed,
  expandedProjectTasks,
  groupKey,
  item,
  navigation,
  options,
  projectDepth,
  projectStatistics,
  projectScopeKey,
  ready,
  rootIsSelected,
  taskDepth,
  toggleCollapsed,
  toggleProjectTasks,
}) => {
  if (item.kind === "project") {
    return (
      <ProjectBranch
        actions={actions}
        collapsed={collapsed}
        depth={projectDepth}
        expandedProjectTasks={expandedProjectTasks}
        groupKey={groupKey}
        navigation={navigation}
        options={options}
        project={item.project}
        projectStatistics={projectStatistics}
        ready={ready}
        rootIsSelected={rootIsSelected}
        toggleCollapsed={toggleCollapsed}
        toggleProjectTasks={toggleProjectTasks}
      />
    );
  }
  if (item.kind === "section") {
    return (
      <SectionBranch
        actions={actions}
        collapsed={collapsed}
        depth={taskDepth}
        groupKey={groupKey}
        navigation={navigation}
        options={options}
        projectScopeKey={projectScopeKey}
        ready={ready}
        section={item.section}
        toggleCollapsed={toggleCollapsed}
      />
    );
  }
  return (
    <TaskBranch
      actions={actions}
      collapsed={collapsed}
      depth={taskDepth}
      groupKey={groupKey}
      navigation={navigation}
      options={options}
      ready={ready}
      task={item.task}
      toggleCollapsed={toggleCollapsed}
    />
  );
};

type ProjectRowStatisticsModel = {
  completed: number;
  rate: number | null;
  total: number;
};

const ProjectRowStatistics: React.FC<{
  name: string;
  statistics: ProjectRowStatisticsModel;
}> = ({ name, statistics }) => {
  if (statistics.rate === null) {
    return (
      <span
        className="todoist-bases-project-statistics"
        data-empty="true"
        title={`${name}: No tasks, including child projects`}
      >
        <span className="todoist-bases-project-statistics-label">No tasks</span>
        <span aria-hidden="true" className="todoist-bases-project-progress" />
      </span>
    );
  }

  const percentage = Math.round(statistics.rate * percentageScale);
  return (
    <span
      className="todoist-bases-project-statistics"
      title={`${name}: ${statistics.completed} of ${statistics.total} tasks completed, ${percentage}%, including child projects`}
    >
      <span aria-hidden="true" className="todoist-bases-project-statistics-label">
        <span>
          {statistics.completed} / {statistics.total} completed
        </span>
        <span className="todoist-bases-project-statistics-separator">·</span>
        <strong>{percentage}%</strong>
      </span>
      <progress
        aria-label={`${name} completion`}
        className="todoist-bases-project-progress"
        max={statistics.total}
        value={statistics.completed}
      />
    </span>
  );
};

const projectItemKey = (item: TodoistListProjectItem): string => {
  if (item.kind === "project") {
    return `project:${item.project.scopeKey}`;
  }
  if (item.kind === "section") {
    return `section:${item.section.key}`;
  }
  return `task:${item.task.scopeKey}`;
};

const SectionBranch: React.FC<
  BranchProps & {
    depth: number;
    groupKey: string;
    projectScopeKey: string;
    section: TodoistListSection;
  }
> = ({
  actions,
  collapsed,
  depth,
  groupKey,
  navigation,
  options,
  projectScopeKey,
  ready,
  section,
  toggleCollapsed,
}) => {
  const key = `${groupKey}:section:${projectScopeKey}:${section.key}`;
  const isCollapsed = collapsed.has(key);
  return (
    <div className="todoist-bases-section">
      <div className="todoist-bases-section-row" style={indentationStyle(depth)}>
        <DisclosureButton
          collapsed={isCollapsed}
          label={`${isCollapsed ? "Expand" : "Collapse"} section ${section.name}`}
          onClick={() => toggleCollapsed(key)}
        />
        <ObsidianIcon id="lucide-gallery-vertical" size="s" />
        <span>{section.name}</span>
        <span className="todoist-bases-section-count">{countTotal(section.counts)}</span>
      </div>
      {!isCollapsed && (
        <div>
          {section.tasks.map((task) => (
            <TaskBranch
              actions={actions}
              collapsed={collapsed}
              depth={depth + 1}
              groupKey={groupKey}
              key={task.scopeKey}
              navigation={navigation}
              options={options}
              ready={ready}
              task={task}
              toggleCollapsed={toggleCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const TaskBranch: React.FC<
  BranchProps & {
    depth: number;
    groupKey: string;
    task: TodoistListTaskNode;
  }
> = ({
  actions,
  collapsed,
  depth,
  groupKey,
  navigation,
  options,
  ready,
  task,
  toggleCollapsed,
}) => {
  const [pending, setPending] = useState<"complete" | "reopen" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectionLock, setProjectionLock] = useState<{
    completed: boolean;
    status: TodoistListTaskRecord["status"];
  } | null>(null);
  const operationToken = useRef(0);
  const completionOperation = useRef<{
    completed: boolean;
    status: TodoistListTaskRecord["status"];
    token: number;
  } | null>(null);
  const key = `${groupKey}:task:${task.scopeKey}`;
  const isCollapsed = collapsed.has(key);
  const hasChildren = task.children.length > 0;
  const awaitingProjection =
    projectionLock !== null &&
    projectionLock.completed === task.completed &&
    projectionLock.status === task.status;
  useEffect(() => {
    const operation = completionOperation.current;
    if (
      operation !== null &&
      (operation.completed !== task.completed || operation.status !== task.status)
    ) {
      operationToken.current++;
      completionOperation.current = null;
      setPending(null);
      setError(null);
      setProjectionLock(null);
      return;
    }

    if (projectionLock !== null && !awaitingProjection) {
      setError(null);
      setProjectionLock(null);
    }
  }, [awaitingProjection, projectionLock, task.completed, task.status]);
  const readOnlyReason = awaitingProjection
    ? "Todoist was updated. Waiting for Project sync before another action."
    : getReadOnlyReason(task, ready);
  const editReadOnlyReason =
    task.status === "completed" ? "Reopen before editing." : readOnlyReason;

  const runCompletionAction = async () => {
    if (readOnlyReason !== null || pending !== null) {
      return;
    }
    const action = task.status === "completed" ? "reopen" : "complete";
    const token = ++operationToken.current;
    const startingProjection = { completed: task.completed, status: task.status };
    completionOperation.current = { ...startingProjection, token };
    setPending(action);
    setError(null);
    try {
      const result =
        action === "reopen" ? await actions.reopenTask(task) : await actions.completeTask(task);
      if (operationToken.current !== token) {
        return;
      }

      setPending(null);
      setProjectionLock(startingProjection);
      void result.projection.catch((caught: unknown) => {
        if (operationToken.current !== token) {
          return;
        }
        console.error(`Failed to project ${action} Todoist task`, caught);
        setError(
          errorMessage(
            caught,
            `Todoist was updated, but Project sync could not refresh this task.`,
          ),
        );
      });
    } catch (caught: unknown) {
      if (operationToken.current !== token) {
        return;
      }
      console.error(`Failed to ${action} Todoist task`, caught);
      if (didRemoteMutationSucceed(caught)) {
        setProjectionLock(startingProjection);
      }
      setError(errorMessage(caught, `Could not ${action} this task.`));
    } finally {
      if (operationToken.current === token) {
        setPending(null);
      }
    }
  };

  const runEditAction = async () => {
    if (editReadOnlyReason !== null || pending !== null) {
      return;
    }
    const token = ++operationToken.current;
    completionOperation.current = null;
    setPending("edit");
    setError(null);
    try {
      await actions.editTask(task);
    } catch (caught: unknown) {
      if (operationToken.current !== token) {
        return;
      }
      console.error("Failed to edit Todoist task", caught);
      setError(errorMessage(caught, "Could not open this task for editing."));
    } finally {
      if (operationToken.current === token) {
        setPending(null);
      }
    }
  };

  const completionLabel =
    task.status === "completed" ? `Reopen task: ${task.content}` : `Complete task: ${task.content}`;

  return (
    <div
      className="todoist-bases-task"
      data-priority={task.priority?.toLocaleLowerCase("en-US")}
      data-status={task.status}
    >
      <div className="todoist-bases-task-row" style={indentationStyle(depth)}>
        <DisclosureButton
          collapsed={isCollapsed}
          disabled={!hasChildren}
          label={`${isCollapsed ? "Expand" : "Collapse"} subtasks for ${task.content}`}
          onClick={() => toggleCollapsed(key)}
        />
        <span
          aria-busy={pending === "complete" || pending === "reopen"}
          className="todoist-bases-task-action-wrap"
          data-loading={pending === "complete" || pending === "reopen" || undefined}
          title={readOnlyReason ?? undefined}
        >
          {pending === "complete" || pending === "reopen" ? (
            <ObsidianLoadingIcon
              aria-label={`${pending === "reopen" ? "Reopening" : "Completing"} task: ${task.content}`}
              role="status"
              size="xs"
            />
          ) : (
            <input
              aria-label={completionLabel}
              checked={task.completed}
              className="todoist-bases-task-checkbox"
              disabled={readOnlyReason !== null}
              onChange={() => void runCompletionAction()}
              type="checkbox"
            />
          )}
        </span>
        <div className="todoist-bases-task-main">
          <div className="todoist-bases-task-primary">
            <FileLink navigation={navigation} task={task} />
            {task.status === "stale" && <StatusBadge label="Stale" />}
            {task.status === "out_of_scope" && <StatusBadge label="Out of scope" />}
            {task.hierarchyWarning !== undefined && (
              <span
                aria-label={
                  task.hierarchyWarning === "cycle"
                    ? "Task hierarchy cycle detected"
                    : "Parent task is not in this view"
                }
                className="todoist-bases-hierarchy-warning"
                role="img"
                title={
                  task.hierarchyWarning === "cycle"
                    ? "Task hierarchy cycle detected"
                    : "Parent task is not in this view"
                }
              >
                <ObsidianIcon id="lucide-triangle-alert" size="xs" />
              </span>
            )}
          </div>
          {options.showDescriptions && task.description !== "" && (
            <div className="todoist-bases-task-description">{task.description}</div>
          )}
          {task.metadata.length > 0 && (
            <div className="todoist-bases-task-metadata">
              {task.metadata.map((metadata) => (
                <MetadataValue key={metadata.propertyId} metadata={metadata} />
              ))}
            </div>
          )}
          {error !== null && (
            <output aria-live="polite" className="todoist-bases-task-error">
              {error}
            </output>
          )}
        </div>
        <div className="todoist-bases-task-actions">
          <span title={editReadOnlyReason ?? undefined}>
            <button
              aria-label={`Edit task: ${task.content}`}
              className="clickable-icon"
              disabled={editReadOnlyReason !== null || pending !== null}
              onClick={() => void runEditAction()}
              title={editReadOnlyReason ?? "Edit task"}
              type="button"
            >
              {pending === "edit" ? (
                <ObsidianLoadingIcon size="s" />
              ) : (
                <ObsidianIcon id="lucide-pencil" size="s" />
              )}
            </button>
          </span>
          {task.url !== undefined && (
            <a
              aria-label={`Open in Todoist: ${task.content}`}
              className="clickable-icon"
              href={task.url}
              rel="noreferrer"
              target="_blank"
              title="Open in Todoist"
            >
              <ObsidianIcon id="lucide-external-link" size="s" />
            </a>
          )}
        </div>
      </div>
      {!isCollapsed && hasChildren && (
        <div>
          {task.children.map((child) => (
            <TaskBranch
              actions={actions}
              collapsed={collapsed}
              depth={depth + 1}
              groupKey={groupKey}
              key={child.scopeKey}
              navigation={navigation}
              options={options}
              ready={ready}
              task={child}
              toggleCollapsed={toggleCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FileLink: React.FC<{
  navigation: TodoistListNavigation;
  task: TodoistListTaskRecord;
}> = ({ navigation, task }) => {
  const open = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    event.preventDefault();
    navigation.openFile(task.filePath, event.metaKey || event.ctrlKey || event.button === 1);
  };
  return (
    <a
      className="internal-link todoist-bases-task-title"
      data-href={task.filePath}
      href={task.filePath}
      onAuxClick={open}
      onClick={open}
      onMouseEnter={(event) =>
        navigation.hoverFile(task.filePath, event.currentTarget, event.nativeEvent)
      }
    >
      {task.content}
    </a>
  );
};

const MetadataValue: React.FC<{ metadata: TodoistListMetadata }> = ({ metadata }) => (
  <span className="todoist-bases-metadata" data-kind={metadata.kind} title={metadata.displayName}>
    {metadata.kind === "date" && <ObsidianIcon id="lucide-calendar" size="xs" />}
    {metadata.kind === "deadline" && <ObsidianIcon id="lucide-target" size="xs" />}
    {metadata.kind === "priority" && <ObsidianIcon id="lucide-flag" size="xs" />}
    {metadata.kind === "project" && <ObsidianIcon id="lucide-hash" size="xs" />}
    {[...new Set(metadata.values)].map((value) => (
      <span key={value}>{value}</span>
    ))}
  </span>
);

const StatusBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="todoist-bases-status-badge">
    <ObsidianIcon id="lucide-circle-alert" size="xs" />
    {label}
  </span>
);

const DisclosureButton: React.FC<{
  collapsed: boolean;
  controlsId?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}> = ({ collapsed, controlsId, disabled = false, label, onClick }) => (
  <button
    aria-controls={disabled ? undefined : controlsId}
    aria-expanded={disabled ? undefined : !collapsed}
    aria-label={label}
    className="clickable-icon todoist-bases-disclosure"
    disabled={disabled}
    onClick={onClick}
    tabIndex={disabled ? -1 : 0}
    type="button"
  >
    {!disabled && (
      <ObsidianIcon id={collapsed ? "lucide-chevron-right" : "lucide-chevron-down"} size="xs" />
    )}
  </button>
);

const EmptyState: React.FC<{ model: TodoistListModel }> = ({ model }) => (
  <div className="todoist-bases-list-empty">
    <ObsidianIcon id="lucide-list-tree" size="xl" />
    <strong>No Todoist Project Sync tasks were found in this Base.</strong>
    <span>
      {model.diagnostics.ignoredNonManaged > 0
        ? `${model.diagnostics.ignoredNonManaged} non-managed notes were ignored.`
        : "Add Project Sync notes or adjust the Base filters."}
    </span>
  </div>
);

const getReadOnlyReason = (task: TodoistListTaskRecord, ready: boolean): string | null => {
  if (task.status === "stale") {
    return "Stale tasks are read-only.";
  }
  if (task.status === "out_of_scope") {
    return "Out-of-scope tasks are read-only.";
  }
  if (!ready) {
    return "Todoist is not ready. This task is read-only.";
  }
  return null;
};

const readReady = (actions: TodoistListActions): boolean => {
  try {
    return actions.isReady();
  } catch {
    return false;
  }
};

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error && caught.message.trim() !== "" ? caught.message : fallback;

const didRemoteMutationSucceed = (caught: unknown): boolean =>
  typeof caught === "object" &&
  caught !== null &&
  "remoteMutationSucceeded" in caught &&
  caught.remoteMutationSucceeded === true;

const countTotal = (counts: TodoistListCounts): number =>
  counts.active + counts.completed + counts.unavailable;

const countsLabel = (counts: TodoistListCounts): string =>
  `${counts.active} active, ${counts.completed} completed, ${counts.unavailable} unavailable`;

const makeDiagnosticsMessage = (model: TodoistListModel): string | null => {
  const messages: string[] = [];
  if (model.diagnostics.ignoredNonManaged > 0) {
    messages.push(
      `${model.diagnostics.ignoredNonManaged} non-managed ${pluralize("note", model.diagnostics.ignoredNonManaged)} ignored`,
    );
  }
  if (model.diagnostics.ignoredDuplicateTaskNotes > 0) {
    messages.push(
      `${model.diagnostics.ignoredDuplicateTaskNotes} duplicate Todoist task ${pluralize("note", model.diagnostics.ignoredDuplicateTaskNotes)} ignored`,
    );
  }
  if (model.diagnostics.ignoredInvalid > 0) {
    messages.push(
      `${model.diagnostics.ignoredInvalid} invalid Todoist ${pluralize("note", model.diagnostics.ignoredInvalid)} ignored`,
    );
  }
  if (model.diagnostics.hierarchyWarnings > 0) {
    messages.push(
      `${model.diagnostics.hierarchyWarnings} hierarchy ${pluralize("warning", model.diagnostics.hierarchyWarnings)}`,
    );
  }
  return messages.length === 0 ? null : `${messages.join("; ")}.`;
};

const pluralize = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

const mergeProjectOptions = (
  snapshotProjects: readonly TodoistListProjectOption[],
  baseProjects: readonly TodoistListProjectOption[],
): TodoistListProjectOption[] => {
  const merged: TodoistListProjectOption[] = [];
  const seen = new Set<string>();
  for (const project of [...snapshotProjects, ...baseProjects]) {
    if (seen.has(project.scopeKey)) {
      continue;
    }
    seen.add(project.scopeKey);
    merged.push(project);
  }
  return merged;
};

const indexProjectStatistics = (
  roots: readonly ProjectOverviewNode[],
): Map<string, ProjectOverviewNode> => {
  const result = new Map<string, ProjectOverviewNode>();
  const visit = (project: ProjectOverviewNode): void => {
    result.set(project.scopeKey, project);
    for (const child of project.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return result;
};

const projectRowStatistics = (
  project: TodoistListProject,
  snapshot: ProjectOverviewNode | undefined,
): ProjectRowStatisticsModel => {
  if (snapshot !== undefined) {
    return {
      completed: snapshot.counts.completed,
      rate: snapshot.completionRate,
      total: snapshot.taskCount,
    };
  }

  const total = project.counts.active + project.counts.completed;
  return {
    completed: project.counts.completed,
    rate: total === 0 ? null : project.counts.completed / total,
    total,
  };
};

const indentationStyle = (depth: number): CSSProperties =>
  ({ "--todoist-bases-depth": Math.max(0, depth) }) as CSSProperties;

const projectContentKey = (groupKey: string, projectScopeKey: string): string =>
  `${groupKey}:project-content:${projectScopeKey}`;

const collectProjectContentKeys = (
  groups: readonly TodoistListGroup[],
  showSections: boolean,
): Set<string> => {
  const keys = new Set<string>();
  const collectProjects = (groupKey: string, projects: readonly TodoistListProject[]) => {
    for (const project of projects) {
      const items = showSections ? project.items : project.flatItems;
      if (items.some((item) => item.kind !== "project")) {
        keys.add(projectContentKey(groupKey, project.scopeKey));
      }
      collectProjects(groupKey, project.projects);
    }
  };
  for (const group of groups) {
    collectProjects(group.key, group.projects);
  }
  return keys;
};
