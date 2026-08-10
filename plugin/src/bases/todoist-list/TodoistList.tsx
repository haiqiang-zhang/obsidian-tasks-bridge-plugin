import type React from "react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProjectSyncStatisticsSnapshot, ProjectSyncStatus } from "@/project-sync";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";

import { scopeTodoistListGroups } from "./model";
import { ProjectOverview } from "./ProjectOverview";
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
  onProjectOverviewCollapsedChange: (collapsed: boolean) => void;
  onRootProjectChange: (projectId: string | null) => void;
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
  onProjectOverviewCollapsedChange,
  onRootProjectChange,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedRoot, setSelectedRoot] = useState(rootProjectId);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [overviewCollapsed, setOverviewCollapsed] = useState(projectOverviewCollapsed);
  const [ready, setReady] = useState(() => readReady(actions));

  useEffect(() => setSelectedRoot(rootProjectId), [rootProjectId]);
  useEffect(() => setOverviewCollapsed(projectOverviewCollapsed), [projectOverviewCollapsed]);
  useEffect(() => {
    const refresh = () => setReady(readReady(actions));
    refresh();
    const ownerWindow = listRef.current?.ownerDocument.defaultView ?? window;
    const interval = ownerWindow.setInterval(refresh, readinessRefreshIntervalMs);
    return () => ownerWindow.clearInterval(interval);
  }, [actions]);

  const projectOverviewModel = useMemo(
    () => buildProjectOverviewModel(projectStatisticsSnapshot, selectedRoot),
    [projectStatisticsSnapshot, selectedRoot],
  );
  const projectOptions = useMemo(
    () => mergeProjectOptions(projectOverviewModel?.projectOptions ?? [], model.projects),
    [projectOverviewModel, model.projects],
  );
  const rootAvailable =
    selectedRoot === null || projectOptions.some((project) => project.id === selectedRoot);
  const projectOverviewScopeLabel =
    selectedRoot === null
      ? "All synchronized projects"
      : (projectOptions.find((project) => project.id === selectedRoot)?.pathNames.join(" / ") ??
        "Selected root project");
  const scopedGroups = useMemo(
    () => scopeTodoistListGroups(model.groups, selectedRoot),
    [model.groups, selectedRoot],
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

  const selectRoot = (projectId: string | null) => {
    setSelectedRoot(projectId);
    setCollapsed(new Set());
    onRootProjectChange(projectId);
  };

  const changeOverviewCollapsed = (nextCollapsed: boolean) => {
    setOverviewCollapsed(nextCollapsed);
    onProjectOverviewCollapsedChange(nextCollapsed);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const collapseAll = () => setCollapsed(collectBranchKeys(scopedGroups, options.showSections));
  const expandAll = () => setCollapsed(new Set());
  const scopedTaskCount = countTotal(scopedCounts);
  const diagnosticsMessage = makeDiagnosticsMessage(model);

  return (
    <div className="todoist-bases-list" data-density={options.density} ref={listRef}>
      <div className="todoist-bases-list-toolbar">
        <RootPicker projects={projectOptions} selected={selectedRoot} onChange={selectRoot} />
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
            aria-label="Expand all Todoist projects and tasks"
            className="clickable-icon"
            onClick={expandAll}
            title="Expand all"
            type="button"
          >
            <ObsidianIcon id="lucide-chevrons-down" size="s" />
          </button>
          <button
            aria-label="Collapse all Todoist projects and tasks"
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
        configured={projectSyncConfigured}
        model={projectOverviewModel}
        onCollapsedChange={changeOverviewCollapsed}
        scopeLabel={projectOverviewScopeLabel}
        status={projectSyncStatus}
      />

      {!rootAvailable && (
        <output className="todoist-bases-list-notice">
          <ObsidianIcon id="lucide-circle-alert" size="s" />
          <span>The selected root project is no longer available.</span>
          <button className="mod-cta" onClick={() => selectRoot(null)} type="button">
            Reset root
          </button>
        </output>
      )}

      {diagnosticsMessage !== null && (
        <output className="todoist-bases-list-notice">
          <ObsidianIcon id="lucide-info" size="s" />
          <span>{diagnosticsMessage}</span>
        </output>
      )}

      {model.taskCount === 0 && <EmptyState model={model} />}
      {model.taskCount > 0 && scopedTaskCount === 0 && (
        <div className="todoist-bases-list-empty">
          <ObsidianIcon id="lucide-list-filter" size="xl" />
          <strong>No tasks under this project match the Base filters.</strong>
          <span>Choose another root project or adjust the Base filters.</span>
        </div>
      )}
      {model.taskCount > 0 && scopedTaskCount > 0 && (
        <div className="todoist-bases-list-groups">
          {scopedGroups.map((group) => (
            <GroupBranch
              actions={actions}
              collapsed={collapsed}
              group={group}
              key={group.key}
              navigation={navigation}
              options={options}
              ready={ready}
              rootIsSelected={selectedRoot !== null}
              toggleCollapsed={toggleCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const RootPicker: React.FC<{
  projects: TodoistListProjectOption[];
  selected: string | null;
  onChange: (projectId: string | null) => void;
}> = ({ projects, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedProject = projects.find((project) => project.id === selected);
  const selectedLabel =
    selected === null
      ? "All projects"
      : (selectedProject?.pathNames.join(" / ") ?? "Unavailable project");
  const query = search.trim().toLocaleLowerCase("en-US");
  const filtered = projects.filter((project) =>
    project.pathNames.join(" / ").toLocaleLowerCase("en-US").includes(query),
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    searchRef.current?.focus();
    const ownerDocument = containerRef.current?.ownerDocument;
    const ownerNode = ownerDocument?.defaultView?.Node;
    if (ownerDocument === undefined || ownerNode === undefined) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof ownerNode && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    ownerDocument.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => ownerDocument.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const choose = (projectId: string | null) => {
    triggerRef.current?.focus();
    onChange(projectId);
    setOpen(false);
    setSearch("");
  };

  return (
    <div className="todoist-bases-root-picker" ref={containerRef}>
      <button
        aria-label={`Root: ${selectedLabel}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="todoist-bases-root-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <ObsidianIcon id="lucide-git-fork" size="s" />
        <span className="todoist-bases-root-picker-label">Root</span>
        <span className="todoist-bases-root-picker-value">{selectedLabel}</span>
        <ObsidianIcon id="lucide-chevron-down" size="s" />
      </button>
      {open && (
        <div
          aria-label="Choose a root project"
          className="todoist-bases-root-picker-popover"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              setSearch("");
              triggerRef.current?.focus();
            }
          }}
          role="dialog"
        >
          <div className="search-input-container">
            <input
              aria-label="Search projects"
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search projects"
              ref={searchRef}
              type="search"
              value={search}
            />
          </div>
          <div className="todoist-bases-root-options">
            {query === "" && (
              <RootOption
                depth={0}
                label="All projects"
                onClick={() => choose(null)}
                selected={selected === null}
              />
            )}
            {filtered.map((project) => (
              <RootOption
                depth={project.pathIds.length - 1}
                key={project.id}
                label={project.name}
                onClick={() => choose(project.id)}
                path={project.pathNames.join(" / ")}
                selected={selected === project.id}
              />
            ))}
            {filtered.length === 0 && query !== "" && (
              <div className="todoist-bases-root-no-results">No projects found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const RootOption: React.FC<{
  depth: number;
  label: string;
  path?: string;
  selected: boolean;
  onClick: () => void;
}> = ({ depth, label, path, selected, onClick }) => (
  <button
    aria-current={selected ? "true" : undefined}
    aria-label={path ?? label}
    className="todoist-bases-root-option"
    onClick={onClick}
    style={indentationStyle(depth)}
    type="button"
  >
    <ObsidianIcon id={selected ? "lucide-check" : "lucide-folder"} size="s" />
    <span>{label}</span>
  </button>
);

type BranchProps = {
  actions: TodoistListActions;
  collapsed: ReadonlySet<string>;
  navigation: TodoistListNavigation;
  options: TodoistListViewOptions;
  ready: boolean;
  toggleCollapsed: (key: string) => void;
};

const GroupBranch: React.FC<
  BranchProps & {
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
            key={project.id}
            project={project}
            rootIsSelected={rootIsSelected}
          />
        ))}
      </div>
    </section>
  );
};

const ProjectBranch: React.FC<
  BranchProps & {
    depth: number;
    groupKey: string;
    project: TodoistListProject;
    rootIsSelected: boolean;
  }
> = ({
  actions,
  collapsed,
  depth,
  groupKey,
  navigation,
  options,
  project,
  ready,
  rootIsSelected,
  toggleCollapsed,
}) => {
  const key = `${groupKey}:project:${project.id}`;
  const isCollapsed = collapsed.has(key);
  const childItems = options.showSections ? project.items : project.flatItems;
  const hasChildren = childItems.length > 0;
  const taskDepth = depth + 1;
  const childProjectDepth = depth + 1;

  return (
    <div className="todoist-bases-project" data-project-id={project.id}>
      <div className="todoist-bases-project-row" style={indentationStyle(depth)}>
        <DisclosureButton
          collapsed={isCollapsed}
          disabled={!hasChildren}
          label={`${isCollapsed ? "Expand" : "Collapse"} project ${project.name}`}
          onClick={() => toggleCollapsed(key)}
        />
        <ObsidianIcon className="todoist-bases-project-icon" id="lucide-folder" size="s" />
        <span className="todoist-bases-project-name">{project.name}</span>
        {rootIsSelected && depth === 0 && <span className="todoist-bases-root-badge">Root</span>}
        <span className="todoist-bases-project-count" title={countsLabel(project.counts)}>
          {project.counts.active} / {countTotal(project.counts)}
        </span>
      </div>
      {!isCollapsed && hasChildren && (
        <div className="todoist-bases-project-children">
          {childItems.map((item) => (
            <ProjectItemBranch
              actions={actions}
              collapsed={collapsed}
              groupKey={groupKey}
              item={item}
              key={projectItemKey(item)}
              navigation={navigation}
              options={options}
              projectDepth={childProjectDepth}
              projectId={project.id}
              ready={ready}
              rootIsSelected={rootIsSelected}
              taskDepth={taskDepth}
              toggleCollapsed={toggleCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ProjectItemBranch: React.FC<
  BranchProps & {
    item: TodoistListProjectItem;
    groupKey: string;
    projectDepth: number;
    projectId: string;
    rootIsSelected: boolean;
    taskDepth: number;
  }
> = ({
  actions,
  collapsed,
  groupKey,
  item,
  navigation,
  options,
  projectDepth,
  projectId,
  ready,
  rootIsSelected,
  taskDepth,
  toggleCollapsed,
}) => {
  if (item.kind === "project") {
    return (
      <ProjectBranch
        actions={actions}
        collapsed={collapsed}
        depth={projectDepth}
        groupKey={groupKey}
        navigation={navigation}
        options={options}
        project={item.project}
        ready={ready}
        rootIsSelected={rootIsSelected}
        toggleCollapsed={toggleCollapsed}
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
        projectId={projectId}
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

const projectItemKey = (item: TodoistListProjectItem): string => {
  if (item.kind === "project") {
    return `project:${item.project.id}`;
  }
  if (item.kind === "section") {
    return `section:${item.section.key}`;
  }
  return `task:${item.task.id}`;
};

const SectionBranch: React.FC<
  BranchProps & {
    depth: number;
    groupKey: string;
    projectId: string;
    section: TodoistListSection;
  }
> = ({
  actions,
  collapsed,
  depth,
  groupKey,
  navigation,
  options,
  projectId,
  ready,
  section,
  toggleCollapsed,
}) => {
  const key = `${groupKey}:section:${projectId}:${section.key}`;
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
              key={task.id}
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
  const key = `${groupKey}:task:${task.id}`;
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
          className="todoist-bases-task-action-wrap"
          data-loading={pending === "complete" || pending === "reopen" || undefined}
          title={readOnlyReason ?? undefined}
        >
          <input
            aria-label={completionLabel}
            checked={task.completed}
            className="todoist-bases-task-checkbox"
            disabled={readOnlyReason !== null || pending !== null}
            onChange={() => void runCompletionAction()}
            type="checkbox"
          />
          {(pending === "complete" || pending === "reopen") && (
            <ObsidianIcon className="is-loading" id="lucide-loader-circle" size="xs" />
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
              <ObsidianIcon
                className={pending === "edit" ? "is-loading" : undefined}
                id={pending === "edit" ? "lucide-loader-circle" : "lucide-pencil"}
                size="s"
              />
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
              key={child.id}
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
  disabled?: boolean;
  label: string;
  onClick: () => void;
}> = ({ collapsed, disabled = false, label, onClick }) => (
  <button
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
    if (seen.has(project.id)) {
      continue;
    }
    seen.add(project.id);
    merged.push(project);
  }
  return merged;
};

const indentationStyle = (depth: number): CSSProperties =>
  ({ "--todoist-bases-depth": Math.max(0, depth) }) as CSSProperties;

const collectBranchKeys = (
  groups: readonly TodoistListGroup[],
  showSections: boolean,
): Set<string> => {
  const keys = new Set<string>();
  const collectTasks = (groupKey: string, tasks: readonly TodoistListTaskNode[]) => {
    for (const task of tasks) {
      if (task.children.length > 0) {
        keys.add(`${groupKey}:task:${task.id}`);
        collectTasks(groupKey, task.children);
      }
    }
  };
  const collectProjects = (groupKey: string, projects: readonly TodoistListProject[]) => {
    for (const project of projects) {
      keys.add(`${groupKey}:project:${project.id}`);
      collectTasks(groupKey, project.tasks);
      for (const section of project.sections) {
        if (showSections) {
          keys.add(`${groupKey}:section:${project.id}:${section.key}`);
        }
        collectTasks(groupKey, section.tasks);
      }
      collectProjects(groupKey, project.projects);
    }
  };
  for (const group of groups) {
    collectProjects(group.key, group.projects);
  }
  return keys;
};
