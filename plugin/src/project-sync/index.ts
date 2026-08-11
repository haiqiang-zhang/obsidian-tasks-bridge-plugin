export {
  isAutomaticProjectSyncWriter,
  isProjectSyncPath,
  PROJECT_SYNC_QUIET_PERIOD_MS,
  ProjectSyncActivityTracker,
} from "./autoSync";
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
  ProjectCompletionEvent,
  ProjectSyncConfig,
  ProjectSyncConflict,
  ProjectSyncMapping,
  ProjectSyncMappingRoot,
  ProjectSyncProjectStatistics,
  ProjectSyncResult,
  ProjectSyncRunContext,
  ProjectSyncSnapshot,
  ProjectSyncSource,
  ProjectSyncStatisticsCounts,
  ProjectSyncStatisticsScope,
  ProjectSyncStatisticsSnapshot,
  ProjectSyncStatus,
  ProjectSyncStatusListener,
  ProjectSyncVault,
  ProjectTaskPage,
  SnapshotTask,
} from "./types";
export type { OpenFilePathsProvider, ProjectSyncInternalMutationRunner } from "./vault";
export { ObsidianProjectSyncVault } from "./vault";
