import type { Project } from "@/api/domain/project";
import type { ProjectCompletionEvent } from "@/api/domain/task";

import type { ProjectSyncMapping, ProjectSyncSnapshot } from "./types";

export const PROJECT_CATALOG_DATA_KEY = "projectSyncCatalogs";
export const PROJECT_CATALOG_SCHEMA_VERSION = 2;
const LOCAL_EVENT_MATCH_TOLERANCE_MS = 120_000;

export type ProjectCatalogProject = Pick<Project, "id" | "parentId" | "name" | "childOrder">;

export type ProjectCatalogTask = {
  id: string;
  projectId: string;
  parentId?: string;
  sectionId?: string;
  order: number;
  missingCount?: number;
};

export type ProjectCatalog = {
  mappingId: string;
  rootProjectId: string;
  includeSubprojects: boolean;
  syncedAt: string;
  projects: ProjectCatalogProject[];
  tasks: ProjectCatalogTask[];
  completionEvents: ProjectCompletionEvent[];
};

export type ProjectCatalogCollection = Readonly<Record<string, ProjectCatalog>>;

type StoredProjectCatalogs = {
  version: number;
  items: ProjectCatalog[];
};

export type ProjectCatalogStorage = {
  getCatalog(mappingId: string): ProjectCatalog | null;
  persistCatalogs(catalogs: readonly ProjectCatalog[]): Promise<void>;
};

/**
 * Poll freshness belongs in the in-memory merge state, but is not a content change worth
 * synchronizing through data.json. Keep mergeProjectCatalogCollections' timestamp ordering;
 * use this only after merging to decide whether the resulting catalog needs to be written.
 */
export const projectCatalogCollectionsHaveSameContent = (
  current: ProjectCatalogCollection,
  incoming: ProjectCatalogCollection,
): boolean => {
  const mappingIds = Object.keys(current);
  return (
    mappingIds.length === Object.keys(incoming).length &&
    mappingIds.every((mappingId) => {
      const left = current[mappingId];
      const right = incoming[mappingId];
      return (
        right !== undefined &&
        left.mappingId === right.mappingId &&
        left.rootProjectId === right.rootProjectId &&
        left.includeSubprojects === right.includeSubprojects &&
        sameCatalogItems(
          left.projects,
          right.projects,
          (a, b) => a.parentId === b.parentId && a.name === b.name && a.childOrder === b.childOrder,
        ) &&
        sameCatalogItems(
          left.tasks,
          right.tasks,
          (a, b) =>
            a.projectId === b.projectId &&
            a.parentId === b.parentId &&
            a.sectionId === b.sectionId &&
            a.order === b.order &&
            (a.missingCount ?? 0) === (b.missingCount ?? 0),
        ) &&
        sameCatalogItems(
          left.completionEvents,
          right.completionEvents,
          (a, b) =>
            a.taskId === b.taskId && a.projectId === b.projectId && a.completedAt === b.completedAt,
        )
      );
    })
  );
};

const sameCatalogItems = <T extends { id: string }>(
  left: readonly T[],
  right: readonly T[],
  sameContent: (left: T, right: T) => boolean,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const byId = new Map(right.map((item) => [item.id, item]));
  if (byId.size !== right.length || new Set(left.map((item) => item.id)).size !== left.length) {
    return false;
  }
  return left.every((item) => {
    const matching = byId.get(item.id);
    return matching !== undefined && sameContent(item, matching);
  });
};

export const makeProjectCatalog = (
  snapshot: ProjectSyncSnapshot,
  mapping: ProjectSyncMapping,
): ProjectCatalog => ({
  mappingId: mapping.id,
  rootProjectId: snapshot.rootProjectId,
  includeSubprojects: mapping.includeSubprojects,
  syncedAt: snapshot.syncedAt,
  projects: snapshot.projects.map(({ id, parentId, name, childOrder }) => ({
    id,
    parentId,
    name,
    childOrder,
  })),
  tasks: snapshot.tasks.map(({ task }) => ({
    id: task.id,
    projectId: task.project.id,
    ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
    ...(task.section === undefined ? {} : { sectionId: task.section.id }),
    order: task.order,
  })),
  completionEvents: deduplicateCompletionEvents(snapshot.completionEvents ?? []),
});

export const readProjectCatalogCollection = (storedData: unknown): ProjectCatalogCollection => {
  if (!isRecord(storedData)) {
    return {};
  }
  const stored = storedData[PROJECT_CATALOG_DATA_KEY];
  if (
    !isRecord(stored) ||
    (stored.version !== 1 && stored.version !== PROJECT_CATALOG_SCHEMA_VERSION) ||
    !Array.isArray(stored.items)
  ) {
    return {};
  }

  const catalogs: Record<string, ProjectCatalog> = {};
  for (const value of stored.items) {
    const catalog = parseProjectCatalog(value);
    if (catalog === null) {
      continue;
    }
    const current = catalogs[catalog.mappingId];
    if (current === undefined || current.syncedAt < catalog.syncedAt) {
      catalogs[catalog.mappingId] = catalog;
    }
  }
  return catalogs;
};

export const withProjectCatalogCollection = (
  settings: Record<string, unknown>,
  catalogs: ProjectCatalogCollection,
): Record<string, unknown> => {
  const data = { ...settings };
  const items = Object.values(catalogs)
    .map(cloneProjectCatalog)
    .sort((left, right) => left.mappingId.localeCompare(right.mappingId));
  if (items.length === 0) {
    delete data[PROJECT_CATALOG_DATA_KEY];
    return data;
  }
  data[PROJECT_CATALOG_DATA_KEY] = {
    version: PROJECT_CATALOG_SCHEMA_VERSION,
    items,
  } satisfies StoredProjectCatalogs;
  return data;
};

export const mergeProjectCatalogCollections = (
  current: ProjectCatalogCollection,
  incoming: ProjectCatalogCollection,
): ProjectCatalogCollection => {
  const merged: Record<string, ProjectCatalog> = {};
  for (const catalog of [...Object.values(current), ...Object.values(incoming)]) {
    const existing = merged[catalog.mappingId];
    if (existing === undefined || existing.syncedAt < catalog.syncedAt) {
      merged[catalog.mappingId] = cloneProjectCatalog(catalog);
    } else if (existing.syncedAt === catalog.syncedAt) {
      merged[catalog.mappingId] = mergeSameSnapshotCatalog(existing, catalog);
    }
  }
  return merged;
};

const mergeSameSnapshotCatalog = (
  current: ProjectCatalog,
  incoming: ProjectCatalog,
): ProjectCatalog => {
  if (
    current.rootProjectId !== incoming.rootProjectId ||
    current.includeSubprojects !== incoming.includeSubprojects
  ) {
    return cloneProjectCatalog(incoming);
  }
  const tasks = new Map(current.tasks.map((task) => [task.id, { ...task }]));
  for (const task of incoming.tasks) {
    const previous = tasks.get(task.id);
    tasks.set(task.id, {
      ...task,
      ...(Math.max(previous?.missingCount ?? 0, task.missingCount ?? 0) > 0
        ? { missingCount: Math.max(previous?.missingCount ?? 0, task.missingCount ?? 0) }
        : {}),
    });
  }
  return {
    ...cloneProjectCatalog(incoming),
    tasks: [...tasks.values()],
    completionEvents: mergeProjectCompletionEvents(
      current.completionEvents,
      incoming.completionEvents,
    ),
  };
};

export const cloneProjectCatalog = (catalog: ProjectCatalog): ProjectCatalog => ({
  ...catalog,
  projects: catalog.projects.map((project) => ({ ...project })),
  tasks: catalog.tasks.map((task) => ({ ...task })),
  completionEvents: catalog.completionEvents.map((event) => ({ ...event })),
});

export const parseProjectCatalog = (value: unknown): ProjectCatalog | null => {
  if (!isRecord(value)) {
    return null;
  }
  const mappingId = readNonEmptyString(value.mappingId);
  const rootProjectId = readNonEmptyString(value.rootProjectId);
  const syncedAt = readTimestamp(value.syncedAt);
  if (
    mappingId === null ||
    rootProjectId === null ||
    syncedAt === null ||
    typeof value.includeSubprojects !== "boolean" ||
    !Array.isArray(value.projects) ||
    (value.tasks !== undefined && !Array.isArray(value.tasks)) ||
    (value.completionEvents !== undefined && !Array.isArray(value.completionEvents))
  ) {
    return null;
  }

  const projectIds = new Set<string>();
  const projects: ProjectCatalogProject[] = [];
  for (const candidate of value.projects) {
    const project = parseCatalogProject(candidate);
    if (project === null || projectIds.has(project.id)) {
      return null;
    }
    projectIds.add(project.id);
    projects.push(project);
  }
  if (!projectIds.has(rootProjectId)) {
    return null;
  }

  const taskIds = new Set<string>();
  const tasks: ProjectCatalogTask[] = [];
  for (const candidate of value.tasks ?? []) {
    const task = parseCatalogTask(candidate);
    if (task === null || taskIds.has(task.id)) {
      return null;
    }
    taskIds.add(task.id);
    tasks.push(task);
  }

  const completionEvents: ProjectCompletionEvent[] = [];
  for (const candidate of value.completionEvents ?? []) {
    const event = parseCompletionEvent(candidate);
    if (event === null) {
      return null;
    }
    completionEvents.push(event);
  }
  return {
    mappingId,
    rootProjectId,
    includeSubprojects: value.includeSubprojects,
    syncedAt,
    projects,
    tasks,
    completionEvents: deduplicateCompletionEvents(completionEvents),
  };
};

const parseCatalogTask = (value: unknown): ProjectCatalogTask | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const projectId = readNonEmptyString(value.projectId);
  const parentId = value.parentId === undefined ? undefined : readNonEmptyString(value.parentId);
  const sectionId = value.sectionId === undefined ? undefined : readNonEmptyString(value.sectionId);
  if (
    id === null ||
    projectId === null ||
    (value.parentId !== undefined && parentId === null) ||
    (value.sectionId !== undefined && sectionId === null) ||
    typeof value.order !== "number" ||
    !Number.isFinite(value.order)
  ) {
    return null;
  }
  return {
    id,
    projectId,
    ...(typeof parentId === "string" ? { parentId } : {}),
    ...(typeof sectionId === "string" ? { sectionId } : {}),
    order: value.order,
    ...(typeof value.missingCount === "number" && Number.isFinite(value.missingCount)
      ? { missingCount: Math.max(0, Math.floor(value.missingCount)) }
      : {}),
  };
};

const parseCompletionEvent = (value: unknown): ProjectCompletionEvent | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const taskId = readNonEmptyString(value.taskId);
  const projectId = readNonEmptyString(value.projectId);
  const completedAt = readTimestamp(value.completedAt);
  return id === null || taskId === null || projectId === null || completedAt === null
    ? null
    : { id, taskId, projectId, completedAt };
};

const deduplicateCompletionEvents = (
  events: readonly ProjectCompletionEvent[],
): ProjectCompletionEvent[] => {
  const byId = new Map<string, ProjectCompletionEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) {
      byId.set(event.id, { ...event });
    }
  }
  return [...byId.values()].sort((left, right) => {
    const byTime = left.completedAt.localeCompare(right.completedAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
};

export const mergeProjectCompletionEvents = (
  current: readonly ProjectCompletionEvent[],
  incoming: readonly ProjectCompletionEvent[],
): ProjectCompletionEvent[] => {
  const canonical = incoming.filter((event) => !event.id.startsWith("local:"));
  const canonicalIds = new Set(canonical.map(({ id }) => id));
  return deduplicateCompletionEvents([
    ...incoming,
    ...current.filter(
      (event) =>
        !canonicalIds.has(event.id) &&
        !canonical.some((candidate) => completionEventsMatch(event, candidate)),
    ),
  ]);
};

const completionEventsMatch = (
  left: ProjectCompletionEvent,
  right: ProjectCompletionEvent,
): boolean => {
  if (left.taskId !== right.taskId || left.projectId !== right.projectId) {
    return false;
  }
  const leftTime = Date.parse(left.completedAt);
  const rightTime = Date.parse(right.completedAt);
  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    Math.abs(leftTime - rightTime) <= LOCAL_EVENT_MATCH_TOLERANCE_MS
  );
};

const parseCatalogProject = (value: unknown): ProjectCatalogProject | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const name = readNonEmptyString(value.name);
  const parentId = value.parentId === null ? null : readNonEmptyString(value.parentId);
  if (
    id === null ||
    name === null ||
    (value.parentId !== null && parentId === null) ||
    typeof value.childOrder !== "number" ||
    !Number.isFinite(value.childOrder)
  ) {
    return null;
  }
  return { id, parentId, name, childOrder: value.childOrder };
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const readTimestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
