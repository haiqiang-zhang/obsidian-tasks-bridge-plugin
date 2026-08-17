export {
  isProjectSyncPath,
  ProjectSyncActivityTracker,
} from "./autoSync";
export {
  cloneProjectCatalog,
  makeProjectCatalog,
  mergeProjectCatalogCollections,
  PROJECT_CATALOG_DATA_KEY,
  type ProjectCatalog,
  type ProjectCatalogCollection,
  type ProjectCatalogStorage,
  parseProjectCatalog,
  readProjectCatalogCollection,
  withProjectCatalogCollection,
} from "./catalog";
export {
  applyManagedFrontmatter,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  MANAGED_FRONTMATTER_KEYS,
  MANAGED_TASK_CODE_BLOCK,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  replaceManagedBody,
} from "./document";
export {
  cloneProjectSyncFolderOwnershipRegistry,
  decodeProjectSyncFolderOwnershipRegistry,
  emptyProjectSyncFolderOwnershipRegistry,
  listOwnedFolders,
  type ManagedFolderCreation,
  type ManagedFolderOwnerKind,
  type ManagedFolderOwnership,
  type ManagedFolderPathTombstone,
  mergeProjectSyncFolderOwnershipRegistries,
  PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY,
  PROJECT_SYNC_FOLDER_OWNERSHIP_SCHEMA_VERSION,
  type ProjectSyncFolderOwnershipOpaqueData,
  type ProjectSyncFolderOwnershipReadResult,
  type ProjectSyncFolderOwnershipRegistry,
  type ProjectSyncFolderOwnershipStorage,
  readProjectSyncFolderOwnershipRegistry,
  recordCreatedFolders,
  releaseOwnedFolderPaths,
  withProjectSyncFolderOwnershipRegistry,
} from "./folderOwnership";
export { projectNamePath, selectProjectHierarchy } from "./hierarchy";
export {
  LEGACY_PROJECT_CATALOG_FOLDER,
  LEGACY_PROJECT_CATALOG_MARKER,
  legacyProjectCatalogPath,
  ObsidianProjectSyncStatisticsRepository,
} from "./localStatistics";
export {
  isPathInside,
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
  ProjectSyncStatisticsRepository,
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
