import type { BasesEntry, BasesEntryGroup, BasesPropertyId, Value } from "obsidian";

import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";

import type {
  TodoistListCounts,
  TodoistListDiagnostics,
  TodoistListGroup,
  TodoistListMetadata,
  TodoistListMetadataKind,
  TodoistListModel,
  TodoistListProject,
  TodoistListProjectItem,
  TodoistListProjectOption,
  TodoistListSection,
  TodoistListTaskNode,
  TodoistListTaskRecord,
  TodoistListTaskStatus,
} from "./types";

const properties = {
  projectCatalog: "note.tasks_bridge_project_catalog_managed",
  managed: "note.todoist_sync_managed",
  mappingId: "note.todoist_sync_mapping_id",
  rootProjectId: "note.todoist_sync_root_id",
  taskId: "note.todoist_task_id",
  content: "note.todoist_content",
  description: "note.todoist_description",
  status: "note.todoist_status",
  completed: "note.todoist_completed",
  projectId: "note.todoist_project_id",
  project: "note.todoist_project",
  projectPath: "note.todoist_project_path",
  projectIdPath: "note.todoist_project_id_path",
  parentTaskId: "note.todoist_parent_task_id",
  sectionId: "note.todoist_section_id",
  section: "note.todoist_section",
  labels: "note.todoist_labels",
  priority: "note.todoist_priority",
  dueDate: "note.todoist_due_date",
  dueDatetime: "note.todoist_due_datetime",
  dueTimezone: "note.todoist_due_timezone",
  dueIsRecurring: "note.todoist_due_is_recurring",
  deadline: "note.todoist_deadline",
  duration: "note.todoist_duration",
  durationUnit: "note.todoist_duration_unit",
  order: "note.todoist_order",
  url: "note.todoist_url",
} as const satisfies Record<string, BasesPropertyId>;

const hiddenMetadataProperties = new Set<BasesPropertyId>([
  "file.name",
  "file.basename",
  "file.path",
  properties.managed,
  properties.projectCatalog,
  properties.taskId,
  properties.content,
  properties.description,
  properties.status,
  properties.completed,
  properties.projectId,
  properties.projectPath,
  properties.projectIdPath,
  properties.parentTaskId,
  properties.mappingId,
  properties.rootProjectId,
  "note.todoist_sync_missing_count",
]);

type BuildOptions = {
  order: BasesPropertyId[];
  getDisplayName?: (propertyId: BasesPropertyId) => string;
  projectStatisticsSnapshot?: ProjectSyncStatisticsSnapshot | null;
};

type CatalogTaskContext = {
  mappingId: string;
  rootProjectId: string;
  projectId: string;
  projectIdPath: string[];
  parentTaskId?: string;
  sectionId?: string;
  order: number;
};

type OrderedTaskRecord = {
  sourceOrder: number;
  task: TodoistListTaskRecord;
};

type MutableProject = Omit<TodoistListProject, "projects"> & {
  projects: MutableProject[];
  directTasks: OrderedTaskRecord[];
  firstSourceOrder: number;
};

type OrderedProjectItem = {
  item: TodoistListProjectItem;
  sourceOrder: number;
};

type GroupBuildResult = {
  key: string;
  label?: string;
  synthetic?: true;
  projectsById: Map<string, MutableProject>;
  projectOrder: MutableProject[];
  observedScopeKeys: Set<string>;
  taskCount: number;
  diagnostics: TodoistListDiagnostics;
};

type SnapshotProjectDescriptor = {
  id: string;
  scopeKey: string;
  name: string;
  parentScopeKey?: string;
  pathIds: string[];
  pathNames: string[];
};

type SnapshotScopeHierarchy = {
  scopeKey: string;
  projects: SnapshotProjectDescriptor[];
  projectsByScopeKey: ReadonlyMap<string, SnapshotProjectDescriptor>;
};

type TaskIdentityState = {
  acceptedTaskKeys: Set<string>;
  occurrencesByTaskKey: Map<string, number>;
  seenFilePaths: Set<string>;
};

const emptyCounts = (): TodoistListCounts => ({ active: 0, completed: 0, unavailable: 0 });

const addCounts = (target: TodoistListCounts, source: TodoistListCounts): TodoistListCounts => {
  target.active += source.active;
  target.completed += source.completed;
  target.unavailable += source.unavailable;
  return target;
};

export const buildTodoistListModel = (
  groups: readonly BasesEntryGroup[],
  options: BuildOptions,
): TodoistListModel => {
  const diagnostics: TodoistListDiagnostics = {
    ignoredNonManaged: 0,
    ignoredDuplicateTaskNotes: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  };
  const taskIdentities: TaskIdentityState = {
    acceptedTaskKeys: new Set(),
    occurrencesByTaskKey: new Map(),
    seenFilePaths: new Set(),
  };
  const catalogTasks = makeCatalogTaskContexts(options.projectStatisticsSnapshot ?? null);
  const groupResults = groups.map((sourceGroup, index) =>
    buildGroup(sourceGroup, index, options, taskIdentities, catalogTasks),
  );
  mergeSnapshotProjectHierarchy(groupResults, options.projectStatisticsSnapshot ?? null);

  const modelGroups: TodoistListGroup[] = [];
  const projectOptions: TodoistListProjectOption[] = [];
  const seenProjectOptions = new Set<string>();
  const counts = emptyCounts();
  let taskCount = 0;
  for (const result of groupResults) {
    const group = finalizeGroup(result);
    modelGroups.push(group);
    addCounts(counts, group.counts);
    taskCount += result.taskCount;
    diagnostics.ignoredNonManaged += result.diagnostics.ignoredNonManaged;
    diagnostics.ignoredInvalid += result.diagnostics.ignoredInvalid;
    diagnostics.hierarchyWarnings += result.diagnostics.hierarchyWarnings;

    collectProjectOptions(group.projects, projectOptions, seenProjectOptions);
  }

  for (const occurrences of taskIdentities.occurrencesByTaskKey.values()) {
    diagnostics.ignoredDuplicateTaskNotes += Math.max(0, occurrences - 1);
  }

  return {
    groups: modelGroups,
    projects: projectOptions,
    counts,
    taskCount,
    diagnostics,
  };
};

const buildGroup = (
  sourceGroup: BasesEntryGroup,
  groupIndex: number,
  options: BuildOptions,
  taskIdentities: TaskIdentityState,
  catalogTasks: ReadonlyMap<string, CatalogTaskContext>,
): GroupBuildResult => {
  const diagnostics: TodoistListDiagnostics = {
    ignoredNonManaged: 0,
    ignoredDuplicateTaskNotes: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  };
  const projectsById = new Map<string, MutableProject>();
  const projectOrder: MutableProject[] = [];
  const observedScopeKeys = new Set<string>();
  let acceptedTaskCount = 0;

  for (const [sourceOrder, entry] of sourceGroup.entries.entries()) {
    // A broad Base folder filter may include its own .base configuration file or other assets.
    // They are not notes and should not be reported as non-managed Markdown notes.
    if (!isMarkdownEntry(entry)) {
      continue;
    }
    // Project catalogs are Markdown so they synchronize across devices, but they are local
    // projection metadata rather than task rows. Broad folder filters must ignore them silently.
    if (readBoolean(entry, properties.projectCatalog)) {
      continue;
    }
    if (taskIdentities.seenFilePaths.has(entry.file.path)) {
      continue;
    }
    taskIdentities.seenFilePaths.add(entry.file.path);
    const taskId = readString(entry, properties.taskId);
    if (taskId === undefined) {
      diagnostics.ignoredNonManaged++;
      continue;
    }

    const context = catalogTasks.get(taskId);
    const rootProjectId = context?.rootProjectId ?? readString(entry, properties.rootProjectId);
    const mappingId = context?.mappingId ?? readString(entry, properties.mappingId);
    if (rootProjectId === undefined) {
      diagnostics.ignoredInvalid++;
      continue;
    }
    const taskKey = todoistListTaskScopeKey(mappingId, rootProjectId, taskId);
    taskIdentities.occurrencesByTaskKey.set(
      taskKey,
      (taskIdentities.occurrencesByTaskKey.get(taskKey) ?? 0) + 1,
    );
    const task = readTask(entry, options, context);
    if (task === null) {
      diagnostics.ignoredInvalid++;
      continue;
    }
    if (taskIdentities.acceptedTaskKeys.has(taskKey)) {
      if (!hasValidProjectPath(task)) {
        diagnostics.ignoredInvalid++;
      }
      continue;
    }
    const project = ensureProjectPath(task, sourceOrder, projectsById, projectOrder, diagnostics);
    if (project === null) {
      diagnostics.ignoredInvalid++;
      continue;
    }
    taskIdentities.acceptedTaskKeys.add(task.scopeKey);
    observedScopeKeys.add(makeScopeKey(task.mappingId, task.rootProjectId));
    project.directTasks.push({ sourceOrder, task });
    acceptedTaskCount++;
  }
  const label = readGroupLabel(sourceGroup);

  return {
    key: `group:${groupIndex}:${label ?? "all"}`,
    ...(label === undefined ? {} : { label }),
    projectsById,
    projectOrder,
    observedScopeKeys,
    taskCount: acceptedTaskCount,
    diagnostics,
  };
};

const mergeSnapshotProjectHierarchy = (
  groups: GroupBuildResult[],
  snapshot: ProjectSyncStatisticsSnapshot | null,
): void => {
  const hierarchies = buildSnapshotScopeHierarchies(snapshot);
  let syntheticGroup: GroupBuildResult | undefined;

  for (const hierarchy of hierarchies) {
    const observedGroups = groups.filter((group) =>
      group.observedScopeKeys.has(hierarchy.scopeKey),
    );
    if (observedGroups.length > 0) {
      for (const group of observedGroups) {
        const existingProjects = hierarchy.projects
          .filter((project) => group.projectsById.has(project.scopeKey))
          .map((project) => project.scopeKey);
        mergeSnapshotScopeIntoGroup(
          group,
          hierarchy,
          withSnapshotAncestors(existingProjects, hierarchy),
        );
      }

      const represented = new Set(groups.flatMap((group) => [...group.projectsById.keys()]));
      const missingProjects = hierarchy.projects
        .filter((project) => !represented.has(project.scopeKey))
        .map((project) => project.scopeKey);
      mergeSnapshotScopeIntoGroup(
        observedGroups[0] as GroupBuildResult,
        hierarchy,
        withSnapshotAncestors(missingProjects, hierarchy),
      );
      continue;
    }

    syntheticGroup ??= makeSyntheticGroup();
    mergeSnapshotScopeIntoGroup(
      syntheticGroup,
      hierarchy,
      new Set(hierarchy.projects.map((project) => project.scopeKey)),
    );
  }

  if (syntheticGroup !== undefined) {
    groups.push(syntheticGroup);
  }
};

const makeSyntheticGroup = (): GroupBuildResult => ({
  key: "group:snapshot:ungrouped",
  synthetic: true,
  projectsById: new Map(),
  projectOrder: [],
  observedScopeKeys: new Set(),
  taskCount: 0,
  diagnostics: {
    ignoredNonManaged: 0,
    ignoredDuplicateTaskNotes: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  },
});

const buildSnapshotScopeHierarchies = (
  snapshot: ProjectSyncStatisticsSnapshot | null,
): SnapshotScopeHierarchy[] => {
  const result: SnapshotScopeHierarchy[] = [];
  for (const scope of snapshot?.scopes ?? []) {
    const projectsById = new Map<string, (typeof scope.projects)[number]>();
    for (const project of scope.projects) {
      if (!projectsById.has(project.id)) {
        projectsById.set(project.id, project);
      }
    }
    const root = projectsById.get(scope.rootProjectId);
    if (root === undefined) {
      continue;
    }

    const childrenByParentId = new Map<string, (typeof scope.projects)[number][]>();
    for (const project of projectsById.values()) {
      if (project.id === root.id || project.parentId === null) {
        continue;
      }
      const children = childrenByParentId.get(project.parentId) ?? [];
      children.push(project);
      childrenByParentId.set(project.parentId, children);
    }
    for (const children of childrenByParentId.values()) {
      children.sort(compareSnapshotProjects);
    }

    const scopeKey = makeScopeKey(scope.mappingId, scope.rootProjectId);
    const projects: SnapshotProjectDescriptor[] = [];
    const descriptorsByScopeKey = new Map<string, SnapshotProjectDescriptor>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (
      project: (typeof scope.projects)[number],
      pathIds: readonly string[],
      pathNames: readonly string[],
      parentScopeKey?: string,
    ): void => {
      if (visiting.has(project.id) || visited.has(project.id)) {
        return;
      }
      visiting.add(project.id);
      const projectScopeKey = todoistListProjectScopeKey(
        scope.mappingId,
        scope.rootProjectId,
        project.id,
      );
      const descriptor: SnapshotProjectDescriptor = {
        id: project.id,
        scopeKey: projectScopeKey,
        name: project.name,
        ...(parentScopeKey === undefined ? {} : { parentScopeKey }),
        pathIds: [...pathIds, project.id],
        pathNames: [...pathNames, project.name],
      };
      projects.push(descriptor);
      descriptorsByScopeKey.set(projectScopeKey, descriptor);
      for (const child of childrenByParentId.get(project.id) ?? []) {
        visit(child, descriptor.pathIds, descriptor.pathNames, projectScopeKey);
      }
      visiting.delete(project.id);
      visited.add(project.id);
    };
    visit(root, [], []);

    result.push({
      scopeKey,
      projects,
      projectsByScopeKey: descriptorsByScopeKey,
    });
  }
  return result;
};

const compareSnapshotProjects = (
  left: ProjectSyncStatisticsSnapshot["scopes"][number]["projects"][number],
  right: ProjectSyncStatisticsSnapshot["scopes"][number]["projects"][number],
): number => {
  const byOrder = left.childOrder - right.childOrder;
  if (byOrder !== 0) {
    return byOrder;
  }
  const byName = left.name.localeCompare(right.name);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
};

const mergeSnapshotScopeIntoGroup = (
  group: GroupBuildResult,
  hierarchy: SnapshotScopeHierarchy,
  selected: ReadonlySet<string>,
): void => {
  for (const descriptor of hierarchy.projects) {
    if (!selected.has(descriptor.scopeKey)) {
      continue;
    }
    let project = group.projectsById.get(descriptor.scopeKey);
    if (project === undefined) {
      const parent =
        descriptor.parentScopeKey === undefined
          ? undefined
          : hierarchy.projectsByScopeKey.get(descriptor.parentScopeKey);
      project = {
        id: descriptor.id,
        scopeKey: descriptor.scopeKey,
        name: descriptor.name,
        ...(parent === undefined ? {} : { parentId: parent.id }),
        pathIds: [...descriptor.pathIds],
        pathNames: [...descriptor.pathNames],
        projects: [],
        tasks: [],
        sections: [],
        items: [],
        flatItems: [],
        counts: emptyCounts(),
        directTasks: [],
        firstSourceOrder: Number.POSITIVE_INFINITY,
      };
      group.projectsById.set(descriptor.scopeKey, project);
      group.projectOrder.push(project);
    }

    const parent =
      descriptor.parentScopeKey === undefined
        ? undefined
        : group.projectsById.get(descriptor.parentScopeKey);
    if (descriptor.parentScopeKey !== undefined && parent === undefined) {
      group.diagnostics.hierarchyWarnings++;
      continue;
    }
    const expectedParentId = parent?.id;
    if (project.parentId !== expectedParentId) {
      detachProject(group.projectOrder, project.scopeKey);
      project.parentId = expectedParentId;
    }
    project.pathIds = [...descriptor.pathIds];
    project.pathNames = [...descriptor.pathNames];
    if (parent === undefined) {
      continue;
    }
    if (!parent.projects.some((child) => child.scopeKey === project.scopeKey)) {
      parent.projects.push(project);
    }
  }
};

const withSnapshotAncestors = (
  scopeKeys: readonly string[],
  hierarchy: SnapshotScopeHierarchy,
): Set<string> => {
  const result = new Set<string>();
  for (const scopeKey of scopeKeys) {
    let project = hierarchy.projectsByScopeKey.get(scopeKey);
    const visiting = new Set<string>();
    while (project !== undefined && !visiting.has(project.scopeKey)) {
      visiting.add(project.scopeKey);
      result.add(project.scopeKey);
      project =
        project.parentScopeKey === undefined
          ? undefined
          : hierarchy.projectsByScopeKey.get(project.parentScopeKey);
    }
  }
  return result;
};

const detachProject = (projects: readonly MutableProject[], projectScopeKey: string): void => {
  for (const candidate of projects) {
    candidate.projects = candidate.projects.filter((child) => child.scopeKey !== projectScopeKey);
  }
};

const finalizeGroup = (result: GroupBuildResult): TodoistListGroup => {
  const roots = result.projectOrder.filter((project) => project.parentId === undefined);
  for (const project of result.projectOrder) {
    buildProjectTasks(project, result.diagnostics);
  }
  for (const project of roots) {
    calculateProjectCounts(project);
  }
  const counts = roots.reduce(
    (groupCounts, project) => addCounts(groupCounts, project.counts),
    emptyCounts(),
  );
  return {
    key: result.key,
    ...(result.label === undefined ? {} : { label: result.label }),
    ...(result.synthetic === true ? { synthetic: true as const } : {}),
    projects: roots,
    counts,
  };
};

const collectProjectOptions = (
  projects: readonly TodoistListProject[],
  options: TodoistListProjectOption[],
  seen: Set<string>,
): void => {
  for (const project of projects) {
    if (!seen.has(project.scopeKey)) {
      seen.add(project.scopeKey);
      options.push({
        id: project.id,
        scopeKey: project.scopeKey,
        name: project.name,
        pathIds: [...project.pathIds],
        pathNames: [...project.pathNames],
      });
    }
    collectProjectOptions(project.projects, options, seen);
  }
};

const isMarkdownEntry = (entry: BasesEntry): boolean =>
  entry.file.extension?.toLocaleLowerCase("en-US") === "md" ||
  entry.file.path.toLocaleLowerCase("en-US").endsWith(".md");

const hasValidProjectPath = (task: TodoistListTaskRecord): boolean => {
  if (
    task.projectIdPath.length === 0 ||
    task.projectIdPath.length !== task.projectPath.length ||
    task.projectIdPath[task.projectIdPath.length - 1] !== task.projectId
  ) {
    return false;
  }
  const pathIds = new Set<string>();
  return task.projectIdPath.every((id, index) => {
    const normalizedId = id.trim();
    const name = task.projectPath[index]?.trim();
    if (normalizedId === "" || name === undefined || name === "" || pathIds.has(normalizedId)) {
      return false;
    }
    pathIds.add(normalizedId);
    return true;
  });
};

const ensureProjectPath = (
  task: TodoistListTaskRecord,
  sourceOrder: number,
  projectsById: Map<string, MutableProject>,
  projectOrder: MutableProject[],
  diagnostics: TodoistListDiagnostics,
): MutableProject | null => {
  if (!hasValidProjectPath(task)) {
    return null;
  }

  const segments: { id: string; name: string }[] = [];
  const pathIds = new Set<string>();
  for (const [index, id] of task.projectIdPath.entries()) {
    const name = task.projectPath[index]?.trim();
    const normalizedId = id.trim();
    if (normalizedId === "" || name === undefined || name === "" || pathIds.has(normalizedId)) {
      return null;
    }
    pathIds.add(normalizedId);
    segments.push({ id: normalizedId, name });

    const projectScopeKey = todoistListProjectScopeKey(
      task.mappingId,
      task.rootProjectId,
      normalizedId,
    );
    const existing = projectsById.get(projectScopeKey);
    const expectedParentId = segments[index - 1]?.id;
    if (
      existing !== undefined &&
      (existing.name !== name || existing.parentId !== expectedParentId)
    ) {
      diagnostics.hierarchyWarnings++;
      return null;
    }
  }

  // Commit only after the complete path has been validated. Otherwise a malformed note whose
  // later segment conflicts with an existing project could leave empty "ghost" projects behind.
  let parent: MutableProject | undefined;
  for (const [index, segment] of segments.entries()) {
    const projectScopeKey = todoistListProjectScopeKey(
      task.mappingId,
      task.rootProjectId,
      segment.id,
    );
    let project = projectsById.get(projectScopeKey);
    if (project === undefined) {
      project = {
        id: segment.id,
        scopeKey: projectScopeKey,
        name: segment.name,
        parentId: parent?.id,
        pathIds: segments.slice(0, index + 1).map(({ id }) => id),
        pathNames: segments.slice(0, index + 1).map(({ name }) => name),
        projects: [],
        tasks: [],
        sections: [],
        items: [],
        flatItems: [],
        counts: emptyCounts(),
        directTasks: [],
        firstSourceOrder: sourceOrder,
      };
      projectsById.set(projectScopeKey, project);
      projectOrder.push(project);
      parent?.projects.push(project);
    }
    project.firstSourceOrder = Math.min(project.firstSourceOrder, sourceOrder);
    parent = project;
  }

  return parent ?? null;
};

const buildProjectTasks = (project: MutableProject, diagnostics: TodoistListDiagnostics): void => {
  const sourceOrderByTaskId = new Map(
    project.directTasks.map(({ sourceOrder, task }) => [task.id, sourceOrder]),
  );
  const nodes = project.directTasks.map<TodoistListTaskNode>(({ task }) => ({
    ...task,
    children: [],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots: TodoistListTaskNode[] = [];

  for (const node of nodes) {
    const parent = node.parentTaskId === undefined ? undefined : byId.get(node.parentTaskId);
    if (parent === undefined) {
      if (node.parentTaskId !== undefined) {
        node.hierarchyWarning = "missing-parent";
        diagnostics.hierarchyWarnings++;
      }
      roots.push(node);
      continue;
    }

    if (parent.id === node.id || taskParentChainContains(node.id, parent, byId)) {
      node.hierarchyWarning = "cycle";
      diagnostics.hierarchyWarnings++;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const sections = new Map<string, TodoistListSection>();
  const sectionSourceOrder = new Map<string, number>();
  for (const task of roots) {
    if (task.sectionId === undefined && task.sectionName === undefined) {
      project.tasks.push(task);
      continue;
    }
    const key = task.sectionId ?? `name:${task.sectionName}`;
    let section = sections.get(key);
    if (section === undefined) {
      section = {
        key,
        id: task.sectionId,
        name: task.sectionName ?? "Untitled section",
        tasks: [],
        counts: emptyCounts(),
      };
      sections.set(key, section);
      project.sections.push(section);
    }
    section.tasks.push(task);
    sectionSourceOrder.set(
      key,
      Math.min(
        sectionSourceOrder.get(key) ?? Number.POSITIVE_INFINITY,
        taskTreeSourceOrder(task, sourceOrderByTaskId),
      ),
    );
  }

  project.counts = countTasks(roots);
  for (const section of project.sections) {
    section.counts = countTasks(section.tasks);
  }

  const childProjectItems = project.projects.map<OrderedProjectItem>((child) => ({
    item: { kind: "project", project: child },
    sourceOrder: child.firstSourceOrder,
  }));
  const unsectionedTaskItems = project.tasks.map<OrderedProjectItem>((task) => ({
    item: { kind: "task", task },
    sourceOrder: taskTreeSourceOrder(task, sourceOrderByTaskId),
  }));
  const sectionItems = project.sections.map<OrderedProjectItem>((section) => ({
    item: { kind: "section", section },
    sourceOrder: sectionSourceOrder.get(section.key) ?? Number.POSITIVE_INFINITY,
  }));
  project.items = sortProjectItems([
    ...childProjectItems,
    ...unsectionedTaskItems,
    ...sectionItems,
  ]);
  project.flatItems = sortProjectItems([
    ...childProjectItems,
    ...unsectionedTaskItems,
    ...project.sections.flatMap((section) =>
      section.tasks.map<OrderedProjectItem>((task) => ({
        item: { kind: "task", task },
        sourceOrder: taskTreeSourceOrder(task, sourceOrderByTaskId),
      })),
    ),
  ]);
};

const sortProjectItems = (items: OrderedProjectItem[]): TodoistListProjectItem[] =>
  items.sort((left, right) => left.sourceOrder - right.sourceOrder).map(({ item }) => item);

const taskTreeSourceOrder = (
  task: TodoistListTaskNode,
  sourceOrderByTaskId: ReadonlyMap<string, number>,
): number => {
  let sourceOrder = sourceOrderByTaskId.get(task.id) ?? Number.POSITIVE_INFINITY;
  for (const child of task.children) {
    sourceOrder = Math.min(sourceOrder, taskTreeSourceOrder(child, sourceOrderByTaskId));
  }
  return sourceOrder;
};

const taskParentChainContains = (
  taskId: string,
  initialParent: TodoistListTaskNode,
  tasksById: ReadonlyMap<string, TodoistListTaskNode>,
): boolean => {
  const seen = new Set<string>([taskId]);
  let current: TodoistListTaskNode | undefined = initialParent;
  while (current !== undefined) {
    if (seen.has(current.id)) {
      return true;
    }
    seen.add(current.id);
    current = current.parentTaskId === undefined ? undefined : tasksById.get(current.parentTaskId);
  }
  return false;
};

const calculateProjectCounts = (project: MutableProject): TodoistListCounts => {
  const counts = { ...project.counts };
  for (const child of project.projects) {
    addCounts(counts, calculateProjectCounts(child));
  }
  project.counts = counts;
  return counts;
};

const countTasks = (tasks: TodoistListTaskNode[]): TodoistListCounts => {
  const counts = emptyCounts();
  const visit = (task: TodoistListTaskNode): void => {
    switch (task.status) {
      case "active":
        counts.active++;
        break;
      case "completed":
        counts.completed++;
        break;
      case "stale":
      case "out_of_scope":
        counts.unavailable++;
        break;
      default:
        break;
    }
    for (const child of task.children) {
      visit(child);
    }
  };
  for (const task of tasks) {
    visit(task);
  }
  return counts;
};

const readTask = (
  entry: BasesEntry,
  options: BuildOptions,
  context?: CatalogTaskContext,
): TodoistListTaskRecord | null => {
  const id = readString(entry, properties.taskId);
  const mappingId = context?.mappingId ?? readString(entry, properties.mappingId);
  const rootProjectId = context?.rootProjectId ?? readString(entry, properties.rootProjectId);
  const content = readString(entry, properties.content);
  const status = readStatus(entry);
  const projectId = context?.projectId ?? readString(entry, properties.projectId);
  const projectName = readString(entry, properties.project);
  const projectIdPath = context?.projectIdPath ?? readStringList(entry, properties.projectIdPath);
  const projectPath = readStringList(entry, properties.projectPath);
  const completedProperty = readOptionalBoolean(entry, properties.completed);
  if (
    id === undefined ||
    rootProjectId === undefined ||
    content === undefined ||
    status === undefined ||
    projectId === undefined ||
    projectName === undefined ||
    projectIdPath === undefined ||
    projectPath === undefined
  ) {
    return null;
  }

  return {
    id,
    scopeKey: todoistListTaskScopeKey(mappingId, rootProjectId, id),
    mappingId,
    rootProjectId,
    filePath: entry.file.path,
    fileName: entry.file.name,
    content,
    description: readString(entry, properties.description, true) ?? "",
    status,
    completed: completedProperty ?? status === "completed",
    projectId,
    projectName,
    projectIdPath,
    projectPath,
    parentTaskId: context?.parentTaskId ?? readString(entry, properties.parentTaskId),
    sectionId: context?.sectionId ?? readString(entry, properties.sectionId),
    sectionName: readString(entry, properties.section),
    labels: readStringList(entry, properties.labels) ?? [],
    priority: readString(entry, properties.priority),
    dueDate: readString(entry, properties.dueDate),
    dueDatetime: readString(entry, properties.dueDatetime),
    dueTimezone: readString(entry, properties.dueTimezone),
    dueIsRecurring: readBoolean(entry, properties.dueIsRecurring),
    deadline: readString(entry, properties.deadline),
    duration: readNumber(entry, properties.duration),
    durationUnit: readString(entry, properties.durationUnit),
    order: context?.order ?? readNumber(entry, properties.order),
    url: readString(entry, properties.url),
    metadata: readMetadata(entry, options),
  };
};

const makeCatalogTaskContexts = (
  snapshot: ProjectSyncStatisticsSnapshot | null,
): Map<string, CatalogTaskContext> => {
  const result = new Map<string, CatalogTaskContext>();
  const duplicates = new Set<string>();
  for (const scope of snapshot?.scopes ?? []) {
    const projects = new Map(scope.projects.map((project) => [project.id, project]));
    for (const task of scope.tasks ?? []) {
      if (result.has(task.id)) {
        duplicates.add(task.id);
        continue;
      }
      const projectIdPath = resolveCatalogProjectIdPath(task.projectId, projects);
      if (projectIdPath.length === 0) {
        continue;
      }
      result.set(task.id, {
        mappingId: scope.mappingId,
        rootProjectId: scope.rootProjectId,
        projectId: task.projectId,
        projectIdPath,
        ...(task.parentId === undefined ? {} : { parentTaskId: task.parentId }),
        ...(task.sectionId === undefined ? {} : { sectionId: task.sectionId }),
        order: task.order,
      });
    }
  }
  for (const taskId of duplicates) {
    result.delete(taskId);
  }
  return result;
};

const resolveCatalogProjectIdPath = (
  projectId: string,
  projects: ReadonlyMap<string, { id: string; parentId: string | null }>,
): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  let current = projects.get(projectId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    result.push(current.id);
    current = current.parentId === null ? undefined : projects.get(current.parentId);
  }
  return result.reverse();
};

const makeScopeKey = (mappingId: string | undefined, rootProjectId: string): string =>
  JSON.stringify([mappingId ?? null, rootProjectId]);

export const todoistListTaskScopeKey = (
  mappingId: string | undefined,
  rootProjectId: string,
  taskId: string,
): string => `task:${makeScopeKey(mappingId, rootProjectId)}:${JSON.stringify(taskId)}`;

export const todoistListProjectScopeKey = (
  mappingId: string | undefined,
  rootProjectId: string,
  projectId: string,
): string => `project:${makeScopeKey(mappingId, rootProjectId)}:${JSON.stringify(projectId)}`;

const readMetadata = (entry: BasesEntry, options: BuildOptions): TodoistListMetadata[] => {
  const result: TodoistListMetadata[] = [];
  for (const propertyId of options.order) {
    if (hiddenMetadataProperties.has(propertyId)) {
      continue;
    }
    const values = readStringList(entry, propertyId) ?? readSingleValue(entry, propertyId);
    if (values === undefined || values.length === 0) {
      continue;
    }
    result.push({
      propertyId,
      displayName: getDisplayName(propertyId, options.getDisplayName),
      kind: metadataKind(propertyId),
      values,
    });
  }
  return result;
};

const readSingleValue = (entry: BasesEntry, propertyId: BasesPropertyId): string[] | undefined => {
  const value = safeValue(entry, propertyId);
  if (value === null || !value.isTruthy()) {
    return undefined;
  }
  const text = value.toString().trim();
  return text === "" ? undefined : [text];
};

const readStatus = (entry: BasesEntry): TodoistListTaskStatus | undefined => {
  const value = readString(entry, properties.status);
  switch (value) {
    case "active":
    case "completed":
    case "stale":
    case "out_of_scope":
      return value;
    default:
      return undefined;
  }
};

const readString = (
  entry: BasesEntry,
  propertyId: BasesPropertyId,
  allowEmpty = false,
): string | undefined => {
  const value = safeValue(entry, propertyId);
  // Bases represents a missing property with a falsy Value whose string form is "null". Follow
  // the official Value contract instead of treating that diagnostic string as task metadata.
  if (value === null || !value.isTruthy()) {
    return allowEmpty ? "" : undefined;
  }
  const text = value.toString().trim();
  return text === "" && !allowEmpty ? undefined : text;
};

const readStringList = (entry: BasesEntry, propertyId: BasesPropertyId): string[] | undefined => {
  const value = safeValue(entry, propertyId);
  if (value === null || !isListValue(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length(); index++) {
    const text = value.get(index).toString().trim();
    if (text !== "") {
      result.push(text);
    }
  }
  return result;
};

const readBoolean = (entry: BasesEntry, propertyId: BasesPropertyId): boolean => {
  return readOptionalBoolean(entry, propertyId) ?? false;
};

const readOptionalBoolean = (
  entry: BasesEntry,
  propertyId: BasesPropertyId,
): boolean | undefined => {
  const value = safeValue(entry, propertyId);
  if (value === null) {
    return undefined;
  }
  const text = value.toString().trim().toLocaleLowerCase("en-US");
  if (text === "" || text === "null") {
    return undefined;
  }
  return value.isTruthy() && text !== "false" && text !== "0";
};

const readNumber = (entry: BasesEntry, propertyId: BasesPropertyId): number | undefined => {
  const value = safeValue(entry, propertyId);
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value.toString().trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safeValue = (entry: BasesEntry, propertyId: BasesPropertyId): Value | null => {
  try {
    return entry.getValue(propertyId);
  } catch {
    return null;
  }
};

const isListValue = (
  value: Value,
): value is Value & { length(): number; get(index: number): Value } => {
  const candidate = value as Partial<{ length(): number; get(index: number): Value }>;
  return typeof candidate.length === "function" && typeof candidate.get === "function";
};

const readGroupLabel = (group: BasesEntryGroup): string | undefined => {
  if (!group.hasKey() || group.key === undefined || !group.key.isTruthy()) {
    return undefined;
  }
  const text = group.key.toString().trim();
  return text === "" ? undefined : text;
};

const getDisplayName = (
  propertyId: BasesPropertyId,
  configured?: (propertyId: BasesPropertyId) => string,
): string => {
  try {
    const displayName = configured?.(propertyId).trim();
    if (displayName !== undefined && displayName !== "") {
      return displayName;
    }
  } catch {
    // Fall through to the stable property-name fallback.
  }
  const separator = propertyId.indexOf(".");
  return propertyId.slice(separator + 1).replace(/_/gu, " ");
};

const metadataKind = (propertyId: BasesPropertyId): TodoistListMetadataKind => {
  switch (propertyId) {
    case properties.labels:
      return "labels";
    case properties.priority:
      return "priority";
    case properties.dueDate:
    case properties.dueDatetime:
      return "date";
    case properties.deadline:
      return "deadline";
    case properties.project:
    case properties.section:
      return "project";
    default:
      return "generic";
  }
};

export const findProjectRoot = (
  projects: readonly TodoistListProject[],
  projectId: string,
): TodoistListProject | undefined => {
  for (const project of projects) {
    if (project.id === projectId) {
      return project;
    }
    const child = findProjectRoot(project.projects, projectId);
    if (child !== undefined) {
      return child;
    }
  }
  return undefined;
};

const findProjectRoots = (
  projects: readonly TodoistListProject[],
  projectId: string,
): TodoistListProject[] => {
  const matches: TodoistListProject[] = [];
  for (const project of projects) {
    if (project.id === projectId) {
      matches.push(project);
    }
    matches.push(...findProjectRoots(project.projects, projectId));
  }
  return matches;
};

export const scopeTodoistListGroups = (
  groups: readonly TodoistListGroup[],
  rootProjectId: string | null,
): TodoistListGroup[] => {
  if (rootProjectId === null) {
    return groups.map((group) => ({ ...group, projects: [...group.projects] }));
  }

  return groups.map((group) => {
    const projects = findProjectRoots(group.projects, rootProjectId);
    const counts = projects.reduce(
      (result, project) => addCounts(result, project.counts),
      emptyCounts(),
    );
    return {
      ...group,
      projects,
      counts,
    };
  });
};
