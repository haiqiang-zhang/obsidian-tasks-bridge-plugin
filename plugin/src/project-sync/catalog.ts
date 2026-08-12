import type { Project } from "@/api/domain/project";

import type { ProjectSyncMapping, ProjectSyncSnapshot } from "./types";

export const PROJECT_CATALOG_DATA_KEY = "projectSyncCatalogs";
export const PROJECT_CATALOG_SCHEMA_VERSION = 1;

export type ProjectCatalogProject = Pick<Project, "id" | "parentId" | "name" | "childOrder">;

export type ProjectCatalog = {
  mappingId: string;
  rootProjectId: string;
  includeSubprojects: boolean;
  syncedAt: string;
  projects: ProjectCatalogProject[];
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
});

export const readProjectCatalogCollection = (storedData: unknown): ProjectCatalogCollection => {
  if (!isRecord(storedData)) {
    return {};
  }
  const stored = storedData[PROJECT_CATALOG_DATA_KEY];
  if (
    !isRecord(stored) ||
    stored.version !== PROJECT_CATALOG_SCHEMA_VERSION ||
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
    }
  }
  return merged;
};

export const cloneProjectCatalog = (catalog: ProjectCatalog): ProjectCatalog => ({
  ...catalog,
  projects: catalog.projects.map((project) => ({ ...project })),
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
    !Array.isArray(value.projects)
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
  return {
    mappingId,
    rootProjectId,
    includeSubprojects: value.includeSubprojects,
    syncedAt,
    projects,
  };
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
