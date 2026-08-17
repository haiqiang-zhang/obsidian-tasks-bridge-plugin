import {
  type FileManager,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
  type TAbstractFile,
  TFile,
  type TFolder,
  type Vault,
} from "obsidian";

import { todoistTimestampSchema } from "@/api/domain/task";

import {
  makeProjectCatalog,
  mergeProjectCompletionEvents,
  type ProjectCatalog,
  type ProjectCatalogStorage,
} from "./catalog";
import {
  applyManagedTaskRelationships,
  isRecoverableManagedFrontmatterResidue,
  MANAGED_BODY_START,
  ManagedBodyConflictError,
  type ManagedFrontmatter,
  type ManagedNoteIdentity,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  readRecoverableManagedNoteIdentity,
  readUserOwnedTaskDocument,
  renderNewTaskDocument,
  renderTaskDocumentWithUserContent,
  replaceManagedTaskDocument,
  type UserOwnedTaskDocument,
} from "./document";
import type { ManagedFolderCreation, ProjectSyncFolderOwnershipStorage } from "./folderOwnership";
import { projectHierarchyPath } from "./hierarchy";
import {
  isPathInside,
  makeProjectFolderSegment,
  makeTaskFilename,
  makeTaskFolderSegment,
} from "./paths";
import type {
  ProjectSyncConfig,
  ProjectSyncConflict,
  ProjectSyncMapping,
  ProjectSyncResult,
  ProjectSyncRunContext,
  ProjectSyncSnapshot,
  SnapshotTask,
} from "./types";

export type OpenFilePathsProvider = () => Iterable<string>;
export type ProjectSyncInternalMutationRunner = <T>(
  affectedPaths: readonly string[],
  operation: () => Promise<T>,
) => Promise<T>;

type ManagedFile = {
  file: TFile;
  identity: ManagedNoteIdentity;
  frontmatter: ManagedFrontmatter;
  projectionRoot: string;
  recoveredMalformed?: true;
};

type TrashedStagedManagedNote = {
  taskId: string;
  path: string;
  content: string;
  addedUserDocument: boolean;
};

type ResolvedMappingRoot = {
  mappingId: string;
  rootProjectId: string;
  path: string;
  active: boolean;
};

type TaskFilePlan = {
  depth: number;
  folder: string;
  path: string;
  ownsFolder: boolean;
};

type CanonicalProjectionPlan = {
  folderKeys: ReadonlySet<string>;
  fileTaskIdsByKey: ReadonlyMap<string, string>;
  fileKeysByTaskId: ReadonlyMap<string, string>;
  taskFolderTaskIdsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  projectFoldersById: ReadonlyMap<string, string>;
  taskFilePlansById: ReadonlyMap<string, TaskFilePlan>;
};

type ProjectedTaskFile = {
  file: TFile;
  relationshipFrontmatter: ManagedFrontmatter;
  outcome: "created" | "updated" | "unchanged";
};

type ManagedFileScan = {
  configuredByTaskId: Map<string, ManagedFile[]>;
  ownedByTaskId: Map<string, ManagedFile[]>;
  creationFencePaths: string[];
  unresolvedHistoricalOwnership: boolean;
};

type ProtectedProjectionPreflight = {
  blockedFolderKeys: ReadonlySet<string>;
  blockedTaskIds: ReadonlySet<string>;
};

type CreatedFolderObservation = {
  creation: ManagedFolderCreation;
  folder: TFolder;
};

type IndexedVaultFile = {
  file: TFile;
  content: string;
  frontmatter?: ManagedFrontmatter;
  identity?: ManagedNoteIdentity | null;
  recoveredIdentity?: ManagedNoteIdentity;
  parseError?: string;
};

type LiveManagedNote = {
  content: string;
  contentStart: number;
  frontmatter: ManagedFrontmatter;
  identity: ManagedNoteIdentity;
};

type ManagedFrontMatterInfo = {
  exists: boolean;
  frontmatter: string;
  contentStart: number;
};

const YAML_DELIMITER_WITH_LEADING_LINE_BREAK = "\n---";
const YAML_OPENING_LENGTH = 4;

const emptyResult = (): ProjectSyncResult => ({
  created: 0,
  updated: 0,
  moved: 0,
  unchanged: 0,
  deleted: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  pausedMappingIds: [],
  settledMappingIds: [],
});

const emptyProtectedProjectionPreflight = (): ProtectedProjectionPreflight => ({
  blockedFolderKeys: new Set(),
  blockedTaskIds: new Set(),
});

const alwaysValidRun: ProjectSyncRunContext = { assertValid: () => undefined };
const runMutationDirectly: ProjectSyncInternalMutationRunner = async (_affectedPaths, operation) =>
  await operation();

class ActiveManagedNoteError extends Error {}
class ManagedNoteIdentityConflictError extends Error {}
class ManagedPathRaceError extends Error {}
class NoManagedDocumentChangeError extends Error {}
class DuplicateManagedNoteConflictError extends Error {}

class PortableVaultPathIndex {
  private readonly occupantsByPath = new Map<string, Set<TAbstractFile>>();

  constructor(files: readonly TAbstractFile[]) {
    for (const file of files) {
      this.add(file);
    }
  }

  public add(file: TAbstractFile, path = file.path): void {
    const key = portablePathKey(path);
    const occupants = this.occupantsByPath.get(key) ?? new Set<TAbstractFile>();
    occupants.add(file);
    this.occupantsByPath.set(key, occupants);
  }

  public move(file: TAbstractFile, oldPath: string, newPath: string): void {
    const oldKey = portablePathKey(oldPath);
    const oldOccupants = this.occupantsByPath.get(oldKey);
    oldOccupants?.delete(file);
    if (oldOccupants?.size === 0) {
      this.occupantsByPath.delete(oldKey);
    }
    this.add(file, newPath);
  }

  public remove(file: TAbstractFile, path = file.path): void {
    const key = portablePathKey(path);
    const occupants = this.occupantsByPath.get(key);
    occupants?.delete(file);
    if (occupants?.size === 0) {
      this.occupantsByPath.delete(key);
    }
  }

  public occupants(path: string, current?: TAbstractFile): TAbstractFile[] {
    return [...(this.occupantsByPath.get(portablePathKey(path)) ?? [])].filter(
      (occupant) => occupant !== current,
    );
  }
}

export class ObsidianProjectSyncVault {
  private readonly vault: Vault;
  private readonly fileManager: FileManager;
  private readonly openFilePaths: OpenFilePathsProvider;
  private readonly runInternalMutation: ProjectSyncInternalMutationRunner;
  private readonly catalogStorage?: ProjectCatalogStorage;
  private readonly folderOwnershipStorage?: ProjectSyncFolderOwnershipStorage;
  private readonly managedFileIndexes = new WeakMap<object, Promise<IndexedVaultFile[]>>();

  constructor(
    vault: Vault,
    fileManager: FileManager,
    openFilePaths: OpenFilePathsProvider,
    runInternalMutation: ProjectSyncInternalMutationRunner = runMutationDirectly,
    catalogStorage?: ProjectCatalogStorage,
    folderOwnershipStorage?: ProjectSyncFolderOwnershipStorage,
  ) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.openFilePaths = openFilePaths;
    this.runInternalMutation = runInternalMutation;
    this.catalogStorage = catalogStorage;
    this.folderOwnershipStorage = folderOwnershipStorage;
  }

  public validateConfig(config: ProjectSyncConfig): void {
    if (config.mappings.length === 0) {
      throw new Error("Project sync requires at least one project mapping");
    }

    const mappingIds = new Set<string>();
    const folders = config.mappings.flatMap((mapping, index) => {
      if (mapping.project === null) {
        throw new Error(`Project sync mapping ${index + 1} requires a Todoist project`);
      }
      if (mapping.id.trim() === "" || mappingIds.has(mapping.id)) {
        throw new Error(`Project sync mapping ${index + 1} requires a unique mapping ID`);
      }
      mappingIds.add(mapping.id);

      const path = this.validateRootFolder(mapping.folder);
      const roots = [{ mappingId: mapping.id, path, portablePath: portablePathKey(path) }];
      for (const previousFolder of mapping.previousFolders) {
        const previousPath = this.tryResolveExistingRootFolder(previousFolder);
        if (previousPath !== null) {
          roots.push({
            mappingId: mapping.id,
            path: previousPath,
            portablePath: portablePathKey(previousPath),
          });
        }
      }
      return roots;
    });

    for (let leftIndex = 0; leftIndex < folders.length; leftIndex++) {
      const left = folders[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < folders.length; rightIndex++) {
        const right = folders[rightIndex];
        if (left.mappingId === right.mappingId) {
          continue;
        }
        if (!portablePathsOverlap(left.portablePath, right.portablePath)) {
          continue;
        }

        throw new Error(
          `Project sync folders '${left.path}' and '${right.path}' overlap; each mapping requires a separate folder`,
        );
      }
    }
  }

  public validateSnapshot(snapshot: ProjectSyncSnapshot, mapping: ProjectSyncMapping): void {
    if (mapping.project === null || mapping.project.projectId !== snapshot.rootProjectId) {
      throw new Error("Project sync snapshot does not match its configured Todoist project");
    }
    validateCanonicalProjectionPaths(snapshot, this.validateRootFolder(mapping.folder));
  }

  public async reconcile(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    runContext: ProjectSyncRunContext = alwaysValidRun,
  ): Promise<ProjectSyncResult> {
    runContext.assertValid();
    if (mapping.project === null || mapping.project.projectId !== snapshot.rootProjectId) {
      throw new Error("Project sync snapshot does not match its configured Todoist project");
    }
    const rootPath = this.validateRootFolder(mapping.folder);
    const canonicalProjection = makeCanonicalProjectionPlan(snapshot, rootPath);
    const result = emptyResult();
    const previousCatalog = this.catalogStorage?.getCatalog(mapping.id) ?? null;
    const missingHistoricalRoot = mapping.previousFolders.some(
      (folder) => this.tryResolveExistingRootFolder(folder) === null,
    );
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const configuredRoots = this.resolveConfiguredRoots(
      mapping.id,
      snapshot.rootProjectId,
      rootPath,
      mapping.previousFolders,
      runContext,
    );
    const {
      configuredByTaskId,
      ownedByTaskId: managedById,
      creationFencePaths,
      unresolvedHistoricalOwnership,
    } = await this.scanManagedFiles(
      mapping.id,
      snapshot.rootProjectId,
      rootPath,
      configuredRoots,
      result.conflicts,
      runContext,
    );
    const desiredIds = new Set(snapshot.tasks.map(({ task }) => task.id));
    const stagedUserDocuments =
      runContext.stagedUserDocumentsByTaskId ?? new Map<string, UserOwnedTaskDocument>();
    const protectedProjection =
      runContext.preserveUnmanagedItems === false
        ? emptyProtectedProjectionPreflight()
        : this.preflightProtectedProjection(canonicalProjection, configuredByTaskId, result);
    const projectionReady = await this.cleanupExclusiveRoot(
      mapping,
      rootPath,
      desiredIds,
      canonicalProjection,
      configuredByTaskId,
      managedById,
      stagedUserDocuments,
      protectedProjection.blockedTaskIds,
      result,
      runContext,
    );
    if (!projectionReady) {
      if (runContext.scanToken !== undefined) {
        this.managedFileIndexes.delete(runContext.scanToken);
      }
      return result;
    }
    const liveCreationFencePaths = creationFencePaths.filter(
      (path) => this.vault.getAbstractFileByPath(path) !== null,
    );
    const projectFolders = await this.ensureProjectFolders(
      canonicalProjection,
      mapping,
      rootPath,
      protectedProjection.blockedFolderKeys,
      runContext,
    );
    runContext.assertValid();
    const pathIndex = new PortableVaultPathIndex(this.vault.getAllLoadedFiles());
    const managedFiles = new Set<TFile>(
      [...configuredByTaskId.values()].flatMap((files) => files.map(({ file }) => file)),
    );
    const taskFilePlans = await this.ensureTaskFilePlans(
      snapshot.tasks,
      canonicalProjection,
      projectFolders,
      configuredByTaskId,
      managedFiles,
      rootPath,
      pathIndex,
      mapping,
      protectedProjection.blockedTaskIds,
      runContext,
    );
    runContext.assertValid();
    const completionEventsByTaskId = groupCompletionEventsByTaskId(snapshot.completionEvents ?? []);
    const projectedFilesByTaskId = new Map<string, ProjectedTaskFile>();
    const conflictedIds = new Set<string>();

    const orderedSnapshotTasks = [...snapshot.tasks].sort((left, right) => {
      const depthComparison =
        (taskFilePlans.get(left.task.id)?.depth ?? 0) -
        (taskFilePlans.get(right.task.id)?.depth ?? 0);
      return depthComparison === 0
        ? compareStableIds(left.task.id, right.task.id)
        : depthComparison;
    });
    for (const snapshotTask of orderedSnapshotTasks) {
      runContext.assertValid();
      const taskId = snapshotTask.task.id;
      if (conflictedIds.has(taskId) || protectedProjection.blockedTaskIds.has(taskId)) {
        continue;
      }

      const taskFilePlan = taskFilePlans.get(taskId);
      if (taskFilePlan === undefined) {
        result.conflicts.push({
          taskId,
          message: `Task '${taskId}' belongs to a project outside the selected hierarchy`,
          projectionBlocked: true,
        });
        continue;
      }

      const projectPath = projectHierarchyPath(snapshotTask.task.project.id, projects);
      const desiredFrontmatter = makeTaskFrontmatter(
        snapshotTask,
        snapshot.rootProjectId,
        projectPath,
        snapshot.syncedAt,
        mapping.id,
        completionEventsByTaskId.get(taskId) ?? [],
      );
      const desiredBody = makeManagedBody(snapshotTask.task);
      // A duplicate is scoped to this selected mapping/root plus Todoist's immutable task ID.
      // Same-ID notes owned by another configured mapping are migration candidates, not copies
      // that this mapping may discard.
      const duplicateFiles = configuredByTaskId.get(taskId) ?? [];
      if (duplicateFiles.length > 1) {
        try {
          const reconciled = await this.reconcileDuplicateManagedFiles(
            duplicateFiles,
            desiredFrontmatter,
            desiredBody,
            taskFilePlan.path,
            rootPath,
            pathIndex,
            managedFiles,
            runContext,
          );
          configuredByTaskId.set(taskId, [reconciled.managed]);
          managedById.set(taskId, [reconciled.managed]);
          result.updated += reconciled.updated ? 1 : 0;
          result.moved += reconciled.moved ? 1 : 0;
          if (!reconciled.updated && !reconciled.moved) {
            result.unchanged++;
          }
          projectedFilesByTaskId.set(taskId, {
            file: reconciled.managed.file,
            relationshipFrontmatter: { ...desiredFrontmatter },
            outcome: reconciled.updated || reconciled.moved ? "updated" : "unchanged",
          });
          continue;
        } catch (error: unknown) {
          if (error instanceof ActiveManagedNoteError) {
            this.recordDeferred(
              result,
              taskId,
              duplicateFiles.map(({ file }) => file.path).join(", "),
              error.message,
            );
            continue;
          }
          if (!(error instanceof DuplicateManagedNoteConflictError)) {
            throw error;
          }
          conflictedIds.add(taskId);
          result.conflicts.push({
            taskId,
            message: error.message,
            path: duplicateFiles
              .map(({ file }) => file.path)
              .sort(comparePortablePaths)
              .join(", "),
            projectionBlocked: true,
          });
          continue;
        }
      }
      const migrationCandidates = configuredByTaskId.get(taskId) ?? [];
      if (migrationCandidates.length > 1) {
        conflictedIds.add(taskId);
        result.conflicts.push({
          taskId,
          path: migrationCandidates
            .map(({ file }) => file.path)
            .sort(comparePortablePaths)
            .join(", "),
          message: `Multiple managed notes use Todoist task ID '${taskId}' outside the current mapping identity; all copies were preserved`,
          projectionBlocked: true,
        });
        continue;
      }
      // A task can move from one mapped Todoist project to another. Reuse the one managed note
      // found anywhere inside the configured mapping roots so its user-authored content moves
      // with it instead of creating a duplicate in the destination mapping.
      const existing = configuredByTaskId.get(taskId)?.[0];
      if (existing === undefined && liveCreationFencePaths.length > 0) {
        result.conflicts.push({
          taskId,
          path: liveCreationFencePaths.join(", "),
          message:
            "Task-note creation was blocked because a likely managed note has unreadable frontmatter in this mapping; repair that note before synchronizing again",
          projectionBlocked: true,
        });
        continue;
      }
      const targetPath = this.resolveAvailableTaskFilePath(
        taskFilePlan.path,
        existing?.file,
        rootPath,
        pathIndex,
      );

      try {
        if (existing === undefined) {
          runContext.assertValid();
          const stagedUserDocument = stagedUserDocuments.get(taskId);
          const created = await this.createManagedFile(
            targetPath,
            stagedUserDocument === undefined
              ? renderNewTaskDocument(desiredFrontmatter, desiredBody)
              : renderTaskDocumentWithUserContent(
                  desiredFrontmatter,
                  desiredBody,
                  stagedUserDocument,
                ),
            runContext,
          );
          pathIndex.add(created);
          managedFiles.add(created);
          projectedFilesByTaskId.set(taskId, {
            file: created,
            relationshipFrontmatter: { ...desiredFrontmatter },
            outcome: "created",
          });
          runContext.assertValid();
          result.created++;
          stagedUserDocuments.delete(taskId);
          continue;
        }

        const update = await this.updateManagedFile(
          existing,
          desiredFrontmatter,
          desiredBody,
          targetPath,
          pathIndex,
          runContext,
        );
        if (update.moved) {
          result.moved++;
        }
        if (update.updated) {
          result.updated++;
        }
        if (!update.moved && !update.updated) {
          result.unchanged++;
        }
        projectedFilesByTaskId.set(taskId, {
          file: existing.file,
          relationshipFrontmatter: { ...existing.frontmatter },
          outcome: update.moved || update.updated ? "updated" : "unchanged",
        });
        stagedUserDocuments.delete(taskId);
      } catch (error: unknown) {
        if (error instanceof ActiveManagedNoteError) {
          this.recordDeferred(result, taskId, existing?.file.path, error.message);
          continue;
        }
        if (
          !(error instanceof ManagedBodyConflictError) &&
          !(error instanceof ManagedNoteIdentityConflictError) &&
          !(error instanceof ManagedPathRaceError)
        ) {
          throw error;
        }
        result.conflicts.push({
          taskId,
          path: existing?.file.path ?? targetPath,
          message: error.message,
          projectionBlocked: true,
        });
      }
    }

    await this.projectTaskRelationships(
      orderedSnapshotTasks,
      projectedFilesByTaskId,
      result,
      runContext,
    );

    const orderedManagedEntries = [...managedById].sort(([left], [right]) =>
      compareStableIds(left, right),
    );
    for (const [taskId, files] of orderedManagedEntries) {
      runContext.assertValid();
      if (desiredIds.has(taskId) || conflictedIds.has(taskId)) {
        continue;
      }

      // A task can move between configured mappings in one complete multi-project snapshot.
      // Let the destination mapping move its existing file instead of treating it as deleted.
      const existsInAnotherSnapshot = runContext.allSnapshotTaskIds?.has(taskId) === true;
      if (!existsInAnotherSnapshot) {
        const retained: ManagedFile[] = [];
        for (const managed of files) {
          try {
            await this.trashMissingManagedFile(managed, runContext);
          } catch (error: unknown) {
            retained.push(managed);
            if (error instanceof ActiveManagedNoteError) {
              this.recordDeferred(result, taskId, managed.file.path, error.message);
              continue;
            }
            if (
              error instanceof ManagedNoteIdentityConflictError ||
              error instanceof ManagedPathRaceError
            ) {
              result.conflicts.push({
                taskId,
                path: managed.file.path,
                message: error.message,
                projectionBlocked: true,
              });
              continue;
            }
            throw error;
          }
          pathIndex.remove(managed.file);
          managedFiles.delete(managed.file);
          result.deleted++;
        }
        if (retained.length === 0) {
          managedById.delete(taskId);
        } else {
          managedById.set(taskId, retained);
        }
      }

      // The task belongs to another complete snapshot in this same batch. Leave every file in
      // place for that destination mapping, which will collapse the global same-ID set and move one
      // canonical note to the deterministic destination path.
    }

    await this.cleanupEmptyNonCanonicalFolders(
      mapping,
      rootPath,
      canonicalProjection.folderKeys,
      runContext,
    );

    const historicalOwnedNoteRemains = [...managedById.values()].some((files) =>
      files.some(({ file }) => !isPathInside(rootPath, normalizePath(file.path))),
    );
    if (
      mapping.previousFolders.length > 0 &&
      !missingHistoricalRoot &&
      !unresolvedHistoricalOwnership &&
      !historicalOwnedNoteRemains
    ) {
      result.settledMappingIds.push(mapping.id);
    }

    await this.persistCatalogState(snapshot, mapping, previousCatalog, managedById, runContext);
    if (runContext.scanToken !== undefined) {
      this.managedFileIndexes.delete(runContext.scanToken);
    }

    return result;
  }

  /**
   * Reserve user-owned Vault entries before any managed note is staged. A static user collision
   * blocks only the affected Todoist task or subtree, so unrelated remote renames and deletions
   * still reconcile in the same complete snapshot.
   */
  private preflightProtectedProjection(
    canonicalProjection: CanonicalProjectionPlan,
    configuredByTaskId: ReadonlyMap<string, readonly ManagedFile[]>,
    result: ProjectSyncResult,
  ): ProtectedProjectionPreflight {
    const managedTaskIdByFile = new Map<TFile, string>();
    for (const [taskId, files] of configuredByTaskId) {
      for (const { file } of files) {
        managedTaskIdByFile.set(file, taskId);
      }
    }

    const pathIndex = new PortableVaultPathIndex(this.vault.getAllLoadedFiles());
    const blockedFolderKeys = new Set<string>();
    const blockedTaskIds = new Set<string>();
    const reported = new Set<string>();
    const canonicalFolders = new Map<string, string>();
    for (const path of canonicalProjection.projectFoldersById.values()) {
      canonicalFolders.set(portablePathKey(path), path);
    }
    for (const plan of canonicalProjection.taskFilePlansById.values()) {
      if (plan.ownsFolder) {
        canonicalFolders.set(portablePathKey(plan.folder), plan.folder);
      }
    }

    const blockFolder = (
      path: string,
      occupant: TAbstractFile,
      blockingManagedTaskId?: string,
    ): boolean => {
      let changed = false;
      for (const [folderKey, folderPath] of canonicalFolders) {
        if (isPathInside(path, folderPath) && !blockedFolderKeys.has(folderKey)) {
          blockedFolderKeys.add(folderKey);
          changed = true;
        }
      }
      for (const [taskId, plan] of canonicalProjection.taskFilePlansById) {
        if (isPathInside(path, plan.path) && !blockedTaskIds.has(taskId)) {
          blockedTaskIds.add(taskId);
          changed = true;
        }
      }
      const reportKey = `folder\u0000${portablePathKey(path)}\u0000${occupant.path}`;
      if (!reported.has(reportKey)) {
        reported.add(reportKey);
        result.conflicts.push({
          path: occupant.path,
          message:
            blockingManagedTaskId === undefined
              ? `Canonical Todoist folder '${path}' is occupied by an unmanaged Vault entry; the entry and affected Todoist subtree were preserved`
              : `Canonical Todoist folder '${path}' cannot be prepared because managed task '${blockingManagedTaskId}' is blocked at another protected Vault path; both affected projections were preserved`,
          projectionBlocked: true,
        });
      }
      return changed;
    };

    const blockTask = (
      taskId: string,
      path: string,
      occupant: TAbstractFile,
      blockingManagedTaskId?: string,
    ): boolean => {
      const changed = !blockedTaskIds.has(taskId);
      blockedTaskIds.add(taskId);
      const reportKey = `task\u0000${taskId}\u0000${occupant.path}`;
      if (!reported.has(reportKey)) {
        reported.add(reportKey);
        result.conflicts.push({
          taskId,
          path: occupant.path,
          message:
            blockingManagedTaskId === undefined
              ? `Canonical Todoist task note '${path}' is occupied by an unmanaged Vault entry; the entry was preserved`
              : `Canonical Todoist task note '${path}' cannot be prepared because managed task '${blockingManagedTaskId}' is blocked at another protected Vault path; both affected projections were preserved`,
          projectionBlocked: true,
        });
      }
      return changed;
    };

    // Blocking one desired task can make an old managed note for that task unable to vacate a
    // different canonical path. Iterate until that dependency propagation reaches a fixed point.
    const maximumPasses = canonicalFolders.size + canonicalProjection.taskFilePlansById.size + 1;
    for (let pass = 0; pass < maximumPasses; pass++) {
      let changed = false;
      for (const [folderKey, path] of canonicalFolders) {
        if (blockedFolderKeys.has(folderKey)) {
          continue;
        }
        const exactFolder = this.vault.getFolderByPath(path);
        for (const occupant of pathIndex.occupants(path)) {
          if (exactFolder !== null && occupant === exactFolder) {
            continue;
          }
          const managedTaskId =
            occupant instanceof TFile ? managedTaskIdByFile.get(occupant) : null;
          if (typeof managedTaskId === "string" && !blockedTaskIds.has(managedTaskId)) {
            continue;
          }
          changed =
            blockFolder(
              path,
              occupant,
              typeof managedTaskId === "string" ? managedTaskId : undefined,
            ) || changed;
          break;
        }
      }

      for (const [taskId, plan] of canonicalProjection.taskFilePlansById) {
        if (blockedTaskIds.has(taskId)) {
          continue;
        }
        for (const occupant of pathIndex.occupants(plan.path)) {
          const managedTaskId =
            occupant instanceof TFile ? managedTaskIdByFile.get(occupant) : null;
          if (
            typeof managedTaskId === "string" &&
            (managedTaskId === taskId || !blockedTaskIds.has(managedTaskId))
          ) {
            continue;
          }
          changed =
            blockTask(
              taskId,
              plan.path,
              occupant,
              typeof managedTaskId === "string" ? managedTaskId : undefined,
            ) || changed;
          break;
        }
      }
      if (!changed) {
        break;
      }
    }

    return { blockedFolderKeys, blockedTaskIds };
  }

  /**
   * Reconcile obsolete entries before canonical folders and filenames are created. In the default
   * protected mode, only positively identified Todoist task notes are mutable. The legacy
   * exclusive-mirror sweep remains available only when the user explicitly disables protection.
   */
  private async cleanupExclusiveRoot(
    mapping: ProjectSyncMapping,
    rootPath: string,
    desiredIds: ReadonlySet<string>,
    canonicalProjection: CanonicalProjectionPlan,
    configuredByTaskId: Map<string, ManagedFile[]>,
    managedById: Map<string, ManagedFile[]>,
    stagedUserDocuments: Map<string, UserOwnedTaskDocument>,
    blockedTaskIds: ReadonlySet<string>,
    result: ProjectSyncResult,
    runContext: ProjectSyncRunContext,
  ): Promise<boolean> {
    const completeSnapshotIds = runContext.allSnapshotTaskIds ?? desiredIds;
    const managedByFile = new Map<TFile, ManagedFile>();
    for (const files of [...configuredByTaskId.values(), ...managedById.values()]) {
      for (const managed of files) {
        managedByFile.set(managed.file, managed);
      }
    }

    const files = this.vault
      .getAllLoadedFiles()
      .filter(
        (entry): entry is TFile =>
          entry instanceof TFile && isPathInside(rootPath, normalizePath(entry.path)),
      )
      .sort((left, right) => comparePortablePaths(left.path, right.path));
    let projectionBlocked = false;
    for (const file of files) {
      const managed = managedByFile.get(file);
      if (managed === undefined) {
        continue;
      }
      if (blockedTaskIds.has(managed.identity.taskId)) {
        continue;
      }
      const belongsToCompleteSnapshot = completeSnapshotIds.has(managed.identity.taskId);
      const mustStageManagedNote =
        belongsToCompleteSnapshot &&
        this.mustStageForCanonicalProjection(managed, canonicalProjection);
      if (belongsToCompleteSnapshot && !mustStageManagedNote) {
        continue;
      }
      try {
        this.assertBackgroundFile(file);
      } catch (error: unknown) {
        if (!(error instanceof ActiveManagedNoteError)) {
          throw error;
        }
        this.recordDeferred(result, managed.identity.taskId, file.path, error.message);
        projectionBlocked = true;
      }
    }
    if (projectionBlocked) {
      return false;
    }

    const trashedStagedNotes: TrashedStagedManagedNote[] = [];
    for (const file of files) {
      runContext.assertValid();
      const managed = managedByFile.get(file);
      if (managed === undefined && runContext.preserveUnmanagedItems !== false) {
        continue;
      }
      if (managed !== undefined && blockedTaskIds.has(managed.identity.taskId)) {
        continue;
      }
      const belongsToCompleteSnapshot =
        managed !== undefined && completeSnapshotIds.has(managed.identity.taskId);
      const mustStageManagedNote =
        belongsToCompleteSnapshot &&
        this.mustStageForCanonicalProjection(managed, canonicalProjection);
      if (belongsToCompleteSnapshot && !mustStageManagedNote) {
        continue;
      }

      const path = normalizePath(file.path);
      let stagedUserDocument: UserOwnedTaskDocument | undefined;
      let stagedOriginalContent: string | undefined;
      try {
        if (managed !== undefined) {
          this.assertBackgroundFile(file);
        }
        await this.runInternalMutation([path], async () => {
          runContext.assertValid();
          if (this.vault.getAbstractFileByPath(path) !== file) {
            throw new ManagedPathRaceError(
              `Exclusive Project sync entry '${path}' changed before it could be moved to trash`,
            );
          }
          if (managed !== undefined) {
            if (managed.recoveredMalformed === true) {
              const content = await this.vault.read(file);
              this.assertRecoverableManagedIdentity(content, managed.identity, path);
              if (mustStageManagedNote) {
                stagedOriginalContent = content;
                stagedUserDocument = this.readRecoverableUserDocument(content, path);
              }
            } else {
              const live = await this.readLiveManagedNote(file);
              this.assertSameManagedIdentity(managed.identity, live.identity, path);
              if (mustStageManagedNote) {
                stagedOriginalContent = live.content;
                stagedUserDocument = readUserOwnedTaskDocument(
                  live.content,
                  live.frontmatter,
                  live.contentStart,
                );
              }
            }
          }
          await this.fileManager.trashFile(file);
        });
      } catch (error: unknown) {
        if (error instanceof ActiveManagedNoteError && managed !== undefined) {
          this.recordDeferred(result, managed.identity.taskId, path, error.message);
          projectionBlocked = true;
          break;
        }
        if (
          !(error instanceof ManagedNoteIdentityConflictError) &&
          !(error instanceof ManagedPathRaceError)
        ) {
          throw error;
        }
        result.conflicts.push({
          taskId: managed?.identity.taskId,
          path,
          message: error.message,
          projectionBlocked: true,
        });
        projectionBlocked = true;
        // Do not retry the same stale scan entry later in this run. The file was deliberately
        // preserved because its live path or Todoist identity changed; the next complete scan will
        // classify that new live state from scratch.
        if (managed !== undefined && !belongsToCompleteSnapshot) {
          removeManagedFile(configuredByTaskId, file);
          removeManagedFile(managedById, file);
        }
        break;
      }
      let addedUserDocument = false;
      if (
        mustStageManagedNote &&
        managed !== undefined &&
        stagedUserDocument !== undefined &&
        !stagedUserDocuments.has(managed.identity.taskId)
      ) {
        stagedUserDocuments.set(managed.identity.taskId, stagedUserDocument);
        addedUserDocument = true;
      }
      if (mustStageManagedNote && managed !== undefined && stagedOriginalContent !== undefined) {
        trashedStagedNotes.push({
          taskId: managed.identity.taskId,
          path,
          content: stagedOriginalContent,
          addedUserDocument,
        });
      }
      removeManagedFile(configuredByTaskId, file);
      removeManagedFile(managedById, file);
      result.deleted++;
    }

    if (projectionBlocked) {
      await this.restoreStagedCleanupNotes(
        trashedStagedNotes,
        stagedUserDocuments,
        result,
        runContext,
      );
      return false;
    }

    await this.cleanupEmptyNonCanonicalFolders(
      mapping,
      rootPath,
      canonicalProjection.folderKeys,
      runContext,
    );
    return true;
  }

  private async restoreStagedCleanupNotes(
    stagedNotes: readonly TrashedStagedManagedNote[],
    stagedUserDocuments: Map<string, UserOwnedTaskDocument>,
    result: ProjectSyncResult,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    for (const staged of [...stagedNotes].reverse()) {
      runContext.assertValid();
      if (this.vault.getAbstractFileByPath(staged.path) !== null) {
        result.conflicts.push({
          taskId: staged.taskId,
          path: staged.path,
          message: `Could not restore staged managed note '${staged.path}' because the path became occupied; the original remains recoverable from the configured trash`,
          projectionBlocked: true,
        });
        continue;
      }
      try {
        await this.runInternalMutation(
          [staged.path],
          async () => await this.vault.create(staged.path, staged.content),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        result.conflicts.push({
          taskId: staged.taskId,
          path: staged.path,
          message: `Could not restore staged managed note '${staged.path}'; the original remains recoverable from the configured trash: ${message}`,
          projectionBlocked: true,
        });
        continue;
      }
      if (staged.addedUserDocument) {
        stagedUserDocuments.delete(staged.taskId);
      }
      result.deleted = Math.max(0, result.deleted - 1);
    }
  }

  private async cleanupEmptyNonCanonicalFolders(
    mapping: ProjectSyncMapping,
    rootPath: string,
    canonicalFolderKeys: ReadonlySet<string>,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    if (runContext.preserveUnmanagedItems !== false) {
      await this.cleanupOwnedEmptyNonCanonicalFolders(
        mapping,
        rootPath,
        canonicalFolderKeys,
        runContext,
      );
      return;
    }

    const folders = this.vault
      .getAllLoadedFiles()
      .filter((entry) => {
        const path = normalizePath(entry.path);
        return !(entry instanceof TFile) && path !== rootPath && isPathInside(rootPath, path);
      })
      .sort((left, right) => {
        const depth = right.path.split("/").length - left.path.split("/").length;
        return depth === 0 ? comparePortablePaths(left.path, right.path) : depth;
      });
    for (const candidate of folders) {
      runContext.assertValid();
      const path = normalizePath(candidate.path);
      const folder = this.vault.getFolderByPath(path);
      if (folder === null) {
        continue;
      }
      if (canonicalFolderKeys.has(portablePathKey(path))) {
        continue;
      }
      const hasDescendants = this.vault
        .getAllLoadedFiles()
        .some((entry) => normalizePath(entry.path).startsWith(`${path}/`));
      if (hasDescendants) {
        continue;
      }
      await this.runInternalMutation([path], async () => {
        runContext.assertValid();
        const liveFolder = this.vault.getFolderByPath(path);
        if (liveFolder === null) {
          return;
        }
        const gainedDescendants = this.vault
          .getAllLoadedFiles()
          .some((entry) => normalizePath(entry.path).startsWith(`${path}/`));
        if (gainedDescendants) {
          return;
        }
        await this.fileManager.trashFile(liveFolder);
      });
    }
  }

  private async cleanupOwnedEmptyNonCanonicalFolders(
    mapping: ProjectSyncMapping,
    rootPath: string,
    canonicalFolderKeys: ReadonlySet<string>,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    const storage = this.folderOwnershipStorage;
    const rootProjectId = mapping.project?.projectId;
    if (storage === undefined || rootProjectId === undefined) {
      return;
    }

    const configuredRoots = [rootPath, ...mapping.previousFolders]
      .map(normalizeConfiguredOwnershipRoot)
      .filter((path): path is string => path !== null);
    const configuredRootKeys = new Set(configuredRoots.map(portablePathKey));
    const ownedPaths = new Map<string, string>();
    for (const ownership of storage.listOwnedFolders(mapping.id)) {
      if (ownership.rootProjectId !== rootProjectId) {
        continue;
      }
      const path = normalizePath(ownership.path);
      const key = portablePathKey(path);
      if (
        configuredRootKeys.has(key) ||
        !configuredRoots.some((root) => isPathInside(root, path))
      ) {
        continue;
      }
      const current = ownedPaths.get(key);
      if (current === undefined || comparePortablePaths(path, current) < 0) {
        ownedPaths.set(key, path);
      }
    }

    const orderedPaths = [...ownedPaths.values()].sort((left, right) => {
      const depth = right.split("/").length - left.split("/").length;
      return depth === 0 ? comparePortablePaths(left, right) : depth;
    });
    const releasedPaths: string[] = [];
    try {
      for (const path of orderedPaths) {
        runContext.assertValid();
        const folder = this.vault.getFolderByPath(path);
        if (folder === null) {
          // A missing folder or a user file at the old path is no longer the creation instance
          // recorded by Tasks Bridge. Release ownership without touching the live occupant.
          releasedPaths.push(path);
          continue;
        }
        if (canonicalFolderKeys.has(portablePathKey(path))) {
          continue;
        }
        const hasDescendants = await this.hasFolderDescendants(path);
        if (hasDescendants) {
          continue;
        }
        await this.runInternalMutation([path], async () => {
          runContext.assertValid();
          const liveFolder = this.vault.getFolderByPath(path);
          if (liveFolder === null || liveFolder !== folder) {
            return;
          }
          const gainedDescendants = await this.hasFolderDescendants(path);
          if (gainedDescendants) {
            return;
          }
          await this.fileManager.trashFile(liveFolder);
          releasedPaths.push(path);
        });
      }
    } finally {
      await storage.releaseOwnedFolderPaths(mapping.id, releasedPaths);
    }
  }

  private async hasFolderDescendants(path: string): Promise<boolean> {
    if (
      this.vault
        .getAllLoadedFiles()
        .some((entry) => normalizePath(entry.path).startsWith(`${path}/`))
    ) {
      return true;
    }

    try {
      const listed = await this.vault.adapter.list(path);
      return listed.files.length > 0 || listed.folders.length > 0;
    } catch (error: unknown) {
      // A stale Vault index must not turn an unreadable folder into an apparently empty one.
      console.error(`Could not verify that managed folder '${path}' is empty:`, error);
      return true;
    }
  }

  private mustStageForCanonicalProjection(
    managed: ManagedFile,
    canonicalProjection: CanonicalProjectionPlan,
  ): boolean {
    const currentKey = portablePathKey(managed.file.path);
    const desiredFileKey = canonicalProjection.fileKeysByTaskId.get(managed.identity.taskId);
    if (canonicalProjection.folderKeys.has(currentKey)) {
      return true;
    }
    for (const [fileKey, taskId] of canonicalProjection.fileTaskIdsByKey) {
      if (currentKey.startsWith(`${fileKey}/`)) {
        return true;
      }
      if (currentKey === fileKey && managed.identity.taskId !== taskId) {
        return true;
      }
    }
    for (const [folderKey, allowedTaskIds] of canonicalProjection.taskFolderTaskIdsByKey) {
      if (currentKey.startsWith(`${folderKey}/`) && !allowedTaskIds.has(managed.identity.taskId)) {
        return true;
      }
    }
    if (desiredFileKey !== undefined && currentKey === desiredFileKey) {
      return false;
    }
    return false;
  }

  /**
   * Write task hierarchy only after every canonical file has reached its final path. This keeps
   * generated links correct when a single sync creates or moves both sides of a relationship.
   */
  private async projectTaskRelationships(
    snapshotTasks: readonly SnapshotTask[],
    projectedFilesByTaskId: ReadonlyMap<string, ProjectedTaskFile>,
    result: ProjectSyncResult,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    const tasksById = new Map(snapshotTasks.map(({ task }) => [task.id, task] as const));
    const parentByTaskId = makeSafeTaskParentMap(
      snapshotTasks,
      new Map(snapshotTasks.map((snapshotTask) => [snapshotTask.task.id, snapshotTask])),
    );
    const childrenByTaskId = new Map<string, (typeof snapshotTasks)[number]["task"][]>();
    for (const [taskId, parentId] of parentByTaskId) {
      const task = tasksById.get(taskId);
      if (task === undefined || !projectedFilesByTaskId.has(taskId)) {
        continue;
      }
      const children = childrenByTaskId.get(parentId) ?? [];
      children.push(task);
      childrenByTaskId.set(parentId, children);
    }
    for (const children of childrenByTaskId.values()) {
      children.sort(compareTaskProjectionOrder);
    }

    for (const snapshotTask of snapshotTasks) {
      runContext.assertValid();
      const projected = projectedFilesByTaskId.get(snapshotTask.task.id);
      if (projected === undefined) {
        continue;
      }
      const parentFile =
        snapshotTask.task.parentId === undefined
          ? undefined
          : projectedFilesByTaskId.get(parentByTaskId.get(snapshotTask.task.id) ?? "")?.file;
      const subtasks = (childrenByTaskId.get(snapshotTask.task.id) ?? []).flatMap((child) => {
        const file = projectedFilesByTaskId.get(child.id)?.file;
        return file === undefined
          ? []
          : [
              this.fileManager.generateMarkdownLink(
                file,
                projected.file.path,
                undefined,
                child.content,
              ),
            ];
      });
      const parentTask =
        parentFile === undefined
          ? undefined
          : this.fileManager.generateMarkdownLink(
              parentFile,
              projected.file.path,
              undefined,
              tasksById.get(parentByTaskId.get(snapshotTask.task.id) ?? "")?.content ?? "",
            );

      if (
        parentTask === undefined &&
        subtasks.length === 0 &&
        !hasTaskRelationshipProperties(projected.relationshipFrontmatter)
      ) {
        continue;
      }

      const desiredRelationshipFrontmatter = { ...projected.relationshipFrontmatter };
      if (
        !applyManagedTaskRelationships(desiredRelationshipFrontmatter, { parentTask, subtasks })
      ) {
        continue;
      }

      let changed = false;
      try {
        await this.runInternalMutation([projected.file.path], async () => {
          await this.fileManager.processFrontMatter(projected.file, (frontmatter: unknown) => {
            runContext.assertValid();
            if (!isRecord(frontmatter)) {
              throw new ManagedNoteIdentityConflictError(
                `Invalid frontmatter in '${projected.file.path}'`,
              );
            }
            const identity = readManagedNoteIdentity(frontmatter);
            if (identity?.taskId !== snapshotTask.task.id) {
              throw new ManagedNoteIdentityConflictError(
                `Managed note '${projected.file.path}' changed identity before task relationships were projected`,
              );
            }
            changed = applyManagedTaskRelationships(frontmatter, { parentTask, subtasks });
          });
        });
      } catch (error: unknown) {
        if (!(error instanceof ManagedNoteIdentityConflictError)) {
          throw error;
        }
        result.conflicts.push({
          taskId: snapshotTask.task.id,
          path: projected.file.path,
          message: error.message,
          projectionBlocked: true,
        });
        continue;
      }

      if (!changed || projected.outcome === "created" || projected.outcome === "updated") {
        continue;
      }
      result.unchanged = Math.max(0, result.unchanged - 1);
      result.updated++;
      projected.outcome = "updated";
    }
  }

  private validateRootFolder(folder: string): string {
    const raw = folder.trim().split("\\").join("/");
    if (
      raw === "" ||
      raw === "/" ||
      raw.split("/").some((segment: string) => segment === "." || segment === "..")
    ) {
      throw new Error("Project sync requires a dedicated folder inside the vault");
    }

    const normalized = normalizePath(raw);
    if (
      normalized === "" ||
      normalized === "/" ||
      this.vault.getFolderByPath(normalized) === null
    ) {
      throw new Error(`Project sync folder '${normalized}' does not exist`);
    }
    return normalized;
  }

  private tryResolveExistingRootFolder(folder: string): string | null {
    try {
      return this.validateRootFolder(folder);
    } catch {
      return null;
    }
  }

  private async ensureProjectFolders(
    canonicalProjection: CanonicalProjectionPlan,
    mapping: ProjectSyncMapping,
    rootPath: string,
    blockedFolderKeys: ReadonlySet<string>,
    runContext: ProjectSyncRunContext,
  ): Promise<Map<string, string>> {
    const folders = new Map(canonicalProjection.projectFoldersById);
    const createdFolders: CreatedFolderObservation[] = [];
    const rootProjectId = mapping.project?.projectId;
    if (rootProjectId === undefined) {
      throw new Error("Project sync mapping requires a Todoist project");
    }
    const orderedFolders = [...folders.entries()].sort(
      ([leftId, leftPath], [rightId, rightPath]) => {
        const depth = leftPath.split("/").length - rightPath.split("/").length;
        return depth === 0 ? compareStableIds(leftId, rightId) : depth;
      },
    );
    try {
      for (const [projectId, path] of orderedFolders) {
        runContext.assertValid();
        if (
          portablePathKey(path) === portablePathKey(rootPath) ||
          blockedFolderKeys.has(portablePathKey(path))
        ) {
          continue;
        }
        const createdFolder = await this.resolveProjectFolder(path, rootPath, runContext);
        if (createdFolder !== null) {
          createdFolders.push({
            folder: createdFolder,
            creation: {
              mappingId: mapping.id,
              rootProjectId,
              ownerKind: "project",
              ownerId: projectId,
              path,
            },
          });
        }
        runContext.assertValid();
      }
    } finally {
      await this.folderOwnershipStorage?.recordCreatedFolders(
        createdFolders.flatMap(({ creation, folder }) =>
          this.vault.getFolderByPath(creation.path) === folder ? [creation] : [],
        ),
      );
    }
    return folders;
  }

  private async resolveProjectFolder(
    path: string,
    rootPath: string,
    runContext: ProjectSyncRunContext,
  ): Promise<TFolder | null> {
    runContext.assertValid();
    this.assertWithinRoot(rootPath, path);
    if (this.vault.getFolderByPath(path) !== null) {
      return null;
    }
    if (this.vault.getAbstractFileByPath(path) !== null) {
      throw new ManagedPathRaceError(
        `Canonical Todoist project folder '${path}' is occupied by a file`,
      );
    }
    try {
      return await this.runInternalMutation(
        [path],
        async () => await this.vault.createFolder(path),
      );
    } catch (error: unknown) {
      if (this.vault.getFolderByPath(path) !== null) {
        return null;
      }
      if (this.vault.getAbstractFileByPath(path) === null) {
        throw error;
      }
      throw new ManagedPathRaceError(
        `Canonical Todoist project folder '${path}' became occupied during synchronization`,
      );
    }
  }

  private async ensureTaskFilePlans(
    snapshotTasks: readonly SnapshotTask[],
    canonicalProjection: CanonicalProjectionPlan,
    projectFolders: ReadonlyMap<string, string>,
    configuredByTaskId: ReadonlyMap<string, readonly ManagedFile[]>,
    managedFiles: ReadonlySet<TFile>,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    mapping: ProjectSyncMapping,
    blockedTaskIds: ReadonlySet<string>,
    runContext: ProjectSyncRunContext,
  ): Promise<Map<string, TaskFilePlan>> {
    const desiredTaskIds = new Set(snapshotTasks.map(({ task }) => task.id));
    const managedTaskIdByFile = new Map<TFile, string>();
    for (const [taskId, files] of configuredByTaskId) {
      for (const { file } of files) {
        managedTaskIdByFile.set(file, taskId);
      }
    }
    const plans = new Map(canonicalProjection.taskFilePlansById);
    const createdFolders: CreatedFolderObservation[] = [];
    const rootProjectId = mapping.project?.projectId;
    if (rootProjectId === undefined) {
      throw new Error("Project sync mapping requires a Todoist project");
    }
    const reservedFolders = new Set([...projectFolders.values()].map(portablePathKey));
    const orderedPlans = [...plans.entries()].sort(([leftId, left], [rightId, right]) => {
      const depth = left.depth - right.depth;
      return depth === 0 ? compareStableIds(leftId, rightId) : depth;
    });
    try {
      for (const [taskId, plan] of orderedPlans) {
        runContext.assertValid();
        if (!plan.ownsFolder || blockedTaskIds.has(taskId)) {
          continue;
        }
        const existingFiles = configuredByTaskId.get(taskId) ?? [];
        const current = existingFiles.length === 1 ? existingFiles[0]?.file : undefined;
        const allowedTaskIds = canonicalProjection.taskFolderTaskIdsByKey.get(
          portablePathKey(plan.folder),
        );
        if (allowedTaskIds === undefined) {
          throw new Error(`Missing canonical subtree ownership for Todoist task '${taskId}'`);
        }
        const createdFolder = await this.resolveTaskFolder(
          plan.folder,
          plan.path,
          current,
          rootPath,
          pathIndex,
          reservedFolders,
          allowedTaskIds,
          desiredTaskIds,
          managedFiles,
          managedTaskIdByFile,
          runContext,
        );
        if (createdFolder !== null) {
          createdFolders.push({
            folder: createdFolder,
            creation: {
              mappingId: mapping.id,
              rootProjectId,
              ownerKind: "task",
              ownerId: taskId,
              path: plan.folder,
            },
          });
        }
        runContext.assertValid();
      }
    } finally {
      await this.folderOwnershipStorage?.recordCreatedFolders(
        createdFolders.flatMap(({ creation, folder }) =>
          this.vault.getFolderByPath(creation.path) === folder ? [creation] : [],
        ),
      );
    }
    return plans;
  }

  private async resolveTaskFolder(
    path: string,
    notePath: string,
    current: TFile | undefined,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    reservedFolders: Set<string>,
    allowedTaskIds: ReadonlySet<string>,
    desiredTaskIds: ReadonlySet<string>,
    managedFiles: ReadonlySet<TFile>,
    managedTaskIdByFile: ReadonlyMap<TFile, string>,
    runContext: ProjectSyncRunContext,
  ): Promise<TFolder | null> {
    const pathKey = portablePathKey(path);
    this.assertWithinRoot(rootPath, path);
    if (reservedFolders.has(pathKey)) {
      throw new ManagedPathRaceError(`Canonical Todoist task folder '${path}' is already reserved`);
    }

    const incompatibleNoteOccupants = pathIndex.occupants(notePath, current).filter((occupant) => {
      if (!(occupant instanceof TFile) || !managedFiles.has(occupant)) {
        return true;
      }
      const taskId = managedTaskIdByFile.get(occupant);
      return taskId === undefined || !allowedTaskIds.has(taskId);
    });
    if (incompatibleNoteOccupants.length > 0) {
      throw new ManagedPathRaceError(`Canonical Todoist task note '${notePath}' is occupied`);
    }

    const folder = this.vault.getFolderByPath(path);
    if (folder !== null) {
      if (
        !this.isReusableTaskFolder(
          path,
          current,
          allowedTaskIds,
          desiredTaskIds,
          managedFiles,
          managedTaskIdByFile,
          runContext.preserveUnmanagedItems !== false,
        )
      ) {
        throw new ManagedPathRaceError(`Canonical Todoist task folder '${path}' is occupied`);
      }
      reservedFolders.add(pathKey);
      return null;
    }
    if (this.vault.getAbstractFileByPath(path) !== null) {
      throw new ManagedPathRaceError(
        `Canonical Todoist task folder '${path}' is occupied by a file`,
      );
    }

    try {
      runContext.assertValid();
      const created = await this.runInternalMutation(
        [path],
        async () => await this.vault.createFolder(path),
      );
      pathIndex.add(created);
      reservedFolders.add(pathKey);
      return created;
    } catch (error: unknown) {
      const racedFolder = this.vault.getFolderByPath(path);
      if (racedFolder !== null && !reservedFolders.has(pathKey)) {
        if (
          !this.isReusableTaskFolder(
            path,
            current,
            allowedTaskIds,
            desiredTaskIds,
            managedFiles,
            managedTaskIdByFile,
            runContext.preserveUnmanagedItems !== false,
          )
        ) {
          throw new ManagedPathRaceError(
            `Canonical Todoist task folder '${path}' changed during synchronization`,
          );
        }
        pathIndex.add(racedFolder);
        reservedFolders.add(pathKey);
        return null;
      }
      if (this.vault.getAbstractFileByPath(path) === null) {
        throw error;
      }
      throw new ManagedPathRaceError(
        `Canonical Todoist task folder '${path}' became occupied during synchronization`,
      );
    }
  }

  private isReusableTaskFolder(
    path: string,
    current: TFile | undefined,
    allowedTaskIds: ReadonlySet<string>,
    desiredTaskIds: ReadonlySet<string>,
    managedFiles: ReadonlySet<TFile>,
    managedTaskIdByFile: ReadonlyMap<TFile, string>,
    preserveUnmanagedItems: boolean,
  ): boolean {
    if (preserveUnmanagedItems) {
      for (const entry of this.vault.getAllLoadedFiles()) {
        const entryPath = normalizePath(entry.path);
        if (!entryPath.startsWith(`${path}/`) || entry === current || !(entry instanceof TFile)) {
          continue;
        }
        const taskId = managedTaskIdByFile.get(entry);
        if (taskId !== undefined && desiredTaskIds.has(taskId) && !allowedTaskIds.has(taskId)) {
          return false;
        }
      }
      return true;
    }

    const allowedManagedPaths = new Set(
      [...managedTaskIdByFile].flatMap(([file, taskId]) =>
        allowedTaskIds.has(taskId) || !desiredTaskIds.has(taskId) ? [normalizePath(file.path)] : [],
      ),
    );
    if (current !== undefined) {
      allowedManagedPaths.add(normalizePath(current.path));
    }
    for (const entry of this.vault.getAllLoadedFiles()) {
      const entryPath = normalizePath(entry.path);
      if (!entryPath.startsWith(`${path}/`)) {
        continue;
      }
      if (this.vault.getFolderByPath(entryPath) !== null) {
        if (![...allowedManagedPaths].some((filePath) => filePath.startsWith(`${entryPath}/`))) {
          return false;
        }
        continue;
      }
      if (entry === current) {
        continue;
      }
      if (!(entry instanceof TFile) || !managedFiles.has(entry)) {
        return false;
      }
      const taskId = managedTaskIdByFile.get(entry);
      if (taskId === undefined || (desiredTaskIds.has(taskId) && !allowedTaskIds.has(taskId))) {
        return false;
      }
    }
    return true;
  }

  private resolveAvailableTaskFilePath(
    targetPath: string,
    current: TFile | undefined,
    root: string,
    pathIndex: PortableVaultPathIndex,
  ): string {
    this.assertWithinRoot(root, targetPath);
    if (pathIndex.occupants(targetPath, current).length > 0) {
      throw new ManagedPathRaceError(`Canonical Todoist task path '${targetPath}' is occupied`);
    }
    return targetPath;
  }

  /**
   * Collapse files in one validated mapping that claim the same immutable Todoist task identity.
   *
   * The desired target is derived only from the live Todoist snapshot. The preferred path selects
   * one deterministic canonical note; every other same-ID copy goes to Obsidian's recoverable
   * trash regardless of differences outside the managed projection.
   */
  private async reconcileDuplicateManagedFiles(
    files: readonly ManagedFile[],
    desiredFrontmatter: ManagedFrontmatter,
    desiredBody: string,
    targetPath: string,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    managedFiles: Set<TFile>,
    runContext: ProjectSyncRunContext,
  ): Promise<{ managed: ManagedFile; moved: boolean; updated: boolean }> {
    runContext.assertValid();
    const taskId = this.requireLiveManagedIdentity(desiredFrontmatter, targetPath).taskId;
    this.assertWithinRoot(rootPath, targetPath);
    const candidates = [...files].sort((left, right) =>
      comparePortablePaths(left.file.path, right.file.path),
    );
    const canonicalCandidate =
      candidates.find((managed) => normalizePath(managed.file.path) === targetPath) ??
      candidates.find(
        (managed) => portablePathKey(managed.file.path) === portablePathKey(targetPath),
      );
    const canonical = canonicalCandidate ?? candidates[0];
    if (canonical === undefined) {
      throw new DuplicateManagedNoteConflictError(
        `No live managed note remained for Todoist task ID '${taskId}'`,
      );
    }
    const duplicateFiles = candidates.filter((candidate) => candidate !== canonical);
    for (const candidate of candidates) {
      this.assertBackgroundFile(candidate.file);
    }

    for (const candidate of candidates) {
      runContext.assertValid();
      const content = await this.vault.read(candidate.file);
      this.readDuplicateCandidate(content, candidate, taskId);
    }

    const originalContent = await this.vault.read(canonical.file);
    let desiredDocument = "";
    runContext.assertValid();
    await this.processFileInternally(canonical.file, (content) => {
      runContext.assertValid();
      const current = this.readDuplicateCandidate(content, canonical, taskId);
      desiredDocument =
        current === null
          ? renderTaskDocumentWithUserContent(
              desiredFrontmatter,
              desiredBody,
              this.readRecoverableUserDocument(content, canonical.file.path),
            )
          : renderTaskDocumentWithUserContent(
              desiredFrontmatter,
              desiredBody,
              readUserOwnedTaskDocument(current.content, current.frontmatter, current.contentStart),
            );
      return desiredDocument;
    });
    runContext.assertValid();

    let trashedCount = 0;
    for (const duplicate of duplicateFiles) {
      runContext.assertValid();
      try {
        const content = await this.vault.read(duplicate.file);
        this.readDuplicateCandidate(content, duplicate, taskId);
      } catch (error: unknown) {
        if (error instanceof DuplicateManagedNoteConflictError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DuplicateManagedNoteConflictError(
          `Could not revalidate duplicate note '${duplicate.file.path}'; it and every remaining copy were preserved: ${message}`,
        );
      }
      runContext.assertValid();
      const path = duplicate.file.path;
      try {
        await this.runInternalMutation(
          [path],
          async () => await this.fileManager.trashFile(duplicate.file),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DuplicateManagedNoteConflictError(
          `Duplicate cleanup for Todoist task ID '${taskId}' stopped after moving ${trashedCount} of ${duplicateFiles.length} redundant notes to the Obsidian trash; the canonical note and every remaining copy were preserved: ${message}`,
        );
      }
      trashedCount++;
      pathIndex.remove(duplicate.file, path);
      managedFiles.delete(duplicate.file);
      runContext.assertValid();
    }

    this.resolveAvailableTaskFilePath(targetPath, canonical.file, rootPath, pathIndex);
    const moved = canonical.file.path !== targetPath;
    if (moved) {
      runContext.assertValid();
      this.assertLivePathAvailable(targetPath, canonical.file);
      const oldPath = canonical.file.path;
      await this.runInternalMutation(
        [oldPath, targetPath],
        async () => await this.fileManager.renameFile(canonical.file, targetPath),
      );
      pathIndex.move(canonical.file, oldPath, targetPath);
    }

    return {
      managed: {
        file: canonical.file,
        frontmatter: desiredFrontmatter,
        identity: this.requireLiveManagedIdentity(desiredFrontmatter, targetPath),
        projectionRoot: rootPath,
      },
      moved,
      updated: originalContent !== desiredDocument,
    };
  }

  private readDuplicateCandidate(
    content: string,
    candidate: ManagedFile,
    taskId: string,
  ): LiveManagedNote | null {
    try {
      const current = this.parseLiveManagedNote(content, candidate.file.path);
      if (
        current.identity.taskId === taskId &&
        current.identity.taskId === candidate.identity.taskId
      ) {
        return current;
      }
    } catch {
      const info = getManagedFrontMatterInfo(content);
      const recovered = info.exists
        ? readRecoverableManagedNoteIdentity(content, info.frontmatter)
        : null;
      if (recovered?.taskId === taskId && recovered.taskId === candidate.identity.taskId) {
        return null;
      }
    }

    throw new DuplicateManagedNoteConflictError(
      `Managed note '${candidate.file.path}' changed Todoist identity while duplicate reconciliation was running; it was preserved`,
    );
  }

  private async updateManagedFile(
    managed: ManagedFile,
    desiredFrontmatter: ManagedFrontmatter,
    desiredBody: string,
    targetPath: string,
    pathIndex: PortableVaultPathIndex,
    runContext: ProjectSyncRunContext,
  ): Promise<{ moved: boolean; updated: boolean }> {
    if (managed.recoveredMalformed === true) {
      return await this.repairRecoveredManagedFile(
        managed,
        desiredFrontmatter,
        desiredBody,
        targetPath,
        pathIndex,
        runContext,
      );
    }
    runContext.assertValid();
    const live = await this.readLiveManagedNote(managed.file);
    runContext.assertValid();
    const desiredIdentity = this.requireLiveManagedIdentity(desiredFrontmatter, targetPath);
    this.assertManagedIdentityTransition(
      managed.identity,
      live.identity,
      desiredIdentity,
      managed.file.path,
    );
    const moved = managed.file.path !== targetPath;
    const comparisonFrontmatter = this.makeComparisonFrontmatter(
      live.frontmatter,
      desiredFrontmatter,
    );
    const preview = replaceManagedTaskDocument(
      live.content,
      live.frontmatter,
      comparisonFrontmatter,
      desiredBody,
      live.contentStart,
    );
    if (preview.changed) {
      this.assertDesiredSourceRevisionCanUpdate(
        live.frontmatter,
        desiredFrontmatter,
        managed.file.path,
      );
    }
    let documentUpdated = false;

    if (preview.changed || moved) {
      runContext.assertValid();
      this.assertBackgroundFile(managed.file);
      try {
        await this.processFileInternally(managed.file, (content) => {
          runContext.assertValid();
          const current = this.parseLiveManagedNote(content, managed.file.path);
          this.assertManagedIdentityTransition(
            managed.identity,
            current.identity,
            desiredIdentity,
            managed.file.path,
          );
          const currentComparison = this.makeComparisonFrontmatter(
            current.frontmatter,
            desiredFrontmatter,
          );
          const currentPreview = replaceManagedTaskDocument(
            content,
            current.frontmatter,
            currentComparison,
            desiredBody,
            current.contentStart,
          );
          if (currentPreview.changed) {
            this.assertDesiredSourceRevisionCanUpdate(
              current.frontmatter,
              desiredFrontmatter,
              managed.file.path,
            );
          }
          if (!currentPreview.changed && !moved) {
            throw new NoManagedDocumentChangeError();
          }

          const update = replaceManagedTaskDocument(
            content,
            current.frontmatter,
            this.makeWriteFrontmatter(current.frontmatter, desiredFrontmatter),
            desiredBody,
            current.contentStart,
          );
          if (!update.changed) {
            throw new NoManagedDocumentChangeError();
          }
          documentUpdated = true;
          return update.content;
        });
      } catch (error: unknown) {
        if (!(error instanceof NoManagedDocumentChangeError)) {
          throw error;
        }
      }
      runContext.assertValid();
    }

    if (moved) {
      runContext.assertValid();
      this.assertBackgroundFile(managed.file);
      await this.assertLiveManagedIdentityTransition(managed, desiredIdentity);
      this.assertLivePathAvailable(targetPath, managed.file);
      const oldPath = managed.file.path;
      try {
        await this.runInternalMutation(
          [oldPath, targetPath],
          async () => await this.fileManager.renameFile(managed.file, targetPath),
        );
      } catch (error: unknown) {
        this.throwPathRaceIfOccupied(targetPath, managed.file);
        throw error;
      }
      pathIndex.move(managed.file, oldPath, targetPath);
      runContext.assertValid();
    }
    return { moved, updated: documentUpdated || moved };
  }

  private async repairRecoveredManagedFile(
    managed: ManagedFile,
    desiredFrontmatter: ManagedFrontmatter,
    desiredBody: string,
    targetPath: string,
    pathIndex: PortableVaultPathIndex,
    runContext: ProjectSyncRunContext,
  ): Promise<{ moved: boolean; updated: boolean }> {
    runContext.assertValid();
    const desiredIdentity = this.requireLiveManagedIdentity(desiredFrontmatter, targetPath);
    this.assertBackgroundFile(managed.file);
    await this.processFileInternally(managed.file, (content) => {
      runContext.assertValid();
      this.assertRecoverableManagedIdentity(content, managed.identity, managed.file.path);
      return renderTaskDocumentWithUserContent(
        desiredFrontmatter,
        desiredBody,
        this.readRecoverableUserDocument(content, managed.file.path),
      );
    });
    runContext.assertValid();

    const moved = managed.file.path !== targetPath;
    if (moved) {
      this.assertLivePathAvailable(targetPath, managed.file);
      const oldPath = managed.file.path;
      await this.runInternalMutation(
        [oldPath, targetPath],
        async () => await this.fileManager.renameFile(managed.file, targetPath),
      );
      pathIndex.move(managed.file, oldPath, targetPath);
      runContext.assertValid();
    }

    managed.frontmatter = desiredFrontmatter;
    managed.identity = desiredIdentity;
    delete managed.recoveredMalformed;
    return { moved, updated: true };
  }

  private async trashMissingManagedFile(
    managed: ManagedFile,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    runContext.assertValid();
    this.assertBackgroundFile(managed.file);
    const path = managed.file.path;
    await this.runInternalMutation([path], async () => {
      runContext.assertValid();
      const currentFile = this.vault.getAbstractFileByPath(path);
      if (currentFile === null) {
        return;
      }
      if (!(currentFile instanceof TFile) || currentFile !== managed.file) {
        throw new ManagedPathRaceError(
          `Managed note '${path}' changed while synchronization was confirming its remote deletion`,
        );
      }

      if (managed.recoveredMalformed === true) {
        const content = await this.vault.read(managed.file);
        this.assertRecoverableManagedIdentity(content, managed.identity, path);
      } else {
        const live = await this.readLiveManagedNote(managed.file);
        this.assertSameManagedIdentity(managed.identity, live.identity, path);
      }
      this.assertBackgroundFile(managed.file);
      runContext.assertValid();
      await this.fileManager.trashFile(managed.file);
    });
    runContext.assertValid();
  }

  private async createManagedFile(
    path: string,
    content: string,
    runContext: ProjectSyncRunContext,
  ): Promise<TFile> {
    runContext.assertValid();
    this.assertLivePathAvailable(path);
    let created: TFile;
    try {
      created = await this.runInternalMutation(
        [path],
        async () => await this.vault.create(path, content),
      );
    } catch (error: unknown) {
      this.throwPathRaceIfOccupied(path);
      throw error;
    }
    runContext.assertValid();
    return created;
  }

  private async processFileInternally(
    file: TFile,
    processor: (content: string) => string,
  ): Promise<void> {
    await this.runInternalMutation([file.path], async () => {
      await this.vault.process(file, processor);
    });
  }

  private async readLiveManagedNote(file: TFile): Promise<LiveManagedNote> {
    const content = await this.vault.read(file);
    return this.parseLiveManagedNote(content, file.path);
  }

  private parseLiveManagedNote(content: string, path: string): LiveManagedNote {
    const info = getManagedFrontMatterInfo(content);
    if (!info.exists) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' no longer has frontmatter; synchronization was not applied`,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(info.frontmatter);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' has invalid frontmatter: ${message}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' no longer has valid frontmatter; synchronization was not applied`,
      );
    }

    return {
      content,
      contentStart: info.contentStart,
      frontmatter: parsed,
      identity: this.requireLiveManagedIdentity(parsed, path),
    };
  }

  private assertRecoverableManagedIdentity(
    content: string,
    expected: ManagedNoteIdentity,
    path: string,
  ): void {
    const info = getManagedFrontMatterInfo(content);
    const identity = info.exists
      ? readRecoverableManagedNoteIdentity(content, info.frontmatter)
      : null;
    if (identity?.taskId !== expected.taskId) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' changed Todoist identity while malformed frontmatter was being repaired`,
      );
    }
  }

  private readRecoverableUserDocument(content: string, path: string): UserOwnedTaskDocument {
    const info = getManagedFrontMatterInfo(content);
    if (!info.exists) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' no longer has recoverable frontmatter`,
      );
    }
    // Malformed YAML cannot safely contribute custom frontmatter, but text outside the generated
    // card remains unambiguous and must survive repair.
    return readUserOwnedTaskDocument(content, {}, info.contentStart);
  }

  private requireLiveManagedIdentity(
    frontmatter: ManagedFrontmatter,
    path: string,
  ): ManagedNoteIdentity {
    const identity = readManagedNoteIdentity(frontmatter);
    if (identity === null) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' changed ownership before synchronization; it was not overwritten`,
      );
    }
    return identity;
  }

  private assertSameManagedIdentity(
    expected: ManagedNoteIdentity,
    current: ManagedNoteIdentity,
    path: string,
  ): void {
    if (current.taskId !== expected.taskId) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' changed identity before synchronization; it was not overwritten`,
      );
    }
  }

  private assertManagedIdentityTransition(
    expected: ManagedNoteIdentity,
    current: ManagedNoteIdentity,
    desired: ManagedNoteIdentity,
    path: string,
  ): void {
    if (sameManagedOwnership(current, expected) || sameManagedOwnership(current, desired)) {
      return;
    }
    throw new ManagedNoteIdentityConflictError(
      `Managed note '${path}' changed identity before synchronization; it was not overwritten`,
    );
  }

  private async assertLiveManagedIdentityTransition(
    managed: ManagedFile,
    desired: ManagedNoteIdentity,
  ): Promise<void> {
    const live = await this.readLiveManagedNote(managed.file);
    this.assertManagedIdentityTransition(
      managed.identity,
      live.identity,
      desired,
      managed.file.path,
    );
  }

  private makeComparisonFrontmatter(
    current: ManagedFrontmatter,
    desired: ManagedFrontmatter,
  ): ManagedFrontmatter {
    return this.makeWriteFrontmatter(current, desired);
  }

  private makeWriteFrontmatter(
    current: ManagedFrontmatter,
    desired: ManagedFrontmatter,
  ): ManagedFrontmatter {
    const write = { ...desired };
    if (
      typeof desired.todoist_updated_at !== "string" &&
      typeof current.todoist_updated_at === "string"
    ) {
      write.todoist_updated_at = current.todoist_updated_at;
    }
    return write;
  }

  private assertDesiredSourceRevisionCanUpdate(
    current: ManagedFrontmatter,
    desired: ManagedFrontmatter,
    path: string,
  ): void {
    const currentRevision = readTimestamp(current.todoist_updated_at);
    const desiredRevision = readTimestamp(desired.todoist_updated_at);
    if (typeof current.todoist_updated_at === "string" && currentRevision === undefined) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' contains an unreadable Todoist revision; the incoming snapshot was not applied`,
      );
    }
    if (typeof current.todoist_updated_at === "string" && desiredRevision === undefined) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' contains a Todoist revision, but the incoming snapshot has none; the unversioned snapshot was not applied`,
      );
    }
    if (
      currentRevision !== undefined &&
      desiredRevision !== undefined &&
      desiredRevision < currentRevision
    ) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' contains a newer Todoist revision; the stale snapshot was not applied`,
      );
    }
  }

  private async persistCatalogState(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    previous: ProjectCatalog | null,
    managedById: ReadonlyMap<string, readonly ManagedFile[]>,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    if (this.catalogStorage === undefined) {
      return;
    }
    const next = makeProjectCatalog(snapshot, mapping);
    const desiredIds = new Set(next.tasks.map((task) => task.id));
    const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
    for (const [taskId, managedFiles] of managedById) {
      if (desiredIds.has(taskId) || runContext.allSnapshotTaskIds?.has(taskId) === true) {
        continue;
      }
      const task =
        previousTasks.get(taskId) ??
        readLegacyCatalogTask(managedFiles[0]) ??
        readCatalogTaskFromUserProjection(managedFiles[0], snapshot.projects);
      if (task === undefined) {
        continue;
      }
      const currentTask = { ...task };
      delete currentTask.missingCount;
      next.tasks.push(currentTask);
    }
    next.completionEvents = mergeProjectCompletionEvents(
      previous?.completionEvents ?? [],
      next.completionEvents,
    );
    await this.catalogStorage.persistCatalogs([next]);
  }

  private assertLivePathAvailable(path: string, current?: TAbstractFile): void {
    const occupants = new PortableVaultPathIndex(this.vault.getAllLoadedFiles()).occupants(
      path,
      current,
    );
    if (occupants.length === 0) {
      return;
    }
    throw new ManagedPathRaceError(
      `Task path '${path}' changed while synchronization was running; no file was overwritten`,
    );
  }

  private throwPathRaceIfOccupied(path: string, current?: TAbstractFile): void {
    this.assertLivePathAvailable(path, current);
  }

  private async scanManagedFiles(
    mappingId: string,
    rootProjectId: string,
    rootPath: string,
    configuredRoots: readonly ResolvedMappingRoot[],
    conflicts: ProjectSyncConflict[],
    runContext: ProjectSyncRunContext,
  ): Promise<ManagedFileScan> {
    const configuredByTaskId = new Map<string, ManagedFile[]>();
    const ownedByTaskId = new Map<string, ManagedFile[]>();
    const creationFencePaths = new Set<string>();
    const configuredRootPaths = Array.from(new Set(configuredRoots.map(({ path }) => path)));
    const ownedRootPaths = configuredRoots
      .filter(
        (root) =>
          root.active && root.mappingId === mappingId && root.rootProjectId === rootProjectId,
      )
      .map(({ path }) => path);
    let unresolvedHistoricalOwnership = false;

    const indexedFiles = await this.getManagedFileIndex(configuredRootPaths, runContext);
    for (const indexed of indexedFiles) {
      runContext.assertValid();
      const { file, content } = indexed;
      const recoveredMalformed =
        indexed.parseError !== undefined && indexed.recoveredIdentity !== undefined;
      const frontmatter =
        indexed.frontmatter ??
        (indexed.recoveredIdentity === undefined
          ? undefined
          : { todoist_task_id: indexed.recoveredIdentity.taskId });
      const identity = indexed.identity ?? indexed.recoveredIdentity;
      const filePath = normalizePath(file.path);
      const isInCurrentRoot = isPathInside(rootPath, filePath);
      if (indexed.parseError !== undefined && !recoveredMalformed) {
        const historicalRoot = mostSpecificContainingRoot(
          ownedRootPaths.filter((path) => path !== rootPath),
          filePath,
        );
        const likelyOwnedHistoricalNote =
          historicalRoot !== undefined &&
          (content.includes(MANAGED_BODY_START) || content.includes("todoist_sync_managed")) &&
          (content.includes(mappingId) || content.includes(rootProjectId));
        const likelyOwnedCurrentNote =
          isInCurrentRoot &&
          (content.includes(MANAGED_BODY_START) || content.includes("todoist_sync_managed"));
        if (likelyOwnedCurrentNote || likelyOwnedHistoricalNote) {
          creationFencePaths.add(file.path);
          conflicts.push({
            path: file.path,
            message: `Could not parse managed note frontmatter: ${indexed.parseError}`,
          });
        }
        unresolvedHistoricalOwnership ||= likelyOwnedHistoricalNote;
        continue;
      }
      if (frontmatter === undefined) {
        continue;
      }

      if (identity === null || identity === undefined) {
        const historicalRoot = mostSpecificContainingRoot(
          ownedRootPaths.filter((path) => path !== rootPath),
          filePath,
        );
        const likelyOwnedHistoricalNote =
          historicalRoot !== undefined &&
          frontmatter.todoist_sync_managed === true &&
          (frontmatter.todoist_sync_mapping_id === mappingId ||
            (frontmatter.todoist_sync_mapping_id === undefined &&
              frontmatter.todoist_sync_root_id === rootProjectId));
        const likelyOwnedCurrentNote = isInCurrentRoot && frontmatter.todoist_sync_managed === true;
        if (likelyOwnedCurrentNote || likelyOwnedHistoricalNote) {
          creationFencePaths.add(file.path);
          unresolvedHistoricalOwnership ||= likelyOwnedHistoricalNote;
          conflicts.push({
            path: file.path,
            message: "Could not read the ownership fields of a managed note",
          });
        }
        continue;
      }
      const containingRoots = configuredRoots.filter((root) => isPathInside(root.path, filePath));
      const catalogOwners = containingRoots.filter((root) => {
        const catalog = this.catalogStorage?.getCatalog(root.mappingId);
        return (
          catalog?.rootProjectId === root.rootProjectId &&
          catalog.tasks.some((task) => task.id === identity.taskId)
        );
      });
      const hasConflictingCatalogOwner = containingRoots.some((root) => {
        const catalog = this.catalogStorage?.getCatalog(root.mappingId);
        return (
          catalog?.tasks.some((task) => task.id === identity.taskId) === true &&
          catalog.rootProjectId !== root.rootProjectId
        );
      });
      let identityRoots = containingRoots;
      if (catalogOwners.length > 0) {
        identityRoots = catalogOwners;
      } else if (hasConflictingCatalogOwner) {
        identityRoots = [];
      }
      const activeIdentityRoot = mostSpecificMatchingIdentityRoot(
        identityRoots.filter(({ active }) => active),
        filePath,
      );
      if (activeIdentityRoot !== undefined) {
        const managed = {
          file,
          identity,
          frontmatter,
          projectionRoot: activeIdentityRoot.path,
          ...(recoveredMalformed ? { recoveredMalformed: true as const } : {}),
        };
        const configuredEntries = configuredByTaskId.get(identity.taskId) ?? [];
        configuredEntries.push(managed);
        configuredByTaskId.set(identity.taskId, configuredEntries);

        const ownedProjectionRoot = mostSpecificContainingRoot(ownedRootPaths, filePath);
        const hasMatchingCurrentIdentity =
          activeIdentityRoot.mappingId === mappingId &&
          activeIdentityRoot.rootProjectId === rootProjectId;
        if (ownedProjectionRoot === undefined || !hasMatchingCurrentIdentity) {
          continue;
        }
        managed.projectionRoot = ownedProjectionRoot;
        const ownedEntries = ownedByTaskId.get(identity.taskId) ?? [];
        ownedEntries.push(managed);
        ownedByTaskId.set(identity.taskId, ownedEntries);
      }
    }

    return {
      configuredByTaskId,
      ownedByTaskId,
      creationFencePaths: [...creationFencePaths],
      unresolvedHistoricalOwnership,
    };
  }

  private getManagedFileIndex(
    configuredRootPaths: readonly string[],
    runContext: ProjectSyncRunContext,
  ): Promise<IndexedVaultFile[]> {
    const build = async () => await this.buildManagedFileIndex(configuredRootPaths, runContext);
    if (runContext.scanToken === undefined) {
      return build();
    }

    const cached = this.managedFileIndexes.get(runContext.scanToken);
    if (cached !== undefined) {
      return cached;
    }
    const index = build();
    this.managedFileIndexes.set(runContext.scanToken, index);
    return index;
  }

  private async buildManagedFileIndex(
    configuredRootPaths: readonly string[],
    runContext: ProjectSyncRunContext,
  ): Promise<IndexedVaultFile[]> {
    const indexedFiles: IndexedVaultFile[] = [];
    for (const file of this.vault.getMarkdownFiles()) {
      runContext.assertValid();
      const filePath = normalizePath(file.path);
      if (!configuredRootPaths.some((root) => isPathInside(root, filePath))) {
        continue;
      }

      const content = await this.vault.read(file);
      runContext.assertValid();
      const info = getManagedFrontMatterInfo(content);
      if (!info.exists) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(info.frontmatter);
      } catch (error: unknown) {
        indexedFiles.push({
          file,
          content,
          recoveredIdentity:
            readRecoverableManagedNoteIdentity(content, info.frontmatter) ?? undefined,
          parseError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!isRecord(parsed)) {
        indexedFiles.push({ file, content });
        continue;
      }
      indexedFiles.push({
        file,
        content,
        frontmatter: parsed,
        identity: readManagedNoteIdentity(parsed),
      });
    }
    return indexedFiles;
  }

  private resolveConfiguredRoots(
    mappingId: string,
    rootProjectId: string,
    currentRootPath: string,
    previousFolders: readonly string[],
    runContext: ProjectSyncRunContext,
  ): ResolvedMappingRoot[] {
    const roots = new Map<string, ResolvedMappingRoot>();
    const addRoot = (root: ResolvedMappingRoot, required: boolean) => {
      const normalized = required
        ? this.validateRootFolder(root.path)
        : this.tryResolveExistingRootFolder(root.path);
      if (normalized === null) {
        return;
      }
      const key = `${root.mappingId}\u0000${root.rootProjectId}\u0000${portablePathKey(normalized)}`;
      roots.set(key, { ...root, path: normalized });
    };

    addRoot({ mappingId, rootProjectId, path: currentRootPath, active: true }, true);
    for (const previousFolder of previousFolders) {
      addRoot({ mappingId, rootProjectId, path: previousFolder, active: true }, false);
    }
    for (const mappingRoot of runContext.mappingRoots ?? []) {
      addRoot(
        { ...mappingRoot, path: mappingRoot.folder, active: mappingRoot.active !== false },
        false,
      );
    }
    return [...roots.values()];
  }

  private assertBackgroundFile(file: TFile): void {
    const filePath = normalizePath(file.path);
    for (const openPath of this.openFilePaths()) {
      if (normalizePath(openPath) === filePath) {
        throw new ActiveManagedNoteError(
          `Managed note '${file.path}' is open in an editor; synchronization was deferred`,
        );
      }
    }
  }

  private recordDeferred(
    result: ProjectSyncResult,
    taskId: string,
    path: string | undefined,
    message: string,
  ): void {
    result.deferred++;
    result.conflicts.push({
      taskId,
      path,
      message,
      deferred: true,
      projectionBlocked: true,
    });
  }

  private assertWithinRoot(root: string, path: string): void {
    if (!isPathInside(root, path)) {
      throw new Error(`Refusing to write outside project sync folder '${root}'`);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeConfiguredOwnershipRoot = (path: string): string | null => {
  const raw = path.trim().split("\\").join("/");
  if (
    raw === "" ||
    raw === "/" ||
    raw.startsWith("/") ||
    raw.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const normalized = normalizePath(raw);
  return normalized === "" || normalized === "/" ? null : normalized;
};

const readLegacyCatalogTask = (
  managed: ManagedFile | undefined,
): import("./catalog").ProjectCatalogTask | undefined => {
  if (managed === undefined) {
    return undefined;
  }
  const frontmatter = managed.frontmatter;
  const projectId = readNonEmptyString(frontmatter.todoist_project_id);
  if (projectId === null) {
    return undefined;
  }
  const parentId = readNonEmptyString(frontmatter.todoist_parent_task_id);
  const sectionId = readNonEmptyString(frontmatter.todoist_section_id);
  const order =
    typeof frontmatter.todoist_order === "number" && Number.isFinite(frontmatter.todoist_order)
      ? frontmatter.todoist_order
      : 0;
  return {
    id: managed.identity.taskId,
    projectId,
    ...(parentId === null ? {} : { parentId }),
    ...(sectionId === null ? {} : { sectionId }),
    order,
  };
};

const readLegacyProjectIdFromPath = (
  managed: ManagedFile,
  currentProjects: readonly { id: string; name: string }[],
): string | undefined => {
  const projectPath = managed.frontmatter.todoist_project_path;
  if (!Array.isArray(projectPath) || projectPath.length === 0) {
    return undefined;
  }
  const projectName = projectPath[projectPath.length - 1];
  if (typeof projectName !== "string") {
    return undefined;
  }
  const matches = currentProjects.filter((project) => project.name === projectName);
  return matches.length === 1 ? matches[0]?.id : `legacy-project:${projectName}`;
};

const readCatalogTaskFromUserProjection = (
  managed: ManagedFile | undefined,
  projects: readonly { id: string; name: string }[],
): import("./catalog").ProjectCatalogTask | undefined => {
  if (managed === undefined) {
    return undefined;
  }
  const projectId = readLegacyProjectIdFromPath(managed, projects);
  if (projectId === undefined) {
    return undefined;
  }
  return { id: managed.identity.taskId, projectId, order: 0 };
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const hasTaskRelationshipProperties = (frontmatter: ManagedFrontmatter): boolean =>
  "todoist_parent_task" in frontmatter || "todoist_subtasks" in frontmatter;

type CanonicalProjectionPath = {
  kind: "file" | "folder";
  ownerKey: string | null;
  owner: string;
  path: string;
};

type ProjectionIdentity = {
  createdAt?: string | null;
  id: string;
  kind: "project" | "task";
  tokenSource: string;
};

type ProjectionNamespaceEntry = {
  kind: CanonicalProjectionPath["kind"];
  name: string;
  owner: string;
  ownerKey: string;
};

const IDENTITY_FINGERPRINT_VISIBLE_LENGTH = 8;
const MAX_IDENTITY_TOKEN_LENGTH = 40;
const MAX_PROJECTION_ALLOCATION_PASSES = 128;
const PROJECTION_MARKER_SEPARATOR = " · ";
const IDENTITY_READABLE_HEAD_LENGTH = 8;
const IDENTITY_FINGERPRINT_RADIX = 36;
const IDENTITY_FINGERPRINT_PART_WIDTH = 7;
const FINGERPRINT_LEFT_SEED = 0x81_1c_9d_c5;
const FINGERPRINT_RIGHT_SEED = 0x9e_37_79_b9;
const FINGERPRINT_LEFT_MULTIPLIER = 0x01_00_01_93;
const FINGERPRINT_RIGHT_MULTIPLIER = 0x85_eb_ca_6b;

const validateCanonicalProjectionPaths = (
  snapshot: ProjectSyncSnapshot,
  rootPath: string,
): void => {
  makeCanonicalProjectionPlan(snapshot, rootPath);
};

const makeCanonicalProjectionPlan = (
  snapshot: ProjectSyncSnapshot,
  rootPath: string,
): CanonicalProjectionPlan => {
  const projectsById = new Map<string, ProjectSyncSnapshot["projects"][number]>();
  for (const project of snapshot.projects) {
    if (projectsById.has(project.id)) {
      throw new Error(`Todoist project '${project.id}' appears more than once in one snapshot`);
    }
    projectsById.set(project.id, project);
  }
  const rootProject = projectsById.get(snapshot.rootProjectId);
  if (rootProject === undefined) {
    throw new Error("Selected Todoist project is missing from the project sync snapshot");
  }

  const tasksById = new Map<string, SnapshotTask>();
  for (const snapshotTask of snapshot.tasks) {
    const taskId = snapshotTask.task.id;
    if (tasksById.has(taskId)) {
      throw new Error(`Todoist task '${taskId}' appears more than once in one project snapshot`);
    }
    tasksById.set(taskId, snapshotTask);
  }
  const parentByTaskId = makeSafeTaskParentMap(snapshot.tasks, tasksById);
  const parentTaskIds = new Set(parentByTaskId.values());
  const childrenByTaskId = new Map<string, string[]>();
  for (const [taskId, parentId] of parentByTaskId) {
    const children = childrenByTaskId.get(parentId) ?? [];
    children.push(taskId);
    childrenByTaskId.set(parentId, children);
  }

  const identities = new Map<string, ProjectionIdentity>();
  for (const project of snapshot.projects) {
    identities.set(projectionOwnerKey("project", project.id), {
      createdAt: project.createdAt,
      id: project.id,
      kind: "project",
      tokenSource: makeIdentityTokenSource(project.id),
    });
  }
  for (const { task } of snapshot.tasks) {
    identities.set(projectionOwnerKey("task", task.id), {
      createdAt: task.authoritativeCreatedAt,
      id: task.id,
      kind: "task",
      tokenSource: makeIdentityTokenSource(task.id),
    });
  }

  // Absence means the plain Todoist title. Zero means creation time alone; a positive value adds
  // that many stable identity-token characters after the time. Missing creation times skip
  // directly to the typed identity token.
  const markerLengths = new Map<string, number>();
  for (let pass = 0; pass < MAX_PROJECTION_ALLOCATION_PASSES; pass++) {
    const markerFor = makeProjectionMarkerResolver(identities, markerLengths);
    const collisions = findProjectionNamespaceCollisions(
      makeProjectionNamespaceEntries(snapshot, parentByTaskId, parentTaskIds, markerFor),
    );
    if (collisions.length === 0) {
      return buildCanonicalProjectionPlan(
        snapshot,
        rootPath,
        projectsById,
        tasksById,
        parentByTaskId,
        parentTaskIds,
        childrenByTaskId,
        markerFor,
      );
    }

    const newlyMarked = new Set<string>();
    for (const collision of collisions) {
      for (const { ownerKey } of collision) {
        if (!markerLengths.has(ownerKey)) {
          newlyMarked.add(ownerKey);
        }
      }
    }
    if (newlyMarked.size > 0) {
      for (const ownerKey of newlyMarked) {
        const identity = identities.get(ownerKey);
        markerLengths.set(
          ownerKey,
          identity !== undefined && makeCreationTimeMarker(identity.createdAt) !== undefined
            ? 0
            : initialIdentityTokenLength(identity),
        );
      }
      continue;
    }

    let extended = false;
    const collidingOwners = new Set(
      collisions.flatMap((collision) => collision.map(({ ownerKey }) => ownerKey)),
    );
    for (const ownerKey of collidingOwners) {
      const identity = identities.get(ownerKey);
      const currentLength = markerLengths.get(ownerKey);
      if (identity === undefined || currentLength === undefined) {
        continue;
      }
      const maximumLength = Math.min(MAX_IDENTITY_TOKEN_LENGTH, identity.tokenSource.length);
      if (currentLength === 0) {
        markerLengths.set(ownerKey, initialIdentityTokenLength(identity));
        extended = true;
      } else if (currentLength < maximumLength) {
        markerLengths.set(ownerKey, currentLength + 1);
        extended = true;
      }
    }
    if (!extended) {
      throw new Error(
        `Todoist identities cannot be represented uniquely in the mapped folder: ${formatProjectionCollisions(
          collisions,
        )}`,
      );
    }
  }

  throw new Error("Todoist path allocation did not converge");
};

const buildCanonicalProjectionPlan = (
  snapshot: ProjectSyncSnapshot,
  rootPath: string,
  projectsById: ReadonlyMap<string, ProjectSyncSnapshot["projects"][number]>,
  tasksById: ReadonlyMap<string, SnapshotTask>,
  parentByTaskId: ReadonlyMap<string, string>,
  parentTaskIds: ReadonlySet<string>,
  childrenByTaskId: ReadonlyMap<string, readonly string[]>,
  markerFor: (kind: ProjectionIdentity["kind"], id: string) => string | undefined,
): CanonicalProjectionPlan => {
  const paths: CanonicalProjectionPath[] = [];
  const folderKeys = new Set<string>();
  const fileTaskIdsByKey = new Map<string, string>();
  const fileKeysByTaskId = new Map<string, string>();
  const taskFolderTaskIdsByKey = new Map<string, ReadonlySet<string>>();
  const projectFoldersById = new Map<string, string>();
  const taskFilePlansById = new Map<string, TaskFilePlan>();
  const register = (
    path: string,
    kind: CanonicalProjectionPath["kind"],
    owner: string,
    ownerKey: string | null,
    taskId?: string,
  ): void => {
    const normalized = normalizePath(path);
    const key = portablePathKey(normalized);
    paths.push({ kind, owner, ownerKey, path: normalized });
    if (kind === "folder") {
      folderKeys.add(key);
    } else if (taskId !== undefined) {
      fileTaskIdsByKey.set(key, taskId);
      fileKeysByTaskId.set(taskId, key);
    }
  };

  const rootProject = projectsById.get(snapshot.rootProjectId);
  if (rootProject === undefined) {
    throw new Error("Selected Todoist project is missing from the project sync snapshot");
  }
  register(rootPath, "folder", `root project '${rootProject.name}' (${rootProject.id})`, null);

  const projectFolders = new Map<string, string>([[snapshot.rootProjectId, rootPath]]);
  const pendingProjects = new Map(
    snapshot.projects
      .filter((project) => project.id !== snapshot.rootProjectId)
      .map((project) => [project.id, project]),
  );
  while (pendingProjects.size > 0) {
    let madeProgress = false;
    for (const [projectId, project] of pendingProjects) {
      const parentPath =
        project.parentId === null ? undefined : projectFolders.get(project.parentId);
      if (parentPath === undefined) {
        continue;
      }
      const segment = makeProjectFolderSegment(project.name, markerFor("project", project.id));
      const path = normalizePath(`${parentPath}/${segment}`);
      register(
        path,
        "folder",
        `project '${project.name}' (${project.id})`,
        projectionOwnerKey("project", project.id),
      );
      projectFolders.set(projectId, path);
      pendingProjects.delete(projectId);
      madeProgress = true;
    }
    if (!madeProgress) {
      throw new Error("Selected Todoist project hierarchy contains an orphan or cycle");
    }
  }

  const taskFolders = new Map<string, string>();
  const taskDepths = new Map<string, number>();
  const visiting = new Set<string>();

  const registerTask = (snapshotTask: SnapshotTask): string => {
    const task = snapshotTask.task;
    const existing = taskFolders.get(task.id);
    if (existing !== undefined) {
      return existing;
    }
    if (visiting.has(task.id)) {
      throw new Error("Selected Todoist task hierarchy contains a cycle");
    }
    visiting.add(task.id);
    const parentId = parentByTaskId.get(task.id);
    const parentTask = parentId === undefined ? undefined : tasksById.get(parentId);
    const containingFolder =
      parentTask === undefined ? projectFolders.get(task.project.id) : registerTask(parentTask);
    if (containingFolder === undefined) {
      throw new Error(
        `Todoist task '${task.id}' belongs to a project outside the selected hierarchy`,
      );
    }

    let taskFolder = containingFolder;
    let taskPath: string;
    const marker = markerFor("task", task.id);
    if (parentTaskIds.has(task.id)) {
      const segment = makeTaskFolderSegment(task.content, marker);
      taskFolder = normalizePath(`${containingFolder}/${segment}`);
      register(
        taskFolder,
        "folder",
        `task '${task.content}' (${task.id})`,
        projectionOwnerKey("task", task.id),
      );
      taskFolderTaskIdsByKey.set(
        portablePathKey(taskFolder),
        collectTaskSubtreeIds(task.id, childrenByTaskId),
      );
      taskPath = normalizePath(`${taskFolder}/${makeTaskFilename(segment)}`);
      register(
        taskPath,
        "file",
        `task '${task.content}' (${task.id})`,
        projectionOwnerKey("task", task.id),
        task.id,
      );
    } else {
      taskPath = normalizePath(`${containingFolder}/${makeTaskFilename(task.content, marker)}`);
      register(
        taskPath,
        "file",
        `task '${task.content}' (${task.id})`,
        projectionOwnerKey("task", task.id),
        task.id,
      );
    }
    const depth = parentId === undefined ? 0 : (taskDepths.get(parentId) ?? -1) + 1;
    taskFolders.set(task.id, taskFolder);
    taskDepths.set(task.id, depth);
    taskFilePlansById.set(task.id, {
      depth,
      folder: taskFolder,
      ownsFolder: parentTaskIds.has(task.id),
      path: taskPath,
    });
    visiting.delete(task.id);
    return taskFolder;
  };

  for (const snapshotTask of snapshot.tasks) {
    registerTask(snapshotTask);
  }
  const physicalCollisions = findPhysicalProjectionCollisions(paths);
  if (physicalCollisions.length > 0) {
    throw new Error(
      `Internal Todoist path allocation conflict: ${formatPhysicalProjectionCollisions(
        physicalCollisions,
      )}`,
    );
  }
  for (const [projectId, path] of projectFolders) {
    projectFoldersById.set(projectId, path);
  }
  return {
    folderKeys,
    fileTaskIdsByKey,
    fileKeysByTaskId,
    taskFolderTaskIdsByKey,
    projectFoldersById,
    taskFilePlansById,
  };
};

const makeProjectionNamespaceEntries = (
  snapshot: ProjectSyncSnapshot,
  parentByTaskId: ReadonlyMap<string, string>,
  parentTaskIds: ReadonlySet<string>,
  markerFor: (kind: ProjectionIdentity["kind"], id: string) => string | undefined,
): ReadonlyMap<string, readonly ProjectionNamespaceEntry[]> => {
  const namespaces = new Map<string, ProjectionNamespaceEntry[]>();
  const add = (containerKey: string, entry: ProjectionNamespaceEntry): void => {
    const entries = namespaces.get(containerKey) ?? [];
    entries.push(entry);
    namespaces.set(containerKey, entries);
  };

  for (const project of snapshot.projects) {
    if (project.id !== snapshot.rootProjectId && project.parentId !== null) {
      add(projectionOwnerKey("project", project.parentId), {
        kind: "folder",
        name: makeProjectFolderSegment(project.name, markerFor("project", project.id)),
        owner: `project '${project.name}' (${project.id})`,
        ownerKey: projectionOwnerKey("project", project.id),
      });
    }
  }

  for (const { task } of snapshot.tasks) {
    const parentId = parentByTaskId.get(task.id);
    const containerKey =
      parentId === undefined
        ? projectionOwnerKey("project", task.project.id)
        : projectionOwnerKey("task", parentId);
    const marker = markerFor("task", task.id);
    add(containerKey, {
      kind: parentTaskIds.has(task.id) ? "folder" : "file",
      name: parentTaskIds.has(task.id)
        ? makeTaskFolderSegment(task.content, marker)
        : makeTaskFilename(task.content, marker),
      owner: `task '${task.content}' (${task.id})`,
      ownerKey: projectionOwnerKey("task", task.id),
    });
  }

  for (const taskId of parentTaskIds) {
    const snapshotTask = snapshot.tasks.find(({ task }) => task.id === taskId);
    if (snapshotTask === undefined) {
      continue;
    }
    const segment = makeTaskFolderSegment(snapshotTask.task.content, markerFor("task", taskId));
    add(projectionOwnerKey("task", taskId), {
      kind: "file",
      name: makeTaskFilename(segment),
      owner: `task '${snapshotTask.task.content}' (${taskId}) self note`,
      ownerKey: projectionOwnerKey("task", taskId),
    });
  }

  return namespaces;
};

const findProjectionNamespaceCollisions = (
  namespaces: ReadonlyMap<string, readonly ProjectionNamespaceEntry[]>,
): ProjectionNamespaceEntry[][] => {
  const collisions: ProjectionNamespaceEntry[][] = [];
  for (const entries of namespaces.values()) {
    const entriesByName = new Map<string, ProjectionNamespaceEntry[]>();
    for (const entry of entries) {
      const key = portablePathKey(entry.name);
      const sameName = entriesByName.get(key) ?? [];
      sameName.push(entry);
      entriesByName.set(key, sameName);
    }
    for (const sameName of entriesByName.values()) {
      if (new Set(sameName.map(({ ownerKey }) => ownerKey)).size > 1) {
        collisions.push(sameName);
      }
    }
  }
  return collisions;
};

const makeProjectionMarkerResolver =
  (
    identities: ReadonlyMap<string, ProjectionIdentity>,
    markerLengths: ReadonlyMap<string, number>,
  ): ((kind: ProjectionIdentity["kind"], id: string) => string | undefined) =>
  (kind, id) => {
    const ownerKey = projectionOwnerKey(kind, id);
    const length = markerLengths.get(ownerKey);
    const identity = identities.get(ownerKey);
    if (length === undefined || identity === undefined) {
      return undefined;
    }
    const creationTime = makeCreationTimeMarker(identity.createdAt);
    if (length === 0) {
      return creationTime;
    }
    const prefix = kind === "project" ? "p" : "t";
    const identityToken = `${prefix}-${identity.tokenSource.slice(0, length)}`;
    return creationTime === undefined
      ? identityToken
      : `${creationTime}${PROJECTION_MARKER_SEPARATOR}${identityToken}`;
  };

const makeCreationTimeMarker = (createdAt: string | null | undefined): string | undefined => {
  if (createdAt === null || createdAt === undefined) {
    return undefined;
  }
  if (!todoistTimestampSchema.safeParse(createdAt).success) {
    return undefined;
  }
  const timestamp = Date.parse(createdAt);
  // Todoist adapters use the Unix epoch only as an explicit placeholder when an old endpoint did
  // not supply a creation time. Treat it as missing instead of exposing a misleading 1970 date.
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  const iso = new Date(timestamp).toISOString();
  const normalizedParts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{3})Z$/u.exec(iso);
  if (normalizedParts === null) {
    return undefined;
  }
  const [, date, rawTime, milliseconds] = normalizedParts;
  const time = rawTime?.replace(/:/g, ".");
  if (date === undefined || time === undefined || milliseconds === undefined) {
    return undefined;
  }
  return `${date} ${time}${milliseconds === "000" ? "" : `.${milliseconds}`}Z`;
};

const projectionOwnerKey = (kind: ProjectionIdentity["kind"], id: string): string =>
  `${kind}:${id}`;

const makeIdentityTokenSource = (id: string): string => {
  const readable = Array.from(id.normalize("NFC"), (character) =>
    /[A-Za-z0-9_-]/u.test(character) ? character : "-",
  )
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedReadable = readable === "" ? "id" : readable;
  const head = normalizedReadable.slice(0, IDENTITY_READABLE_HEAD_LENGTH);
  const fingerprint = stableIdentityFingerprint(id);
  // A fixed readable head plus an identity-derived fingerprint keeps existing names stable when a
  // new same-time sibling is added. The complete normalized ID remains available only to resolve
  // the extraordinarily unlikely case where both fixed portions collide.
  return `${head}-${fingerprint}-${normalizedReadable}`;
};

const initialIdentityTokenLength = (identity: ProjectionIdentity | undefined): number => {
  if (identity === undefined) {
    return IDENTITY_FINGERPRINT_VISIBLE_LENGTH;
  }
  return Math.min(
    identity.tokenSource.length,
    IDENTITY_READABLE_HEAD_LENGTH + 1 + IDENTITY_FINGERPRINT_VISIBLE_LENGTH,
  );
};

const stableIdentityFingerprint = (value: string): string => {
  let left = FINGERPRINT_LEFT_SEED;
  let right = FINGERPRINT_RIGHT_SEED;
  for (const byte of new TextEncoder().encode(value)) {
    left = Math.imul(left ^ byte, FINGERPRINT_LEFT_MULTIPLIER) >>> 0;
    right = Math.imul(right ^ byte, FINGERPRINT_RIGHT_MULTIPLIER) >>> 0;
    right = ((right << 13) | (right >>> 19)) >>> 0;
  }
  return `${left
    .toString(IDENTITY_FINGERPRINT_RADIX)
    .padStart(IDENTITY_FINGERPRINT_PART_WIDTH, "0")}${right
    .toString(IDENTITY_FINGERPRINT_RADIX)
    .padStart(IDENTITY_FINGERPRINT_PART_WIDTH, "0")}`;
};

const findPhysicalProjectionCollisions = (
  paths: readonly CanonicalProjectionPath[],
): [CanonicalProjectionPath, CanonicalProjectionPath][] => {
  const collisions: [CanonicalProjectionPath, CanonicalProjectionPath][] = [];
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex++) {
    const left = paths[leftIndex];
    if (left === undefined) {
      continue;
    }
    const leftKey = portablePathKey(left.path);
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex++) {
      const right = paths[rightIndex];
      if (right === undefined) {
        continue;
      }
      const rightKey = portablePathKey(right.path);
      if (
        leftKey === rightKey ||
        (left.kind === "file" && rightKey.startsWith(`${leftKey}/`)) ||
        (right.kind === "file" && leftKey.startsWith(`${rightKey}/`))
      ) {
        collisions.push([left, right]);
      }
    }
  }
  return collisions;
};

const formatProjectionCollisions = (
  collisions: readonly (readonly ProjectionNamespaceEntry[])[],
): string =>
  collisions
    .map((entries) =>
      entries
        .map(({ owner }) => owner)
        .sort(compareStableIds)
        .join(" / "),
    )
    .sort(compareStableIds)
    .join("; ");

const formatPhysicalProjectionCollisions = (
  collisions: readonly (readonly [CanonicalProjectionPath, CanonicalProjectionPath])[],
): string =>
  collisions
    .map(([left, right]) => `${left.owner} at '${left.path}' / ${right.owner} at '${right.path}'`)
    .sort(compareStableIds)
    .join("; ");

const makeSafeTaskParentMap = (
  snapshotTasks: readonly SnapshotTask[],
  tasksById: ReadonlyMap<string, SnapshotTask>,
): Map<string, string> => {
  const candidates = new Map<string, string>();
  for (const { task } of snapshotTasks) {
    if (task.parentId === undefined || task.parentId === task.id) {
      continue;
    }
    const parent = tasksById.get(task.parentId)?.task;
    if (parent === undefined || parent.project.id !== task.project.id) {
      continue;
    }
    candidates.set(task.id, parent.id);
  }

  const safe = new Map<string, string>();
  for (const [taskId, parentId] of candidates) {
    const seen = new Set<string>([taskId]);
    let current: string | undefined = parentId;
    let cyclic = false;
    while (current !== undefined) {
      if (seen.has(current)) {
        cyclic = true;
        break;
      }
      seen.add(current);
      current = candidates.get(current);
    }
    if (!cyclic) {
      safe.set(taskId, parentId);
    }
  }
  return safe;
};

const collectTaskSubtreeIds = (
  rootTaskId: string,
  childrenByTaskId: ReadonlyMap<string, readonly string[]>,
): Set<string> => {
  const result = new Set<string>();
  const pending = [rootTaskId];
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (taskId === undefined || result.has(taskId)) {
      continue;
    }
    result.add(taskId);
    pending.push(...(childrenByTaskId.get(taskId) ?? []));
  }
  return result;
};

const removeManagedFile = (filesByTaskId: Map<string, ManagedFile[]>, file: TFile): void => {
  for (const [taskId, files] of filesByTaskId) {
    const remaining = files.filter((managed) => managed.file !== file);
    if (remaining.length === files.length) {
      continue;
    }
    if (remaining.length === 0) {
      filesByTaskId.delete(taskId);
    } else {
      filesByTaskId.set(taskId, remaining);
    }
  }
};

const groupCompletionEventsByTaskId = (
  events: readonly import("./types").ProjectCompletionEvent[],
): Map<string, import("./types").ProjectCompletionEvent[]> => {
  const result = new Map<string, import("./types").ProjectCompletionEvent[]>();
  const seenIds = new Set<string>();
  for (const event of events) {
    if (seenIds.has(event.id)) {
      continue;
    }
    seenIds.add(event.id);
    const taskEvents = result.get(event.taskId) ?? [];
    taskEvents.push(event);
    result.set(event.taskId, taskEvents);
  }
  return result;
};

/**
 * Read strict Obsidian frontmatter, with one narrowly scoped recovery path for projection damage
 * emitted by older Tasks Bridge builds. Those builds could join the closing `---` directly to the
 * plugin's managed marker (optionally with one duplicated managed scalar between two delimiters).
 * No other malformed document is treated as managed.
 */
const getManagedFrontMatterInfo = (content: string): ManagedFrontMatterInfo => {
  const strict = getFrontMatterInfo(content);
  if (strict.exists || !content.startsWith("---\n")) {
    return strict;
  }

  const marker = content.indexOf(MANAGED_BODY_START);
  if (marker < 0 || content.indexOf(MANAGED_BODY_START, marker + MANAGED_BODY_START.length) >= 0) {
    return strict;
  }
  const joinedClosing = marker - YAML_DELIMITER_WITH_LEADING_LINE_BREAK.length;
  if (
    joinedClosing < YAML_OPENING_LENGTH ||
    content.slice(joinedClosing, marker) !== YAML_DELIMITER_WITH_LEADING_LINE_BREAK
  ) {
    return strict;
  }

  let closing = joinedClosing;
  const earlierClosing = content.lastIndexOf(
    YAML_DELIMITER_WITH_LEADING_LINE_BREAK,
    joinedClosing - 1,
  );
  if (
    earlierClosing >= YAML_OPENING_LENGTH &&
    isRecoverableManagedFrontmatterResidue(
      content.slice(earlierClosing + YAML_DELIMITER_WITH_LEADING_LINE_BREAK.length, marker),
    )
  ) {
    closing = earlierClosing;
  }

  return {
    exists: true,
    frontmatter: content.slice(YAML_OPENING_LENGTH, closing),
    contentStart: closing + YAML_DELIMITER_WITH_LEADING_LINE_BREAK.length,
  };
};

const sameManagedOwnership = (left: ManagedNoteIdentity, right: ManagedNoteIdentity): boolean =>
  left.taskId === right.taskId;

const readTimestamp = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
};

const portablePathKey = (path: string): string =>
  normalizePath(path).normalize("NFC").toLocaleLowerCase("en-US");

const comparePortablePaths = (left: string, right: string): number => {
  const keyComparison = compareStableIds(portablePathKey(left), portablePathKey(right));
  return keyComparison === 0
    ? compareStableIds(normalizePath(left), normalizePath(right))
    : keyComparison;
};

const portablePathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const compareStableIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const compareTaskProjectionOrder = (
  left: SnapshotTask["task"],
  right: SnapshotTask["task"],
): number => {
  const orderComparison = left.order - right.order;
  return orderComparison === 0 ? compareStableIds(left.id, right.id) : orderComparison;
};

const mostSpecificContainingRoot = (
  roots: readonly string[],
  filePath: string,
): string | undefined =>
  roots
    .filter((root) => isPathInside(root, filePath))
    .sort((left, right) => right.length - left.length)[0];

const mostSpecificMatchingIdentityRoot = (
  roots: readonly ResolvedMappingRoot[],
  filePath: string,
): ResolvedMappingRoot | undefined =>
  roots
    .filter((root) => isPathInside(root.path, filePath))
    .sort((left, right) => right.path.length - left.path.length)[0];
