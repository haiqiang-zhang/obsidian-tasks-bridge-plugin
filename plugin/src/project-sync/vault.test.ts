import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import type { FileManager, TAbstractFile, TFile, Vault } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import {
  mergeProjectCatalogCollections,
  type ProjectCatalog,
  type ProjectCatalogStorage,
} from "./catalog";
import {
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  makeManagedBody,
  makeManagedTaskIdentityMarker,
  makeProjectTaskBlock,
  makeTaskFrontmatter,
  renderNewTaskDocument,
} from "./document";
import {
  emptyProjectSyncFolderOwnershipRegistry,
  listOwnedFolders,
  type ManagedFolderCreation,
  type ManagedFolderOwnership,
  type ManagedFolderRelocation,
  type ProjectSyncFolderOwnershipRegistry,
  type ProjectSyncFolderOwnershipStorage,
  recordCreatedFolders,
  releaseOwnedFolderPaths,
  relocateOwnedFolders,
} from "./folderOwnership";
import { readTaskProperty, TASK_PROPERTY_NAMES } from "./properties";
import type { ProjectSyncConfig, ProjectSyncMapping, ProjectSyncSnapshot } from "./types";
import { ObsidianProjectSyncVault } from "./vault";

vi.mock("obsidian", async () => {
  const { load, dump } = await import("js-yaml");
  // biome-ignore lint/complexity/noStaticOnlyClass: constructor-shaped mock for instanceof checks
  class MockTFile {
    static [Symbol.hasInstance](value: unknown): boolean {
      return (
        typeof value === "object" &&
        value !== null &&
        "_fakeKind" in value &&
        value._fakeKind === "file"
      );
    }
  }
  // biome-ignore lint/complexity/noStaticOnlyClass: constructor-shaped mock for instanceof checks
  class MockTFolder {
    static [Symbol.hasInstance](value: unknown): boolean {
      return (
        typeof value === "object" &&
        value !== null &&
        "_fakeKind" in value &&
        value._fakeKind === "folder"
      );
    }
  }
  const getFrontmatterInfo = (content: string) => {
    if (!content.startsWith("---\n")) {
      return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
    }
    const closing = content.indexOf("\n---\n", 4);
    if (closing < 0) {
      return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
    }
    return {
      exists: true,
      frontmatter: content.slice(4, closing),
      from: 4,
      to: closing,
      contentStart: closing + 5,
    };
  };
  return {
    TFile: MockTFile,
    TFolder: MockTFolder,
    normalizePath: (path: string) =>
      path
        .split("/")
        .filter((segment) => segment !== "")
        .join("/"),
    getFrontMatterInfo: getFrontmatterInfo,
    parseYaml: (yaml: string) => load(yaml),
    stringifyYaml: (value: unknown) => dump(value, { lineWidth: -1, noRefs: true }),
  };
});

type FakeFile = TFile & { path: string; name: string; _fakeKind: "file" };
type FakeFolder = TAbstractFile & { path: string; name: string; _fakeKind: "folder" };

class FakeVault {
  readonly files = new Map<string, { file: FakeFile; content: string }>();
  readonly folders = new Set<string>(["Sync"]);
  readonly adapter = {
    exists: vi.fn(async (path: string, sensitive = false) => {
      if (sensitive) {
        return this.getAbstractFileByPath(path) !== null;
      }
      const key = portableTestPathKey(path);
      return this.getAllLoadedFiles().some((entry) => portableTestPathKey(entry.path) === key);
    }),
    list: vi.fn(async (path: string) => {
      const prefix = `${path}/`;
      return {
        files: [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix)),
        folders: [...this.folders].filter((candidate) => candidate.startsWith(prefix)),
      };
    }),
  };
  private readonly folderEntries = new Map<string, FakeFolder>();
  beforeProcess: (() => void) | undefined;
  beforeCreate: ((path: string) => void) | undefined;
  beforeCreateFolder: ((path: string) => void) | undefined;
  afterProcess: (() => void) | undefined;
  readonly process = vi.fn(async (file: TFile, update: (content: string) => string) => {
    this.beforeProcess?.();
    const entry = this.files.get(file.path);
    if (entry === undefined) {
      throw new Error("Missing fake file");
    }
    entry.content = update(entry.content);
    this.afterProcess?.();
    return entry.content;
  });

  addFile(path: string, content: string): FakeFile {
    const segments = path.split("/");
    const file = {
      path,
      name: segments[segments.length - 1] ?? path,
      _fakeKind: "file",
    } as FakeFile;
    this.files.set(path, { file, content });
    return file;
  }

  getFolderByPath(path: string) {
    return this.folders.has(path) ? this.folderEntry(path) : null;
  }

  getAbstractFileByPath(path: string) {
    return this.getFolderByPath(path) ?? this.files.get(path)?.file ?? null;
  }

  async createFolder(path: string) {
    this.beforeCreateFolder?.(path);
    if (this.getAbstractFileByPath(path) !== null) {
      throw new Error(`Folder already exists: ${path}`);
    }
    this.folders.add(path);
    return this.folderEntry(path);
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [
      ...[...this.folders].map((path) => this.folderEntry(path)),
      ...[...this.files.values()].map(({ file }) => file),
    ];
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()]
      .map(({ file }) => file)
      .filter((file) => file.path.endsWith(".md"));
  }

  async read(file: TFile): Promise<string> {
    const content = this.files.get(file.path)?.content;
    if (content === undefined) {
      throw new Error("Missing fake file");
    }
    return content;
  }

  async create(path: string, content: string): Promise<TFile> {
    this.beforeCreate?.(path);
    if (this.getAbstractFileByPath(path) !== null) {
      throw new Error(`File already exists: ${path}`);
    }
    return this.addFile(path, content);
  }

  replaceFolderIdentity(path: string): void {
    if (!this.folders.has(path)) {
      throw new Error(`Missing fake folder: ${path}`);
    }
    this.folderEntries.delete(path);
  }

  moveFolder(folder: FakeFolder, newPath: string): void {
    const oldPath = folder.path;
    if (!this.folders.has(oldPath)) {
      throw new Error("Missing fake folder");
    }
    if (this.getAbstractFileByPath(newPath) !== null) {
      throw new Error(`Folder already exists: ${newPath}`);
    }

    const folderMoves = [...this.folders]
      .filter((path) => path === oldPath || path.startsWith(`${oldPath}/`))
      .sort((left, right) => left.length - right.length)
      .map((path) => ({
        entry: this.folderEntry(path),
        oldPath: path,
        newPath: `${newPath}${path.slice(oldPath.length)}`,
      }));
    const fileMoves = [...this.files]
      .filter(([path]) => path.startsWith(`${oldPath}/`))
      .map(([path, entry]) => ({
        entry,
        oldPath: path,
        newPath: `${newPath}${path.slice(oldPath.length)}`,
      }));

    for (const { oldPath: path } of folderMoves) {
      this.folders.delete(path);
      this.folderEntries.delete(path);
    }
    for (const { oldPath: path } of fileMoves) {
      this.files.delete(path);
    }
    for (const move of folderMoves) {
      move.entry.path = move.newPath;
      move.entry.name = move.newPath.slice(move.newPath.lastIndexOf("/") + 1);
      this.folders.add(move.newPath);
      this.folderEntries.set(move.newPath, move.entry);
    }
    for (const move of fileMoves) {
      move.entry.file.path = move.newPath;
      move.entry.file.name = move.newPath.slice(move.newPath.lastIndexOf("/") + 1);
      this.files.set(move.newPath, move.entry);
    }
  }

  private folderEntry(path: string): FakeFolder {
    const existing = this.folderEntries.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const segments = path.split("/");
    const folder = {
      path,
      name: segments[segments.length - 1] ?? path,
      _fakeKind: "folder",
    } as FakeFolder;
    this.folderEntries.set(path, folder);
    return folder;
  }
}

class FakeFileManager {
  private readonly vault: FakeVault;
  beforeProcessFrontMatter: (() => void) | undefined;
  beforeRename: ((newPath: string) => void) | undefined;
  afterProcessFrontMatter: (() => void) | undefined;
  afterRename: (() => void) | undefined;
  beforeTrash: ((file: TAbstractFile) => void) | undefined;

  readonly processFrontMatter = vi.fn(
    async (file: TFile, update: (frontmatter: Record<string, unknown>) => void) => {
      this.beforeProcessFrontMatter?.();
      const entry = this.vault.files.get(file.path);
      if (entry === undefined) {
        throw new Error("Missing fake file");
      }
      const info = frontmatterInfo(entry.content);
      const parsed = loadYaml(info.frontmatter);
      const frontmatter = isRecord(parsed) ? parsed : {};
      update(frontmatter);
      const tail = entry.content.slice(info.contentStart);
      entry.content = `---\n${dumpYaml(frontmatter, { lineWidth: -1, noRefs: true })}---\n${tail}`;
      this.afterProcessFrontMatter?.();
    },
  );

  readonly renameFile = vi.fn(async (file: TAbstractFile, newPath: string) => {
    this.beforeRename?.(newPath);
    if ((file as FakeFolder)._fakeKind === "folder") {
      this.vault.moveFolder(file as FakeFolder, newPath);
      this.afterRename?.();
      return;
    }
    const entry = this.vault.files.get(file.path);
    if (entry === undefined) {
      throw new Error("Missing fake file");
    }
    if (this.vault.getAbstractFileByPath(newPath) !== null) {
      throw new Error(`File already exists: ${newPath}`);
    }
    this.vault.files.delete(file.path);
    file.path = newPath;
    file.name = newPath.slice(newPath.lastIndexOf("/") + 1);
    this.vault.files.set(newPath, entry);
    this.afterRename?.();
  });

  readonly trashFile = vi.fn(async (file: TAbstractFile) => {
    this.beforeTrash?.(file);
    if (this.vault.files.delete(file.path)) {
      return;
    }
    if (this.vault.folders.delete(file.path)) {
      return;
    }
    throw new Error("Missing fake file");
  });

  constructor(vault: FakeVault) {
    this.vault = vault;
  }

  generateMarkdownLink(
    file: TFile,
    _sourcePath: string,
    _subpath?: string,
    alias?: string,
  ): string {
    const linkPath = file.path.replace(/\.md$/u, "");
    return `[[${linkPath}${alias === undefined || alias === "" ? "" : `|${alias}`}]]`;
  }
}

class FakeCatalogStorage implements ProjectCatalogStorage {
  readonly catalogs = new Map<string, ProjectCatalog>();

  getCatalog(mappingId: string): ProjectCatalog | null {
    const catalog = this.catalogs.get(mappingId);
    return catalog === undefined ? null : structuredClone(catalog);
  }

  async persistCatalogs(catalogs: readonly ProjectCatalog[]): Promise<void> {
    const current = Object.fromEntries(this.catalogs);
    const incoming = Object.fromEntries(catalogs.map((catalog) => [catalog.mappingId, catalog]));
    this.catalogs.clear();
    for (const [mappingId, catalog] of Object.entries(
      mergeProjectCatalogCollections(current, incoming),
    )) {
      this.catalogs.set(mappingId, structuredClone(catalog));
    }
  }
}

class FakeFolderOwnershipStorage implements ProjectSyncFolderOwnershipStorage {
  registry: ProjectSyncFolderOwnershipRegistry = emptyProjectSyncFolderOwnershipRegistry();
  private nextCreationId = 0;

  listOwnedFolders(mappingId: string): readonly ManagedFolderOwnership[] {
    return listOwnedFolders(this.registry, mappingId);
  }

  async recordCreatedFolder(input: ManagedFolderCreation): Promise<void> {
    await this.recordCreatedFolders([input]);
  }

  async recordCreatedFolders(inputs: readonly ManagedFolderCreation[]): Promise<void> {
    this.registry = recordCreatedFolders(this.registry, inputs, () => {
      this.nextCreationId++;
      return `test-folder-${this.nextCreationId}`;
    });
  }

  async relocateOwnedFolders(inputs: readonly ManagedFolderRelocation[]): Promise<void> {
    this.registry = relocateOwnedFolders(this.registry, inputs, () => {
      this.nextCreationId++;
      return `test-folder-${this.nextCreationId}`;
    });
  }

  async releaseOwnedFolderPath(mappingId: string, path: string): Promise<void> {
    await this.releaseOwnedFolderPaths(mappingId, [path]);
  }

  async releaseOwnedFolderPaths(mappingId: string, paths: readonly string[]): Promise<void> {
    this.registry = releaseOwnedFolderPaths(this.registry, mappingId, paths);
  }
}

const portableTestPathKey = (path: string): string =>
  path.normalize("NFC").toLocaleLowerCase("en-US");

const frontmatterInfo = (content: string) => {
  if (!content.startsWith("---\n")) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const closing = content.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  return {
    exists: true,
    frontmatter: content.slice(4, closing),
    from: 4,
    to: closing,
    contentStart: closing + 5,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const testProjectPath = (...projects: ReturnType<typeof makeProject>[]) => ({
  ids: projects.map(({ id }) => id),
  names: projects.map(({ name }) => name),
});

const mapping: ProjectSyncMapping = {
  id: "mapping-root",
  folder: "Sync",
  project: { projectId: "root", projectName: "Root" },
  includeSubprojects: true,
  previousFolders: [],
};

const config: ProjectSyncConfig = {
  enabled: true,
  preserveUnmanagedItems: true,
  mappings: [mapping],
};

describe("ObsidianProjectSyncVault", () => {
  let vault: FakeVault;
  let fileManager: FakeFileManager;
  let catalogStorage: FakeCatalogStorage;
  let folderOwnershipStorage: FakeFolderOwnershipStorage;
  let adapter: ObsidianProjectSyncVault;

  beforeEach(() => {
    vault = new FakeVault();
    fileManager = new FakeFileManager(vault);
    catalogStorage = new FakeCatalogStorage();
    folderOwnershipStorage = new FakeFolderOwnershipStorage();
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
      undefined,
      catalogStorage,
      folderOwnershipStorage,
    );
  });

  it("uses each configured folder as the root project folder", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const rootTask = makeTask("root-task", { content: "Root task", project: root });
    const childTask = makeTask("child-task", { content: "Child task", project: child });

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [
          { task: rootTask, completed: false },
          { task: childTask, completed: false },
        ],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result.created).toBe(2);
    expect(vault.files.has("Sync/Root task.task.md")).toBe(true);
    expect(vault.files.has("Sync/Child/Child task.task.md")).toBe(true);
    expect(vault.folders.has("Sync/Child")).toBe(true);
    expect(vault.folders.has("Sync/Root")).toBe(false);
    expect(
      parseFrontmatter(vault.files.get("Sync/Root task.task.md")?.content ?? ""),
    ).toMatchObject({
      "task id": "root-task",
      description: "",
      project: "Root",
      "project path": ["Root"],
    });
    expect(
      parseFrontmatter(vault.files.get("Sync/Child/Child task.task.md")?.content ?? ""),
    ).toMatchObject({
      project: "Child",
      "project path": ["Root", "Child"],
    });
  });

  it.each([
    false,
    true,
  ])("renames an existing .md task in place and stays stable after sync (initially open: %s)", async (initiallyOpen) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("existing-task", { content: "Existing task", project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    const frontmatter = {
      ...makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        snapshot.syncedAt,
      ),
      user_note: "Keep this property",
    };
    const oldPath = "Sync/Existing task.md";
    const targetPath = "Sync/Existing task.task.md";
    const original = `${renderNewTaskDocument(frontmatter, makeManagedBody(task))}\nUser notes and [[Reference#Heading]] stay here.\n`;
    const file = vault.addFile(oldPath, original);
    const ordinaryNote = vault.addFile("Sync/Notes.md", "Ordinary Markdown stays unchanged.\n");
    const openPaths = new Set(initiallyOpen ? [oldPath] : []);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => openPaths,
    );

    if (initiallyOpen) {
      const deferred = await adapter.reconcile(snapshot, mapping);
      expect(deferred).toMatchObject({ created: 0, moved: 0, updated: 0, deferred: 1 });
      expect(vault.files.get(oldPath)?.content).toBe(original);
      expect(vault.files.has(targetPath)).toBe(false);
      expect(fileManager.renameFile).not.toHaveBeenCalled();
      openPaths.clear();
    }

    const migrated = await adapter.reconcile(snapshot, mapping);
    expect(migrated).toMatchObject({ created: 0, moved: 1, updated: 1, deferred: 0 });
    expect(migrated.conflicts).toEqual([]);
    expect(fileManager.renameFile).toHaveBeenCalledExactlyOnceWith(file, targetPath);
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.get(targetPath)?.file).toBe(file);
    expect(vault.files.get(targetPath)?.content).toBe(original);
    expect(vault.files.get(ordinaryNote.path)?.file).toBe(ordinaryNote);
    expect(vault.files.size).toBe(2);

    fileManager.renameFile.mockClear();
    const stable = await adapter.reconcile(snapshot, mapping);
    expect(stable).toMatchObject({ created: 0, moved: 0, updated: 0, unchanged: 1 });
    expect(stable.conflicts).toEqual([]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.has("Sync/Existing task.task.task.md")).toBe(false);
    expect(vault.files.size).toBe(2);
  });

  const prepareLegacyFolderNote = (inside = true) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("folder-task", { content: "Parent", project });
    const child = makeTask("child-task", { content: "Child", project, parentId: task.id });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }, ...(inside ? [{ task: child, completed: false }] : [])],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    vault.folders.add("Sync/Parent");
    const oldPath = inside ? "Sync/Parent/Parent.md" : "Sync/Parent.md";
    const targetPath = oldPath.replace(/\.md$/u, ".task.md");
    const content = `${renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        snapshot.syncedAt,
      ),
      makeManagedBody(task),
    )}\nUser notes and [[Reference#Heading]] stay here.\n`;
    const file = vault.addFile(oldPath, content);
    return { snapshot, oldPath, targetPath, content, file };
  };

  it.each([
    true,
    false,
  ])("migrates a legacy folder note using native moves without renaming its folder (inside: %s)", async (inside) => {
    const { snapshot, oldPath, targetPath, file } = prepareLegacyFolderNote(inside);
    const folder = vault.getFolderByPath("Sync/Parent");
    const unrelated = vault.addFile("Sync/Parent/Notes.md", "User-owned child note");
    const rename = fileManager.renameFile.getMockImplementation();
    if (rename === undefined) {
      throw new Error("Missing fake native rename");
    }
    fileManager.renameFile.mockImplementation(async (entry, newPath) => {
      const before = entry.path;
      const beforeDirectory = before.slice(0, before.lastIndexOf("/"));
      const oldStem = before.slice(before.lastIndexOf("/") + 1).replace(/\.md$/u, "");
      const associatedFolder = inside
        ? vault.getFolderByPath(beforeDirectory)
        : vault.getFolderByPath(`${beforeDirectory}/${oldStem}`);
      await rename(entry, newPath);
      // Folder Notes 1.8.26's rename listener synchronizes the associated folder only when
      // the note changes its basename within the same directory.
      if (
        associatedFolder?.name === oldStem &&
        beforeDirectory === newPath.slice(0, newPath.lastIndexOf("/"))
      ) {
        const folderParent = associatedFolder.path.slice(0, associatedFolder.path.lastIndexOf("/"));
        const newStem = entry.name.replace(/\.md$/u, "");
        vault.moveFolder(associatedFolder, `${folderParent}/${newStem}`);
      }
    });
    const mutationPaths: string[][] = [];
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => [],
      async (paths, operation) => {
        mutationPaths.push([...paths]);
        return await operation();
      },
    );

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([]);
    expect(result.moved).toBe(1);
    expect(fileManager.renameFile).toHaveBeenCalledTimes(2);
    const stagingPath = fileManager.renameFile.mock.calls[0][1];
    expect(stagingPath.startsWith("Sync/")).toBe(true);
    expect(stagingPath.slice(0, stagingPath.lastIndexOf("/"))).not.toBe(
      oldPath.slice(0, oldPath.lastIndexOf("/")),
    );
    expect(mutationPaths).toContainEqual([oldPath, stagingPath, targetPath]);
    expect(vault.getFolderByPath("Sync/Parent")).toBe(folder);
    expect(unrelated.path).toBe("Sync/Parent/Notes.md");
    expect(vault.files.get(targetPath)?.file).toBe(file);
    expect(vault.files.get(targetPath)?.content).toContain(
      "User notes and [[Reference#Heading]] stay here.",
    );
    expect(vault.files.has(stagingPath)).toBe(false);
  });

  it("reserves a folder-note staging path against loaded, on-disk, and matching-folder collisions", async () => {
    const { snapshot } = prepareLegacyFolderNote();
    const occupied = vault.addFile("Sync/Parent.tasks-bridge-migrate.md", "Do not overwrite");
    vault.folders.add("Sync/Parent.tasks-bridge-migrate-3");
    const exists = vault.adapter.exists.getMockImplementation();
    if (exists === undefined) {
      throw new Error("Missing fake adapter exists");
    }
    vault.adapter.exists.mockImplementation(
      async (path, sensitive) =>
        path === "Sync/Parent.tasks-bridge-migrate-2.md" || (await exists(path, sensitive)),
    );

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([]);
    expect(fileManager.renameFile.mock.calls[0][1]).toBe("Sync/Parent.tasks-bridge-migrate-4.md");
    expect(vault.files.get(occupied.path)?.content).toBe("Do not overwrite");
  });

  it.each([
    false,
    true,
  ])("restores a staged folder note if migration fails (cancelled: %s)", async (cancelled) => {
    const { snapshot, oldPath, targetPath, file } = prepareLegacyFolderNote();
    let staged = false;
    fileManager.beforeRename = (newPath) => {
      if (!cancelled && newPath === targetPath) {
        throw new Error("Target move failed");
      }
    };
    fileManager.afterRename = () => {
      if (file.path.includes("tasks-bridge-migrate")) {
        staged = true;
      }
    };

    await expect(
      adapter.reconcile(snapshot, mapping, {
        assertValid: () => {
          if (cancelled && staged) {
            throw new Error("Run cancelled");
          }
        },
      }),
    ).rejects.toThrow(cancelled ? "Run cancelled" : "Target move failed");

    expect(vault.files.get(oldPath)?.file).toBe(file);
    expect(vault.files.has(targetPath)).toBe(false);
    expect([...vault.files.keys()].some((path) => path.includes("tasks-bridge-migrate"))).toBe(
      false,
    );
  });

  it("preserves both a newly occupied rollback path and the staged folder note", async () => {
    const { snapshot, oldPath, targetPath, file } = prepareLegacyFolderNote();
    fileManager.beforeRename = (newPath) => {
      if (newPath === targetPath) {
        vault.addFile(oldPath, "New user note");
        throw new Error("Target move failed");
      }
    };

    await expect(adapter.reconcile(snapshot, mapping)).rejects.toThrow("rollback failed");

    expect(vault.files.get(oldPath)?.content).toBe("New user note");
    expect(file.path).toBe("Sync/Parent.tasks-bridge-migrate.md");
    expect(vault.files.get(file.path)?.content).toContain(
      "User notes and [[Reference#Heading]] stay here.",
    );
  });

  it("defers a folder-note migration if the note opens while reserving its temporary path", async () => {
    const { snapshot, oldPath, file } = prepareLegacyFolderNote();
    const openPaths = new Set<string>();
    const exists = vault.adapter.exists.getMockImplementation();
    if (exists === undefined) {
      throw new Error("Missing fake adapter exists");
    }
    vault.adapter.exists.mockImplementation(async (path, sensitive) => {
      if (path.includes("tasks-bridge-migrate")) {
        openPaths.add(oldPath);
      }
      return await exists(path, sensitive);
    });
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => openPaths,
    );

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.deferred).toBe(1);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.get(oldPath)?.file).toBe(file);
  });

  it("preserves a root folder note when no safe staging directory exists inside its mapping", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("root-note", { content: "Sync", project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    const file = vault.addFile(
      "Sync/Sync.md",
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          snapshot.syncedAt,
        ),
        makeManagedBody(task),
      ),
    );

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("another existing folder inside 'Sync'"),
      }),
    ]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.get("Sync/Sync.md")?.file).toBe(file);
    expect([...vault.files.keys()]).toEqual(["Sync/Sync.md"]);
  });

  it("rejects a changed task identity between the caller's validation and folder-note migration", async () => {
    const { oldPath, targetPath, file, content } = prepareLegacyFolderNote();
    const replacement = content.split("folder-task").join("replacement-task");
    vault.files.set(oldPath, { file, content: replacement });
    const internal = adapter as unknown as {
      renameManagedFileToPath(
        file: TFile,
        target: string,
        context: { assertValid: () => void },
        root: string,
        expectedIdentity: { taskId: string },
      ): Promise<void>;
    };

    await expect(
      internal.renameManagedFileToPath(file, targetPath, { assertValid: () => undefined }, "Sync", {
        taskId: "folder-task",
      }),
    ).rejects.toThrow("changed identity");

    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.get(oldPath)?.content).toBe(replacement);
  });

  it("accepts a folder-note move that reaches its target before native link maintenance reports an error", async () => {
    const { snapshot, targetPath, file } = prepareLegacyFolderNote();
    fileManager.afterRename = () => {
      if (file.path === targetPath) {
        throw new Error("Native link update failed after the move");
      }
    };

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([]);
    expect(vault.files.get(targetPath)?.file).toBe(file);
    expect([...vault.files.keys()].some((path) => path.includes("tasks-bridge-migrate"))).toBe(
      false,
    );
  });

  it("preserves an old .md task when an unmanaged file occupies its .task.md destination", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("existing-task", { content: "Existing task", project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        snapshot.syncedAt,
      ),
      makeManagedBody(task),
    );
    const oldPath = "Sync/Existing task.md";
    const targetPath = "Sync/Existing task.task.md";
    vault.addFile(oldPath, original);
    const occupant = vault.addFile(targetPath, "This is a user-owned file.\n");

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result).toMatchObject({ created: 0, moved: 0 });
    expect(result.conflicts).not.toEqual([]);
    expect(vault.files.get(oldPath)?.content).toBe(original);
    expect(vault.files.get(targetPath)?.file).toBe(occupant);
    expect(vault.files.get(targetPath)?.content).toBe("This is a user-owned file.\n");
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(vault.files.size).toBe(2);
  });

  it("migrates legacy task properties and the filename together without touching user data", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("legacy-properties", { content: "Legacy properties", project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    const desired = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      snapshot.syncedAt,
    );
    const legacy = Object.fromEntries(
      Object.entries(TASK_PROPERTY_NAMES)
        .filter(([, canonical]) => canonical in desired)
        .map(([key, canonical]) => [key, desired[canonical]]),
    );
    legacy.user_property = "Preserve custom fields";
    const oldPath = "Sync/Legacy properties.md";
    const targetPath = "Sync/Legacy properties.task.md";
    const file = vault.addFile(
      oldPath,
      `${renderNewTaskDocument(legacy, makeManagedBody(task))}\nKeep [[Reference#Section]] and my notes.\n`,
    );

    const migrated = await adapter.reconcile(snapshot, mapping);

    expect(migrated).toMatchObject({ created: 0, updated: 1, moved: 1 });
    expect(migrated.conflicts).toEqual([]);
    expect(vault.files.get(targetPath)?.file).toBe(file);
    const content = vault.files.get(targetPath)?.content ?? "";
    expect(parseFrontmatter(content)).toEqual({
      ...desired,
      user_property: "Preserve custom fields",
    });
    expect(content).toContain("Keep [[Reference#Section]] and my notes.");
    expect(content).not.toContain("todoist_");
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.size).toBe(1);

    const stable = await adapter.reconcile(snapshot, mapping);
    expect(stable).toMatchObject({ created: 0, updated: 0, moved: 0, unchanged: 1 });
  });

  it.each([
    true,
    false,
  ])("preserves conflicting user properties before cleanup or migration (preserve unmanaged: %s)", async (preserveUnmanagedItems) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("property-conflict", { content: "Conflicting task", project });
    const oldPath = "Sync/Conflicting task.md";
    const original = renderNewTaskDocument(
      {
        todoist_task_id: task.id,
        todoist_status: "active",
        status: "Personal workflow status",
      },
      makeManagedBody(task),
    );
    vault.addFile(oldPath, original);
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const result = await adapter.reconcile(snapshot, mapping, {
      assertValid: () => undefined,
      preserveUnmanagedItems,
    });

    expect(result).toMatchObject({ created: 0, moved: 0, updated: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        path: oldPath,
        message: expect.stringContaining('property "status"'),
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.get(oldPath)?.content).toBe(original);
    expect(vault.files.size).toBe(1);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("migrates Bases outside the task folder before creating new task files", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("base-task", { content: "Task", project });
    const basePath = "Dashboards/Tasks.base";
    const original =
      "# User dashboard\nfilters:\n  and:\n    - note.todoist_task_id != null\nviews:\n  - type: tasks-bridge-list\n    name: Tasks\n    order:\n      - note.todoist_content\n";
    const base = vault.addFile(basePath, original);
    let basesReadyBeforeTaskCreation = false;
    vault.beforeCreate = () => {
      basesReadyBeforeTaskCreation = vault.files.get(basePath)?.content !== original;
    };
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([]);
    expect(result.created).toBe(1);
    expect(basesReadyBeforeTaskCreation).toBe(true);
    expect(vault.process.mock.calls[0]?.[0]).toBe(base);
    const baseContent = vault.files.get(basePath)?.content ?? "";
    expect(baseContent).toContain("# User dashboard");
    const parsed = loadYaml(baseContent) as {
      filters: { and: string[] };
      formulas: Record<string, string>;
      views: { order: string[] }[];
    };
    expect(parsed.filters.and[0]).toContain('note["task id"]');
    expect(parsed.filters.and[0]).toContain("note.todoist_task_id");
    expect(parsed.views[0]?.order[0]).toBe("note.content");
    expect(parseFrontmatter(vault.files.get("Sync/Task.task.md")?.content ?? "")["task id"]).toBe(
      task.id,
    );

    vault.process.mockClear();
    const stable = await adapter.reconcile(snapshot, mapping);
    expect(stable).toMatchObject({ created: 0, updated: 0, moved: 0, unchanged: 1 });
    expect(stable.conflicts).toEqual([]);
    expect(vault.process).not.toHaveBeenCalled();
    expect(vault.files.get(basePath)?.content).toBe(baseContent);
  });

  it.each([
    "invalid",
    "open",
  ])("preflights every Base and preserves old task files when a Base is %s", async (reason) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("base-blocked", { content: "Task", project });
    const originalTask = renderNewTaskDocument(
      { todoist_task_id: task.id, todoist_status: "active" },
      makeManagedBody(task),
    );
    vault.addFile("Sync/Task.md", originalTask);
    const valid = "filters:\n  and:\n    - note.todoist_task_id != null\n";
    const firstBase = vault.addFile("Dashboards/First.base", valid);
    const blockedPath = "Dashboards/Blocked.base";
    const blockedContent = reason === "invalid" ? "filters: [note.todoist_task_id != null" : valid;
    vault.addFile(blockedPath, blockedContent);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(reason === "open" ? [blockedPath] : []),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, updated: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: blockedPath, projectionBlocked: true }),
    ]);
    expect(vault.files.get("Sync/Task.md")?.content).toBe(originalTask);
    expect(vault.files.has("Sync/Task.task.md")).toBe(false);
    expect(vault.files.get(firstBase.path)?.content).toBe(valid);
    expect(vault.files.get(blockedPath)?.content).toBe(blockedContent);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("prepares marked tasks in disabled mappings before switching editable Base columns", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("disabled-task", { content: "Disabled task", project });
    const legacy = {
      todoist_task_id: task.id,
      todoist_status: "active",
      todoist_completed: false,
      tags: ["study"],
      aliases: ["Personal alias"],
      cssclasses: ["personal-style"],
      custom_field: { nested: ["保留", 42] },
    };
    const tail = `description: My personal summary\n---\n${makeManagedBody(task)}\n\r\n保留 [[Reference#Heading]] ^block-id\r\n`;
    const original = `---\n${dumpYaml(legacy, { lineWidth: -1 })}---\n${tail}`;
    const taskFile = vault.addFile("Disabled mapping/Task.md", original);
    const ordinary = vault.addFile(
      "Notes/Ordinary.md",
      renderNewTaskDocument({ "task id": "ordinary", status: "Personal" }, "My own note."),
    );
    const ordinaryContent = vault.files.get(ordinary.path)?.content;
    const base = vault.addFile(
      "Dashboards/Tasks.base",
      "filters: 'note.todoist_task_id != null'\nviews: [{type: table, order: [note.todoist_status]}]\n",
    );

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result.conflicts).toEqual([]);
    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    const migrated = vault.files.get(taskFile.path)?.content ?? "";
    expect(migrated.slice(frontmatterInfo(migrated).contentStart)).toBe(tail);
    expect(parseFrontmatter(migrated)).toEqual({
      "task id": task.id,
      status: "active",
      completed: false,
      tags: legacy.tags,
      aliases: legacy.aliases,
      cssclasses: legacy.cssclasses,
      custom_field: legacy.custom_field,
    });
    expect(taskFile.path).toBe("Disabled mapping/Task.md");
    expect(vault.files.get(ordinary.path)?.content).toBe(ordinaryContent);
    const parsedBase = loadYaml(vault.files.get(base.path)?.content ?? "") as {
      views: { order: string[] }[];
    };
    expect(parsedBase.views[0]?.order).toEqual(["note.status"]);
    expect(vault.process.mock.calls.map(([file]) => file.path)).toEqual([taskFile.path, base.path]);

    vault.process.mockClear();
    await adapter.reconcile(emptySnapshot(project), mapping);
    expect(vault.process).not.toHaveBeenCalled();
  });

  it("defers the entire schema and Base migration when a disabled mapping's legacy task is open", async () => {
    const project = makeProject("root", { name: "Root" });
    const documents = ["closed", "open"].map((id) => {
      const task = makeTask(id, { content: id, project });
      const content = renderNewTaskDocument(
        { todoist_task_id: task.id, todoist_status: "active" },
        makeManagedBody(task),
      );
      const file = vault.addFile(`Disabled mapping/${id}.md`, content);
      return { file, content };
    });
    const baseContent = "views: [{type: table, order: [note.todoist_status]}]\n";
    const base = vault.addFile("Dashboards/Tasks.base", baseContent);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set([documents[1].file.path]),
    );

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0, deferred: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: documents[1].file.path, taskId: "open", deferred: true }),
    ]);
    for (const { file, content } of documents) {
      expect(vault.files.get(file.path)?.content).toBe(content);
    }
    expect(vault.files.get(base.path)?.content).toBe(baseContent);
    expect(vault.process).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("blocks all migration for a disabled legacy task without a managed region (open: %s)", async (open) => {
    const project = makeProject("root", { name: "Root" });
    const original = renderNewTaskDocument(
      { todoist_task_id: "legacy-without-card", todoist_status: "active" },
      "Keep this document untouched.\n",
    );
    const file = vault.addFile("Disabled mapping/Task.md", original);
    const baseContent = "views: [{type: table, order: [note.todoist_status]}]\n";
    const base = vault.addFile("Dashboard.base", baseContent);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(open ? [file.path] : []),
    );

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: file.path, projectionBlocked: true }),
    ]);
    expect(vault.files.get(file.path)?.content).toBe(original);
    expect(vault.files.get(base.path)?.content).toBe(baseContent);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it.each([
    ["flow", '{todoist_task_id: "yaml-task", todoist_status: active}\n'],
    ["explicit keys", '? todoist_task_id\n: "yaml-task"\n? todoist_status\n: active\n'],
  ])("migrates legacy properties written with %s YAML", async (_kind, yaml) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("yaml-task", { content: "Task", project });
    const tail = `${makeManagedBody(task)}\nPersonal text.\n`;
    const file = vault.addFile("Disabled mapping/Task.md", `---\n${yaml}---\n${tail}`);
    const base = vault.addFile(
      "Dashboard.base",
      "views: [{type: table, order: [note.todoist_status]}]\n",
    );
    const ordinaryContent = "---\ninterests: [unfinished\n---\nPersonal note.\n";
    const ordinary = vault.addFile("Notes/Malformed ordinary.md", ordinaryContent);

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result.conflicts).toEqual([]);
    const migrated = vault.files.get(file.path)?.content ?? "";
    expect(parseFrontmatter(migrated)).toEqual({ "task id": task.id, status: "active" });
    expect(migrated.slice(frontmatterInfo(migrated).contentStart)).toBe(tail);
    expect(vault.files.get(base.path)?.content).toContain("note.status");
    expect(vault.files.get(ordinary.path)?.content).toBe(ordinaryContent);
    expect(vault.process.mock.calls.map(([written]) => written.path)).toEqual([
      file.path,
      base.path,
    ]);
  });

  it("preserves ordinary notes with generic task properties inside a protected mapping", async () => {
    const project = makeProject("root", { name: "Root" });
    const original = renderNewTaskDocument(
      { "task id": "personal-task", status: "active", completed: false },
      "This is my own note.\n",
    );
    const file = vault.addFile("Sync/Personal.md", original);

    const result = await adapter.reconcile(emptySnapshot(project), mapping, {
      assertValid: () => undefined,
      preserveUnmanagedItems: true,
    });

    expect(result.conflicts).toEqual([]);
    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(vault.files.get(file.path)?.content).toBe(original);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("does not recover a generic canonical note whose malformed YAML and card disagree", async () => {
    const project = makeProject("root", { name: "Root" });
    const unrelatedTask = makeTask("different-task", { content: "Other task", project });
    const original = `---\ntask id: personal-task\nstatus: [unfinished\n---\n${makeManagedBody(unrelatedTask)}\nPersonal text.\n`;
    const file = vault.addFile("Sync/Personal.md", original);

    const result = await adapter.reconcile(emptySnapshot(project), mapping, {
      assertValid: () => undefined,
      preserveUnmanagedItems: true,
    });

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(vault.files.get(file.path)?.content).toBe(original);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("rejects a legacy frontmatter identity that disagrees with its managed task block", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("block-task", { content: "Task", project });
    const original = renderNewTaskDocument(
      { todoist_task_id: "different-task", todoist_status: "active" },
      makeManagedBody(task),
    );
    const file = vault.addFile("Disabled mapping/Task.md", original);
    const baseContent = "views: [{order: [note.todoist_status]}]\n";
    const base = vault.addFile("Dashboard.base", baseContent);

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: file.path, message: expect.stringContaining("same task") }),
    ]);
    expect(vault.files.get(file.path)?.content).toBe(original);
    expect(vault.files.get(base.path)?.content).toBe(baseContent);
    expect(vault.process).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("preserves concurrent edits and rolls back only unchanged schema writes (earlier task edited: %s)", async (editEarlierTask) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("rollback-task", { content: "Task", project });
    const originalTask = renderNewTaskDocument(
      { todoist_task_id: task.id, todoist_status: "active" },
      makeManagedBody(task),
    );
    const taskFile = vault.addFile("Disabled mapping/Task.md", originalTask);
    const originalBase = "views: [{order: [note.todoist_status]}]\n";
    const base = vault.addFile("Dashboard.base", originalBase);
    vault.beforeProcess = () => {
      const currentFile = vault.process.mock.calls[vault.process.mock.calls.length - 1]?.[0];
      if (currentFile !== base) {
        return;
      }
      const baseEntry = vault.files.get(base.path);
      if (baseEntry !== undefined) {
        baseEntry.content += "# New user comment\n";
      }
      const taskEntry = vault.files.get(taskFile.path);
      if (editEarlierTask && taskEntry !== undefined) {
        taskEntry.content += "New user task text\n";
      }
      vault.beforeProcess = undefined;
    };

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: base.path, projectionBlocked: true }),
    ]);
    expect(vault.files.get(base.path)?.content).toBe(`${originalBase}# New user comment\n`);
    const taskContent = vault.files.get(taskFile.path)?.content ?? "";
    if (editEarlierTask) {
      expect(taskContent).toContain("New user task text");
      expect(parseFrontmatter(taskContent)["task id"]).toBe(task.id);
      expect(result.conflicts[0]?.message).toContain("could not be restored");
    } else {
      expect(taskContent).toBe(originalTask);
    }
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy", "```tasks-bridge-task\n```"],
    ["canonical", makeProjectTaskBlock("legacy-task")],
  ])("migrates the historical %s task block without touching user content", async (_kind, block) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("legacy-task", { content: "Legacy task", project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      snapshot.syncedAt,
    );
    const legacyBody = `${MANAGED_BODY_START}\n${block}\n${MANAGED_BODY_END}`;
    const prefix = "User prefix\r\n\r\n";
    const suffix = `\nUser notes stay here.\r\n${makeProjectTaskBlock("embedded-other-task")}\r\n`;
    vault.addFile(
      "Sync/Legacy task.task.md",
      `${renderNewTaskDocument(frontmatter, `${prefix}${legacyBody}`)}${suffix}`,
    );

    const migrated = await adapter.reconcile(snapshot, mapping);

    expect(migrated).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    const content = vault.files.get("Sync/Legacy task.task.md")?.content ?? "";
    expect(content).toContain(makeManagedTaskIdentityMarker("legacy-task"));
    expect(content).not.toContain("```tasks-bridge-task");
    expect(content.slice(frontmatterInfo(content).contentStart)).toBe(
      `${prefix}${makeManagedBody(task)}\n${suffix}`,
    );

    const stable = await adapter.reconcile(snapshot, mapping);
    expect(stable).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it.each([
    ["wrong comment identity", makeManagedTaskIdentityMarker("different-task")],
    [
      "duplicate comments",
      `${makeManagedTaskIdentityMarker("ambiguous-task")}\n${makeManagedTaskIdentityMarker("ambiguous-task")}`,
    ],
    [
      "duplicate boundary",
      `${makeManagedTaskIdentityMarker("ambiguous-task")}\n${MANAGED_BODY_START}`,
    ],
    ["wrong historical block", makeProjectTaskBlock("different-task")],
  ])("preserves a task with %s during update and remote cleanup", async (_reason, region) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("ambiguous-task", { content: "Task", project });
    const body = `${MANAGED_BODY_START}\n${region}\n${MANAGED_BODY_END}`;
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T00:00:00.000Z",
      ),
      `${body}\nUser notes`,
    );
    const file = vault.addFile("Sync/Task.task.md", original);
    for (const tasks of [[{ task, completed: false }], []]) {
      const result = await adapter.reconcile({ ...emptySnapshot(project), tasks }, mapping, {
        assertValid: () => undefined,
        preserveUnmanagedItems: false,
      });
      expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
      expect(result.conflicts).toEqual([
        expect.objectContaining({ path: file.path, projectionBlocked: true }),
      ]);
      expect(vault.files.get(file.path)?.content).toBe(original);
    }
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("preserves same-named Bases and arbitrary user content while deleting remote task notes", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const rootTask = makeTask("root-task", { content: "Root task", project: root });
    const childTask = makeTask("child-task", { content: "Child task", project: child });
    vault.folders.add("Sync/Child");
    vault.folders.add("Sync/User material");
    vault.folders.add("Sync/User material/Empty folder");
    const rootBase = vault.addFile("Sync/Root.base", "filters:\n  and: []\n");
    const childBase = vault.addFile("Sync/Child/Child.base", "views: []\n");
    const userNote = vault.addFile("Sync/User material/Notes.md", "Personal notes\n");
    const attachment = vault.addFile("Sync/User material/reference.bin", "binary placeholder");

    const first = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [
          { task: rootTask, completed: false },
          { task: childTask, completed: false },
        ],
        syncedAt: "2026-08-17T10:00:00.000Z",
      },
      mapping,
    );

    expect(first).toMatchObject({ created: 2, deleted: 0 });
    expect(first.conflicts).toEqual([]);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([]);

    const second = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root],
        tasks: [],
        syncedAt: "2026-08-17T11:00:00.000Z",
      },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, deleted: 2 });
    expect(second.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Root task.task.md")).toBe(false);
    expect(vault.files.has("Sync/Child/Child task.task.md")).toBe(false);
    expect(vault.files.get(rootBase.path)?.file).toBe(rootBase);
    expect(vault.files.get(childBase.path)?.file).toBe(childBase);
    expect(vault.files.get(userNote.path)?.file).toBe(userNote);
    expect(vault.files.get(attachment.path)?.file).toBe(attachment);
    expect(vault.folders.has("Sync/Child")).toBe(true);
    expect(vault.folders.has("Sync/User material/Empty folder")).toBe(true);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(rootBase);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(childBase);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(userNote);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(attachment);
  });

  it("preserves invalid task-ID notes as user content while exact supported IDs remain managed", async () => {
    const project = makeProject("root", { name: "Root" });
    const invalidIds = [" \t ", " task-1", "task-1 ", "task 1", "task.1"];
    const validIds = ["6hGr78cXw24jQC7W", "task-1", "task_1"];
    const invalidFiles = invalidIds.map((taskId, index) => {
      const path = `Sync/User note ${index + 1}.md`;
      const content = renderNewTaskDocument(
        { "task id": taskId, user_property: "preserve me" },
        makeManagedBody(makeTask(`invalid-source-${index + 1}`, { project })),
      );
      return { file: vault.addFile(path, content), content };
    });
    const validFiles = validIds.map((taskId, index) => {
      const path = `Sync/Managed note ${index + 1}.task.md`;
      const content = renderNewTaskDocument(
        { "task id": taskId },
        makeManagedBody(makeTask(taskId, { project })),
      );
      return vault.addFile(path, content);
    });

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ created: 0, deleted: validFiles.length });
    expect(result.conflicts).toEqual([]);
    for (const { file, content } of invalidFiles) {
      expect(vault.files.get(file.path)).toEqual({ file, content });
      expect(fileManager.trashFile).not.toHaveBeenCalledWith(file);
    }
    for (const file of validFiles) {
      expect(vault.files.has(file.path)).toBe(false);
      expect(fileManager.trashFile).toHaveBeenCalledWith(file);
    }
  });

  it("tracks created project and task folders, but retains old owned folders with user content", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const parent = makeTask("parent", { content: "Parent", project: root });
    const subtask = makeTask("subtask", {
      content: "Subtask",
      parentId: parent.id,
      project: root,
    });
    const childTask = makeTask("child-task", { content: "Child task", project: child });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, child],
      tasks: [
        { task: parent, completed: false },
        { task: subtask, completed: false },
        { task: childTask, completed: false },
      ],
      syncedAt: "2026-08-17T10:00:00.000Z",
    };

    await adapter.reconcile(initial, mapping);

    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: "project", ownerId: child.id, path: "Sync/Child" }),
        expect.objectContaining({ ownerKind: "task", ownerId: parent.id, path: "Sync/Parent" }),
      ]),
    );
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Sync" })]),
    );
    const childBase = vault.addFile("Sync/Child/Child.base", "views: []\n");
    const parentBase = vault.addFile("Sync/Parent/Parent.base", "views: []\n");
    const renamedChild = { ...child, name: "Renamed child" };
    const renamedParent = { ...parent, content: "Renamed parent" };
    const renamedSnapshot: ProjectSyncSnapshot = {
      ...initial,
      projects: [root, renamedChild],
      tasks: [
        { task: renamedParent, completed: false },
        { task: subtask, completed: false },
        { task: { ...childTask, project: renamedChild }, completed: false },
      ],
      syncedAt: "2026-08-17T11:00:00.000Z",
    };

    const renamed = await adapter.reconcile(renamedSnapshot, mapping);

    expect(renamed).toMatchObject({ moved: 3, deleted: 0 });
    expect(renamed.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Renamed child/Child task.task.md")).toBe(true);
    expect(vault.files.has("Sync/Renamed parent/Renamed parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Renamed parent/Subtask.task.md")).toBe(true);
    expect(vault.files.get(childBase.path)?.file).toBe(childBase);
    expect(vault.files.get(parentBase.path)?.file).toBe(parentBase);
    expect(vault.folders.has("Sync/Child")).toBe(true);
    expect(vault.folders.has("Sync/Parent")).toBe(true);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Sync/Child" }),
        expect.objectContaining({ path: "Sync/Parent" }),
        expect.objectContaining({ path: "Sync/Renamed child" }),
        expect.objectContaining({ path: "Sync/Renamed parent" }),
      ]),
    );

    vault.files.delete(childBase.path);
    vault.files.delete(parentBase.path);
    vi.clearAllMocks();
    const settled = await adapter.reconcile(renamedSnapshot, mapping);

    expect(settled.conflicts).toEqual([]);
    expect(vault.folders.has("Sync/Child")).toBe(false);
    expect(vault.folders.has("Sync/Parent")).toBe(false);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Sync/Child" }),
        expect.objectContaining({ path: "Sync/Parent" }),
      ]),
    );
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Sync/Child" }),
    );
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Sync/Parent" }),
    );
  });

  it("recases an owned project folder to Todoist's exact spelling with its whole subtree", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const task = makeTask("logistics-task", {
      content: "Application",
      project: lowercaseProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFolder = vault.getFolderByPath("Sync/logistics");
    const originalTaskFile = vault.files.get("Sync/logistics/Application.task.md")?.file;
    const userBase = vault.addFile("Sync/logistics/Logistics.base", "views: []\n");
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    const canonical: ProjectSyncSnapshot = {
      ...initial,
      projects: [root, canonicalProject],
      tasks: [{ task: { ...task, project: canonicalProject }, completed: false }],
      syncedAt: "2026-08-19T01:00:00.000Z",
    };

    const recased = await adapter.reconcile(canonical, mapping);

    expect(recased.conflicts).toEqual([]);
    expect(vault.getFolderByPath("Sync/Logistics")).toBe(originalFolder);
    expect(vault.getFolderByPath("Sync/logistics")).toBeNull();
    expect(vault.files.get("Sync/Logistics/Application.task.md")?.file).toBe(originalTaskFile);
    expect(vault.files.get("Sync/Logistics/Logistics.base")?.file).toBe(userBase);
    expect(vault.files.get("Sync/Logistics/Logistics.base")?.content).toBe("views: []\n");
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "project",
          ownerId: lowercaseProject.id,
          path: "Sync/Logistics",
          generation: 2,
        }),
      ]),
    );
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Sync/logistics" })]),
    );

    vi.clearAllMocks();
    const settled = await adapter.reconcile(canonical, mapping);
    expect(settled.conflicts).toEqual([]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("rebases every owned descendant when a parent project folder changes casing", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const childProject = makeProject("operations", {
      name: "Operations",
      parentId: lowercaseProject.id,
    });
    const parentTask = makeTask("checklist", { content: "Checklist", project: childProject });
    const childTask = makeTask("step", {
      content: "Step",
      parentId: parentTask.id,
      project: childProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject, childProject],
      tasks: [
        { task: parentTask, completed: false },
        { task: childTask, completed: false },
      ],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    const canonical: ProjectSyncSnapshot = {
      ...initial,
      projects: [root, canonicalProject, childProject],
      syncedAt: "2026-08-19T01:00:00.000Z",
    };

    const recased = await adapter.reconcile(canonical, mapping);

    expect(recased.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Logistics/Operations/Checklist/Checklist.task.md")).toBe(true);
    expect(vault.files.has("Sync/Logistics/Operations/Checklist/Step.task.md")).toBe(true);
    const ownedPaths = folderOwnershipStorage
      .listOwnedFolders(mapping.id)
      .map(({ path }) => path)
      .sort();
    expect(ownedPaths).toEqual([
      "Sync/Logistics",
      "Sync/Logistics/Operations",
      "Sync/Logistics/Operations/Checklist",
    ]);
    expect(ownedPaths.some((path) => path.startsWith("Sync/logistics"))).toBe(false);
  });

  it("uses a safe temporary Vault path when a direct case-only folder rename is unavailable", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const task = makeTask("logistics-task", {
      content: "Application",
      project: lowercaseProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    let rejectedDirectRename = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/Logistics" && !rejectedDirectRename) {
        rejectedDirectRename = true;
        throw new Error("Direct case-only rename is unavailable");
      }
    };

    const result = await adapter.reconcile(
      {
        ...initial,
        projects: [root, canonicalProject],
        tasks: [{ task: { ...task, project: canonicalProject }, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([]);
    expect(rejectedDirectRename).toBe(true);
    expect(vault.getFolderByPath("Sync/Logistics")).not.toBeNull();
    expect(vault.getFolderByPath("Sync/logistics")).toBeNull();
    expect([...vault.folders].some((path) => path.includes("tasks-bridge-recase"))).toBe(false);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ path: "Sync/Logistics", generation: 2 }),
    ]);
  });

  it("accepts a folder fallback rename that reaches the exact target before reporting an error", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const task = makeTask("logistics-task", {
      content: "Application",
      project: lowercaseProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    let rejectedDirectRename = false;
    let rejectedCompletedFallback = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/Logistics" && !rejectedDirectRename) {
        rejectedDirectRename = true;
        throw new Error("Direct case-only rename is unavailable");
      }
    };
    fileManager.afterRename = () => {
      if (!rejectedCompletedFallback && vault.getFolderByPath("Sync/Logistics") !== null) {
        rejectedCompletedFallback = true;
        throw new Error("Link maintenance failed after the folder moved");
      }
    };

    const result = await adapter.reconcile(
      {
        ...initial,
        projects: [root, canonicalProject],
        tasks: [{ task: { ...task, project: canonicalProject }, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([]);
    expect(rejectedDirectRename).toBe(true);
    expect(rejectedCompletedFallback).toBe(true);
    expect(vault.getFolderByPath("Sync/Logistics")).not.toBeNull();
    expect(vault.getFolderByPath("Sync/logistics")).toBeNull();
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ path: "Sync/Logistics", generation: 2 }),
    ]);
  });

  it("recognizes a restored folder when the rollback reports an error after moving it", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const task = makeTask("logistics-task", {
      content: "Application",
      project: lowercaseProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    let targetAttempts = 0;
    let rejectedCompletedRollback = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/Logistics") {
        targetAttempts++;
        throw new Error(
          targetAttempts === 1
            ? "Direct case-only rename is unavailable"
            : "Fallback target rename failed",
        );
      }
    };
    fileManager.afterRename = () => {
      if (
        !rejectedCompletedRollback &&
        targetAttempts === 2 &&
        vault.getFolderByPath("Sync/logistics") !== null
      ) {
        rejectedCompletedRollback = true;
        throw new Error("Link maintenance failed after the folder rollback");
      }
    };

    await expect(
      adapter.reconcile(
        {
          ...initial,
          projects: [root, canonicalProject],
          tasks: [{ task: { ...task, project: canonicalProject }, completed: false }],
          syncedAt: "2026-08-19T01:00:00.000Z",
        },
        mapping,
      ),
    ).rejects.toThrow("Fallback target rename failed");

    expect(targetAttempts).toBe(2);
    expect(rejectedCompletedRollback).toBe(true);
    expect(vault.getFolderByPath("Sync/logistics")).not.toBeNull();
    expect(vault.getFolderByPath("Sync/Logistics")).toBeNull();
    expect([...vault.folders].some((path) => path.includes("tasks-bridge-recase"))).toBe(false);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ path: "Sync/logistics", generation: 1 }),
    ]);
  });

  it("recases an owned parent-task folder and its self-note to Todoist's exact spelling", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseParent = makeTask("course", { content: "course", project: root });
    const child = makeTask("chapter", {
      content: "Chapter",
      parentId: lowercaseParent.id,
      project: root,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [
        { task: lowercaseParent, completed: false },
        { task: child, completed: false },
      ],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFolder = vault.getFolderByPath("Sync/course");
    const originalParentFile = vault.files.get("Sync/course/course.task.md")?.file;
    const originalChildFile = vault.files.get("Sync/course/Chapter.task.md")?.file;
    const userBase = vault.addFile("Sync/course/Course.base", "views: []\n");
    const canonicalParent = { ...lowercaseParent, content: "Course" };
    const canonical: ProjectSyncSnapshot = {
      ...initial,
      tasks: [
        { task: canonicalParent, completed: false },
        { task: child, completed: false },
      ],
      syncedAt: "2026-08-19T01:00:00.000Z",
    };

    const recased = await adapter.reconcile(canonical, mapping);

    expect(recased.conflicts).toEqual([]);
    expect(vault.getFolderByPath("Sync/Course")).toBe(originalFolder);
    expect(vault.getFolderByPath("Sync/course")).toBeNull();
    expect(vault.files.get("Sync/Course/Course.task.md")?.file).toBe(originalParentFile);
    expect(vault.files.get("Sync/Course/Chapter.task.md")?.file).toBe(originalChildFile);
    expect(vault.files.get("Sync/Course/Course.base")?.file).toBe(userBase);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "task",
          ownerId: lowercaseParent.id,
          path: "Sync/Course",
          generation: 2,
        }),
      ]),
    );

    vi.clearAllMocks();
    const settled = await adapter.reconcile(canonical, mapping);
    expect(settled.conflicts).toEqual([]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("recases a managed leaf task note and preserves its user-authored content", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseTask = makeTask("wifi", { content: "wifi", project: root });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task: lowercaseTask, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFile = vault.files.get("Sync/wifi.task.md")?.file;
    const originalEntry = vault.files.get("Sync/wifi.task.md");
    if (originalEntry === undefined) {
      throw new Error("Expected the initial managed note");
    }
    originalEntry.content += "\nUser-authored notes stay here.\n";
    const canonicalTask = { ...lowercaseTask, content: "WIFI" };
    const canonical: ProjectSyncSnapshot = {
      ...initial,
      tasks: [{ task: canonicalTask, completed: false }],
      syncedAt: "2026-08-19T01:00:00.000Z",
    };

    const recased = await adapter.reconcile(canonical, mapping);

    expect(recased).toMatchObject({ moved: 1 });
    expect(recased.conflicts).toEqual([]);
    expect(vault.files.has("Sync/wifi.task.md")).toBe(false);
    expect(vault.files.get("Sync/WIFI.task.md")?.file).toBe(originalFile);
    expect(vault.files.get("Sync/WIFI.task.md")?.content).toContain(
      "User-authored notes stay here.",
    );

    vi.clearAllMocks();
    const settled = await adapter.reconcile(canonical, mapping);
    expect(settled.conflicts).toEqual([]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it.each([
    { rejection: new Error("Native rename failed"), message: "Native rename failed" },
    { rejection: "Native rename failed", message: "Native rename failed" },
    { rejection: null, message: "did not move to 'Sync/Renamed.task.md'" },
    { rejection: undefined, message: "did not move to 'Sync/Renamed.task.md'" },
  ])("reports a rejected rename as an Error: $rejection", async ({ rejection, message }) => {
    const root = makeProject("root", { name: "Root" });
    const task = makeTask("rename-rejection", { content: "Original", project: root });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFile = vault.files.get("Sync/Original.task.md")?.file;
    fileManager.renameFile.mockRejectedValueOnce(rejection);

    const rename = adapter.reconcile(
      {
        ...initial,
        tasks: [{ task: { ...task, content: "Renamed" }, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    await expect(rename).rejects.toThrow(message);
    if (rejection instanceof Error) {
      await expect(rename).rejects.toBe(rejection);
    }
    expect(vault.files.get("Sync/Original.task.md")?.file).toBe(originalFile);
    expect(vault.files.has("Sync/Renamed.task.md")).toBe(false);
  });

  it("uses a safe temporary Vault path when a direct case-only note rename is unavailable", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseTask = makeTask("wifi", { content: "wifi", project: root });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task: lowercaseTask, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFile = vault.files.get("Sync/wifi.task.md")?.file;
    const canonicalTask = { ...lowercaseTask, content: "WIFI" };
    let rejectedDirectRename = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/WIFI.task.md" && !rejectedDirectRename) {
        rejectedDirectRename = true;
        throw new Error("Direct case-only rename is unavailable");
      }
    };

    const result = await adapter.reconcile(
      {
        ...initial,
        tasks: [{ task: canonicalTask, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ moved: 1 });
    expect(result.conflicts).toEqual([]);
    expect(rejectedDirectRename).toBe(true);
    expect(vault.files.get("Sync/WIFI.task.md")?.file).toBe(originalFile);
    expect(vault.files.has("Sync/wifi.task.md")).toBe(false);
    expect([...vault.files.keys()].some((path) => path.includes("tasks-bridge-recase"))).toBe(
      false,
    );
  });

  it("accepts a note fallback rename that reaches the exact target before reporting an error", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseTask = makeTask("wifi", { content: "wifi", project: root });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task: lowercaseTask, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFile = vault.files.get("Sync/wifi.task.md")?.file;
    const canonicalTask = { ...lowercaseTask, content: "WIFI" };
    let rejectedDirectRename = false;
    let rejectedCompletedFallback = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/WIFI.task.md" && !rejectedDirectRename) {
        rejectedDirectRename = true;
        throw new Error("Direct case-only rename is unavailable");
      }
    };
    fileManager.afterRename = () => {
      if (!rejectedCompletedFallback && vault.files.has("Sync/WIFI.task.md")) {
        rejectedCompletedFallback = true;
        throw new Error("Link maintenance failed after the note moved");
      }
    };

    const result = await adapter.reconcile(
      {
        ...initial,
        tasks: [{ task: canonicalTask, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ moved: 1 });
    expect(result.conflicts).toEqual([]);
    expect(rejectedDirectRename).toBe(true);
    expect(rejectedCompletedFallback).toBe(true);
    expect(vault.files.get("Sync/WIFI.task.md")?.file).toBe(originalFile);
    expect(vault.files.has("Sync/wifi.task.md")).toBe(false);
  });

  it("recognizes a restored note when the rollback reports an error after moving it", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseTask = makeTask("wifi", { content: "wifi", project: root });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task: lowercaseTask, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const originalFile = vault.files.get("Sync/wifi.task.md")?.file;
    const canonicalTask = { ...lowercaseTask, content: "WIFI" };
    let targetAttempts = 0;
    let rejectedCompletedRollback = false;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/WIFI.task.md") {
        targetAttempts++;
        throw new Error(
          targetAttempts === 1
            ? "Direct case-only rename is unavailable"
            : "Fallback target rename failed",
        );
      }
    };
    fileManager.afterRename = () => {
      if (
        !rejectedCompletedRollback &&
        targetAttempts === 2 &&
        vault.files.has("Sync/wifi.task.md")
      ) {
        rejectedCompletedRollback = true;
        throw new Error("Link maintenance failed after the note rollback");
      }
    };

    await expect(
      adapter.reconcile(
        {
          ...initial,
          tasks: [{ task: canonicalTask, completed: false }],
          syncedAt: "2026-08-19T01:00:00.000Z",
        },
        mapping,
      ),
    ).rejects.toThrow("Fallback target rename failed");

    expect(targetAttempts).toBe(2);
    expect(rejectedCompletedRollback).toBe(true);
    expect(vault.files.get("Sync/wifi.task.md")?.file).toBe(originalFile);
    expect(vault.files.has("Sync/WIFI.task.md")).toBe(false);
    expect([...vault.files.keys()].some((path) => path.includes("tasks-bridge-recase"))).toBe(
      false,
    );
  });

  it("does not recase or claim an unmanaged case-variant project folder", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("logistics", { name: "Logistics", parentId: root.id });
    const task = makeTask("logistics-task", { content: "Application", project: child });
    vault.folders.add("Sync/logistics");
    const unmanagedFolder = vault.getFolderByPath("Sync/logistics");
    const userBase = vault.addFile("Sync/logistics/Personal.base", "views: []\n");

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "Sync/logistics", projectionBlocked: true }),
    ]);
    expect(vault.getFolderByPath("Sync/logistics")).toBe(unmanagedFolder);
    expect(vault.getFolderByPath("Sync/Logistics")).toBeNull();
    expect(vault.files.get("Sync/logistics/Personal.base")?.file).toBe(userBase);
    expect(vault.files.has("Sync/Logistics/Application.task.md")).toBe(false);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("does not recase a case-variant folder owned by a different Todoist project", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("logistics", { name: "Logistics", parentId: root.id });
    const task = makeTask("logistics-task", { content: "Application", project: child });
    vault.folders.add("Sync/logistics");
    const wrongOwnerFolder = vault.getFolderByPath("Sync/logistics");
    await folderOwnershipStorage.recordCreatedFolder({
      mappingId: mapping.id,
      rootProjectId: root.id,
      ownerKind: "project",
      ownerId: "another-project",
      path: "Sync/logistics",
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "Sync/logistics", projectionBlocked: true }),
    ]);
    expect(vault.getFolderByPath("Sync/logistics")).toBe(wrongOwnerFolder);
    expect(vault.getFolderByPath("Sync/Logistics")).toBeNull();
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ ownerId: "another-project", path: "Sync/logistics" }),
    ]);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("preserves a target folder that appears while an owned folder is being recased", async () => {
    const root = makeProject("root", { name: "Root" });
    const lowercaseProject = makeProject("logistics", { name: "logistics", parentId: root.id });
    const task = makeTask("logistics-task", {
      content: "Application",
      project: lowercaseProject,
    });
    const initial: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, lowercaseProject],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-19T00:00:00.000Z",
    };
    await adapter.reconcile(initial, mapping);
    const canonicalProject = { ...lowercaseProject, name: "Logistics" };
    let racedFolder: FakeFolder | null = null;
    fileManager.beforeRename = (newPath) => {
      if (newPath === "Sync/Logistics" && racedFolder === null) {
        vault.folders.add(newPath);
        racedFolder = vault.getFolderByPath(newPath);
      }
    };

    const result = await adapter.reconcile(
      {
        ...initial,
        projects: [root, canonicalProject],
        tasks: [{ task: { ...task, project: canonicalProject }, completed: false }],
        syncedAt: "2026-08-19T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "Sync/logistics", projectionBlocked: true }),
    ]);
    expect(vault.getFolderByPath("Sync/Logistics")).toBe(racedFolder);
    expect(vault.getFolderByPath("Sync/logistics")).not.toBeNull();
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(racedFolder);
  });

  it("keeps an owned folder from a previous mapping root tracked until user content is removed", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const task = makeTask("child-task", { content: "Child task", project: child });
    vault.folders.add("Old");
    const oldMapping: ProjectSyncMapping = { ...mapping, folder: "Old" };
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, child],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-17T10:00:00.000Z",
    };

    await adapter.reconcile(snapshot, oldMapping);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Old/Child" })]),
    );
    const userBase = vault.addFile("Old/Child/Child.base", "views: []\n");
    const movedMapping: ProjectSyncMapping = {
      ...mapping,
      previousFolders: ["Old"],
    };

    const moved = await adapter.reconcile(snapshot, movedMapping);

    expect(moved).toMatchObject({ created: 0, moved: 1 });
    expect(moved.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Child/Child task.task.md")).toBe(true);
    expect(vault.files.get(userBase.path)?.file).toBe(userBase);
    expect(vault.folders.has("Old/Child")).toBe(true);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Old/Child" }),
        expect.objectContaining({ path: "Sync/Child" }),
      ]),
    );

    vault.files.delete(userBase.path);
    vi.clearAllMocks();
    const settled = await adapter.reconcile(snapshot, movedMapping);

    expect(settled.conflicts).toEqual([]);
    expect(vault.folders.has("Old/Child")).toBe(false);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Old/Child" })]),
    );
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Old/Child" }),
    );
  });

  it("preserves an exact user collision while still applying unrelated Todoist deletion", async () => {
    const project = makeProject("root", { name: "Root" });
    const obsolete = makeTask("obsolete", { content: "Obsolete", project });
    await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: obsolete, completed: false }],
        syncedAt: "2026-08-17T10:00:00.000Z",
      },
      mapping,
    );
    const userFile = vault.addFile("Sync/Blocked.task.md", "User-owned note\n");
    const blocked = makeTask("blocked", { content: "Blocked", project });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: blocked, completed: false }],
        syncedAt: "2026-08-17T11:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, deleted: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: blocked.id,
        path: userFile.path,
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.has("Sync/Obsolete.task.md")).toBe(false);
    expect(vault.files.get(userFile.path)?.file).toBe(userFile);
    expect(vault.files.get(userFile.path)?.content).toBe("User-owned note\n");
    expect(vault.files.has("Sync/Blocked (2).task.md")).toBe(false);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(userFile);
  });

  it("projects a parent task into a same-named folder beside its direct subtasks", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Problem sets", project });
    const first = makeTask("first", {
      content: "Chapter one",
      parentId: parent.id,
      project,
    });
    const second = makeTask("second", {
      content: "Chapter two",
      parentId: parent.id,
      project,
    });

    const firstResult = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: second, completed: false },
          { task: parent, completed: false },
          { task: first, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );

    expect(firstResult).toMatchObject({ created: 3, moved: 0 });
    expect(firstResult.conflicts).toEqual([]);
    expect(vault.folders.has("Sync/Problem sets")).toBe(true);
    expect(vault.files.has("Sync/Problem sets/Problem sets.task.md")).toBe(true);
    expect(vault.files.has("Sync/Problem sets/Chapter one.task.md")).toBe(true);
    expect(vault.files.has("Sync/Problem sets/Chapter two.task.md")).toBe(true);
    expect(vault.files.has("Sync/Problem sets.task.md")).toBe(false);
    expect(
      parseFrontmatter(vault.files.get("Sync/Problem sets/Problem sets.task.md")?.content ?? ""),
    ).toMatchObject({
      subtasks: [
        "[[Sync/Problem sets/Chapter one.task|Chapter one]]",
        "[[Sync/Problem sets/Chapter two.task|Chapter two]]",
      ],
    });
    expect(
      parseFrontmatter(vault.files.get("Sync/Problem sets/Chapter one.task.md")?.content ?? ""),
    ).toMatchObject({
      "parent task": "[[Sync/Problem sets/Problem sets.task|Problem sets]]",
    });

    const secondResult = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: first, completed: false },
          { task: second, completed: false },
          { task: parent, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );

    expect(secondResult).toMatchObject({ created: 0, moved: 0, unchanged: 3 });
    expect(secondResult.conflicts).toEqual([]);
  });

  it("recursively nests a task that is both a subtask and a parent", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    const grandchild = makeTask("grandchild", {
      content: "Grandchild",
      parentId: child.id,
      project,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: grandchild, completed: false },
          { task: child, completed: false },
          { task: parent, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child/Child.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child/Grandchild.task.md")).toBe(true);
  });

  it("migrates the existing flat projection into parent-task folders without losing user content", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Problem sets", project });
    const child = makeTask("child", {
      content: "Chapter one",
      parentId: parent.id,
      project,
    });
    const syncedAt = "2026-08-12T00:00:00.000Z";
    vault.addFile(
      "Sync/Problem sets.task.md",
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: parent, completed: false },
          project.id,
          testProjectPath(project),
          syncedAt,
          mapping.id,
        ),
        makeManagedBody(parent),
      )}\nParent notes\n`,
    );
    vault.addFile(
      "Sync/Chapter one.task.md",
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: child, completed: false },
          project.id,
          testProjectPath(project),
          syncedAt,
          mapping.id,
        ),
        makeManagedBody(child),
      )}\nChild notes\n`,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt,
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 2 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.get("Sync/Problem sets/Problem sets.task.md")?.content).toContain(
      "Parent notes",
    );
    expect(vault.files.get("Sync/Problem sets/Chapter one.task.md")?.content).toContain(
      "Child notes",
    );
    expect(vault.files.has("Sync/Problem sets.task.md")).toBe(false);
    expect(vault.files.has("Sync/Chapter one.task.md")).toBe(false);
  });

  it("uses stable Todoist-ID markers for same-title parent-task subtrees", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const firstParent = makeTask("parent-a", { content: "Problem sets", project });
    const secondParent = makeTask("parent-b", { content: "Problem sets", project });
    const firstChild = makeTask("child-a", {
      content: "First child",
      parentId: firstParent.id,
      project,
    });
    const secondChild = makeTask("child-b", {
      content: "Second child",
      parentId: secondParent.id,
      project,
    });
    const tasks = [firstParent, secondParent, firstChild, secondChild].map((task) => ({
      task,
      completed: false,
    }));
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks,
      syncedAt: "2026-08-13T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const firstParentPath = firstPaths.get(firstParent.id);
    const secondParentPath = firstPaths.get(secondParent.id);
    const firstParentFolder = parentPathOf(firstParentPath);
    const secondParentFolder = parentPathOf(secondParentPath);

    expect(first).toMatchObject({ created: 4, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(firstParentFolder).toMatch(/^Sync\/Problem sets · t-/u);
    expect(secondParentFolder).toMatch(/^Sync\/Problem sets · t-/u);
    expect(firstParentFolder).not.toBe(secondParentFolder);
    expect(firstParentPath).toBe(`${firstParentFolder}/${basename(firstParentFolder)}.task.md`);
    expect(secondParentPath).toBe(`${secondParentFolder}/${basename(secondParentFolder)}.task.md`);
    expect(firstPaths.get(firstChild.id)).toBe(`${firstParentFolder}/First child.task.md`);
    expect(firstPaths.get(secondChild.id)).toBe(`${secondParentFolder}/Second child.task.md`);
    expect(parseFrontmatter(vault.files.get(firstParentPath ?? "")?.content ?? "")).toMatchObject({
      "task id": firstParent.id,
      content: "Problem sets",
    });
    expect(parseFrontmatter(vault.files.get(secondParentPath ?? "")?.content ?? "")).toMatchObject({
      "task id": secondParent.id,
      content: "Problem sets",
    });
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);

    const second = await adapter.reconcile(
      { ...snapshot, tasks: [...snapshot.tasks].reverse() },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 4 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("moves tasks back to the project folder when their parent relationship is removed", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );
    const independentChild = { ...child, parentId: undefined };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: independentChild, completed: false },
        ],
        syncedAt: "2026-08-13T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 2 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Child.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(false);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(false);
  });

  it("moves a complete subtree and removes its empty old folder when a parent is renamed", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Original parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );
    const renamedParent = { ...parent, content: "Renamed parent" };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: renamedParent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 2 });
    expect(result.conflicts).toEqual([]);
    expect(vault.folders.has("Sync/Original parent")).toBe(false);
    expect(vault.files.has("Sync/Renamed parent/Renamed parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Renamed parent/Child.task.md")).toBe(true);
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Sync/Original parent" }),
    );
  });

  it("trashes an unmanaged parent-folder occupant and creates the canonical subtree in one run", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    vault.folders.add("Sync/Parent");
    const unrelated = vault.addFile("Sync/Parent/User note.md", "Remove from exclusive root\n");

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
      { assertValid: () => undefined, preserveUnmanagedItems: false },
    );

    expect(result).toMatchObject({ created: 2, moved: 0, deleted: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(unrelated.path)).toBe(false);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect([...vault.files.keys()].some((path) => path.includes("Parent (2)"))).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledWith(unrelated);
  });

  it("trashes arbitrary nested files and folders, then remains idempotent", async () => {
    const project = makeProject("root", { name: "Software engineering" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    vault.folders.add("Sync/Junk");
    vault.folders.add("Sync/Junk/Nested");
    vault.addFile("Sync/Junk/Nested/User note.md", "Unmanaged Markdown\n");
    vault.addFile("Sync/Junk/Nested/cache.bin", "Unmanaged binary placeholder\n");
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: parent, completed: false },
        { task: child, completed: false },
      ],
      syncedAt: "2026-08-13T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping, {
      assertValid: () => undefined,
      preserveUnmanagedItems: false,
    });

    expect(first).toMatchObject({ created: 2, moved: 0, deleted: 2 });
    expect(first.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect(vault.files.has("Sync/Junk/Nested/User note.md")).toBe(false);
    expect(vault.files.has("Sync/Junk/Nested/cache.bin")).toBe(false);
    expect(vault.folders).toEqual(new Set(["Sync", "Sync/Parent"]));

    vi.clearAllMocks();
    const second = await adapter.reconcile(snapshot, mapping, {
      assertValid: () => undefined,
      preserveUnmanagedItems: false,
    });

    expect(second).toMatchObject({ created: 0, moved: 0, deleted: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
  });

  it("stages a desired task misplaced inside another parent subtree and converges in one run", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", {
      content: "Child",
      parentId: parent.id,
      project,
    });
    const misplaced = makeTask("misplaced", { content: "Independent", project });
    vault.folders.add("Sync/Parent");
    const misplacedFile = vault.addFile(
      "Sync/Parent/Independent.task.md",
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: misplaced, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(misplaced),
      )}\nMisplaced task user body must survive convergence.\n`,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
          { task: misplaced, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 3, moved: 0, deleted: 1 });
    expect(result.conflicts).toEqual([]);
    expect(fileManager.trashFile).toHaveBeenCalledWith(misplacedFile);
    expect(vault.files.has("Sync/Parent/Independent.task.md")).toBe(false);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect(vault.files.get("Sync/Independent.task.md")?.content).toContain(
      "Misplaced task user body must survive convergence.",
    );
    const convergedFrontmatter = parseFrontmatter(
      vault.files.get("Sync/Independent.task.md")?.content ?? "",
    );
    expect(convergedFrontmatter["task id"]).toBe(misplaced.id);
    expect(convergedFrontmatter).not.toHaveProperty("todoist_parent_task_id");
    expect([...vault.files.keys()].some((path) => / \(\d+\)(?:\/|\.task\.md$)/u.test(path))).toBe(
      false,
    );
  });

  it("defers an open misplaced task before exclusive cleanup mutates the mapping", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    const misplaced = makeTask("misplaced", { content: "Independent", project });
    const misplacedPath = "Sync/Parent/Independent.task.md";
    vault.folders.add("Sync/Parent");
    const original = `${renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: misplaced, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(misplaced),
    )}\nOpen task user notes.\n`;
    vault.addFile(misplacedPath, original);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set([misplacedPath]),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
          { task: misplaced, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, deleted: 0, deferred: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: misplaced.id,
        path: misplacedPath,
        deferred: true,
      }),
    ]);
    expect(vault.files.get(misplacedPath)?.content).toBe(original);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
  });

  it("restores an earlier staged task when a later cleanup candidate changes identity", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    const first = makeTask("first", { content: "First", project });
    const second = makeTask("second", { content: "Second", project });
    vault.folders.add("Sync/Parent");
    const makeDocument = (task: typeof first, note: string): string =>
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      )}\n${note}\n`;
    const firstPath = "Sync/Parent/First.task.md";
    const secondPath = "Sync/Parent/Second.task.md";
    const firstContent = makeDocument(first, "First user notes must be restored.");
    vault.addFile(firstPath, firstContent);
    vault.addFile(secondPath, makeDocument(second, "Second user notes."));
    fileManager.beforeTrash = (file) => {
      if (file.path !== firstPath) {
        return;
      }
      const secondEntry = vault.files.get(secondPath);
      if (secondEntry !== undefined) {
        secondEntry.content = secondEntry.content.replace(
          "task id: second",
          "task id: changed-during-cleanup",
        );
      }
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
          { task: first, completed: false },
          { task: second, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: second.id,
        path: secondPath,
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.get(firstPath)?.content).toBe(firstContent);
    expect(vault.files.get(secondPath)?.content).toContain("changed-during-cleanup");
    expect(vault.files.has("Sync/First.task.md")).toBe(false);
    expect(vault.files.has("Sync/Second.task.md")).toBe(false);
  });

  it("reuses but does not claim a raced user folder that gains an unmanaged descendant", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    vault.beforeCreateFolder = (path) => {
      vault.beforeCreateFolder = undefined;
      vault.folders.add(path);
      vault.addFile(`${path}/Arrived from Sync.md`, "Concurrent inbound file\n");
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 2, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.get("Sync/Parent/Arrived from Sync.md")?.content).toBe(
      "Concurrent inbound file\n",
    );
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([]);
  });

  it("does not claim a newly created folder whose live folder identity is replaced before recording", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    let replaced = false;

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-17T12:00:00.000Z",
      },
      mapping,
      {
        assertValid: () => {
          if (!replaced && vault.folders.has("Sync/Parent")) {
            replaced = true;
            vault.replaceFolderIdentity("Sync/Parent");
          }
        },
      },
    );

    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([]);
  });

  it("records a successfully created folder before propagating run invalidation", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    let invalidated = false;

    await expect(
      adapter.reconcile(
        {
          rootProjectId: project.id,
          projects: [project],
          tasks: [
            { task: parent, completed: false },
            { task: child, completed: false },
          ],
          syncedAt: "2026-08-17T12:00:00.000Z",
        },
        mapping,
        {
          assertValid: () => {
            if (!invalidated && vault.folders.has("Sync/Parent")) {
              invalidated = true;
              throw new Error("run invalidated after folder creation");
            }
          },
        },
      ),
    ).rejects.toThrow("run invalidated after folder creation");

    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ ownerId: parent.id, path: "Sync/Parent" }),
    ]);
  });

  it("does not trash an empty obsolete folder after it gains a descendant", async () => {
    const project = makeProject("root", { name: "Root" });
    vault.folders.add("Sync/Obsolete");
    let injected = false;
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
      async <T>(affectedPaths: readonly string[], operation: () => Promise<T>): Promise<T> => {
        if (!injected && affectedPaths.length === 1 && affectedPaths[0] === "Sync/Obsolete") {
          injected = true;
          vault.addFile("Sync/Obsolete/Arrived from Sync.md", "Concurrent inbound file\n");
        }
        return await operation();
      },
      catalogStorage,
      folderOwnershipStorage,
    );
    await folderOwnershipStorage.recordCreatedFolder({
      mappingId: mapping.id,
      rootProjectId: project.id,
      ownerKind: "project",
      ownerId: "obsolete-project",
      path: "Sync/Obsolete",
    });

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result.conflicts).toEqual([]);
    expect(vault.folders.has("Sync/Obsolete")).toBe(true);
    expect(vault.files.get("Sync/Obsolete/Arrived from Sync.md")?.content).toBe(
      "Concurrent inbound file\n",
    );
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "Sync/Obsolete" }),
    );
  });

  it("preserves an owned folder when the raw adapter sees content missing from the Vault index", async () => {
    const project = makeProject("root", { name: "Root" });
    vault.folders.add("Sync/Obsolete");
    vault.adapter.list.mockResolvedValue({
      files: ["Sync/Obsolete/Arriving.base"],
      folders: [],
    });
    await folderOwnershipStorage.recordCreatedFolder({
      mappingId: mapping.id,
      rootProjectId: project.id,
      ownerKind: "project",
      ownerId: "obsolete-project",
      path: "Sync/Obsolete",
    });

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result.conflicts).toEqual([]);
    expect(vault.folders.has("Sync/Obsolete")).toBe(true);
    expect(folderOwnershipStorage.listOwnedFolders(mapping.id)).toEqual([
      expect.objectContaining({ path: "Sync/Obsolete" }),
    ]);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "Sync/Obsolete" }),
    );
  });

  it("keeps cyclic and cross-project parent references at their project roots", async () => {
    const root = makeProject("root", { name: "Root" });
    const childProject = makeProject("child-project", { name: "Child project", parentId: root.id });
    const first = makeTask("first", { content: "First", parentId: "second", project: root });
    const second = makeTask("second", { content: "Second", parentId: first.id, project: root });
    const crossProject = makeTask("cross", {
      content: "Cross project",
      parentId: first.id,
      project: childProject,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, childProject],
        tasks: [
          { task: first, completed: false },
          { task: second, completed: false },
          { task: crossProject, completed: false },
        ],
        syncedAt: "2026-08-13T00:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/First.task.md")).toBe(true);
    expect(vault.files.has("Sync/Second.task.md")).toBe(true);
    expect(vault.files.has("Sync/Child project/Cross project.task.md")).toBe(true);
  });

  it("scopes every Vault mutation to its exact affected paths", async () => {
    const affectedPathSets: string[][] = [];
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
      async <T>(affectedPaths: readonly string[], operation: () => Promise<T>): Promise<T> => {
        affectedPathSets.push([...affectedPaths]);
        return await operation();
      },
    );
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const original = makeTask("task", { content: "Original", project: child });

    await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [{ task: original, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(affectedPathSets).toContainEqual(["Sync/Child"]);
    expect(affectedPathSets).toContainEqual(["Sync/Child/Original.task.md"]);

    affectedPathSets.length = 0;
    const renamed = makeTask("task", { content: "Renamed", project: child });
    await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [{ task: renamed, completed: false }],
        syncedAt: "2026-08-10T00:01:00.000Z",
      },
      mapping,
    );

    expect(affectedPathSets).toContainEqual(["Sync/Child/Original.task.md"]);
    expect(affectedPathSets).toContainEqual([
      "Sync/Child/Original.task.md",
      "Sync/Child/Renamed.task.md",
    ]);
  });

  it("backfills Bases task metadata in an existing managed note", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const task = {
      ...makeTask("task-1", { content: "Task", project: child }),
      description: "Task description",
    };
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      root.id,
      testProjectPath(root, child),
      "2026-08-09T00:00:00.000Z",
      mapping.id,
    );
    delete frontmatter.description;
    frontmatter.user_property = "keep me";
    vault.folders.add("Sync/Child");
    vault.addFile(
      "Sync/Child/Task.task.md",
      renderNewTaskDocument(frontmatter, makeManagedBody(task)),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 1, moved: 0 });
    expect(
      parseFrontmatter(vault.files.get("Sync/Child/Task.task.md")?.content ?? ""),
    ).toMatchObject({
      description: "Task description",
      "project path": ["Root", "Child"],
      user_property: "keep me",
    });
  });

  it("replaces a matching local completion occurrence with Todoist's canonical event", async () => {
    const root = makeProject("root", { name: "Root" });
    const task = makeTask("task-1", { content: "Task", project: root });
    const localEvent = {
      id: "local:event",
      taskId: task.id,
      projectId: root.id,
      completedAt: "2026-08-10T01:00:00.000Z",
    };
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      root.id,
      testProjectPath(root),
      "2026-08-10T01:00:00.000Z",
      mapping.id,
      [localEvent],
    );
    vault.addFile("Sync/Task.task.md", renderNewTaskDocument(frontmatter, makeManagedBody(task)));
    const canonicalEvent = {
      id: "canonical-event",
      taskId: task.id,
      projectId: root.id,
      completedAt: "2026-08-10T01:00:01.000Z",
    };

    await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root],
        tasks: [{ task, completed: false }],
        completionEvents: [canonicalEvent],
        syncedAt: "2026-08-10T02:00:00.000Z",
      },
      mapping,
    );

    expect(catalogStorage.getCatalog(mapping.id)?.completionEvents).toEqual([canonicalEvent]);
    expect(
      parseFrontmatter(vault.files.get("Sync/Task.task.md")?.content ?? ""),
    ).not.toHaveProperty("todoist_completion_events");
  });

  it("keeps updated projections parseable across repeated syncs instead of creating copies", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("task-1", { content: "Task", project });
    const path = "Sync/Task.task.md";
    vault.addFile(
      path,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: originalTask, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(originalTask),
      ),
    );
    const changedTask = { ...originalTask, description: "Updated" };
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task: changedTask, completed: false }],
      syncedAt: "2026-08-12T01:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const second = await adapter.reconcile(snapshot, mapping);

    expect(first).toMatchObject({ created: 0, updated: 1 });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(vault.files.size).toBe(1);
    expect(vault.files.has("Sync/Task (2).task.md")).toBe(false);
    expect(vault.files.get(path)?.content).toContain(
      `\n---\n<!-- todoist-sync-plus:managed:start -->`,
    );
    expect(parseFrontmatter(vault.files.get(path)?.content ?? "")).toMatchObject({
      "task id": originalTask.id,
      description: "Updated",
    });
  });

  it("renames a legacy ID-suffixed note on the next sync without losing user content", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("6grv4CPC4VRF9MVj", {
      content: "国企求职老师沟通",
      project,
    });
    const oldPath = "Sync/国企求职老师沟通 -- 6grv4CPC4VRF9MVj.md";
    const newPath = "Sync/国企求职老师沟通.task.md";
    const oldFile = vault.addFile(
      oldPath,
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      )}\nUser-authored notes stay here.\n`,
    );
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);

    expect(first).toMatchObject({ created: 0, moved: 1 });
    expect(first.conflicts).toEqual([]);
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.get(newPath)?.file).toBe(oldFile);
    expect(vault.files.get(newPath)?.content).toContain("User-authored notes stay here.");
    expect(parseFrontmatter(vault.files.get(newPath)?.content ?? "")).toMatchObject({
      "task id": task.id,
      content: task.content,
    });

    const second = await adapter.reconcile(snapshot, mapping);

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 1 });
    expect(second.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(newPath)?.file).toBe(oldFile);
  });

  it.each([
    ["exact", "Same title", "Same title"],
    ["case-insensitive", "Same title", "same title"],
    ["Unicode-normalized", "Café", "Cafe\u0301"],
    ["sanitized", "A/B", "A:B"],
    ["truncated", `${"x".repeat(250)}A`, `${"x".repeat(250)}B`],
  ])("mirrors remote %s leaf-title collisions with deterministic Todoist-ID markers", async (_kind, firstTitle, secondTitle) => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("6g7v4J39V9jhMw2Q", { content: firstTitle, project });
    const secondTask = makeTask("6g7v4JPmg6Q8QXCQ", { content: secondTitle, project });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: firstTask, completed: false },
        { task: secondTask, completed: true },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const firstPath = firstPaths.get(firstTask.id);
    const secondPath = firstPaths.get(secondTask.id);

    expect(first).toMatchObject({ created: 2, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(firstPath).toMatch(/^Sync\/.+ · t-[^/]+\.task\.md$/u);
    expect(secondPath).toMatch(/^Sync\/.+ · t-[^/]+\.task\.md$/u);
    expect(firstPath).not.toBe(secondPath);
    expect(
      new Set(
        [firstPath, secondPath].map((path) => path?.normalize("NFC").toLocaleLowerCase("en-US")),
      ).size,
    ).toBe(2);
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);
    expect(parseFrontmatter(vault.files.get(firstPath ?? "")?.content ?? "")).toMatchObject({
      "task id": firstTask.id,
      content: firstTitle,
      completed: false,
    });
    expect(parseFrontmatter(vault.files.get(secondPath ?? "")?.content ?? "")).toMatchObject({
      "task id": secondTask.id,
      content: secondTitle,
      completed: true,
    });

    const second = await adapter.reconcile(
      { ...snapshot, tasks: [...snapshot.tasks].reverse() },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("uses readable UTC creation times before task IDs for duplicate titles", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("first-task", {
      content: "Review",
      createdAt: "2026-08-17T06:32:05.000Z",
      project,
    });
    const secondTask = makeTask("second-task", {
      content: "Review",
      createdAt: "2026-08-17T14:33:06.123+08:00",
      project,
    });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: firstTask, completed: false },
        { task: secondTask, completed: false },
      ],
      syncedAt: "2026-08-17T07:00:00.000Z",
    };

    const result = await adapter.reconcile(snapshot, mapping);

    expect(result.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(
      new Map([
        [firstTask.id, "Sync/Review · 2026-08-17 06.32.05Z.task.md"],
        [secondTask.id, "Sync/Review · 2026-08-17 06.33.06.123Z.task.md"],
      ]),
    );
    expect([...vault.files.keys()].every((path) => !path.includes(" · t-"))).toBe(true);
  });

  it("adds a short task ID only when normalized creation times are still identical", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("first-task", {
      content: "Review",
      createdAt: "2026-08-17T06:32:05.000Z",
      project,
    });
    const secondTask = makeTask("second-task", {
      content: "Review",
      createdAt: "2026-08-17T14:32:05+08:00",
      project,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: firstTask, completed: false },
          { task: secondTask, completed: false },
        ],
        syncedAt: "2026-08-17T07:00:00.000Z",
      },
      mapping,
    );
    const paths = managedPathsByTaskId(vault);

    expect(result.conflicts).toEqual([]);
    expect(paths.get(firstTask.id)).toMatch(
      /^Sync\/Review · 2026-08-17 06\.32\.05Z · t-[^/]+\.task\.md$/u,
    );
    expect(paths.get(secondTask.id)).toMatch(
      /^Sync\/Review · 2026-08-17 06\.32\.05Z · t-[^/]+\.task\.md$/u,
    );
    expect(paths.get(firstTask.id)).not.toBe(paths.get(secondTask.id));
  });

  it("keeps existing short-ID paths stable when a same-prefix same-time task joins", async () => {
    const project = makeProject("root", { name: "Root" });
    const createdAt = "2026-08-17T06:32:05.000Z";
    const firstTask = makeTask("6g7v4JAaaaaaaaaa", {
      content: "Review",
      createdAt,
      project,
    });
    const secondTask = makeTask("6g7v4JBbbbbbbbbb", {
      content: "Review",
      createdAt,
      project,
    });
    const thirdTask = makeTask("6g7v4JAccccccccc", {
      content: "Review",
      createdAt,
      project,
    });
    const initialSnapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: firstTask, completed: false },
        { task: secondTask, completed: false },
      ],
      syncedAt: "2026-08-17T07:00:00.000Z",
    };

    await adapter.reconcile(initialSnapshot, mapping);
    const initialPaths = managedPathsByTaskId(vault);
    const firstFile = vault.files.get(initialPaths.get(firstTask.id) ?? "")?.file;
    const secondFile = vault.files.get(initialPaths.get(secondTask.id) ?? "")?.file;

    const joined = await adapter.reconcile(
      {
        ...initialSnapshot,
        tasks: [{ task: thirdTask, completed: false }, ...initialSnapshot.tasks],
      },
      mapping,
    );
    const joinedPaths = managedPathsByTaskId(vault);

    expect(joined).toMatchObject({ created: 1, moved: 0 });
    expect(joined.conflicts).toEqual([]);
    expect(joinedPaths.get(firstTask.id)).toBe(initialPaths.get(firstTask.id));
    expect(joinedPaths.get(secondTask.id)).toBe(initialPaths.get(secondTask.id));
    expect(vault.files.get(joinedPaths.get(firstTask.id) ?? "")?.file).toBe(firstFile);
    expect(vault.files.get(joinedPaths.get(secondTask.id) ?? "")?.file).toBe(secondFile);
    expect(joinedPaths.get(thirdTask.id)).toMatch(
      /^Sync\/Review · 2026-08-17 06\.32\.05Z · t-[^/]+\.task\.md$/u,
    );
    expect(new Set(joinedPaths.values()).size).toBe(3);
  });

  it("falls back to typed task IDs instead of displaying missing or invalid creation times", async () => {
    const project = makeProject("root", { name: "Root" });
    const missingTime = makeTask("missing-time", { content: "Review", project });
    const invalidTime = makeTask("invalid-time", {
      authoritativeCreatedAt: "not-a-timestamp",
      content: "Review",
      createdAt: "not-a-timestamp",
      project,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: missingTime, completed: false },
          { task: invalidTime, completed: false },
        ],
        syncedAt: "2026-08-17T07:00:00.000Z",
      },
      mapping,
    );
    const paths = managedPathsByTaskId(vault);

    expect(result.conflicts).toEqual([]);
    expect(paths.get(missingTime.id)).toMatch(/^Sync\/Review · t-[^/]+\.task\.md$/u);
    expect(paths.get(invalidTime.id)).toMatch(/^Sync\/Review · t-[^/]+\.task\.md$/u);
    expect([...paths.values()].every((path) => !path.includes("1970"))).toBe(true);
  });

  it.each([
    ["offset-less", "2026-08-17T06:32:05"],
    ["date-only", "2026-08-17"],
    ["impossible", "2026-02-30T06:32:05Z"],
    ["whitespace-padded", " 2026-08-17T06:32:05Z "],
    ["Unix-epoch", "1970-01-01T00:00:00.000Z"],
  ])("uses a typed task ID for a remote %s creation timestamp", async (_kind, createdAt) => {
    const project = makeProject("root", { name: "Root" });
    const candidate = makeTask("candidate-time", {
      authoritativeCreatedAt: createdAt,
      content: "Review",
      createdAt,
      project,
    });
    const other = makeTask("other-time", { content: "Review", project });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: other, completed: false },
          { task: candidate, completed: false },
        ],
        syncedAt: "2026-08-17T07:00:00.000Z",
      },
      mapping,
    );
    const candidatePath = managedPathsByTaskId(vault).get(candidate.id);

    expect(result.conflicts).toEqual([]);
    expect(candidatePath).toMatch(/^Sync\/Review · t-[^/]+\.task\.md$/u);
    expect(candidatePath).not.toContain("2026-");
    expect(candidatePath).not.toContain("1970-");
  });

  it("allocates creation-time paths identically in fresh Vaults regardless of snapshot order", async () => {
    const project = makeProject("root", { name: "Root" });
    const tasks = [
      makeTask("first-task", {
        content: "Review",
        createdAt: "2026-08-17T06:32:05.000Z",
        project,
      }),
      makeTask("second-task", {
        content: "Review",
        createdAt: "2026-08-17T06:33:05.000Z",
        project,
      }),
    ];
    const reconcileFresh = async (orderedTasks: typeof tasks): Promise<Map<string, string>> => {
      const freshVault = new FakeVault();
      const freshFileManager = new FakeFileManager(freshVault);
      const freshAdapter = new ObsidianProjectSyncVault(
        freshVault as unknown as Vault,
        freshFileManager as unknown as FileManager,
        () => new Set(),
        undefined,
        new FakeCatalogStorage(),
      );
      await freshAdapter.reconcile(
        {
          rootProjectId: project.id,
          projects: [project],
          tasks: orderedTasks.map((task) => ({ task, completed: false })),
          syncedAt: "2026-08-17T07:00:00.000Z",
        },
        mapping,
      );
      return managedPathsByTaskId(freshVault);
    };

    const forward = await reconcileFresh(tasks);
    const reversed = await reconcileFresh([...tasks].reverse());

    expect(reversed).toEqual(forward);
  });

  it("disambiguates a natural title that resembles a generated creation-time path", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("first-task", {
      content: "Review",
      createdAt: "2026-08-17T06:32:05.000Z",
      project,
    });
    const secondTask = makeTask("second-task", {
      content: "Review",
      createdAt: "2026-08-17T06:33:05.000Z",
      project,
    });
    const naturalTitleTask = makeTask("natural-title", {
      content: "Review · 2026-08-17 06.32.05Z",
      createdAt: "2026-08-17T06:34:05.000Z",
      project,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: naturalTitleTask, completed: false },
          { task: secondTask, completed: false },
          { task: firstTask, completed: false },
        ],
        syncedAt: "2026-08-17T07:00:00.000Z",
      },
      mapping,
    );
    const paths = managedPathsByTaskId(vault);

    expect(result.conflicts).toEqual([]);
    expect(new Set(paths.values()).size).toBe(3);
    expect(paths.get(firstTask.id)).toBe("Sync/Review · 2026-08-17 06.32.05Z.task.md");
    expect(paths.get(naturalTitleTask.id)).toBe(
      "Sync/Review · 2026-08-17 06.32.05Z · 2026-08-17 06.34.05Z.task.md",
    );
  });

  it("disambiguates same-name sibling projects and a same-name parent task by typed IDs", async () => {
    const root = makeProject("root", { name: "Root" });
    const firstProject = makeProject("project-alpha", { name: "Area", parentId: root.id });
    const secondProject = makeProject("project-beta", { name: "Area", parentId: root.id });
    const firstProjectTask = makeTask("first-project-task", {
      content: "First project task",
      project: firstProject,
    });
    const secondProjectTask = makeTask("second-project-task", {
      content: "Second project task",
      project: secondProject,
    });
    const parentTask = makeTask("parent-task", { content: "Area", project: root });
    const childTask = makeTask("child-task", {
      content: "Parent child",
      parentId: parentTask.id,
      project: root,
    });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, secondProject, firstProject],
      tasks: [
        { task: childTask, completed: false },
        { task: secondProjectTask, completed: false },
        { task: parentTask, completed: false },
        { task: firstProjectTask, completed: false },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const firstProjectFolder = parentPathOf(firstPaths.get(firstProjectTask.id));
    const secondProjectFolder = parentPathOf(firstPaths.get(secondProjectTask.id));
    const parentTaskFolder = parentPathOf(firstPaths.get(parentTask.id));

    expect(first).toMatchObject({ created: 4, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(firstProjectFolder).toMatch(/^Sync\/Area · p-/u);
    expect(secondProjectFolder).toMatch(/^Sync\/Area · p-/u);
    expect(parentTaskFolder).toMatch(/^Sync\/Area · t-/u);
    expect(new Set([firstProjectFolder, secondProjectFolder, parentTaskFolder]).size).toBe(3);
    expect(firstPaths.get(childTask.id)).toBe(`${parentTaskFolder}/Parent child.task.md`);
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);

    const second = await adapter.reconcile(
      {
        ...snapshot,
        projects: [...snapshot.projects].reverse(),
        tasks: [...snapshot.tasks].reverse(),
      },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 4 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("uses project and task creation times for cross-kind sibling collisions", async () => {
    const root = makeProject("root", { name: "Root" });
    const firstProject = makeProject("project-alpha", {
      createdAt: "2026-08-17T06:10:00.000Z",
      name: "Area",
      parentId: root.id,
    });
    const secondProject = makeProject("project-beta", {
      createdAt: "2026-08-17T06:11:00.000Z",
      name: "Area",
      parentId: root.id,
    });
    const firstProjectTask = makeTask("first-project-task", {
      content: "First project task",
      project: firstProject,
    });
    const secondProjectTask = makeTask("second-project-task", {
      content: "Second project task",
      project: secondProject,
    });
    const parentTask = makeTask("parent-task", {
      content: "Area",
      createdAt: "2026-08-17T06:12:00.000Z",
      project: root,
    });
    const childTask = makeTask("child-task", {
      content: "Parent child",
      parentId: parentTask.id,
      project: root,
    });

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, secondProject, firstProject],
        tasks: [
          { task: childTask, completed: false },
          { task: secondProjectTask, completed: false },
          { task: parentTask, completed: false },
          { task: firstProjectTask, completed: false },
        ],
        syncedAt: "2026-08-17T07:00:00.000Z",
      },
      mapping,
    );
    const paths = managedPathsByTaskId(vault);

    expect(result.conflicts).toEqual([]);
    expect(parentPathOf(paths.get(firstProjectTask.id))).toBe("Sync/Area · 2026-08-17 06.10.00Z");
    expect(parentPathOf(paths.get(secondProjectTask.id))).toBe("Sync/Area · 2026-08-17 06.11.00Z");
    expect(parentPathOf(paths.get(parentTask.id))).toBe("Sync/Area · 2026-08-17 06.12.00Z");
  });

  it("uses typed project and task IDs when cross-kind creation times normalize identically", async () => {
    const root = makeProject("root", { name: "Root" });
    const childProject = makeProject("project-area", {
      createdAt: "2026-08-17T06:10:00.000Z",
      name: "Area",
      parentId: root.id,
    });
    const projectTask = makeTask("project-child", {
      content: "Project child",
      project: childProject,
    });
    const parentTask = makeTask("task-area", {
      content: "Area",
      createdAt: "2026-08-17T14:10:00+08:00",
      project: root,
    });
    const taskChild = makeTask("task-child", {
      content: "Task child",
      parentId: parentTask.id,
      project: root,
    });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, childProject],
      tasks: [
        { task: taskChild, completed: false },
        { task: projectTask, completed: false },
        { task: parentTask, completed: false },
      ],
      syncedAt: "2026-08-17T07:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const projectFolder = parentPathOf(firstPaths.get(projectTask.id));
    const taskFolder = parentPathOf(firstPaths.get(parentTask.id));

    expect(first.conflicts).toEqual([]);
    expect(projectFolder).toMatch(/^Sync\/Area · 2026-08-17 06\.10\.00Z · p-[^/]+$/u);
    expect(taskFolder).toMatch(/^Sync\/Area · 2026-08-17 06\.10\.00Z · t-[^/]+$/u);
    expect(projectFolder).not.toBe(taskFolder);
    expect(firstPaths.get(projectTask.id)).toBe(`${projectFolder}/Project child.task.md`);
    expect(firstPaths.get(taskChild.id)).toBe(`${taskFolder}/Task child.task.md`);

    const second = await adapter.reconcile(
      {
        ...snapshot,
        projects: [...snapshot.projects].reverse(),
        tasks: [...snapshot.tasks].reverse(),
      },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 3 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("marks both a parent self-note and its same-title direct child", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent-identity", { content: "Alpha", project });
    const child = makeTask("child-identity", {
      content: "Alpha",
      parentId: parent.id,
      project,
    });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: child, completed: false },
        { task: parent, completed: false },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const parentPath = firstPaths.get(parent.id);
    const parentFolder = parentPathOf(parentPath);
    const childPath = firstPaths.get(child.id);

    expect(first).toMatchObject({ created: 2, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(parentFolder).toMatch(/^Sync\/Alpha · t-/u);
    expect(parentPath).toBe(`${parentFolder}/${basename(parentFolder)}.task.md`);
    expect(childPath?.startsWith(`${parentFolder}/Alpha · t-`)).toBe(true);
    expect(childPath?.endsWith(".task.md")).toBe(true);
    expect(childPath).not.toBe(parentPath);
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);

    const second = await adapter.reconcile(
      { ...snapshot, tasks: [...snapshot.tasks].reverse() },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("uses typed markers for a child-project folder that collides with a leaf-task file", async () => {
    const root = makeProject("root", { name: "Root" });
    const childProject = makeProject("child-project", {
      name: "Alpha.task.md",
      parentId: root.id,
    });
    const rootTask = makeTask("root-task", { content: "Alpha", project: root });
    const childProjectTask = makeTask("child-project-task", {
      content: "Inside",
      project: childProject,
    });
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, childProject],
      tasks: [
        { task: rootTask, completed: false },
        { task: childProjectTask, completed: false },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const firstPaths = managedPathsByTaskId(vault);
    const rootTaskPath = firstPaths.get(rootTask.id);
    const projectFolder = parentPathOf(firstPaths.get(childProjectTask.id));

    expect(first).toMatchObject({ created: 2, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(rootTaskPath).toMatch(/^Sync\/Alpha · t-[^/]+\.task\.md$/u);
    expect(projectFolder).toMatch(/^Sync\/Alpha\.task\.md · p-/u);
    expect(firstPaths.get(childProjectTask.id)).toBe(`${projectFolder}/Inside.task.md`);
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);

    const second = await adapter.reconcile(
      {
        ...snapshot,
        projects: [...snapshot.projects].reverse(),
        tasks: [...snapshot.tasks].reverse(),
      },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(managedPathsByTaskId(vault)).toEqual(firstPaths);
  });

  it("migrates legacy plain and numbered same-title notes without losing any user region", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("6g7v4J39V9jhMw2Q", { content: "Diagram", project });
    const secondTask = makeTask("6g7v4JPmg6Q8QXCQ", { content: "Diagram", project });
    const thirdTask = makeTask("6g7v4JQXhQJcX9m", { content: "Diagram", project });
    const makeLegacyDocument = (task: typeof firstTask, userNotes: string): string =>
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      )}\n${userNotes}\n`;
    vault.addFile("Sync/Diagram.task.md", makeLegacyDocument(firstTask, "First user region"));
    vault.addFile("Sync/Diagram (2).task.md", makeLegacyDocument(secondTask, "Second user region"));
    vault.addFile("Sync/Diagram (3).task.md", makeLegacyDocument(thirdTask, "Third user region"));

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: secondTask, completed: false },
          { task: thirdTask, completed: false },
          { task: firstTask, completed: false },
        ],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );
    const paths = managedPathsByTaskId(vault);
    const firstPath = paths.get(firstTask.id);
    const secondPath = paths.get(secondTask.id);
    const thirdPath = paths.get(thirdTask.id);

    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Diagram.task.md")).toBe(false);
    expect(vault.files.has("Sync/Diagram (2).task.md")).toBe(false);
    expect(vault.files.has("Sync/Diagram (3).task.md")).toBe(false);
    expect(firstPath).toMatch(/^Sync\/Diagram · t-[^/]+\.task\.md$/u);
    expect(secondPath).toMatch(/^Sync\/Diagram · t-[^/]+\.task\.md$/u);
    expect(thirdPath).toMatch(/^Sync\/Diagram · t-[^/]+\.task\.md$/u);
    expect(vault.files.get(firstPath ?? "")?.content).toContain("First user region");
    expect(vault.files.get(secondPath ?? "")?.content).toContain("Second user region");
    expect(vault.files.get(thirdPath ?? "")?.content).toContain("Third user region");
    expect(parseFrontmatter(vault.files.get(firstPath ?? "")?.content ?? "")).toMatchObject({
      "task id": firstTask.id,
      content: firstTask.content,
    });
    expect(parseFrontmatter(vault.files.get(secondPath ?? "")?.content ?? "")).toMatchObject({
      "task id": secondTask.id,
      content: secondTask.content,
    });
    expect(parseFrontmatter(vault.files.get(thirdPath ?? "")?.content ?? "")).toMatchObject({
      "task id": thirdTask.id,
      content: thirdTask.content,
    });
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);
  });

  it("migrates current ID-only duplicate paths to creation-time paths without losing user text", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("first-task", {
      content: "Review",
      createdAt: "2026-08-17T06:32:05.000Z",
      project,
    });
    const secondTask = makeTask("second-task", {
      content: "Review",
      createdAt: "2026-08-17T06:33:05.000Z",
      project,
    });
    const addOldProjection = (path: string, task: typeof firstTask, userText: string): FakeFile =>
      vault.addFile(
        path,
        `${renderNewTaskDocument(
          makeTaskFrontmatter(
            { task, completed: false },
            project.id,
            testProjectPath(project),
            "2026-08-16T00:00:00.000Z",
            mapping.id,
          ),
          makeManagedBody(task),
        )}\n${userText}\n`,
      );
    const firstOldFile = addOldProjection(
      "Sync/Review · t-first.task.md",
      firstTask,
      "First user text",
    );
    const secondOldFile = addOldProjection(
      "Sync/Review · t-second.task.md",
      secondTask,
      "Second user text",
    );
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: secondTask, completed: false },
        { task: firstTask, completed: false },
      ],
      syncedAt: "2026-08-17T07:00:00.000Z",
    };

    const result = await adapter.reconcile(snapshot, mapping);
    const firstPath = "Sync/Review · 2026-08-17 06.32.05Z.task.md";
    const secondPath = "Sync/Review · 2026-08-17 06.33.05Z.task.md";

    expect(result).toMatchObject({ created: 0, moved: 2 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has("Sync/Review · t-first.task.md")).toBe(false);
    expect(vault.files.has("Sync/Review · t-second.task.md")).toBe(false);
    expect(vault.files.get(firstPath)?.file).toBe(firstOldFile);
    expect(vault.files.get(secondPath)?.file).toBe(secondOldFile);
    expect(vault.files.get(firstPath)?.content).toContain("First user text");
    expect(vault.files.get(secondPath)?.content).toContain("Second user text");
    expect(parseFrontmatter(vault.files.get(firstPath)?.content ?? "")["task id"]).toBe(
      firstTask.id,
    );
    expect(parseFrontmatter(vault.files.get(secondPath)?.content ?? "")["task id"]).toBe(
      secondTask.id,
    );

    vi.clearAllMocks();
    const second = await adapter.reconcile(snapshot, mapping);

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(vault.files.get(firstPath)?.file).toBe(firstOldFile);
    expect(vault.files.get(secondPath)?.file).toBe(secondOldFile);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("moves the same task note into and out of a remote collision group", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("first-task", { content: "Review", project });
    const secondTask = makeTask("second-task", { content: "Review", project });
    const firstSnapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task: firstTask, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };
    await adapter.reconcile(firstSnapshot, mapping);
    const plainPath = "Sync/Review.task.md";
    const firstFile = vault.files.get(plainPath)?.file;
    const plainContent = vault.files.get(plainPath)?.content ?? "";
    vault.files.set(plainPath, {
      file: firstFile as FakeFile,
      content: `${plainContent}\nPersistent user notes\n`,
    });

    const collisionSnapshot: ProjectSyncSnapshot = {
      ...firstSnapshot,
      tasks: [
        { task: secondTask, completed: false },
        { task: firstTask, completed: false },
      ],
    };
    const joined = await adapter.reconcile(collisionSnapshot, mapping);
    const joinedPaths = managedPathsByTaskId(vault);
    const markedFirstPath = joinedPaths.get(firstTask.id);

    expect(joined).toMatchObject({ created: 1, moved: 1 });
    expect(markedFirstPath).toMatch(/^Sync\/Review · t-/u);
    expect(vault.files.get(markedFirstPath ?? "")?.file).toBe(firstFile);
    expect(vault.files.get(markedFirstPath ?? "")?.content).toContain("Persistent user notes");

    const separated = await adapter.reconcile(firstSnapshot, mapping);

    expect(separated).toMatchObject({ created: 0, moved: 1, deleted: 1 });
    expect(separated.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(plainPath)?.file).toBe(firstFile);
    expect(vault.files.get(plainPath)?.content).toContain("Persistent user notes");
    expect([...vault.files.keys()].some(hasNumberedCollisionSuffix)).toBe(false);
  });

  it("allows equal child titles under different parent-task folders and remains idempotent", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstParent = makeTask("parent-a", { content: "First parent", project });
    const secondParent = makeTask("parent-b", { content: "Second parent", project });
    const firstTask = makeTask("task-a", {
      content: "Same title",
      parentId: firstParent.id,
      project,
    });
    const secondTask = makeTask("task-b", {
      content: "Same title",
      parentId: secondParent.id,
      project,
    });
    const firstSnapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: firstParent, completed: false },
        { task: secondParent, completed: false },
        { task: firstTask, completed: false },
        { task: secondTask, completed: false },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(firstSnapshot, mapping);

    expect(first).toMatchObject({ created: 4, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(
      parseFrontmatter(vault.files.get("Sync/First parent/Same title.task.md")?.content ?? "")[
        "task id"
      ],
    ).toBe(firstTask.id);
    expect(
      parseFrontmatter(vault.files.get("Sync/Second parent/Same title.task.md")?.content ?? "")[
        "task id"
      ],
    ).toBe(secondTask.id);
    expect(vault.files.size).toBe(4);

    const second = await adapter.reconcile(
      { ...firstSnapshot, tasks: [...firstSnapshot.tasks].reverse() },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 4 });
    expect(second.conflicts).toEqual([]);
    expect([...vault.files.keys()].some((path) => / \(\d+\)(?:\/|\.task\.md$)/u.test(path))).toBe(
      false,
    );
  });

  it("preserves every duplicate when conflicting properties arrive after the initial scan", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("duplicate-conflict", { content: "Task", project });
    const document = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T00:00:00.000Z",
      ),
      makeManagedBody(task),
    );
    const canonicalPath = "Sync/Task.task.md";
    const duplicatePath = "Sync/Task copy.md";
    vault.addFile(canonicalPath, document);
    vault.addFile(duplicatePath, document);
    const conflicting = document.replace(
      "status: active",
      "status: active\ntodoist_status: completed",
    );
    vault.beforeProcess = () => {
      const entry = vault.files.get(canonicalPath);
      if (entry !== undefined) {
        entry.content = conflicting;
      }
      vault.beforeProcess = undefined;
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ message: expect.stringContaining("conflicting task properties") }),
    ]);
    expect(vault.files.get(canonicalPath)?.content).toBe(conflicting);
    expect(vault.files.get(duplicatePath)?.content).toBe(document);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(vault.files.size).toBe(2);
  });

  it("rebuilds a clean canonical projection and trashes equivalent same-ID copies", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = {
      ...makeTask("duplicate-task", { content: "Task", project }),
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const oldFrontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-12T00:01:00.000Z",
      mapping.id,
    );
    oldFrontmatter.user_property = "preserved";
    const canonicalPath = "Sync/Task.task.md";
    const duplicatePath = "Sync/Task (2).task.md";
    const generatedResidue = `'todoist_updated_at: '${task.updatedAt}'\n---`;
    vault.addFile(
      canonicalPath,
      `${renderNewTaskDocument(oldFrontmatter, makeManagedBody(task)).replace(
        `\n${makeManagedBody(task)}`,
        `${generatedResidue}${makeManagedBody(task)}`,
      )}\nUser notes\n`,
    );
    vault.addFile(
      duplicatePath,
      `${renderNewTaskDocument(oldFrontmatter, makeManagedBody(task))}\nUser notes\n`,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 1, moved: 0, unchanged: 0 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(canonicalPath)).toBe(true);
    expect(vault.files.has(duplicatePath)).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: duplicatePath }),
    );
    const repaired = vault.files.get(canonicalPath)?.content ?? "";
    expect(repaired).not.toContain(generatedResidue);
    expect(repaired).toContain("user_property: preserved");
    expect(repaired).toContain("\nUser notes\n");
  });

  it("recovers the exact legacy joined frontmatter boundary before consolidating a copy", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("joined-boundary", { content: "Task", project });
    const document = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    const malformed = document.replace(
      `\n---\n<!-- todoist-sync-plus:managed:start -->`,
      `\n---<!-- todoist-sync-plus:managed:start -->`,
    );
    expect(frontmatterInfo(malformed).exists).toBe(false);
    vault.addFile("Sync/Task.task.md", malformed);
    vault.addFile("Sync/Task (2).task.md", document);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.has("Sync/Task (2).task.md")).toBe(false);
    const repaired = vault.files.get("Sync/Task.task.md")?.content ?? "";
    expect(repaired).toContain(`\n---\n<!-- todoist-sync-plus:managed:start -->`);
    expect(parseFrontmatter(repaired)["task id"]).toBe(task.id);
  });

  it("repairs a malformed canonical note and trashes its valid same-ID Sync copy", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("6hGr78cXw24jQC7W", { content: "WIFI", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-12T00:00:00.000Z",
      mapping.id,
    );
    const valid = renderNewTaskDocument(frontmatter, makeManagedBody(task));
    const malformed = `${valid.replace(
      "completed: false\n",
      "completed: false\ncompleted: completed\n",
    )}\nCanonical user notes\n`;
    const canonicalPath = "Sync/WIFI.task.md";
    const duplicatePath = "Sync/WIFI (2).task.md";
    vault.addFile(canonicalPath, malformed);
    vault.addFile(duplicatePath, valid);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, updated: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.has(canonicalPath)).toBe(true);
    expect(vault.files.has(duplicatePath)).toBe(false);
    expect(parseFrontmatter(vault.files.get(canonicalPath)?.content ?? "")).toMatchObject({
      "task id": task.id,
      completed: false,
    });
    expect(vault.files.get(canonicalPath)?.content).toContain("Canonical user notes");
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: duplicatePath }),
    );
  });

  it("repairs one malformed managed note in place instead of allocating a numbered path", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("recoverable-task", { content: "Task", project });
    const valid = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    const path = "Sync/Task.task.md";
    vault.addFile(path, valid.replace("priority: P4", "priority: [broken"));

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, updated: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.has(path)).toBe(true);
    expect(vault.files.has("Sync/Task (2).task.md")).toBe(false);
    expect(parseFrontmatter(vault.files.get(path)?.content ?? "")["task id"]).toBe(task.id);
  });

  it("trashes every same-ID tracked copy absent from the complete remote snapshot", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("deleted-task", { content: "Deleted task", project });
    const document = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    vault.addFile("Sync/Deleted task.task.md", document);
    vault.addFile("Sync/Deleted task (2).task.md", document);

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ deleted: 2, created: 0, updated: 0 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(0);
    expect(fileManager.trashFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the preferred same-ID note and trashes alternate copies even when user content differs", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("duplicate-task", { content: "Task", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-12T00:01:00.000Z",
      mapping.id,
    );
    const canonicalPath = "Sync/Task.task.md";
    const duplicatePath = "Sync/Task (2).task.md";
    const canonical = renderNewTaskDocument(frontmatter, makeManagedBody(task));
    const duplicate = `${canonical}\nUnique user notes\n`;
    vault.addFile(canonicalPath, canonical);
    vault.addFile(duplicatePath, duplicate);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0, unchanged: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.get(canonicalPath)?.content).toBe(canonical);
    expect(vault.files.has(duplicatePath)).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: duplicatePath }),
    );
  });

  it("preflights every duplicate before writing the canonical projection", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("duplicate-task", { content: "Task", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-12T00:01:00.000Z",
      mapping.id,
    );
    const canonicalPath = "Sync/Task.task.md";
    const duplicatePath = "Sync/Task (2).task.md";
    const document = renderNewTaskDocument(frontmatter, makeManagedBody(task));
    vault.addFile(canonicalPath, document);
    vault.addFile(duplicatePath, document);
    let duplicateReads = 0;
    const originalRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (file) => {
      const content = await originalRead(file);
      if (file.path === duplicatePath) {
        duplicateReads++;
        // Schema preparation reads once, then the shared scan, then duplicate preflight.
        if (duplicateReads === 3) {
          const duplicate = vault.files.get(duplicatePath);
          if (duplicate !== undefined) {
            duplicate.content = duplicate.content.replace(
              "task id: duplicate-task",
              "task id: remotely-changed",
            );
            return duplicate.content;
          }
        }
      }
      return content;
    });

    const before = new Map([...vault.files].map(([path, entry]) => [path, entry.content]));

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({ taskId: task.id, projectionBlocked: true }),
    ]);
    expect(vault.files.get(canonicalPath)?.content).toBe(before.get(canonicalPath));
    expect(vault.files.has(duplicatePath)).toBe(true);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
  });

  it("moves an existing numbered projection to the exact canonical path in one run", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("task-a", { content: "Pre-Review", project });
    const numberedPath = "Sync/Pre-Review (3).task.md";
    const canonicalPath = "Sync/Pre-Review.task.md";
    const numbered = vault.addFile(
      numberedPath,
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:01:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      )}\nUser-authored notes remain attached.\n`,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.has(numberedPath)).toBe(false);
    expect(vault.files.get(canonicalPath)?.file).toBe(numbered);
    expect(vault.files.get(canonicalPath)?.content).toContain(
      "User-authored notes remain attached.",
    );
    expect(fileManager.renameFile).toHaveBeenCalledWith(numbered, canonicalPath);
  });

  it.each([
    "Hadoop",
    "No SQL",
  ])("moves the complete legacy %s (3) parent subtree to canonical paths in one run", async (title) => {
    const project = makeProject("root", { name: "Root" });
    const idSuffix = title.replace(/ /gu, "-").toLowerCase();
    const parent = makeTask(`parent-${idSuffix}`, { content: title, project });
    const child = makeTask(`child-${idSuffix}`, {
      content: "Child task",
      parentId: parent.id,
      project,
    });
    const legacyFolder = `Sync/${title} (3)`;
    vault.folders.add(legacyFolder);
    vault.addFile(
      `${legacyFolder}/${title} (3).task.md`,
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: parent, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:01:00.000Z",
          mapping.id,
        ),
        makeManagedBody(parent),
      )}\nParent user notes.\n`,
    );
    vault.addFile(
      `${legacyFolder}/Child task.task.md`,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: child, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-12T00:01:00.000Z",
          mapping.id,
        ),
        makeManagedBody(child),
      ),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 2 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(`${legacyFolder}/${title} (3).task.md`)).toBe(false);
    expect(vault.files.has(`${legacyFolder}/Child task.task.md`)).toBe(false);
    expect(vault.folders.has(legacyFolder)).toBe(true);
    expect(vault.files.get(`Sync/${title}/${title}.task.md`)?.content).toContain(
      "Parent user notes.",
    );
    expect(vault.files.has(`Sync/${title}/Child task.task.md`)).toBe(true);
    expect([...vault.files.keys()].some((path) => path.includes(`${title} (3)`))).toBe(false);
  });

  it("collapses duplicate same-ID parent subtrees into the canonical folder in one run", async () => {
    const project = makeProject("root", { name: "Root" });
    const parent = makeTask("parent", { content: "Parent", project });
    const child = makeTask("child", { content: "Child", parentId: parent.id, project });
    const parentDocument = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: parent, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:01:00.000Z",
        mapping.id,
      ),
      makeManagedBody(parent),
    );
    const childDocument = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: child, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:01:00.000Z",
        mapping.id,
      ),
      makeManagedBody(child),
    );
    vault.folders.add("Sync/Parent");
    vault.folders.add("Sync/Parent (2)");
    vault.addFile("Sync/Parent/Parent.task.md", parentDocument);
    vault.addFile("Sync/Parent/Child.task.md", childDocument);
    vault.addFile("Sync/Parent (2)/Parent (2).task.md", parentDocument);
    vault.addFile("Sync/Parent (2)/Child.task.md", childDocument);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [
          { task: parent, completed: false },
          { task: child, completed: false },
        ],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.size).toBe(2);
    expect(vault.files.has("Sync/Parent/Parent.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent/Child.task.md")).toBe(true);
    expect(vault.files.has("Sync/Parent (2)/Parent (2).task.md")).toBe(false);
    expect(vault.files.has("Sync/Parent (2)/Child.task.md")).toBe(false);
    expect(vault.folders.has("Sync/Parent (2)")).toBe(true);
  });

  it("stops safely and reports partial cleanup when a later trash operation fails", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("duplicate-task", { content: "Task", project });
    const document = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-12T00:01:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    for (const path of ["Sync/Task.task.md", "Sync/Task (2).task.md", "Sync/Task (3).task.md"]) {
      vault.addFile(path, document);
    }
    let trashAttempt = 0;
    fileManager.beforeTrash = () => {
      trashAttempt++;
      if (trashAttempt === 2) {
        throw new Error("simulated trash failure");
      }
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        projectionBlocked: true,
        message: expect.stringContaining("stopped after moving 1 of 2"),
      }),
    ]);
    expect(vault.files.size).toBe(2);
    expect(vault.files.has("Sync/Task (2).task.md")).toBe(false);
    expect(vault.files.has("Sync/Task (3).task.md")).toBe(true);
  });

  it("renames the same managed note when its Todoist task title changes", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("rename-task", { content: "Original title", project });
    await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: originalTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );
    const originalPath = "Sync/Original title.task.md";
    const originalEntry = vault.files.get(originalPath);
    if (originalEntry === undefined) {
      throw new Error("Expected the original managed note");
    }
    originalEntry.content += "\nUser-authored notes stay here.\n";

    const renamedTask = makeTask(originalTask.id, { content: "Renamed title", project });
    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: renamedTask, completed: false }],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      mapping,
    );

    const renamedPath = "Sync/Renamed title.task.md";
    expect(result).toMatchObject({ created: 0, moved: 1, updated: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(originalPath)).toBe(false);
    expect(vault.files.get(renamedPath)?.file).toBe(originalEntry.file);
    expect(vault.files.get(renamedPath)?.content).toContain(
      makeManagedTaskIdentityMarker("rename-task"),
    );
    expect(vault.files.get(renamedPath)?.content).toContain("User-authored notes stay here.");
    expect(parseFrontmatter(vault.files.get(renamedPath)?.content ?? "")).toMatchObject({
      "task id": originalTask.id,
      content: "Renamed title",
    });
  });

  it.each([
    ["exact", "Sync/Task.task.md", "Task"],
    ["case-insensitive", "Sync/TASK.task.md", "Task"],
    ["Unicode-normalized", "Sync/Cafe\u0301.task.md", "Café"],
  ])("preserves an unmanaged %s canonical-path collision", async (_kind, userPath, title) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("protected-collision", { content: title, project });
    const userFile = vault.addFile(userPath, "User-owned document\n");

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-17T12:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        path: userFile.path,
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.get(userFile.path)?.file).toBe(userFile);
    expect(vault.files.get(userFile.path)?.content).toBe("User-owned document\n");
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(userFile);
    expect([...vault.files.keys()].filter((path) => path !== userFile.path)).toEqual([]);
  });

  it.each([
    ["exact", "Child", "Sync/Child"],
    ["case-insensitive", "Child", "Sync/CHILD"],
    ["Unicode-normalized", "Café", "Sync/Cafe\u0301"],
  ])("blocks only a project subtree when its %s canonical folder is occupied by a user file", async (_kind, childName, occupantPath) => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: childName, parentId: root.id });
    const rootTask = makeTask("root-task", { content: "Root task", project: root });
    const childTask = makeTask("child-task", { content: "Child task", project: child });
    const occupant = vault.addFile(occupantPath, "User-owned file at the folder path\n");

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [
          { task: rootTask, completed: false },
          { task: childTask, completed: false },
        ],
        syncedAt: "2026-08-17T12:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 1, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: occupant.path, projectionBlocked: true }),
    ]);
    expect(vault.files.get(occupant.path)?.file).toBe(occupant);
    expect(vault.files.has("Sync/Root task.task.md")).toBe(true);
    expect(vault.files.has(`Sync/${childName}/Child task.task.md`)).toBe(false);
    expect(fileManager.trashFile).not.toHaveBeenCalledWith(occupant);
  });

  it.each([
    ["exact", "Sync/Task.task.md", "Task", "Sync/Task.task.md"],
    ["case-insensitive", "Sync/TASK.task.md", "Task", "Sync/Task.task.md"],
    ["Unicode-normalized", "Sync/Cafe\u0301.task.md", "Café", "Sync/Café.task.md"],
  ])("legacy exclusive mode trashes an unmanaged %s occupant and reclaims the canonical filename", async (_kind, unmanagedPath, taskTitle, canonicalPath) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("collision-task", { content: taskTitle, project });
    const unmanaged = vault.addFile(unmanagedPath, "User-owned document\n");
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const legacyContext = {
      assertValid: () => undefined,
      preserveUnmanagedItems: false,
    };
    const first = await adapter.reconcile(snapshot, mapping, legacyContext);
    const managed = vault.files.get(canonicalPath);

    expect(first).toMatchObject({ created: 1, moved: 0, deleted: 1 });
    expect(first.conflicts).toEqual([]);
    expect(vault.files.get(unmanagedPath)?.file).not.toBe(unmanaged);
    expect(parseFrontmatter(managed?.content ?? "")["task id"]).toBe(task.id);
    expect(fileManager.trashFile).toHaveBeenCalledWith(unmanaged);

    vi.clearAllMocks();
    const second = await adapter.reconcile(snapshot, mapping, legacyContext);

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 1 });
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(canonicalPath)?.file).toBe(managed?.file);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("legacy exclusive mode recreates canonical types after sweeping wrong-type occupants", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const rootTask = makeTask("root-task", { content: "Root task", project: root });
    const childTask = makeTask("child-task", { content: "Child task", project: child });
    const projectFolderOccupant = vault.addFile("Sync/Child", "Wrong type\n");
    vault.folders.add("Sync/Root task.task.md");
    const taskFileOccupant = vault.getFolderByPath("Sync/Root task.task.md");

    const result = await adapter.reconcile(
      {
        rootProjectId: root.id,
        projects: [root, child],
        tasks: [
          { task: rootTask, completed: false },
          { task: childTask, completed: false },
        ],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
      { assertValid: () => undefined, preserveUnmanagedItems: false },
    );

    expect(result).toMatchObject({ created: 2, moved: 0, deleted: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.getFolderByPath("Sync/Child")).not.toBeNull();
    expect(vault.files.has("Sync/Child/Child task.task.md")).toBe(true);
    expect(vault.getFolderByPath("Sync/Root task.task.md")).toBeNull();
    expect(vault.files.has("Sync/Root task.task.md")).toBe(true);
    expect(fileManager.trashFile).toHaveBeenCalledWith(projectFolderOccupant);
    expect(fileManager.trashFile).toHaveBeenCalledWith(taskFileOccupant);
  });

  it("legacy exclusive mode trashes an unreadable occupant and recreates the task note", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("malformed-task", { content: "Task", project });
    const path = "Sync/Task.task.md";
    const malformed = [
      "---",
      "todoist_sync_managed: true",
      "todoist_sync_mapping_id: mapping-root",
      "todoist_sync_root_id: root",
      "task id: [malformed",
      "---",
      "User content",
      "",
    ].join("\n");
    vault.addFile(path, malformed);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
      { assertValid: () => undefined, preserveUnmanagedItems: false },
    );

    expect(result).toMatchObject({ created: 1, updated: 0, moved: 0, deleted: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path, message: expect.stringContaining("Could not parse") }),
    ]);
    expect(vault.files.get(path)?.content).not.toBe(malformed);
    expect(parseFrontmatter(vault.files.get(path)?.content ?? "")["task id"]).toBe(task.id);
    expect(vault.files.has("Sync/Task (2).task.md")).toBe(false);
  });

  it("moves an existing projection when a mapping root changes without duplicating the task", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("task-1", { content: "Task", project });
    const movedMapping: ProjectSyncMapping = {
      ...mapping,
      folder: "New",
      previousFolders: ["Old"],
    };
    vault.folders.add("Old");
    vault.folders.add("New");
    const oldPath = "Old/Task.task.md";
    const oldEntry = vault.addFile(
      oldPath,
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      )}\nUser-authored notes stay here.\n`,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      movedMapping,
    );

    const newPath = "New/Task.task.md";
    expect(result).toMatchObject({ created: 0, moved: 1, settledMappingIds: [mapping.id] });
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.has(newPath)).toBe(true);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(newPath)?.file).toBe(oldEntry);
    expect(vault.files.get(newPath)?.content).toContain("User-authored notes stay here.");
  });

  it("trashes a remotely deleted task directly from a registered historical root", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("missing-task", { content: "Missing task", project });
    const movedMapping: ProjectSyncMapping = {
      ...mapping,
      folder: "Newest",
      previousFolders: ["Old", "Unused intermediate"],
    };
    vault.folders.add("Old");
    vault.folders.add("Old/Archived child");
    vault.folders.add("Unused intermediate");
    vault.folders.add("Newest");
    const oldPath = "Old/Archived child/Missing task -- missing-task.md";
    vault.addFile(
      oldPath,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      ),
    );

    const result = await adapter.reconcile(emptySnapshot(project), movedMapping);

    expect(result).toMatchObject({ moved: 0, deleted: 1, settledMappingIds: [mapping.id] });
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.folders.has("Newest/Archived child")).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
    expect(catalogStorage.getCatalog(mapping.id)?.tasks).toEqual([]);
  });

  it("keeps a previous root registered while an open historical note is deferred", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("open-task", { content: "Open task", project });
    const movedMapping: ProjectSyncMapping = {
      ...mapping,
      folder: "New",
      previousFolders: ["Old"],
    };
    vault.folders.add("Old");
    vault.folders.add("New");
    const oldPath = "Old/Open task -- open-task.md";
    vault.addFile(
      oldPath,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      ),
    );
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set([oldPath]),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      movedMapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, deferred: 1, settledMappingIds: [] });
    expect(vault.files.has(oldPath)).toBe(true);
    expect(vault.files.has("New/Open task.task.md")).toBe(false);
  });

  it("does not settle a migration while a registered previous root is unavailable", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("task-1", { content: "Task", project });
    const movedMapping: ProjectSyncMapping = {
      ...mapping,
      folder: "New",
      previousFolders: ["Temporarily unavailable"],
    };
    vault.folders.add("New");

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      movedMapping,
    );

    expect(result).toMatchObject({ created: 1, settledMappingIds: [] });
    expect(vault.files.has("New/Task.task.md")).toBe(true);
  });

  it("moves one managed note and its user content when a task changes mapped projects", async () => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping: ProjectSyncMapping = {
      id: "mapping-first",
      folder: "Sync",
      project: { projectId: first.id, projectName: first.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    const secondMapping: ProjectSyncMapping = {
      id: "mapping-second",
      folder: "Archive",
      project: { projectId: second.id, projectName: second.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Archive");
    const mappingRoots = [
      { mappingId: firstMapping.id, rootProjectId: first.id, folder: firstMapping.folder },
      { mappingId: secondMapping.id, rootProjectId: second.id, folder: secondMapping.folder },
    ];
    const originalTask = makeTask("moving-task", { content: "Moving task", project: first });
    await adapter.reconcile(
      {
        rootProjectId: first.id,
        projects: [first],
        tasks: [{ task: originalTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      firstMapping,
      { assertValid: () => undefined, mappingRoots },
    );
    const originalPath = "Sync/Moving task.task.md";
    const originalEntry = vault.files.get(originalPath);
    if (originalEntry === undefined) {
      throw new Error("Expected the original managed note");
    }
    originalEntry.content += "\nUser-authored notes stay here.\n";

    // Match service ordering where the old mapping is reconciled before the destination mapping.
    const scanToken = {};
    const allSnapshotTaskIds = new Set([originalTask.id]);
    await adapter.reconcile(emptySnapshot(first), firstMapping, {
      assertValid: () => undefined,
      mappingRoots,
      allSnapshotTaskIds,
      scanToken,
    });
    const movedTask = makeTask("moving-task", { content: "Moving task", project: second });
    const destination = await adapter.reconcile(
      {
        rootProjectId: second.id,
        projects: [second],
        tasks: [{ task: movedTask, completed: false }],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      secondMapping,
      { assertValid: () => undefined, mappingRoots, allSnapshotTaskIds, scanToken },
    );

    const destinationPath = "Archive/Moving task.task.md";
    expect(destination).toMatchObject({ created: 0, moved: 1 });
    expect(vault.files.has(originalPath)).toBe(false);
    expect(vault.files.has(destinationPath)).toBe(true);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(destinationPath)?.content).toContain("User-authored notes stay here.");
    expect(parseFrontmatter(vault.files.get(destinationPath)?.content ?? "")).toMatchObject({
      project: second.name,
      "project path": [second.name],
      status: "active",
    });
  });

  it.each([
    "file",
    "folder",
  ] as const)("stages user content when a task moving mappings blocks another task's canonical %s path", async (blockedKind) => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping: ProjectSyncMapping = {
      id: "mapping-first",
      folder: "Sync",
      project: { projectId: first.id, projectName: first.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    const secondMapping: ProjectSyncMapping = {
      id: "mapping-second",
      folder: "Archive",
      project: { projectId: second.id, projectName: second.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Archive");
    const movingTask = makeTask("moving-task", { content: "Shared", project: first });
    const oldPath = blockedKind === "file" ? "Sync/Shared.task.md" : "Sync/Shared/Shared.task.md";
    if (blockedKind === "folder") {
      vault.folders.add("Sync/Shared");
    }
    const oldFile = vault.addFile(
      oldPath,
      `${renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: movingTask, completed: false },
          first.id,
          testProjectPath(first),
          "2026-08-10T00:00:00.000Z",
          firstMapping.id,
        ),
        makeManagedBody(movingTask),
      )}\nUser body must cross the mapping boundary.\n`,
    );
    const replacement = makeTask("replacement", { content: "Shared", project: first });
    const replacementChild = makeTask("replacement-child", {
      content: "Replacement child",
      parentId: replacement.id,
      project: first,
    });
    const firstSnapshotTasks = [
      { task: replacement, completed: false },
      ...(blockedKind === "folder" ? [{ task: replacementChild, completed: false }] : []),
    ];
    const mappingRoots = [
      { mappingId: firstMapping.id, rootProjectId: first.id, folder: firstMapping.folder },
      { mappingId: secondMapping.id, rootProjectId: second.id, folder: secondMapping.folder },
    ];
    const allSnapshotTaskIds = new Set([
      movingTask.id,
      ...firstSnapshotTasks.map(({ task }) => task.id),
    ]);
    const stagedUserDocumentsByTaskId = new Map<
      string,
      { frontmatter: Record<string, unknown>; body: string }
    >();
    const scanToken = {};

    const source = await adapter.reconcile(
      {
        rootProjectId: first.id,
        projects: [first],
        tasks: firstSnapshotTasks,
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      firstMapping,
      {
        assertValid: () => undefined,
        mappingRoots,
        allSnapshotTaskIds,
        stagedUserDocumentsByTaskId,
        scanToken,
      },
    );

    expect(source).toMatchObject({ created: firstSnapshotTasks.length, deleted: 1 });
    expect(source.conflicts).toEqual([]);
    expect(fileManager.trashFile).toHaveBeenCalledWith(oldFile);
    expect(stagedUserDocumentsByTaskId.has(movingTask.id)).toBe(true);
    const replacementPath =
      blockedKind === "file" ? "Sync/Shared.task.md" : "Sync/Shared/Shared.task.md";
    expect(parseFrontmatter(vault.files.get(replacementPath)?.content ?? "")["task id"]).toBe(
      replacement.id,
    );

    const movedTask = makeTask(movingTask.id, { content: "Shared", project: second });
    const destination = await adapter.reconcile(
      {
        rootProjectId: second.id,
        projects: [second],
        tasks: [{ task: movedTask, completed: false }],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      secondMapping,
      {
        assertValid: () => undefined,
        mappingRoots,
        allSnapshotTaskIds,
        stagedUserDocumentsByTaskId,
        scanToken,
      },
    );

    const destinationPath = "Archive/Shared.task.md";
    expect(destination).toMatchObject({ created: 1, moved: 0 });
    expect(destination.conflicts).toEqual([]);
    expect(vault.files.get(destinationPath)?.content).toContain(
      "User body must cross the mapping boundary.",
    );
    expect(parseFrontmatter(vault.files.get(destinationPath)?.content ?? "")).toMatchObject({
      "task id": movingTask.id,
      project: second.name,
    });
    expect(stagedUserDocumentsByTaskId.size).toBe(0);
    expect([...vault.files.keys()].some((path) => / \(\d+\)(?:\/|\.task\.md$)/u.test(path))).toBe(
      false,
    );
  });

  it("collapses one task ID across mapping roots into its authoritative destination", async () => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping: ProjectSyncMapping = {
      id: "mapping-first",
      folder: "Sync",
      project: { projectId: first.id, projectName: first.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    const secondMapping: ProjectSyncMapping = {
      id: "mapping-second",
      folder: "Archive",
      project: { projectId: second.id, projectName: second.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Archive");
    const task = makeTask("one-id", { content: "One task", project: second });
    const document = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        second.id,
        testProjectPath(second),
        "2026-08-10T00:00:00.000Z",
        secondMapping.id,
      ),
      makeManagedBody(task),
    );
    vault.addFile("Sync/One task.task.md", document);
    vault.addFile("Archive/One task.task.md", document);
    const mappingRoots = [
      { mappingId: firstMapping.id, rootProjectId: first.id, folder: firstMapping.folder },
      { mappingId: secondMapping.id, rootProjectId: second.id, folder: secondMapping.folder },
    ];
    const allSnapshotTaskIds = new Set([task.id]);
    const scanToken = {};

    await adapter.reconcile(emptySnapshot(first), firstMapping, {
      assertValid: () => undefined,
      mappingRoots,
      allSnapshotTaskIds,
      scanToken,
    });
    const destination = await adapter.reconcile(
      {
        rootProjectId: second.id,
        projects: [second],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      secondMapping,
      { assertValid: () => undefined, mappingRoots, allSnapshotTaskIds, scanToken },
    );

    expect(destination.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.has("Sync/One task.task.md")).toBe(false);
    expect(vault.files.has("Archive/One task.task.md")).toBe(true);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
    expect(catalogStorage.getCatalog(firstMapping.id)?.tasks).toEqual([]);
    expect(catalogStorage.getCatalog(secondMapping.id)?.tasks).toEqual([
      expect.objectContaining({ id: task.id, projectId: second.id }),
    ]);
  });

  it("rechecks schema preparation between mappings that share a scan token", async () => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping: ProjectSyncMapping = {
      ...mapping,
      id: "mapping-first",
      project: { projectId: first.id, projectName: first.name },
    };
    const secondMapping: ProjectSyncMapping = {
      ...mapping,
      id: "mapping-second",
      folder: "Archive",
      project: { projectId: second.id, projectName: second.name },
    };
    vault.folders.add("Archive");
    const scanToken = {};
    const mappingRoots = [
      { mappingId: firstMapping.id, rootProjectId: first.id, folder: firstMapping.folder },
      { mappingId: secondMapping.id, rootProjectId: second.id, folder: secondMapping.folder },
    ];
    const context = { assertValid: () => undefined, mappingRoots, scanToken };
    const initial = await adapter.reconcile(emptySnapshot(first), firstMapping, context);
    expect(initial.conflicts).toEqual([]);

    const lateTask = makeTask("late-task", { content: "Late task", project: first });
    const taskFile = vault.addFile(
      "Disabled mapping/Late.md",
      renderNewTaskDocument(
        { todoist_task_id: lateTask.id, todoist_status: "active" },
        makeManagedBody(lateTask),
      ),
    );
    const base = vault.addFile(
      "Late dashboard.base",
      "views: [{type: table, order: [note.todoist_status]}]\n",
    );

    const result = await adapter.reconcile(emptySnapshot(second), secondMapping, context);

    expect(result.conflicts).toEqual([]);
    expect(parseFrontmatter(vault.files.get(taskFile.path)?.content ?? "")).toEqual({
      "task id": lateTask.id,
      status: "active",
    });
    expect(vault.files.get(base.path)?.content).toContain("note.status");
    expect(vault.process.mock.calls.map(([file]) => file.path)).toEqual([taskFile.path, base.path]);
  });

  it("shares one task scan across mappings and rereads each note before mutating it", async () => {
    const first = makeProject("first", { name: "First" });
    const second = makeProject("second", { name: "Second" });
    const firstMapping: ProjectSyncMapping = {
      id: "mapping-first",
      folder: "Sync",
      project: { projectId: first.id, projectName: first.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    const secondMapping: ProjectSyncMapping = {
      id: "mapping-second",
      folder: "Archive",
      project: { projectId: second.id, projectName: second.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Archive");
    for (const [project, currentMapping] of [
      [first, firstMapping],
      [second, secondMapping],
    ] as const) {
      const task = makeTask(`task-${project.id}`, { content: project.name, project });
      vault.addFile(
        `${currentMapping.folder}/${project.name}.task.md`,
        renderNewTaskDocument(
          makeTaskFrontmatter(
            { task, completed: false },
            project.id,
            testProjectPath(project),
            "2026-08-09T00:00:00.000Z",
            currentMapping.id,
          ),
          makeManagedBody(task),
        ),
      );
    }
    const read = vi.spyOn(vault, "read");
    const mappingRoots = [
      { mappingId: firstMapping.id, rootProjectId: first.id, folder: firstMapping.folder },
      { mappingId: secondMapping.id, rootProjectId: second.id, folder: secondMapping.folder },
    ];
    const scanToken = {};

    await adapter.reconcile(emptySnapshot(first), firstMapping, {
      assertValid: () => undefined,
      mappingRoots,
      scanToken,
    });
    await adapter.reconcile(emptySnapshot(second), secondMapping, {
      assertValid: () => undefined,
      mappingRoots,
      scanToken,
    });

    // The first schema preparation and shared task scan each read both files. The second
    // preparation reads the remaining file, while cleanup and mutation revalidate live notes.
    expect(read).toHaveBeenCalledTimes(8);
  });

  it("does not stale a cached note after an earlier mapping moves it into the destination", async () => {
    const destinationProject = makeProject("destination", { name: "Destination" });
    const sourceProject = makeProject("source", { name: "Source" });
    const destinationMapping: ProjectSyncMapping = {
      id: "mapping-destination",
      folder: "Sync",
      project: { projectId: destinationProject.id, projectName: destinationProject.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    const sourceMapping: ProjectSyncMapping = {
      id: "mapping-source",
      folder: "Archive",
      project: { projectId: sourceProject.id, projectName: sourceProject.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Archive");
    const sourceTask = makeTask("moving-task", {
      content: "Moving task",
      project: sourceProject,
    });
    vault.addFile(
      "Archive/Moving task.task.md",
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: sourceTask, completed: false },
          sourceProject.id,
          testProjectPath(sourceProject),
          "2026-08-09T00:00:00.000Z",
          sourceMapping.id,
        ),
        makeManagedBody(sourceTask),
      ),
    );
    const mappingRoots = [
      {
        mappingId: destinationMapping.id,
        rootProjectId: destinationProject.id,
        folder: destinationMapping.folder,
      },
      {
        mappingId: sourceMapping.id,
        rootProjectId: sourceProject.id,
        folder: sourceMapping.folder,
      },
    ];
    const scanToken = {};
    const destinationTask = makeTask("moving-task", {
      content: "Moving task",
      project: destinationProject,
    });

    await adapter.reconcile(
      {
        rootProjectId: destinationProject.id,
        projects: [destinationProject],
        tasks: [{ task: destinationTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      destinationMapping,
      { assertValid: () => undefined, mappingRoots, scanToken },
    );
    await adapter.reconcile(emptySnapshot(sourceProject), sourceMapping, {
      assertValid: () => undefined,
      mappingRoots,
      scanToken,
    });

    const content = vault.files.get("Sync/Moving task.task.md")?.content ?? "";
    expect(vault.files.size).toBe(1);
    expect(parseFrontmatter(content)).toMatchObject({
      project: destinationProject.name,
      status: "active",
    });
  });

  it("sweeps only the active mapping root and ignores open files in other or historical roots", async () => {
    const activeProject = makeProject("active", { name: "Active" });
    const otherProject = makeProject("other", { name: "Other" });
    const activeTask = makeTask("active-task", { content: "Task", project: activeProject });
    const activeMapping: ProjectSyncMapping = {
      id: "mapping-active",
      folder: "Sync",
      project: { projectId: activeProject.id, projectName: activeProject.name },
      includeSubprojects: false,
      previousFolders: ["Old"],
    };
    const otherMapping: ProjectSyncMapping = {
      id: "mapping-other",
      folder: "Archive",
      project: { projectId: otherProject.id, projectName: otherProject.name },
      includeSubprojects: false,
      previousFolders: [],
    };
    vault.folders.add("Old");
    vault.folders.add("Archive");
    const activeUnmanaged = vault.addFile("Sync/Remove me.md", "Exclusive root occupant\n");
    const historicalUnmanaged = vault.addFile("Old/User note.md", "Historical user note\n");
    const otherUnmanaged = vault.addFile("Archive/User note.md", "Other mapping user note\n");
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set([historicalUnmanaged.path, otherUnmanaged.path]),
      undefined,
      catalogStorage,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: activeProject.id,
        projects: [activeProject],
        tasks: [{ task: activeTask, completed: false }],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      activeMapping,
      {
        assertValid: () => undefined,
        mappingRoots: [
          {
            mappingId: activeMapping.id,
            rootProjectId: activeProject.id,
            folder: activeMapping.folder,
            active: true,
          },
          {
            mappingId: activeMapping.id,
            rootProjectId: activeProject.id,
            folder: "Old",
            active: true,
          },
          {
            mappingId: otherMapping.id,
            rootProjectId: otherProject.id,
            folder: otherMapping.folder,
            active: true,
          },
        ],
        preserveUnmanagedItems: false,
      },
    );

    expect(result).toMatchObject({ created: 1, moved: 0, deleted: 1, deferred: 0 });
    expect(vault.files.has(activeUnmanaged.path)).toBe(false);
    expect(vault.files.get(historicalUnmanaged.path)?.content).toBe("Historical user note\n");
    expect(vault.files.get(otherUnmanaged.path)?.content).toBe("Other mapping user note\n");
    expect(parseFrontmatter(vault.files.get("Sync/Task.task.md")?.content ?? "")).toMatchObject({
      "task id": activeTask.id,
      project: activeProject.name,
    });
    expect(fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(fileManager.trashFile).toHaveBeenCalledWith(activeUnmanaged);
  });

  it("preflights every configured folder synchronously", () => {
    expect(() => adapter.validateConfig(config)).not.toThrow();
    vault.folders.add("Archive");
    expect(() =>
      adapter.validateConfig({
        enabled: false,
        preserveUnmanagedItems: true,
        mappings: [
          mapping,
          {
            id: "mapping-archive",
            project: { projectId: "archive", projectName: "Archive" },
            folder: "Archive",
            includeSubprojects: false,
            previousFolders: [],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      adapter.validateConfig({
        enabled: false,
        preserveUnmanagedItems: true,
        mappings: [
          mapping,
          {
            id: "mapping-missing",
            project: { projectId: "missing", projectName: "Missing" },
            folder: "Missing",
            includeSubprojects: false,
            previousFolders: [],
          },
        ],
      }),
    ).toThrow("does not exist");
    expect(vault.files.size).toBe(0);
  });

  it.each([
    ["equal case-insensitive", "Sync", "sync"],
    ["equal Unicode-normalized", "Café", "Cafe\u0301"],
    ["ancestor", "Sync", "Sync/Child"],
    ["descendant", "Sync/Child", "Sync"],
  ])("rejects %s project-folder overlap", (_kind, firstFolder, secondFolder) => {
    vault.folders.add(firstFolder);
    vault.folders.add(secondFolder);
    const overlapping: ProjectSyncConfig = {
      enabled: true,
      preserveUnmanagedItems: true,
      mappings: [
        {
          id: "mapping-first",
          project: { projectId: "first", projectName: "First" },
          folder: firstFolder,
          includeSubprojects: true,
          previousFolders: [],
        },
        {
          id: "mapping-second",
          project: { projectId: "second", projectName: "Second" },
          folder: secondFolder,
          includeSubprojects: true,
          previousFolders: [],
        },
      ],
    };

    expect(() => adapter.validateConfig(overlapping)).toThrow("overlap");
  });

  it("allows separate sibling project folders with a common parent", () => {
    vault.folders.add("Sync/Child");
    vault.folders.add("Sync/Children");

    expect(() =>
      adapter.validateConfig({
        enabled: true,
        preserveUnmanagedItems: true,
        mappings: [
          { ...mapping, folder: "Sync/Child" },
          {
            id: "mapping-second",
            project: { projectId: "second", projectName: "Second" },
            folder: "Sync/Children",
            includeSubprojects: false,
            previousFolders: [],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a current mapping that overlaps another mapping's registered previous root", () => {
    vault.folders.add("New");
    vault.folders.add("Old");
    vault.folders.add("Old/Second");

    expect(() =>
      adapter.validateConfig({
        enabled: true,
        preserveUnmanagedItems: true,
        mappings: [
          { ...mapping, folder: "New", previousFolders: ["Old"] },
          {
            id: "mapping-second",
            project: { projectId: "second", projectName: "Second" },
            folder: "Old/Second",
            includeSubprojects: false,
            previousFolders: [],
          },
        ],
      }),
    ).toThrow("overlap");
  });

  it.each(["", "/", ".", "Sync/../Elsewhere"])("rejects unsafe project folder '%s'", (folder) => {
    expect(() =>
      adapter.validateConfig({
        enabled: true,
        preserveUnmanagedItems: true,
        mappings: [{ ...mapping, folder }],
      }),
    ).toThrow("dedicated folder");
  });

  it("does not read or update same-root managed notes outside the configured folder", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("outside", { content: "Outside", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
      mapping.id,
    );
    vault.addFile(
      "Elsewhere/Outside -- outside.md",
      renderNewTaskDocument(frontmatter, makeManagedBody(task)),
    );

    await adapter.reconcile(emptySnapshot(project), mapping);

    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(vault.files.get("Elsewhere/Outside -- outside.md")?.content).toBe(
      renderNewTaskDocument(frontmatter, makeManagedBody(task)),
    );
  });

  it("leaves an unchanged open note untouched without reporting a conflict", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("task-1", { content: "Task", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
      mapping.id,
    );
    const path = "Sync/Task.task.md";
    const original = renderNewTaskDocument(frontmatter, makeManagedBody(task));
    vault.addFile(path, original);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(["Other split.md", path]),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0, unchanged: 1, deferred: 0 });
    expect(result.conflicts).toEqual([]);
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.get(path)?.content).toBe(original);
  });

  it("defers legacy filename migration while the managed note is open", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("legacy-open", { content: "Open legacy task", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
      mapping.id,
    );
    const oldPath = "Sync/Open legacy task -- legacy-open.md";
    const targetPath = "Sync/Open legacy task.task.md";
    const original = renderNewTaskDocument(frontmatter, makeManagedBody(task));
    vault.addFile(oldPath, original);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set([oldPath]),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0, updated: 0, deferred: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        path: oldPath,
        message: expect.stringContaining("open in an editor"),
      }),
    ]);
    expect(vault.files.get(oldPath)?.content).toBe(original);
    expect(vault.files.has(targetPath)).toBe(false);
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("defers a changed open note without writing any part of it", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("active", { content: "Original", project });
    const changedTask = makeTask("active", { content: "Changed", project });
    const frontmatter = makeTaskFrontmatter(
      { task: originalTask, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
    );
    const path = "Sync/Original.task.md";
    const original = renderNewTaskDocument(frontmatter, makeManagedBody(originalTask));
    vault.addFile(path, original);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(["Other split.md", path]),
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: changedTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0, unchanged: 0, deferred: 1 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: "active",
        path,
        message: expect.stringContaining("open in an editor"),
      }),
    ]);
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(vault.files.get(path)?.content).toBe(original);
  });

  it("does not overwrite a note whose managed identity changes before the atomic update", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("mutable", { content: "Original", project });
    const changedTask = makeTask("mutable", { content: "Changed", project });
    const path = "Sync/Original.task.md";
    vault.addFile(
      path,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: originalTask, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(originalTask),
      ),
    );
    vault.beforeProcess = () => {
      const entry = vault.files.get(path);
      if (entry !== undefined) {
        entry.content = entry.content.replace("task id: mutable", "task id: other");
      }
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: changedTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: originalTask.id,
        path,
        projectionBlocked: true,
        message: expect.stringContaining("changed identity"),
      }),
    ]);
    expect(parseFrontmatter(vault.files.get(path)?.content ?? "")["task id"]).toBe("other");
    expect(vault.files.get(path)?.content).not.toContain("# Changed");
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer Todoist source revision", async () => {
    const project = makeProject("root", { name: "Root" });
    const currentTask = {
      ...makeTask("revisioned", { content: "Current title", project }),
      updatedAt: "2026-08-10T02:00:00.000Z",
    };
    const staleTask = {
      ...makeTask("revisioned", { content: "Stale title", project }),
      updatedAt: "2026-08-10T01:00:00.000Z",
    };
    const path = "Sync/Current title.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: currentTask, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T02:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(currentTask),
    );
    vault.addFile(path, original);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: staleTask, completed: false }],
        syncedAt: "2026-08-10T03:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: staleTask.id,
        path,
        projectionBlocked: true,
        message: expect.stringContaining("newer Todoist revision"),
      }),
    ]);
    expect(vault.files.get(path)?.content).toBe(original);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("does not apply semantic changes from a snapshot without a source revision", async () => {
    const project = makeProject("root", { name: "Root" });
    const currentTask = {
      ...makeTask("revisioned", { content: "Current title", project }),
      updatedAt: "2026-08-10T02:00:00.000Z",
    };
    const unversionedTask = makeTask("revisioned", { content: "Unversioned title", project });
    const path = "Sync/Current title.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: currentTask, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T02:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(currentTask),
    );
    vault.addFile(path, original);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: unversionedTask, completed: false }],
        syncedAt: "2026-08-10T03:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: currentTask.id,
        path,
        projectionBlocked: true,
        message: expect.stringContaining("incoming snapshot has none"),
      }),
    ]);
    expect(vault.files.get(path)?.content).toBe(original);
    expect(vault.files.has("Sync/Unversioned title.task.md")).toBe(false);
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("leaves an unchanged revisioned note alone when the snapshot has no revision", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("revisioned", { content: "Current title", project });
    const revisionedTask = { ...task, updatedAt: "2026-08-10T02:00:00.000Z" };
    const path = "Sync/Current title.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: revisionedTask, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T02:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(revisionedTask),
    );
    vault.addFile(path, original);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T03:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, moved: 0, unchanged: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.get(path)?.content).toBe(original);
    expect(vault.process).not.toHaveBeenCalled();
  });

  it("preserves a file that appears while a managed note is being created", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("create-race", { content: "Created remotely", project });
    const path = "Sync/Created remotely.task.md";
    vault.beforeCreate = (createdPath) => {
      if (createdPath === path) {
        vault.addFile(path, "Remote user-owned note\n");
      }
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        path,
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.get(path)?.content).toBe("Remote user-owned note\n");
  });

  it("preserves a rename target that appears after the final path check", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("rename-race", { content: "Original", project });
    const changedTask = makeTask("rename-race", { content: "Changed", project });
    const sourcePath = "Sync/Original.task.md";
    const targetPath = "Sync/Changed.task.md";
    vault.addFile(
      sourcePath,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task: originalTask, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(originalTask),
      ),
    );
    fileManager.beforeRename = (newPath) => {
      if (newPath === targetPath) {
        vault.addFile(targetPath, "Remote user-owned note\n");
      }
    };

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [{ task: changedTask, completed: false }],
        syncedAt: "2026-08-10T00:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ created: 0, moved: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        taskId: changedTask.id,
        path: sourcePath,
        projectionBlocked: true,
      }),
    ]);
    expect(vault.files.get(targetPath)?.content).toBe("Remote user-owned note\n");
    expect(vault.files.has(sourcePath)).toBe(true);
  });

  it("does not trash a missing note after its identity changes externally", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("missing-race", { content: "Missing", project });
    const path = "Sync/Missing.task.md";
    vault.addFile(
      path,
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          project.id,
          testProjectPath(project),
          "2026-08-09T00:00:00.000Z",
          mapping.id,
        ),
        makeManagedBody(task),
      ),
    );
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
      async (_paths, operation) => {
        const entry = vault.files.get(path);
        if (entry !== undefined) {
          entry.content = entry.content.replace(
            "task id: missing-race",
            "task id: externally-changed",
          );
        }
        return await operation();
      },
      catalogStorage,
    );

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ updated: 0, deleted: 0 });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ taskId: task.id, path, projectionBlocked: true }),
    ]);
    const frontmatter = parseFrontmatter(vault.files.get(path)?.content ?? "");
    expect(frontmatter["task id"]).toBe("externally-changed");
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("trashes a tracked ID absent from the complete snapshot regardless of a local clock", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("newer-missing", { content: "Newer missing", project });
    const path = "Sync/Newer missing.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T02:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    vault.addFile(path, original);

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, deleted: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(path)).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it("rechecks the immutable task ID immediately before authoritative deletion", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = {
      ...makeTask("missing-revision-race", { content: "Missing race", project }),
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const path = "Sync/Missing race.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-10T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(task),
    );
    vault.addFile(path, original);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
      async (_paths, operation) => {
        const entry = vault.files.get(path);
        if (entry !== undefined) {
          entry.content = entry.content.replace(
            "updated at: '2026-08-10T00:00:00.000Z'",
            "updated at: '2026-08-10T02:00:00.000Z'",
          );
        }
        return await operation();
      },
      catalogStorage,
    );

    const result = await adapter.reconcile(
      {
        rootProjectId: project.id,
        projects: [project],
        tasks: [],
        syncedAt: "2026-08-10T01:00:00.000Z",
      },
      mapping,
    );

    expect(result).toMatchObject({ updated: 0, deleted: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(path)).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it("does not write when the run is invalidated before the atomic Vault process callback", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("callback-fence", { content: "Original", project });
    const changedTask = makeTask(originalTask.id, { content: "Changed", project });
    const path = "Sync/Original.task.md";
    const original = renderNewTaskDocument(
      makeTaskFrontmatter(
        { task: originalTask, completed: false },
        project.id,
        testProjectPath(project),
        "2026-08-09T00:00:00.000Z",
        mapping.id,
      ),
      makeManagedBody(originalTask),
    );
    vault.addFile(path, original);

    let valid = true;
    vault.beforeProcess = () => {
      valid = false;
    };
    const invalidated = new Error("sync invalidated before callback");

    await expect(
      adapter.reconcile(
        {
          rootProjectId: project.id,
          projects: [project],
          tasks: [{ task: changedTask, completed: false }],
          syncedAt: "2026-08-10T00:00:00.000Z",
        },
        mapping,
        {
          assertValid: () => {
            if (!valid) {
              throw invalidated;
            }
          },
        },
      ),
    ).rejects.toBe(invalidated);

    expect(vault.process).toHaveBeenCalledTimes(1);
    expect(vault.files.get(path)?.content).toBe(original);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("checks cancellation after the atomic document mutation before renaming", async () => {
    const project = makeProject("root", { name: "Root" });
    const originalTask = makeTask("mutable", { content: "Original", project });
    const changedTask = makeTask("mutable", { content: "Changed", project });
    const frontmatter = makeTaskFrontmatter(
      { task: originalTask, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
    );
    vault.addFile(
      "Sync/Original.task.md",
      renderNewTaskDocument(frontmatter, makeManagedBody(originalTask)),
    );

    let valid = true;
    vault.afterProcess = () => {
      valid = false;
    };
    const invalidated = new Error("sync invalidated");

    await expect(
      adapter.reconcile(
        {
          rootProjectId: project.id,
          projects: [project],
          tasks: [{ task: changedTask, completed: false }],
          syncedAt: "2026-08-10T00:00:00.000Z",
        },
        mapping,
        {
          assertValid: () => {
            if (!valid) {
              throw invalidated;
            }
          },
        },
      ),
    ).rejects.toBe(invalidated);

    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(vault.process).toHaveBeenCalledTimes(1);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("moves a remotely deleted task note to the user's configured trash immediately", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("missing", { content: "Missing", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
    );
    const legacyPath = "Sync/Missing -- missing.md";
    vault.addFile(legacyPath, renderNewTaskDocument(frontmatter, makeManagedBody(task)));

    const result = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(result).toMatchObject({ moved: 0, deleted: 1, updated: 0 });
    expect(vault.files.has(legacyPath)).toBe(false);
    expect(vault.files.has("Sync/Missing.task.md")).toBe(false);
    expect(fileManager.trashFile).toHaveBeenCalledOnce();
    expect(catalogStorage.getCatalog(mapping.id)?.tasks).toEqual([]);
  });

  it("deletes former child-project notes once they leave the configured authoritative scope", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const task = makeTask("child-task", { content: "Child task", project: child });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      root.id,
      testProjectPath(root, child),
      "2026-08-09T00:00:00.000Z",
    );
    frontmatter.status = "stale";
    frontmatter.todoist_sync_missing_count = 2;
    frontmatter.todoist_stale_since = "2026-08-09T12:00:00.000Z";
    const legacyPath = "Sync/Child/Child task -- child-task.md";
    const canonicalPath = "Sync/Child/Child task.task.md";
    vault.addFile(legacyPath, renderNewTaskDocument(frontmatter, makeManagedBody(task)));
    const rootOnlyMapping = { ...mapping, includeSubprojects: false };

    const first = await adapter.reconcile(emptySnapshot(root), rootOnlyMapping);
    const second = await adapter.reconcile(emptySnapshot(root), rootOnlyMapping);

    expect(first).toMatchObject({ moved: 0, outOfScope: 0, updated: 0, unchanged: 0, deleted: 1 });
    expect(second).toMatchObject({ moved: 0, outOfScope: 0, updated: 0, unchanged: 0, deleted: 0 });
    expect(vault.files.has(legacyPath)).toBe(false);
    expect(vault.files.has(canonicalPath)).toBe(false);
  });
});

const emptySnapshot = (project: ReturnType<typeof makeProject>): ProjectSyncSnapshot => ({
  rootProjectId: project.id,
  projects: [project],
  tasks: [],
  syncedAt: "2026-08-10T00:00:00.000Z",
});

const parseFrontmatter = (content: string): Record<string, unknown> => {
  const parsed = loadYaml(frontmatterInfo(content).frontmatter);
  return isRecord(parsed) ? parsed : {};
};

const managedPathsByTaskId = (vault: FakeVault): Map<string, string> => {
  const result = new Map<string, string>();
  for (const [path, { content }] of vault.files) {
    const taskId = readTaskProperty(parseFrontmatter(content), "todoist_task_id");
    if (typeof taskId === "string") {
      if (result.has(taskId)) {
        throw new Error(`Expected one managed note for Todoist task '${taskId}'`);
      }
      result.set(taskId, path);
    }
  }
  return result;
};

const parentPathOf = (path: string | undefined): string => {
  if (path === undefined) {
    throw new Error("Expected managed task path");
  }
  const separator = path.lastIndexOf("/");
  if (separator < 0) {
    throw new Error(`Expected '${path}' to have a parent path`);
  }
  return path.slice(0, separator);
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const hasNumberedCollisionSuffix = (path: string): boolean =>
  / \((?:2|3|[4-9]\d*)\)(?:\/|\.task\.md$)/u.test(path);
