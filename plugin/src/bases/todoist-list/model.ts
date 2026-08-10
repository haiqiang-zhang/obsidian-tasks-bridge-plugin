import type { BasesEntry, BasesEntryGroup, BasesPropertyId, Value } from "obsidian";

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
  managed: "note.todoist_sync_managed",
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
  properties.taskId,
  properties.content,
  properties.description,
  properties.status,
  properties.completed,
  properties.projectId,
  properties.projectPath,
  properties.projectIdPath,
  properties.parentTaskId,
  "note.todoist_sync_mapping_id",
  "note.todoist_sync_root_id",
  "note.todoist_sync_missing_count",
]);

type BuildOptions = {
  order: BasesPropertyId[];
  getDisplayName?: (propertyId: BasesPropertyId) => string;
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
  group: TodoistListGroup;
  projectOptions: TodoistListProjectOption[];
  taskCount: number;
  diagnostics: TodoistListDiagnostics;
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
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  };
  const projectOptions: TodoistListProjectOption[] = [];
  const seenProjectOptions = new Set<string>();
  const modelGroups: TodoistListGroup[] = [];
  const counts = emptyCounts();
  let taskCount = 0;

  for (const [index, sourceGroup] of groups.entries()) {
    const result = buildGroup(sourceGroup, index, options);
    modelGroups.push(result.group);
    addCounts(counts, result.group.counts);
    taskCount += result.taskCount;
    diagnostics.ignoredNonManaged += result.diagnostics.ignoredNonManaged;
    diagnostics.ignoredInvalid += result.diagnostics.ignoredInvalid;
    diagnostics.hierarchyWarnings += result.diagnostics.hierarchyWarnings;

    for (const project of result.projectOptions) {
      if (seenProjectOptions.has(project.id)) {
        continue;
      }
      seenProjectOptions.add(project.id);
      projectOptions.push(project);
    }
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
): GroupBuildResult => {
  const diagnostics: TodoistListDiagnostics = {
    ignoredNonManaged: 0,
    ignoredInvalid: 0,
    hierarchyWarnings: 0,
  };
  const projectsById = new Map<string, MutableProject>();
  const projectOrder: MutableProject[] = [];
  const tasksById = new Set<string>();
  let acceptedTaskCount = 0;

  for (const [sourceOrder, entry] of sourceGroup.entries.entries()) {
    if (!readBoolean(entry, properties.managed)) {
      diagnostics.ignoredNonManaged++;
      continue;
    }

    const task = readTask(entry, options);
    if (task === null || tasksById.has(task.id)) {
      diagnostics.ignoredInvalid++;
      continue;
    }
    const project = ensureProjectPath(task, sourceOrder, projectsById, projectOrder, diagnostics);
    if (project === null) {
      diagnostics.ignoredInvalid++;
      continue;
    }
    tasksById.add(task.id);
    project.directTasks.push({ sourceOrder, task });
    acceptedTaskCount++;
  }

  const roots = projectOrder.filter((project) => project.parentId === undefined);
  for (const project of projectOrder) {
    buildProjectTasks(project, diagnostics);
  }
  for (const project of roots) {
    calculateProjectCounts(project);
  }

  const label = readGroupLabel(sourceGroup);
  const groupCounts = roots.reduce(
    (result, project) => addCounts(result, project.counts),
    emptyCounts(),
  );
  const projectOptions = projectOrder.map(({ id, name, pathIds, pathNames }) => ({
    id,
    name,
    pathIds: [...pathIds],
    pathNames: [...pathNames],
  }));

  return {
    group: {
      key: `group:${groupIndex}:${label ?? "all"}`,
      label,
      projects: roots,
      counts: groupCounts,
    },
    projectOptions,
    taskCount: acceptedTaskCount,
    diagnostics,
  };
};

const ensureProjectPath = (
  task: TodoistListTaskRecord,
  sourceOrder: number,
  projectsById: Map<string, MutableProject>,
  projectOrder: MutableProject[],
  diagnostics: TodoistListDiagnostics,
): MutableProject | null => {
  if (
    task.projectIdPath.length === 0 ||
    task.projectIdPath.length !== task.projectPath.length ||
    task.projectIdPath[task.projectIdPath.length - 1] !== task.projectId
  ) {
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

    const existing = projectsById.get(normalizedId);
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
    let project = projectsById.get(segment.id);
    if (project === undefined) {
      project = {
        id: segment.id,
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
      projectsById.set(segment.id, project);
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

const readTask = (entry: BasesEntry, options: BuildOptions): TodoistListTaskRecord | null => {
  const id = readString(entry, properties.taskId);
  const content = readString(entry, properties.content);
  const status = readStatus(entry);
  const projectId = readString(entry, properties.projectId);
  const projectName = readString(entry, properties.project);
  const projectIdPath = readStringList(entry, properties.projectIdPath);
  const projectPath = readStringList(entry, properties.projectPath);
  if (
    id === undefined ||
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
    filePath: entry.file.path,
    fileName: entry.file.name,
    content,
    description: readString(entry, properties.description, true) ?? "",
    status,
    completed: readBoolean(entry, properties.completed) || status === "completed",
    projectId,
    projectName,
    projectIdPath,
    projectPath,
    parentTaskId: readString(entry, properties.parentTaskId),
    sectionId: readString(entry, properties.sectionId),
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
    order: readNumber(entry, properties.order),
    url: readString(entry, properties.url),
    metadata: readMetadata(entry, options),
  };
};

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
  const value = safeValue(entry, propertyId);
  if (value === null) {
    return false;
  }
  const text = value.toString().trim().toLocaleLowerCase("en-US");
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

export const scopeTodoistListGroups = (
  groups: readonly TodoistListGroup[],
  rootProjectId: string | null,
): TodoistListGroup[] => {
  if (rootProjectId === null) {
    return groups.map((group) => ({ ...group, projects: [...group.projects] }));
  }

  return groups.map((group) => {
    const project = findProjectRoot(group.projects, rootProjectId);
    return {
      ...group,
      projects: project === undefined ? [] : [project],
      counts: project?.counts ?? emptyCounts(),
    };
  });
};
