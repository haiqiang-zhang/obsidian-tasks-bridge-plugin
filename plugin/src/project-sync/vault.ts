import { dump as dumpYaml } from "js-yaml";
import {
  type FileManager,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
  type TAbstractFile,
  TFile,
  type Vault,
} from "obsidian";

import {
  makeProjectCatalog,
  mergeProjectCompletionEvents,
  type ProjectCatalog,
  type ProjectCatalogStorage,
} from "./catalog";
import {
  applyManagedTaskRelationships,
  isRecoverableManagedFrontmatterResidue,
  isSameUserOwnedTaskDocument,
  LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS,
  MANAGED_BODY_START,
  ManagedBodyConflictError,
  type ManagedFrontmatter,
  type ManagedNoteIdentity,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  readUserOwnedTaskDocument,
  removeLegacyImplementationFrontmatter,
  renderNewTaskDocument,
  renderTaskDocumentWithUserContent,
  replaceManagedTaskDocument,
  type UserOwnedTaskDocument,
} from "./document";
import { projectHierarchyPath } from "./hierarchy";
import {
  isPathInside,
  makeDisambiguatedProjectSegment,
  makeProjectSegments,
  makeTaskFilename,
  makeTaskFolderSegment,
  sanitizePathSegment,
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
};

type ResolvedMappingRoot = {
  mappingId: string;
  rootProjectId: string;
  path: string;
  active: boolean;
};

type ResolvedFilePath = {
  path: string;
  usedAlternate: boolean;
  unmanagedCollision: boolean;
};

type ResolvedTaskFolder = {
  path: string;
  preferredPath: string;
  segment: string;
  usedAlternate: boolean;
  unmanagedCollision: boolean;
};

type TaskFilePlan = {
  depth: number;
  folder: string;
  filenameContent: string;
  preferredPath: string;
  folderCollision?: ResolvedTaskFolder;
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

type IndexedVaultFile = {
  file: TFile;
  content: string;
  frontmatter?: ManagedFrontmatter;
  identity?: ManagedNoteIdentity | null;
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

type DuplicateCandidate = {
  managed: ManagedFile;
  live: LiveManagedNote;
  userDocument: UserOwnedTaskDocument;
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

const alwaysValidRun: ProjectSyncRunContext = { assertValid: () => undefined };
const runMutationDirectly: ProjectSyncInternalMutationRunner = async (_affectedPaths, operation) =>
  await operation();

class ActiveManagedNoteError extends Error {}
class HistoricalProjectionConflictError extends Error {}
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
  private readonly managedFileIndexes = new WeakMap<object, Promise<IndexedVaultFile[]>>();

  constructor(
    vault: Vault,
    fileManager: FileManager,
    openFilePaths: OpenFilePathsProvider,
    runInternalMutation: ProjectSyncInternalMutationRunner = runMutationDirectly,
    catalogStorage?: ProjectCatalogStorage,
  ) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.openFilePaths = openFilePaths;
    this.runInternalMutation = runInternalMutation;
    this.catalogStorage = catalogStorage;
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

  public async reconcile(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    runContext: ProjectSyncRunContext = alwaysValidRun,
  ): Promise<ProjectSyncResult> {
    runContext.assertValid();
    if (mapping.project === null || mapping.project.projectId !== snapshot.rootProjectId) {
      throw new Error("Project sync snapshot does not match its configured Todoist project");
    }
    const result = emptyResult();
    const previousCatalog = this.catalogStorage?.getCatalog(mapping.id) ?? null;
    const rootPath = this.validateRootFolder(mapping.folder);
    const missingHistoricalRoot = mapping.previousFolders.some(
      (folder) => this.tryResolveExistingRootFolder(folder) === null,
    );
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const projectFolders = await this.ensureProjectFolders(snapshot, rootPath, runContext);
    runContext.assertValid();
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
    const pathIndex = new PortableVaultPathIndex(this.vault.getAllLoadedFiles());
    const managedFiles = new Set<TFile>(
      [...configuredByTaskId.values()].flatMap((files) => files.map(({ file }) => file)),
    );
    const previousTaskFolders = collectProjectedTaskFolders(managedById, rootPath);
    const taskFilePlans = await this.ensureTaskFilePlans(
      snapshot.tasks,
      projectFolders,
      configuredByTaskId,
      managedFiles,
      rootPath,
      pathIndex,
      runContext,
    );
    runContext.assertValid();
    const completionEventsByTaskId = groupCompletionEventsByTaskId(snapshot.completionEvents ?? []);
    const projectedFilesByTaskId = new Map<string, ProjectedTaskFile>();
    const conflictedIds = new Set<string>();
    const desiredIds = new Set(snapshot.tasks.map(({ task }) => task.id));
    const desiredTaskFolders = new Set(
      [...taskFilePlans.values()].flatMap((plan) =>
        plan.folderCollision === undefined ? [] : [portablePathKey(plan.folder)],
      ),
    );

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
      if (conflictedIds.has(taskId)) {
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
      if (taskFilePlan.folderCollision?.unmanagedCollision === true) {
        result.conflicts.push({
          taskId,
          path: taskFilePlan.folderCollision.path,
          message: `Parent-task folder '${taskFilePlan.folderCollision.preferredPath}' is already in use; using '${taskFilePlan.folderCollision.path}'`,
        });
      }
      // A duplicate is scoped to this selected mapping/root plus Todoist's immutable task ID.
      // Same-ID notes owned by another configured mapping are migration candidates, not copies
      // that this mapping may discard.
      const duplicateFiles = managedById.get(taskId) ?? [];
      if (duplicateFiles.length > 1) {
        try {
          const reconciled = await this.reconcileDuplicateManagedFiles(
            duplicateFiles,
            desiredFrontmatter,
            desiredBody,
            taskFilePlan.folder,
            taskFilePlan.filenameContent,
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
      if (existing === undefined && creationFencePaths.length > 0) {
        result.conflicts.push({
          taskId,
          path: creationFencePaths.join(", "),
          message:
            "Task-note creation was blocked because a likely managed note has unreadable frontmatter in this mapping; repair that note before synchronizing again",
          projectionBlocked: true,
        });
        continue;
      }
      const resolvedPath = this.resolveAvailableTaskFilePath(
        taskFilePlan.folder,
        taskFilePlan.filenameContent,
        existing?.file,
        rootPath,
        pathIndex,
        managedFiles,
      );
      const targetPath = resolvedPath.path;
      if (resolvedPath.unmanagedCollision) {
        result.conflicts.push({
          taskId,
          path: targetPath,
          message: `Task path '${taskFilePlan.preferredPath}' is occupied by an unmanaged vault item; using '${targetPath}'`,
        });
      }

      try {
        if (existing === undefined) {
          runContext.assertValid();
          const created = await this.createManagedFile(
            targetPath,
            renderNewTaskDocument(desiredFrontmatter, desiredBody),
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

      if (files.length > 1) {
        conflictedIds.add(taskId);
        result.conflicts.push({
          taskId,
          path: files
            .map(({ file }) => file.path)
            .sort(comparePortablePaths)
            .join(", "),
          message: `Multiple managed notes use Todoist task ID '${taskId}', but the task is absent from the current Todoist snapshot; all copies were preserved`,
          projectionBlocked: true,
        });
        continue;
      }

      const managed = files[0];
      const catalogTask =
        previousCatalog?.tasks.find((task) => task.id === taskId) ?? readLegacyCatalogTask(managed);
      const outOfScopeProjectId =
        catalogTask?.projectId ?? readLegacyProjectIdFromPath(managed, snapshot.projects);
      const remainsOutOfScope =
        !mapping.includeSubprojects &&
        outOfScopeProjectId !== undefined &&
        outOfScopeProjectId !== snapshot.rootProjectId;
      // A task can move between configured mappings in one complete multi-project snapshot.
      // Let the destination mapping move its existing file instead of treating it as deleted.
      const existsInAnotherSnapshot = runContext.allSnapshotTaskIds?.has(taskId) === true;

      if (!remainsOutOfScope && !existsInAnotherSnapshot) {
        try {
          await this.trashMissingManagedFile(managed, snapshot.syncedAt, runContext);
        } catch (error: unknown) {
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
        managedById.delete(taskId);
        result.deleted++;
        continue;
      }

      try {
        const migration = await this.moveHistoricalManagedFile(
          managed,
          rootPath,
          pathIndex,
          managedFiles,
          runContext,
        );
        if (migration.moved) {
          result.moved++;
        }
        if (migration.unmanagedCollision) {
          result.conflicts.push({
            taskId,
            path: managed.file.path,
            message: `The preferred task path was occupied by an unmanaged vault item; moved the note to '${managed.file.path}'`,
          });
        }
      } catch (error: unknown) {
        if (error instanceof ActiveManagedNoteError) {
          this.recordDeferred(result, taskId, managed.file.path, error.message);
          continue;
        }
        if (error instanceof HistoricalProjectionConflictError) {
          result.conflicts.push({
            taskId,
            path: managed.file.path,
            message: error.message,
            projectionBlocked: true,
          });
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

      if (remainsOutOfScope) {
        try {
          const updated = await this.markOutOfScope(managed, runContext);
          result.outOfScope++;
          if (updated) {
            result.updated++;
          } else {
            result.unchanged++;
          }
        } catch (error: unknown) {
          if (error instanceof ActiveManagedNoteError) {
            this.recordDeferred(result, taskId, managed.file.path, error.message);
            continue;
          }
          if (error instanceof ManagedNoteIdentityConflictError) {
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
      }
    }

    await this.cleanupObsoleteTaskFolders(
      previousTaskFolders,
      desiredTaskFolders,
      rootPath,
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

    await this.persistCatalogState(snapshot, mapping, previousCatalog, managedById);

    return result;
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
    snapshot: ProjectSyncSnapshot,
    rootPath: string,
    runContext: ProjectSyncRunContext,
  ): Promise<Map<string, string>> {
    const segments = makeProjectSegments(snapshot.projects);
    const rootProject = snapshot.projects.find((project) => project.id === snapshot.rootProjectId);
    if (rootProject === undefined) {
      throw new Error("Selected Todoist project is missing from the project sync snapshot");
    }

    const folders = new Map<string, string>([[snapshot.rootProjectId, rootPath]]);
    const pending = new Map(
      snapshot.projects
        .filter((project) => project.id !== snapshot.rootProjectId)
        .map((project) => [project.id, project]),
    );

    while (pending.size > 0) {
      runContext.assertValid();
      let madeProgress = false;
      for (const [projectId, project] of pending) {
        const parentPath = project.parentId === null ? undefined : folders.get(project.parentId);
        if (parentPath === undefined) {
          continue;
        }

        const segment =
          segments.get(projectId) ?? sanitizePathSegment(project.name, "Untitled project");
        const folder = await this.resolveProjectFolder(
          parentPath,
          segment,
          projectId,
          rootPath,
          runContext,
        );
        folders.set(projectId, folder);
        pending.delete(projectId);
        madeProgress = true;
      }

      if (!madeProgress) {
        throw new Error("Selected Todoist project hierarchy contains an orphan or cycle");
      }
    }

    return folders;
  }

  private async resolveProjectFolder(
    parentPath: string,
    segment: string,
    projectId: string,
    rootPath: string,
    runContext: ProjectSyncRunContext,
  ): Promise<string> {
    const candidates = [segment, makeDisambiguatedProjectSegment(segment, projectId)];

    for (let suffix = 2; ; suffix++) {
      runContext.assertValid();
      const candidateSegment =
        candidates.shift() ?? makeDisambiguatedProjectSegment(segment, projectId, suffix);
      const path = normalizePath(`${parentPath}/${candidateSegment}`);
      this.assertWithinRoot(rootPath, path);

      if (this.vault.getFolderByPath(path) !== null) {
        return path;
      }
      if (this.vault.getAbstractFileByPath(path) !== null) {
        continue;
      }

      try {
        runContext.assertValid();
        await this.runInternalMutation([path], async () => await this.vault.createFolder(path));
        runContext.assertValid();
        return path;
      } catch (error: unknown) {
        if (this.vault.getFolderByPath(path) !== null) {
          return path;
        }
        if (this.vault.getAbstractFileByPath(path) === null) {
          throw error;
        }
      }
    }
  }

  private async ensureTaskFilePlans(
    snapshotTasks: readonly SnapshotTask[],
    projectFolders: ReadonlyMap<string, string>,
    configuredByTaskId: ReadonlyMap<string, readonly ManagedFile[]>,
    managedFiles: ReadonlySet<TFile>,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    runContext: ProjectSyncRunContext,
  ): Promise<Map<string, TaskFilePlan>> {
    const tasksById = new Map(
      snapshotTasks.map((snapshotTask) => [snapshotTask.task.id, snapshotTask]),
    );
    const parentByTaskId = makeSafeTaskParentMap(snapshotTasks, tasksById);
    const desiredTaskIds = new Set(tasksById.keys());
    const parentTaskIds = new Set(parentByTaskId.values());
    const childrenByTaskId = new Map<string, string[]>();
    for (const [taskId, parentId] of parentByTaskId) {
      const children = childrenByTaskId.get(parentId) ?? [];
      children.push(taskId);
      childrenByTaskId.set(parentId, children);
    }
    const managedTaskIdByFile = new Map<TFile, string>();
    for (const [taskId, files] of configuredByTaskId) {
      for (const { file } of files) {
        managedTaskIdByFile.set(file, taskId);
      }
    }
    const plans = new Map<string, TaskFilePlan>();
    const reservedFolders = new Set([...projectFolders.values()].map(portablePathKey));
    const visiting = new Set<string>();

    const planTask = async (snapshotTask: SnapshotTask): Promise<TaskFilePlan | undefined> => {
      const taskId = snapshotTask.task.id;
      const existingPlan = plans.get(taskId);
      if (existingPlan !== undefined) {
        return existingPlan;
      }
      if (visiting.has(taskId)) {
        return undefined;
      }
      visiting.add(taskId);

      const parentId = parentByTaskId.get(taskId);
      const parentPlan =
        parentId === undefined
          ? undefined
          : await planTask(tasksById.get(parentId) as SnapshotTask);
      const containingFolder =
        parentPlan?.folder ?? projectFolders.get(snapshotTask.task.project.id);
      if (containingFolder === undefined) {
        visiting.delete(taskId);
        return undefined;
      }

      let plan: TaskFilePlan;
      if (parentTaskIds.has(taskId)) {
        const existingFiles = configuredByTaskId.get(taskId) ?? [];
        const current = existingFiles.length === 1 ? existingFiles[0]?.file : undefined;
        const resolvedFolder = await this.resolveTaskFolder(
          containingFolder,
          snapshotTask.task.content,
          current,
          rootPath,
          pathIndex,
          reservedFolders,
          collectTaskSubtreeIds(taskId, childrenByTaskId),
          desiredTaskIds,
          managedFiles,
          managedTaskIdByFile,
          runContext,
        );
        plan = {
          depth: (parentPlan?.depth ?? -1) + 1,
          folder: resolvedFolder.path,
          filenameContent: resolvedFolder.segment,
          preferredPath: normalizePath(
            `${resolvedFolder.path}/${makeTaskFilename(resolvedFolder.segment)}`,
          ),
          folderCollision: resolvedFolder,
        };
      } else {
        plan = {
          depth: (parentPlan?.depth ?? -1) + 1,
          folder: containingFolder,
          filenameContent: snapshotTask.task.content,
          preferredPath: normalizePath(
            `${containingFolder}/${makeTaskFilename(snapshotTask.task.content)}`,
          ),
        };
      }
      plans.set(taskId, plan);
      visiting.delete(taskId);
      return plan;
    };

    for (const snapshotTask of [...snapshotTasks].sort((left, right) =>
      compareStableIds(left.task.id, right.task.id),
    )) {
      runContext.assertValid();
      await planTask(snapshotTask);
    }
    return plans;
  }

  private async resolveTaskFolder(
    containingFolder: string,
    content: string,
    current: TFile | undefined,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    reservedFolders: Set<string>,
    allowedTaskIds: ReadonlySet<string>,
    desiredTaskIds: ReadonlySet<string>,
    managedFiles: ReadonlySet<TFile>,
    managedTaskIdByFile: ReadonlyMap<TFile, string>,
    runContext: ProjectSyncRunContext,
  ): Promise<ResolvedTaskFolder> {
    const preferredPath = normalizePath(`${containingFolder}/${makeTaskFolderSegment(content)}`);
    let preferredCollisionIndex = this.currentTaskFolderCollisionIndex(
      containingFolder,
      content,
      current,
    );
    let nextCollisionIndex = 1;
    const triedCollisionIndexes = new Set<number>();
    let unmanagedCollision = false;
    for (;;) {
      runContext.assertValid();
      const collisionIndex = preferredCollisionIndex ?? nextCollisionIndex++;
      preferredCollisionIndex = undefined;
      if (triedCollisionIndexes.has(collisionIndex)) {
        continue;
      }
      triedCollisionIndexes.add(collisionIndex);
      const segment = makeTaskFolderSegment(content, collisionIndex);
      const path = normalizePath(`${containingFolder}/${segment}`);
      const pathKey = portablePathKey(path);
      this.assertWithinRoot(rootPath, path);
      if (reservedFolders.has(pathKey)) {
        continue;
      }

      const notePath = normalizePath(`${path}/${makeTaskFilename(segment)}`);
      const noteOccupants = pathIndex.occupants(notePath, current);
      if (noteOccupants.length > 0) {
        unmanagedCollision ||= noteOccupants.some(
          (occupant) =>
            !(occupant instanceof TFile) || current === undefined || occupant !== current,
        );
        continue;
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
          )
        ) {
          unmanagedCollision = true;
          continue;
        }
        reservedFolders.add(pathKey);
        return {
          path,
          preferredPath,
          segment,
          usedAlternate: collisionIndex > 1,
          unmanagedCollision,
        };
      }
      if (this.vault.getAbstractFileByPath(path) !== null) {
        unmanagedCollision = true;
        continue;
      }

      try {
        runContext.assertValid();
        const created = await this.runInternalMutation(
          [path],
          async () => await this.vault.createFolder(path),
        );
        pathIndex.add(created);
        reservedFolders.add(pathKey);
        runContext.assertValid();
        return {
          path,
          preferredPath,
          segment,
          usedAlternate: collisionIndex > 1,
          unmanagedCollision,
        };
      } catch (error: unknown) {
        const racedFolder = this.vault.getFolderByPath(path);
        if (racedFolder !== null && !reservedFolders.has(pathKey)) {
          pathIndex.add(racedFolder);
          reservedFolders.add(pathKey);
          return {
            path,
            preferredPath,
            segment,
            usedAlternate: collisionIndex > 1,
            unmanagedCollision,
          };
        }
        if (this.vault.getAbstractFileByPath(path) === null) {
          throw error;
        }
        unmanagedCollision = true;
      }
    }
  }

  private isReusableTaskFolder(
    path: string,
    current: TFile | undefined,
    allowedTaskIds: ReadonlySet<string>,
    desiredTaskIds: ReadonlySet<string>,
    managedFiles: ReadonlySet<TFile>,
    managedTaskIdByFile: ReadonlyMap<TFile, string>,
  ): boolean {
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

  private async cleanupObsoleteTaskFolders(
    candidates: ReadonlySet<string>,
    desiredFolders: ReadonlySet<string>,
    rootPath: string,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    const ordered = [...candidates].sort((left, right) => {
      const depthComparison = right.split("/").length - left.split("/").length;
      return depthComparison === 0 ? comparePortablePaths(left, right) : depthComparison;
    });
    for (const path of ordered) {
      runContext.assertValid();
      if (desiredFolders.has(portablePathKey(path)) || !isPathInside(rootPath, path)) {
        continue;
      }
      const folder = this.vault.getFolderByPath(path);
      if (folder === null) {
        continue;
      }
      if (
        this.vault
          .getAllLoadedFiles()
          .some((entry) => normalizePath(entry.path).startsWith(`${path}/`))
      ) {
        continue;
      }
      await this.runInternalMutation([path], async () => await this.fileManager.trashFile(folder));
      runContext.assertValid();
    }
  }

  private currentTaskFolderCollisionIndex(
    containingFolder: string,
    content: string,
    current: TFile | undefined,
  ): number | undefined {
    if (current === undefined) {
      return undefined;
    }
    const currentPath = normalizePath(current.path);
    const fileSeparator = currentPath.lastIndexOf("/");
    if (fileSeparator < 0) {
      return undefined;
    }
    const currentFolder = currentPath.slice(0, fileSeparator);
    const folderSeparator = currentFolder.lastIndexOf("/");
    const currentContainingFolder =
      folderSeparator < 0 ? "" : currentFolder.slice(0, folderSeparator);
    if (currentContainingFolder !== normalizePath(containingFolder)) {
      return undefined;
    }
    const segment = currentFolder.slice(folderSeparator + 1);
    if (currentPath !== normalizePath(`${currentFolder}/${makeTaskFilename(segment)}`)) {
      return undefined;
    }
    if (segment === makeTaskFolderSegment(content)) {
      return 1;
    }
    const suffix = segment.match(/ \((\d+)\)$/u);
    if (suffix === null) {
      return undefined;
    }
    const collisionIndex = Number(suffix[1]);
    return Number.isSafeInteger(collisionIndex) &&
      collisionIndex >= 2 &&
      segment === makeTaskFolderSegment(content, collisionIndex)
      ? collisionIndex
      : undefined;
  }

  private resolveAvailableTaskFilePath(
    folder: string,
    content: string,
    current: TFile | undefined,
    root: string,
    pathIndex: PortableVaultPathIndex,
    managedFiles: ReadonlySet<TFile>,
  ): ResolvedFilePath {
    const preferredCollisionIndex = this.currentTaskFilenameCollisionIndex(
      folder,
      content,
      current,
    );
    if (preferredCollisionIndex !== undefined && current !== undefined) {
      const preferredPath = normalizePath(
        `${folder}/${makeTaskFilename(content, preferredCollisionIndex)}`,
      );
      this.assertWithinRoot(root, preferredPath);
      if (pathIndex.occupants(preferredPath, current).length === 0) {
        return {
          path: preferredPath,
          usedAlternate: preferredCollisionIndex > 1,
          unmanagedCollision: false,
        };
      }
    }

    let unmanagedCollision = false;
    for (let collisionIndex = 1; ; collisionIndex++) {
      const candidate = normalizePath(`${folder}/${makeTaskFilename(content, collisionIndex)}`);
      this.assertWithinRoot(root, candidate);
      const occupants = pathIndex.occupants(candidate, current);
      if (occupants.length === 0) {
        return {
          path: candidate,
          usedAlternate: collisionIndex > 1,
          unmanagedCollision,
        };
      }
      unmanagedCollision ||= occupants.some(
        (occupant) => !(occupant instanceof TFile) || !managedFiles.has(occupant),
      );
    }
  }

  private currentTaskFilenameCollisionIndex(
    folder: string,
    content: string,
    current: TFile | undefined,
  ): number | undefined {
    if (current === undefined) {
      return undefined;
    }

    const currentPath = normalizePath(current.path);
    if (currentPath === normalizePath(`${folder}/${makeTaskFilename(content)}`)) {
      return 1;
    }

    const filename = currentPath.slice(currentPath.lastIndexOf("/") + 1);
    const suffixMatch = filename.match(/ \((\d+)\)\.md$/u);
    if (suffixMatch === null) {
      return undefined;
    }
    const collisionIndex = Number(suffixMatch[1]);
    if (!Number.isSafeInteger(collisionIndex) || collisionIndex < 2) {
      return undefined;
    }
    const candidate = normalizePath(`${folder}/${makeTaskFilename(content, collisionIndex)}`);
    return currentPath === candidate ? collisionIndex : undefined;
  }

  private async moveHistoricalManagedFile(
    managed: ManagedFile,
    currentRoot: string,
    pathIndex: PortableVaultPathIndex,
    managedFiles: ReadonlySet<TFile>,
    runContext: ProjectSyncRunContext,
  ): Promise<{ moved: boolean; usedAlternate: boolean; unmanagedCollision: boolean }> {
    const currentPath = normalizePath(managed.file.path);
    const isInCurrentRoot = isPathInside(currentRoot, currentPath);
    if (!isInCurrentRoot && !isPathInside(managed.projectionRoot, currentPath)) {
      throw new HistoricalProjectionConflictError(
        `Managed note '${managed.file.path}' is outside its registered historical root`,
      );
    }

    const sourceRoot = isInCurrentRoot ? currentRoot : managed.projectionRoot;
    const relativePath = currentPath.slice(sourceRoot.length).replace(/^\/+/, "");
    const separator = relativePath.lastIndexOf("/");
    const relativeParent = separator < 0 ? "" : relativePath.slice(0, separator);
    const targetFolder = normalizePath(
      relativeParent === "" ? currentRoot : `${currentRoot}/${relativeParent}`,
    );
    const storedContent = managed.frontmatter.todoist_content;
    const content = typeof storedContent === "string" ? storedContent : "Untitled task";
    const resolved = this.resolveAvailableTaskFilePath(
      targetFolder,
      content,
      managed.file,
      currentRoot,
      pathIndex,
      managedFiles,
    );
    if (resolved.path === currentPath) {
      return { moved: false, ...resolved };
    }

    runContext.assertValid();
    this.assertBackgroundFile(managed.file);
    await this.ensureParentFolders(resolved.path, currentRoot, pathIndex, runContext);
    await this.assertLiveManagedIdentity(managed);
    this.assertLivePathAvailable(resolved.path, managed.file);
    const oldPath = managed.file.path;
    try {
      await this.runInternalMutation(
        [oldPath, resolved.path],
        async () => await this.fileManager.renameFile(managed.file, resolved.path),
      );
    } catch (error: unknown) {
      this.throwPathRaceIfOccupied(resolved.path, managed.file);
      throw error;
    }
    pathIndex.move(managed.file, oldPath, resolved.path);
    runContext.assertValid();
    return {
      moved: true,
      usedAlternate: resolved.usedAlternate,
      unmanagedCollision: resolved.unmanagedCollision,
    };
  }

  /**
   * Collapse files in one validated mapping that claim the same immutable Todoist task identity.
   *
   * The desired target is derived only from the live Todoist snapshot. We merge only when every
   * user-owned region is identical, rebuild one fresh projection, and then use Obsidian's
   * recoverable trash operation for the remaining copies. Divergent user content is never guessed
   * at: every copy remains in place and projection for that task is blocked.
   */
  private async reconcileDuplicateManagedFiles(
    files: readonly ManagedFile[],
    desiredFrontmatter: ManagedFrontmatter,
    desiredBody: string,
    projectFolder: string,
    taskContent: string,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    managedFiles: Set<TFile>,
    runContext: ProjectSyncRunContext,
  ): Promise<{ managed: ManagedFile; moved: boolean; updated: boolean }> {
    runContext.assertValid();
    const taskId = this.requireLiveManagedIdentity(
      desiredFrontmatter,
      normalizePath(`${projectFolder}/${makeTaskFilename(taskContent)}`),
    ).taskId;
    const candidates: DuplicateCandidate[] = [];
    for (const managed of [...files].sort((left, right) =>
      comparePortablePaths(left.file.path, right.file.path),
    )) {
      runContext.assertValid();
      const live = await this.readLiveManagedNote(managed.file);
      this.assertDuplicateCandidateIdentity(
        managed.identity,
        live.identity,
        taskId,
        managed.file.path,
      );
      candidates.push({
        managed,
        live,
        userDocument: readUserOwnedTaskDocument(live.content, live.frontmatter, live.contentStart),
      });
    }

    const mergedUserDocument = candidates[0]?.userDocument ?? { frontmatter: {}, body: "" };
    if (
      candidates.some(
        ({ userDocument }) => !isSameUserOwnedTaskDocument(userDocument, mergedUserDocument),
      )
    ) {
      throw new DuplicateManagedNoteConflictError(
        `Multiple managed notes use Todoist task ID '${taskId}' and contain different user-authored content; all copies were preserved for manual resolution`,
      );
    }

    const preferredPath = normalizePath(`${projectFolder}/${makeTaskFilename(taskContent)}`);
    this.assertWithinRoot(rootPath, preferredPath);
    const canonicalCandidate =
      candidates.find(({ managed }) => normalizePath(managed.file.path) === preferredPath) ??
      candidates.find(
        ({ managed }) => portablePathKey(managed.file.path) === portablePathKey(preferredPath),
      );
    const canonical = canonicalCandidate ?? candidates[0];
    if (canonical === undefined) {
      throw new DuplicateManagedNoteConflictError(
        `No live managed note remained for Todoist task ID '${taskId}'`,
      );
    }
    const duplicateFiles = candidates.filter((candidate) => candidate !== canonical);
    const targetPath = this.resolveAvailableTaskFilePath(
      projectFolder,
      taskContent,
      canonical.managed.file,
      rootPath,
      pathIndex,
      managedFiles,
    ).path;
    for (const candidate of candidates) {
      this.assertBackgroundFile(candidate.managed.file);
    }

    const desiredDocument = renderTaskDocumentWithUserContent(
      desiredFrontmatter,
      desiredBody,
      mergedUserDocument,
    );
    // Complete one last read-only preflight over the whole set before the first mutation. This
    // prevents a concurrently changed copy from causing us to rebuild the canonical note while
    // leaving every duplicate active.
    for (const candidate of candidates) {
      runContext.assertValid();
      const current = await this.readLiveManagedNote(candidate.managed.file);
      this.assertDuplicateCandidateIdentity(
        candidate.managed.identity,
        current.identity,
        taskId,
        candidate.managed.file.path,
      );
      const currentUser = readUserOwnedTaskDocument(
        current.content,
        current.frontmatter,
        current.contentStart,
      );
      if (!isSameUserOwnedTaskDocument(currentUser, mergedUserDocument)) {
        throw new DuplicateManagedNoteConflictError(
          `Managed note '${candidate.managed.file.path}' gained different user-authored content while duplicate reconciliation was running; all copies were preserved`,
        );
      }
    }
    runContext.assertValid();
    await this.processFileInternally(canonical.managed.file, (content) => {
      runContext.assertValid();
      const current = this.parseLiveManagedNote(content, canonical.managed.file.path);
      this.assertDuplicateCandidateIdentity(
        canonical.managed.identity,
        current.identity,
        taskId,
        canonical.managed.file.path,
      );
      const currentUser = readUserOwnedTaskDocument(
        current.content,
        current.frontmatter,
        current.contentStart,
      );
      if (!isSameUserOwnedTaskDocument(currentUser, mergedUserDocument)) {
        throw new DuplicateManagedNoteConflictError(
          `Managed note '${canonical.managed.file.path}' gained different user-authored content while duplicate reconciliation was running; all copies were preserved`,
        );
      }
      return desiredDocument;
    });
    runContext.assertValid();

    let trashedCount = 0;
    for (const duplicate of duplicateFiles) {
      runContext.assertValid();
      let current: LiveManagedNote;
      try {
        current = await this.readLiveManagedNote(duplicate.managed.file);
        this.assertDuplicateCandidateIdentity(
          duplicate.managed.identity,
          current.identity,
          taskId,
          duplicate.managed.file.path,
        );
        const currentUser = readUserOwnedTaskDocument(
          current.content,
          current.frontmatter,
          current.contentStart,
        );
        if (!isSameUserOwnedTaskDocument(currentUser, mergedUserDocument)) {
          throw new DuplicateManagedNoteConflictError(
            `Managed note '${duplicate.managed.file.path}' gained different user-authored content while duplicate reconciliation was running; it was preserved`,
          );
        }
      } catch (error: unknown) {
        if (error instanceof DuplicateManagedNoteConflictError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DuplicateManagedNoteConflictError(
          `Could not revalidate duplicate note '${duplicate.managed.file.path}'; it and every remaining copy were preserved: ${message}`,
        );
      }
      runContext.assertValid();
      const path = duplicate.managed.file.path;
      try {
        await this.runInternalMutation(
          [path],
          async () => await this.fileManager.trashFile(duplicate.managed.file),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DuplicateManagedNoteConflictError(
          `Duplicate cleanup for Todoist task ID '${taskId}' stopped after moving ${trashedCount} of ${duplicateFiles.length} redundant notes to the Obsidian trash; the canonical note and every remaining copy were preserved: ${message}`,
        );
      }
      trashedCount++;
      pathIndex.remove(duplicate.managed.file, path);
      managedFiles.delete(duplicate.managed.file);
      runContext.assertValid();
    }

    const moved = canonical.managed.file.path !== targetPath;
    if (moved) {
      runContext.assertValid();
      this.assertLivePathAvailable(targetPath, canonical.managed.file);
      const oldPath = canonical.managed.file.path;
      await this.runInternalMutation(
        [oldPath, targetPath],
        async () => await this.fileManager.renameFile(canonical.managed.file, targetPath),
      );
      pathIndex.move(canonical.managed.file, oldPath, targetPath);
    }

    return {
      managed: {
        file: canonical.managed.file,
        frontmatter: desiredFrontmatter,
        identity: this.requireLiveManagedIdentity(desiredFrontmatter, targetPath),
        projectionRoot: rootPath,
      },
      moved,
      updated: canonical.live.content !== desiredDocument,
    };
  }

  private assertDuplicateCandidateIdentity(
    expected: ManagedNoteIdentity,
    current: ManagedNoteIdentity,
    taskId: string,
    path: string,
  ): void {
    if (current.taskId !== taskId || current.taskId !== expected.taskId) {
      throw new DuplicateManagedNoteConflictError(
        `Managed note '${path}' changed Todoist identity while duplicate reconciliation was running; it was preserved`,
      );
    }
  }

  private async ensureParentFolders(
    filePath: string,
    rootPath: string,
    pathIndex: PortableVaultPathIndex,
    runContext: ProjectSyncRunContext,
  ): Promise<void> {
    const separator = filePath.lastIndexOf("/");
    if (separator < 0) {
      return;
    }
    const parentPath = filePath.slice(0, separator);
    if (parentPath === rootPath) {
      return;
    }
    this.assertWithinRoot(rootPath, parentPath);
    const relativeParent = parentPath.slice(rootPath.length).replace(/^\/+/, "");
    let current = rootPath;
    for (const segment of relativeParent.split("/")) {
      if (segment === "") {
        continue;
      }
      runContext.assertValid();
      current = normalizePath(`${current}/${segment}`);
      if (this.vault.getFolderByPath(current) !== null) {
        continue;
      }
      if (this.vault.getAbstractFileByPath(current) !== null) {
        throw new HistoricalProjectionConflictError(
          `Cannot migrate '${filePath}' because '${current}' is not a folder`,
        );
      }
      const folder = await this.runInternalMutation(
        [current],
        async () => await this.vault.createFolder(current),
      );
      pathIndex.add(folder);
    }
  }

  private async updateManagedFile(
    managed: ManagedFile,
    desiredFrontmatter: ManagedFrontmatter,
    desiredBody: string,
    targetPath: string,
    pathIndex: PortableVaultPathIndex,
    runContext: ProjectSyncRunContext,
  ): Promise<{ moved: boolean; updated: boolean }> {
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

  private async trashMissingManagedFile(
    managed: ManagedFile,
    syncedAt: string,
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

      const live = await this.readLiveManagedNote(managed.file);
      this.assertSameManagedIdentity(managed.identity, live.identity, path);
      this.assertMissingSnapshotNotOlder(live.frontmatter, syncedAt, path);
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

  private async markOutOfScope(
    managed: ManagedFile,
    runContext: ProjectSyncRunContext,
  ): Promise<boolean> {
    runContext.assertValid();
    const live = await this.readLiveManagedNote(managed.file);
    this.assertSameManagedIdentity(managed.identity, live.identity, managed.file.path);
    if (
      live.frontmatter.todoist_status === "out_of_scope" &&
      !hasLegacyImplementationFrontmatter(live.frontmatter)
    ) {
      return false;
    }
    this.assertBackgroundFile(managed.file);
    await this.processFileInternally(managed.file, (content) => {
      runContext.assertValid();
      const current = this.parseLiveManagedNote(content, managed.file.path);
      this.assertSameManagedIdentity(managed.identity, current.identity, managed.file.path);
      if (
        current.frontmatter.todoist_status === "out_of_scope" &&
        !hasLegacyImplementationFrontmatter(current.frontmatter)
      ) {
        throw new NoManagedDocumentChangeError();
      }
      const nextFrontmatter = { ...current.frontmatter, todoist_status: "out_of_scope" };
      removeLegacyImplementationFrontmatter(nextFrontmatter);
      const yaml = dumpYaml(nextFrontmatter, { lineWidth: -1, noRefs: true });
      return `---\n${yaml}---\n${content.slice(current.contentStart)}`;
    });
    runContext.assertValid();
    return true;
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

  private async assertLiveManagedIdentity(managed: ManagedFile): Promise<void> {
    const live = await this.readLiveManagedNote(managed.file);
    this.assertSameManagedIdentity(managed.identity, live.identity, managed.file.path);
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
    const comparison = this.makeWriteFrontmatter(current, desired);
    if (typeof current.todoist_synced_at === "string") {
      comparison.todoist_synced_at = current.todoist_synced_at;
    }
    return comparison;
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

  private assertMissingSnapshotNotOlder(
    current: ManagedFrontmatter,
    syncedAt: string,
    path: string,
  ): void {
    const snapshotTimestamp = readTimestamp(syncedAt);
    const projectedTimestamp = readTimestamp(current.todoist_synced_at);
    const sourceRevision = readTimestamp(current.todoist_updated_at);
    const hasUnreadableProjectionTimestamp =
      typeof current.todoist_synced_at === "string" && projectedTimestamp === undefined;
    const hasUnreadableSourceRevision =
      typeof current.todoist_updated_at === "string" && sourceRevision === undefined;
    if (
      snapshotTimestamp === undefined ||
      hasUnreadableProjectionTimestamp ||
      hasUnreadableSourceRevision ||
      (projectedTimestamp !== undefined && projectedTimestamp > snapshotTimestamp) ||
      (sourceRevision !== undefined && sourceRevision > snapshotTimestamp)
    ) {
      throw new ManagedNoteIdentityConflictError(
        `Managed note '${path}' contains a newer or unreadable Todoist snapshot revision; the remote deletion was not applied`,
      );
    }
  }

  private async persistCatalogState(
    snapshot: ProjectSyncSnapshot,
    mapping: ProjectSyncMapping,
    previous: ProjectCatalog | null,
    managedById: ReadonlyMap<string, readonly ManagedFile[]>,
  ): Promise<void> {
    if (this.catalogStorage === undefined) {
      return;
    }
    const next = makeProjectCatalog(snapshot, mapping);
    const desiredIds = new Set(next.tasks.map((task) => task.id));
    const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
    for (const [taskId, managedFiles] of managedById) {
      if (desiredIds.has(taskId)) {
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
      const { file, content, frontmatter, identity } = indexed;
      const filePath = normalizePath(file.path);
      const isInCurrentRoot = isPathInside(rootPath, filePath);
      if (indexed.parseError !== undefined) {
        const historicalRoot = mostSpecificContainingRoot(
          ownedRootPaths.filter((path) => path !== rootPath),
          filePath,
        );
        const likelyOwnedHistoricalNote =
          historicalRoot !== undefined &&
          content.includes("todoist_sync_managed") &&
          (content.includes(mappingId) || content.includes(rootProjectId));
        const likelyOwnedCurrentNote = isInCurrentRoot && content.includes("todoist_sync_managed");
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

const hasLegacyImplementationFrontmatter = (frontmatter: ManagedFrontmatter): boolean =>
  LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS.some((key) => key in frontmatter);

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const hasTaskRelationshipProperties = (frontmatter: ManagedFrontmatter): boolean =>
  "todoist_parent_task" in frontmatter || "todoist_subtasks" in frontmatter;

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

const collectProjectedTaskFolders = (
  managedById: ReadonlyMap<string, readonly ManagedFile[]>,
  rootPath: string,
): Set<string> => {
  const result = new Set<string>();
  for (const files of managedById.values()) {
    for (const { file } of files) {
      const filePath = normalizePath(file.path);
      const separator = filePath.lastIndexOf("/");
      if (separator < 0) {
        continue;
      }
      const parentPath = filePath.slice(0, separator);
      const folderSeparator = parentPath.lastIndexOf("/");
      const folderSegment = parentPath.slice(folderSeparator + 1);
      if (
        parentPath !== rootPath &&
        isPathInside(rootPath, parentPath) &&
        filePath === normalizePath(`${parentPath}/${makeTaskFilename(folderSegment)}`)
      ) {
        result.add(parentPath);
      }
    }
  }
  return result;
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
