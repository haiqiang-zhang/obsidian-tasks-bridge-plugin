import { create } from "zustand";

import { sanitizePathSegment } from "@/project-sync/paths";

export type AddPageLinkSetting = "off" | "description" | "content";

export type AddTaskAction = "add" | "add-copy-app" | "add-copy-web";

export type DueDateDefaultSetting = "none" | "today" | "tomorrow";

export type TokenStorageSetting = "secrets" | "file";

export type ProjectDefaultSetting = {
  projectId: string;
  projectName: string;
} | null;

export type ProjectSyncProjectSetting = ProjectDefaultSetting;

export type ProjectSyncMapping = {
  id: string;
  project: ProjectDefaultSetting;
  folder: string;
  includeSubprojects: boolean;
  previousFolders: string[];
};

const defaultAutoRefreshInterval = 60;

export const normalizeAutoRefreshInterval = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : defaultAutoRefreshInterval;

let projectSyncMappingIdFallback = 0;

export const createProjectSyncMappingId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto);
  }

  projectSyncMappingIdFallback++;
  return `project-sync-${Date.now()}-${projectSyncMappingIdFallback}`;
};

export const createProjectSyncMapping = (): ProjectSyncMapping => ({
  id: createProjectSyncMappingId(),
  project: null,
  folder: "",
  includeSubprojects: false,
  previousFolders: [],
});

export const updateProjectSyncMappingFolder = (
  mapping: ProjectSyncMapping,
  folder: string,
  existingFolders: readonly string[],
): ProjectSyncMapping => {
  const currentFolder = normalizeExactProjectSyncFolder(mapping.folder);
  const nextFolder = normalizeExactProjectSyncFolder(folder);
  const existing = new Set(existingFolders.map(normalizeExactProjectSyncFolder));
  const previousFolders = mapping.previousFolders
    .map(normalizeExactProjectSyncFolder)
    .filter((candidate) => candidate !== "" && candidate !== nextFolder);

  if (
    currentFolder !== "" &&
    currentFolder !== nextFolder &&
    existing.has(currentFolder) &&
    !previousFolders.includes(currentFolder)
  ) {
    previousFolders.push(currentFolder);
  }

  return { ...mapping, folder, previousFolders };
};

export const updateProjectSyncMappingProject = (
  mapping: ProjectSyncMapping,
  project: ProjectDefaultSetting,
): ProjectSyncMapping => {
  if (mapping.project?.projectId === project?.projectId) {
    return { ...mapping, project };
  }

  return {
    ...mapping,
    id: createProjectSyncMappingId(),
    project,
    previousFolders: [],
  };
};

export type LabelsDefaultSetting = Array<{
  labelId: string;
  labelName: string;
}>;

const defaultSettings: Settings = {
  apiTokenSecretId: "swt-todoist-api-token",
  tokenStorage: "secrets",

  fadeToggle: true,

  autoRefreshToggle: false,
  autoRefreshInterval: defaultAutoRefreshInterval,

  projectSyncEnabled: false,
  projectSyncMappings: [],

  renderDateIcon: true,
  renderProjectIcon: true,
  renderLabelsIcon: true,

  shouldWrapLinksInParens: false,
  addTaskButtonAddsPageLink: "content",

  taskCreationDefaultDueDate: "none",

  taskCreationDefaultProject: null,

  taskCreationDefaultLabels: [],

  defaultAddTaskAction: "add",

  debugLogging: false,

  version: 0,
};

export type Settings = {
  apiTokenSecretId: string;
  tokenStorage: TokenStorageSetting;

  fadeToggle: boolean;
  autoRefreshToggle: boolean;
  autoRefreshInterval: number;

  projectSyncEnabled: boolean;
  projectSyncMappings: ProjectSyncMapping[];

  renderDateIcon: boolean;

  renderProjectIcon: boolean;

  renderLabelsIcon: boolean;

  shouldWrapLinksInParens: boolean;
  addTaskButtonAddsPageLink: AddPageLinkSetting;

  taskCreationDefaultDueDate: DueDateDefaultSetting;

  taskCreationDefaultProject: ProjectDefaultSetting;

  taskCreationDefaultLabels: LabelsDefaultSetting;

  defaultAddTaskAction: AddTaskAction;

  debugLogging: boolean;

  version: number;
};

export const useSettingsStore = create<Settings>(() => ({
  ...defaultSettings,
}));

export const normalizeSettings = (value: unknown): Settings => {
  const stored = isRecord(value) ? value : {};
  const normalized = { ...defaultSettings };
  const normalizedRecord = normalized as unknown as Record<string, unknown>;
  const storedKeys = new Set(Object.keys(stored));

  for (const key of Object.keys(defaultSettings) as Array<keyof Settings>) {
    if (key !== "projectSyncEnabled" && key !== "projectSyncMappings" && storedKeys.has(key)) {
      normalizedRecord[key] = stored[key];
    }
  }

  normalized.autoRefreshToggle = stored.autoRefreshToggle === true;
  normalized.autoRefreshInterval = normalizeAutoRefreshInterval(stored.autoRefreshInterval);

  normalized.projectSyncEnabled = stored.projectSyncEnabled === true;
  const mappings = normalizeStoredMappings(stored);
  normalized.projectSyncMappings = mappings.values;
  if (mappings.incompleteLegacyMapping || !hasCompleteProjectSyncMappings(mappings.values)) {
    normalized.projectSyncEnabled = false;
  }
  return normalized;
};

const hasCompleteProjectSyncMappings = (mappings: ProjectSyncMapping[]): boolean => {
  if (mappings.length === 0) {
    return false;
  }

  const projectIds = new Set<string>();
  const folders: Array<{ mappingId: string; path: string }> = [];
  for (const mapping of mappings) {
    const folder = normalizeStoredProjectSyncFolder(mapping.folder);
    if (mapping.project === null || folder === null || projectIds.has(mapping.project.projectId)) {
      return false;
    }
    projectIds.add(mapping.project.projectId);
    folders.push({ mappingId: mapping.id, path: folder });
    for (const previousFolder of mapping.previousFolders) {
      const previousPath = normalizeStoredProjectSyncFolder(previousFolder);
      if (previousPath !== null) {
        folders.push({ mappingId: mapping.id, path: previousPath });
      }
    }
  }

  return folders.every((folder, index) =>
    folders.every(
      (candidate, candidateIndex) =>
        index === candidateIndex ||
        candidate.mappingId === folder.mappingId ||
        (candidate.path !== folder.path &&
          !candidate.path.startsWith(`${folder.path}/`) &&
          !folder.path.startsWith(`${candidate.path}/`)),
    ),
  );
};

const normalizeStoredProjectSyncFolder = (folder: string): string | null => {
  const normalized = folder
    .trim()
    .normalize("NFC")
    .split("\\")
    .join("/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .toLocaleLowerCase("en-US");
  if (
    normalized === "" ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
};

type NormalizedMappings = {
  values: ProjectSyncMapping[];
  incompleteLegacyMapping: boolean;
};

const normalizeStoredMappings = (stored: Record<string, unknown>): NormalizedMappings => {
  if (Array.isArray(stored.projectSyncMappings)) {
    const mappingIds = new Set<string>();
    return {
      values: stored.projectSyncMappings.flatMap((value) => {
        const mapping = normalizeMapping(value);
        if (mapping === null) {
          return [];
        }
        if (mappingIds.has(mapping.id)) {
          mapping.id = createProjectSyncMappingId();
        }
        mappingIds.add(mapping.id);
        return [mapping];
      }),
      incompleteLegacyMapping: false,
    };
  }

  const legacyFolder = typeof stored.projectSyncFolder === "string" ? stored.projectSyncFolder : "";
  const legacyProject = normalizeProject(stored.projectSyncProject);
  const includeSubprojects = stored.projectSyncIncludeSubprojects === true;
  if (legacyFolder.trim() === "" && legacyProject === null) {
    return { values: [], incompleteLegacyMapping: false };
  }

  const complete = legacyFolder.trim() !== "" && legacyProject !== null;
  const folder = complete
    ? makeLegacyProjectFolder(legacyFolder, legacyProject.projectName)
    : legacyFolder;
  return {
    values: [
      {
        id: createProjectSyncMappingId(),
        project: legacyProject,
        folder,
        includeSubprojects,
        previousFolders: [],
      },
    ],
    incompleteLegacyMapping: !complete,
  };
};

const normalizeMapping = (value: unknown): ProjectSyncMapping | null => {
  if (!isRecord(value)) {
    return null;
  }
  const folder = typeof value.folder === "string" ? value.folder : "";
  const normalizedFolder = normalizeExactProjectSyncFolder(folder);
  const previousFolders = Array.isArray(value.previousFolders)
    ? Array.from(
        new Set(
          value.previousFolders.flatMap((candidate) => {
            if (typeof candidate !== "string") {
              return [];
            }
            const normalized = normalizeExactProjectSyncFolder(candidate);
            if (
              normalized === "" ||
              normalized === normalizedFolder ||
              normalized.split("/").some((segment) => segment === "." || segment === "..")
            ) {
              return [];
            }
            return [normalized];
          }),
        ),
      )
    : [];
  return {
    id:
      typeof value.id === "string" && value.id.trim() !== ""
        ? value.id.trim()
        : createProjectSyncMappingId(),
    project: normalizeProject(value.project),
    folder,
    includeSubprojects: value.includeSubprojects === true,
    previousFolders,
  };
};

const normalizeExactProjectSyncFolder = (folder: string): string =>
  folder
    .trim()
    .split("\\")
    .join("/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");

const normalizeProject = (value: unknown): ProjectDefaultSetting => {
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    value.projectId.trim() === "" ||
    typeof value.projectName !== "string"
  ) {
    return null;
  }
  return { projectId: value.projectId, projectName: value.projectName };
};

const makeLegacyProjectFolder = (container: string, projectName: string): string => {
  const normalizedContainer = container
    .trim()
    .split("\\")
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
  const projectSegment = sanitizePathSegment(projectName, "Untitled project");
  return `${normalizedContainer}/${projectSegment}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
