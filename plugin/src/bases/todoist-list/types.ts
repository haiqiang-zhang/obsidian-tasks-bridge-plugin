import type { BasesPropertyId } from "obsidian";

export type TodoistListTaskStatus = "active" | "completed" | "stale" | "out_of_scope";

export type TodoistListCounts = {
  active: number;
  completed: number;
  unavailable: number;
};

export type TodoistListMetadataKind =
  | "date"
  | "deadline"
  | "labels"
  | "priority"
  | "project"
  | "generic";

export type TodoistListMetadata = {
  propertyId: BasesPropertyId;
  displayName: string;
  kind: TodoistListMetadataKind;
  values: string[];
};

export type TodoistListTaskRecord = {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  description: string;
  status: TodoistListTaskStatus;
  completed: boolean;
  projectId: string;
  projectName: string;
  projectIdPath: string[];
  projectPath: string[];
  parentTaskId?: string;
  sectionId?: string;
  sectionName?: string;
  labels: string[];
  priority?: string;
  dueDate?: string;
  dueDatetime?: string;
  dueTimezone?: string;
  dueIsRecurring: boolean;
  deadline?: string;
  duration?: number;
  durationUnit?: string;
  order?: number;
  url?: string;
  metadata: TodoistListMetadata[];
};

export type TodoistListTaskNode = TodoistListTaskRecord & {
  children: TodoistListTaskNode[];
  hierarchyWarning?: "missing-parent" | "cycle";
};

export type TodoistListSection = {
  key: string;
  id?: string;
  name: string;
  tasks: TodoistListTaskNode[];
  counts: TodoistListCounts;
};

export type TodoistListProject = {
  id: string;
  name: string;
  parentId?: string;
  pathIds: string[];
  pathNames: string[];
  projects: TodoistListProject[];
  tasks: TodoistListTaskNode[];
  sections: TodoistListSection[];
  items: TodoistListProjectItem[];
  flatItems: TodoistListProjectItem[];
  counts: TodoistListCounts;
};

export type TodoistListProjectItem =
  | { kind: "project"; project: TodoistListProject }
  | { kind: "section"; section: TodoistListSection }
  | { kind: "task"; task: TodoistListTaskNode };

export type TodoistListGroup = {
  key: string;
  label?: string;
  projects: TodoistListProject[];
  counts: TodoistListCounts;
};

export type TodoistListProjectOption = {
  id: string;
  name: string;
  pathIds: string[];
  pathNames: string[];
};

export type TodoistListDiagnostics = {
  ignoredNonManaged: number;
  ignoredInvalid: number;
  hierarchyWarnings: number;
};

export type TodoistListModel = {
  groups: TodoistListGroup[];
  projects: TodoistListProjectOption[];
  counts: TodoistListCounts;
  taskCount: number;
  diagnostics: TodoistListDiagnostics;
};

export interface TodoistListActions {
  isReady(): boolean;
  completeTask(task: TodoistListTaskRecord): Promise<void>;
  reopenTask(task: TodoistListTaskRecord): Promise<void>;
  editTask(task: TodoistListTaskRecord): Promise<void> | void;
}

export interface TodoistListNavigation {
  openFile(filePath: string, newLeaf: boolean): void;
  hoverFile(filePath: string, targetEl: HTMLElement, event: MouseEvent): void;
}

export type TodoistListViewOptions = {
  density: "comfortable" | "compact";
  showDescriptions: boolean;
  showSections: boolean;
};
