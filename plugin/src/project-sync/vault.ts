import {
  type FileManager,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
  type TAbstractFile,
  type TFile,
  type Vault,
} from "obsidian";

import {
  applyManagedFrontmatter,
  ManagedBodyConflictError,
  type ManagedFrontmatter,
  type ManagedNoteIdentity,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  renderNewTaskDocument,
  replaceManagedBody,
} from "./document";
import { projectHierarchyPath } from "./hierarchy";
import {
  isPathInside,
  makeDisambiguatedProjectSegment,
  makeProjectSegments,
  makeTaskFilename,
  sanitizePathSegment,
} from "./paths";
import type {
  ProjectSyncConfig,
  ProjectSyncConflict,
  ProjectSyncMapping,
  ProjectSyncResult,
  ProjectSyncRunContext,
  ProjectSyncSnapshot,
} from "./types";

export type OpenFilePathsProvider = () => Iterable<string>;

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
};

type ResolvedFilePath = {
  path: string;
  usedAlternate: boolean;
  unmanagedCollision: boolean;
};

type ManagedFileScan = {
  configuredByTaskId: Map<string, ManagedFile[]>;
  ownedByTaskId: Map<string, ManagedFile[]>;
  unresolvedHistoricalOwnership: boolean;
};

type IndexedVaultFile = {
  file: TFile;
  content: string;
  frontmatter?: ManagedFrontmatter;
  identity?: ManagedNoteIdentity | null;
  parseError?: string;
};

const emptyResult = (): ProjectSyncResult => ({
  created: 0,
  updated: 0,
  moved: 0,
  unchanged: 0,
  stale: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  settledMappingIds: [],
});

const alwaysValidRun: ProjectSyncRunContext = { assertValid: () => undefined };

class ActiveManagedNoteError extends Error {}
class HistoricalProjectionConflictError extends Error {}

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
  private readonly managedFileIndexes = new WeakMap<object, Promise<IndexedVaultFile[]>>();

  constructor(vault: Vault, fileManager: FileManager, openFilePaths: OpenFilePathsProvider) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.openFilePaths = openFilePaths;
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
    const conflictedIds = new Set<string>();
    const desiredIds = new Set(snapshot.tasks.map(({ task }) => task.id));

    for (const [taskId, files] of configuredByTaskId) {
      if (files.length <= 1) {
        continue;
      }
      const isRelevantToMapping = desiredIds.has(taskId) || managedById.has(taskId);
      if (!isRelevantToMapping) {
        continue;
      }
      conflictedIds.add(taskId);
      result.conflicts.push({
        taskId,
        message: `Multiple managed notes use Todoist task ID '${taskId}'`,
        path: files.map(({ file }) => file.path).join(", "),
        projectionBlocked: true,
      });
    }

    const orderedSnapshotTasks = [...snapshot.tasks].sort((left, right) =>
      compareStableIds(left.task.id, right.task.id),
    );
    for (const snapshotTask of orderedSnapshotTasks) {
      runContext.assertValid();
      const taskId = snapshotTask.task.id;
      if (conflictedIds.has(taskId)) {
        continue;
      }

      const projectFolder = projectFolders.get(snapshotTask.task.project.id);
      if (projectFolder === undefined) {
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
      );
      const desiredBody = makeManagedBody(snapshotTask.task);
      // A task can move from one mapped Todoist project to another. Reuse the one managed note
      // found anywhere inside the configured mapping roots so its user-authored content moves
      // with it instead of creating a duplicate in the destination mapping.
      const existing = configuredByTaskId.get(taskId)?.[0];
      const resolvedPath = this.resolveAvailableTaskFilePath(
        projectFolder,
        snapshotTask.task.content,
        existing?.file,
        rootPath,
        pathIndex,
        managedFiles,
      );
      const targetPath = resolvedPath.path;
      if (resolvedPath.unmanagedCollision) {
        const canonicalPath = normalizePath(
          `${projectFolder}/${makeTaskFilename(snapshotTask.task.content)}`,
        );
        result.conflicts.push({
          taskId,
          path: targetPath,
          message: `Task path '${canonicalPath}' is occupied by an unmanaged vault item; using '${targetPath}'`,
        });
      }

      try {
        if (existing === undefined) {
          runContext.assertValid();
          const created = await this.vault.create(
            targetPath,
            renderNewTaskDocument(desiredFrontmatter, desiredBody),
          );
          pathIndex.add(created);
          managedFiles.add(created);
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
      } catch (error: unknown) {
        if (error instanceof ActiveManagedNoteError) {
          this.recordDeferred(result, taskId, existing?.file.path, error.message);
          continue;
        }
        if (!(error instanceof ManagedBodyConflictError)) {
          throw error;
        }
        result.conflicts.push({
          taskId,
          path: existing?.file.path,
          message: error.message,
          projectionBlocked: true,
        });
      }
    }

    const orderedManagedEntries = [...managedById].sort(([left], [right]) =>
      compareStableIds(left, right),
    );
    for (const [taskId, files] of orderedManagedEntries) {
      runContext.assertValid();
      if (desiredIds.has(taskId) || conflictedIds.has(taskId)) {
        continue;
      }

      const managed = files[0];
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
        throw error;
      }

      if (!mapping.includeSubprojects && managed.identity.projectId !== snapshot.rootProjectId) {
        try {
          const updated = await this.markOutOfScope(managed, mapping.id, runContext);
          result.outOfScope++;
          if (updated) {
            result.updated++;
          } else {
            result.unchanged++;
          }
        } catch (error: unknown) {
          if (!(error instanceof ActiveManagedNoteError)) {
            throw error;
          }
          this.recordDeferred(result, taskId, managed.file.path, error.message);
        }
        continue;
      }

      let missingUpdate: { updated: boolean; becameStale: boolean };
      try {
        missingUpdate = await this.markMissing(managed, snapshot.syncedAt, mapping.id, runContext);
      } catch (error: unknown) {
        if (!(error instanceof ActiveManagedNoteError)) {
          throw error;
        }
        this.recordDeferred(result, taskId, managed.file.path, error.message);
        continue;
      }
      if (missingUpdate.updated) {
        result.updated++;
      } else {
        result.unchanged++;
      }
      if (missingUpdate.becameStale) {
        result.stale++;
      }
    }

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

    return result;
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
        await this.vault.createFolder(path);
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
      unmanagedCollision ||= occupants.some((occupant) => !managedFiles.has(occupant as TFile));
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
    const oldPath = managed.file.path;
    await this.fileManager.renameFile(managed.file, resolved.path);
    pathIndex.move(managed.file, oldPath, resolved.path);
    runContext.assertValid();
    return {
      moved: true,
      usedAlternate: resolved.usedAlternate,
      unmanagedCollision: resolved.unmanagedCollision,
    };
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
      const folder = await this.vault.createFolder(current);
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
    const currentContent = await this.vault.read(managed.file);
    runContext.assertValid();
    const frontmatterInfo = getFrontMatterInfo(currentContent);
    const bodyPreview = replaceManagedBody(
      currentContent,
      desiredBody,
      frontmatterInfo.contentStart,
    );
    const moved = managed.file.path !== targetPath;
    const comparisonFrontmatter = { ...desiredFrontmatter };
    if (typeof managed.frontmatter.todoist_synced_at === "string") {
      comparisonFrontmatter.todoist_synced_at = managed.frontmatter.todoist_synced_at;
    }
    const frontmatterPreview = { ...managed.frontmatter };
    const managedFieldsChanged = applyManagedFrontmatter(frontmatterPreview, comparisonFrontmatter);
    const frontmatterChanged = managedFieldsChanged || bodyPreview.changed || moved;

    if (frontmatterChanged) {
      runContext.assertValid();
      this.assertBackgroundFile(managed.file);
      await this.fileManager.processFrontMatter(managed.file, (frontmatter: unknown) => {
        if (!isRecord(frontmatter)) {
          throw new Error(`Invalid frontmatter in '${managed.file.path}'`);
        }
        applyManagedFrontmatter(frontmatter, desiredFrontmatter);
      });
      runContext.assertValid();
    }
    if (bodyPreview.changed) {
      runContext.assertValid();
      this.assertBackgroundFile(managed.file);
      await this.vault.process(managed.file, (content) => {
        const info = getFrontMatterInfo(content);
        return replaceManagedBody(content, desiredBody, info.contentStart).content;
      });
      runContext.assertValid();
    }

    if (moved) {
      runContext.assertValid();
      this.assertBackgroundFile(managed.file);
      const oldPath = managed.file.path;
      await this.fileManager.renameFile(managed.file, targetPath);
      pathIndex.move(managed.file, oldPath, targetPath);
      runContext.assertValid();
    }
    return { moved, updated: frontmatterChanged || bodyPreview.changed };
  }

  private async markMissing(
    managed: ManagedFile,
    syncedAt: string,
    mappingId: string,
    runContext: ProjectSyncRunContext,
  ): Promise<{ updated: boolean; becameStale: boolean }> {
    const nextMissingCount = Math.min(2, managed.identity.missingCount + 1);
    const becameStale = managed.identity.missingCount < 2 && nextMissingCount >= 2;
    const alreadyStale =
      managed.frontmatter.todoist_status === "stale" &&
      typeof managed.frontmatter.todoist_stale_since === "string";
    const hasCurrentMappingId = managed.identity.mappingId === mappingId;
    if (nextMissingCount === managed.identity.missingCount && alreadyStale && hasCurrentMappingId) {
      return { updated: false, becameStale: false };
    }
    let updated = false;

    runContext.assertValid();
    this.assertBackgroundFile(managed.file);
    await this.fileManager.processFrontMatter(managed.file, (frontmatter: unknown) => {
      if (!isRecord(frontmatter)) {
        throw new Error(`Invalid frontmatter in '${managed.file.path}'`);
      }
      if (frontmatter.todoist_sync_missing_count !== nextMissingCount) {
        frontmatter.todoist_sync_missing_count = nextMissingCount;
        updated = true;
      }
      if (frontmatter.todoist_sync_mapping_id !== mappingId) {
        frontmatter.todoist_sync_mapping_id = mappingId;
        updated = true;
      }
      if (nextMissingCount >= 2 && frontmatter.todoist_status !== "stale") {
        frontmatter.todoist_status = "stale";
        updated = true;
      }
      if (nextMissingCount >= 2 && typeof frontmatter.todoist_stale_since !== "string") {
        frontmatter.todoist_stale_since = syncedAt;
        updated = true;
      }
    });
    runContext.assertValid();

    return { updated, becameStale };
  }

  private async markOutOfScope(
    managed: ManagedFile,
    mappingId: string,
    runContext: ProjectSyncRunContext,
  ): Promise<boolean> {
    const needsUpdate =
      managed.frontmatter.todoist_status !== "out_of_scope" ||
      managed.identity.missingCount !== 0 ||
      managed.identity.mappingId !== mappingId ||
      "todoist_stale_since" in managed.frontmatter;
    if (!needsUpdate) {
      return false;
    }

    runContext.assertValid();
    this.assertBackgroundFile(managed.file);
    await this.fileManager.processFrontMatter(managed.file, (frontmatter: unknown) => {
      if (!isRecord(frontmatter)) {
        throw new Error(`Invalid frontmatter in '${managed.file.path}'`);
      }
      frontmatter.todoist_status = "out_of_scope";
      frontmatter.todoist_sync_mapping_id = mappingId;
      frontmatter.todoist_sync_missing_count = 0;
      delete frontmatter.todoist_stale_since;
    });
    runContext.assertValid();
    return true;
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
    const configuredRootPaths = Array.from(new Set(configuredRoots.map(({ path }) => path)));
    const ownedRootPaths = configuredRoots
      .filter((root) => root.mappingId === mappingId && root.rootProjectId === rootProjectId)
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
        if (likelyOwnedHistoricalNote) {
          unresolvedHistoricalOwnership = true;
          conflicts.push({
            path: file.path,
            message: "Could not read the ownership fields of a historical managed note",
          });
        }
        continue;
      }
      const managed = { file, identity, frontmatter, projectionRoot: rootPath };
      const configuredEntries = configuredByTaskId.get(identity.taskId) ?? [];
      configuredEntries.push(managed);
      configuredByTaskId.set(identity.taskId, configuredEntries);

      const ownedProjectionRoot = isInCurrentRoot
        ? rootPath
        : mostSpecificContainingRoot(ownedRootPaths, filePath);
      const hasMatchingMappingIdentity =
        identity.mappingId === mappingId || identity.mappingId === undefined;
      if (
        ownedProjectionRoot !== undefined &&
        identity.rootProjectId === rootProjectId &&
        hasMatchingMappingIdentity
      ) {
        managed.projectionRoot = ownedProjectionRoot;
        const ownedEntries = ownedByTaskId.get(identity.taskId) ?? [];
        ownedEntries.push(managed);
        ownedByTaskId.set(identity.taskId, ownedEntries);
      }
    }

    return { configuredByTaskId, ownedByTaskId, unresolvedHistoricalOwnership };
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
      const info = getFrontMatterInfo(content);
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

    addRoot({ mappingId, rootProjectId, path: currentRootPath }, true);
    for (const previousFolder of previousFolders) {
      addRoot({ mappingId, rootProjectId, path: previousFolder }, false);
    }
    for (const mappingRoot of runContext.mappingRoots ?? []) {
      addRoot({ ...mappingRoot, path: mappingRoot.folder }, false);
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

const portablePathKey = (path: string): string =>
  normalizePath(path).normalize("NFC").toLocaleLowerCase("en-US");

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

const mostSpecificContainingRoot = (
  roots: readonly string[],
  filePath: string,
): string | undefined =>
  roots
    .filter((root) => isPathInside(root, filePath))
    .sort((left, right) => right.length - left.length)[0];
