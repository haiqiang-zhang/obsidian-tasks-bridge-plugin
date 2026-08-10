export {
  applyManagedFrontmatter,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  MANAGED_FRONTMATTER_KEYS,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  replaceManagedBody,
} from "./document";
export { projectNamePath, selectProjectHierarchy } from "./hierarchy";
export {
  isPathInside,
  makeDisambiguatedProjectSegment,
  makeProjectSegments,
  makeTaskFilename,
  sanitizePathSegment,
} from "./paths";
export { ProjectFolderSyncService } from "./service";
export type {
  ProjectSyncConfig,
  ProjectSyncConflict,
  ProjectSyncMapping,
  ProjectSyncMappingRoot,
  ProjectSyncResult,
  ProjectSyncRunContext,
  ProjectSyncSnapshot,
  ProjectSyncSource,
  ProjectSyncStatus,
  ProjectSyncStatusListener,
  ProjectSyncVault,
  ProjectTaskPage,
  SnapshotTask,
} from "./types";
export type { OpenFilePathsProvider } from "./vault";
export { ObsidianProjectSyncVault } from "./vault";
