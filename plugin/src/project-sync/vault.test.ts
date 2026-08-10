import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import type { FileManager, TAbstractFile, TFile, Vault } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import { makeManagedBody, makeTaskFrontmatter, renderNewTaskDocument } from "./document";
import type { ProjectSyncConfig, ProjectSyncMapping, ProjectSyncSnapshot } from "./types";
import { ObsidianProjectSyncVault } from "./vault";

vi.mock("obsidian", async () => {
  const { load } = await import("js-yaml");
  const getFrontmatterInfo = (content: string) => {
    if (!content.startsWith("---\n")) {
      return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
    }
    const closing = content.indexOf("\n---", 4);
    if (closing < 0) {
      return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
    }
    return {
      exists: true,
      frontmatter: content.slice(4, closing),
      from: 4,
      to: closing,
      contentStart: closing + 4,
    };
  };
  return {
    normalizePath: (path: string) =>
      path
        .split("/")
        .filter((segment) => segment !== "")
        .join("/"),
    getFrontMatterInfo: getFrontmatterInfo,
    parseYaml: (yaml: string) => load(yaml),
  };
});

type FakeFile = TFile & { path: string; name: string };
type FakeFolder = TAbstractFile & { path: string; name: string };

class FakeVault {
  readonly files = new Map<string, { file: FakeFile; content: string }>();
  readonly folders = new Set<string>(["Sync"]);
  private readonly folderEntries = new Map<string, FakeFolder>();
  afterProcess: (() => void) | undefined;
  readonly process = vi.fn(async (file: TFile, update: (content: string) => string) => {
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
    const file = { path, name: segments[segments.length - 1] ?? path } as FakeFile;
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
    return [...this.files.values()].map(({ file }) => file);
  }

  async read(file: TFile): Promise<string> {
    const content = this.files.get(file.path)?.content;
    if (content === undefined) {
      throw new Error("Missing fake file");
    }
    return content;
  }

  async create(path: string, content: string): Promise<TFile> {
    return this.addFile(path, content);
  }

  private folderEntry(path: string): FakeFolder {
    const existing = this.folderEntries.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const segments = path.split("/");
    const folder = { path, name: segments[segments.length - 1] ?? path } as FakeFolder;
    this.folderEntries.set(path, folder);
    return folder;
  }
}

class FakeFileManager {
  private readonly vault: FakeVault;
  afterProcessFrontMatter: (() => void) | undefined;
  afterRename: (() => void) | undefined;

  readonly processFrontMatter = vi.fn(
    async (file: TFile, update: (frontmatter: Record<string, unknown>) => void) => {
      const entry = this.vault.files.get(file.path);
      if (entry === undefined) {
        throw new Error("Missing fake file");
      }
      const info = frontmatterInfo(entry.content);
      const parsed = loadYaml(info.frontmatter);
      const frontmatter = isRecord(parsed) ? parsed : {};
      update(frontmatter);
      entry.content = `---\n${dumpYaml(frontmatter, { lineWidth: -1, noRefs: true })}---${entry.content.slice(info.contentStart)}`;
      this.afterProcessFrontMatter?.();
    },
  );

  readonly renameFile = vi.fn(async (file: TFile, newPath: string) => {
    const entry = this.vault.files.get(file.path);
    if (entry === undefined) {
      throw new Error("Missing fake file");
    }
    this.vault.files.delete(file.path);
    file.path = newPath;
    file.name = newPath.slice(newPath.lastIndexOf("/") + 1);
    this.vault.files.set(newPath, entry);
    this.afterRename?.();
  });

  constructor(vault: FakeVault) {
    this.vault = vault;
  }
}

const frontmatterInfo = (content: string) => {
  if (!content.startsWith("---\n")) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const closing = content.indexOf("\n---", 4);
  if (closing < 0) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  return {
    exists: true,
    frontmatter: content.slice(4, closing),
    from: 4,
    to: closing,
    contentStart: closing + 4,
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
  mappings: [mapping],
};

describe("ObsidianProjectSyncVault", () => {
  let vault: FakeVault;
  let fileManager: FakeFileManager;
  let adapter: ObsidianProjectSyncVault;

  beforeEach(() => {
    vault = new FakeVault();
    fileManager = new FakeFileManager(vault);
    adapter = new ObsidianProjectSyncVault(
      vault as unknown as Vault,
      fileManager as unknown as FileManager,
      () => new Set(),
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
    expect(vault.files.has("Sync/Root task.md")).toBe(true);
    expect(vault.files.has("Sync/Child/Child task.md")).toBe(true);
    expect(vault.folders.has("Sync/Child")).toBe(true);
    expect(vault.folders.has("Sync/Root")).toBe(false);
    expect(parseFrontmatter(vault.files.get("Sync/Root task.md")?.content ?? "")).toMatchObject({
      todoist_sync_root_id: "root",
      todoist_description: "",
      todoist_project_id: "root",
      todoist_project_path: ["Root"],
      todoist_project_id_path: ["root"],
    });
    expect(
      parseFrontmatter(vault.files.get("Sync/Child/Child task.md")?.content ?? ""),
    ).toMatchObject({
      todoist_project_id: "child",
      todoist_project_path: ["Root", "Child"],
      todoist_project_id_path: ["root", "child"],
    });
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
    delete frontmatter.todoist_description;
    delete frontmatter.todoist_project_id_path;
    frontmatter.user_property = "keep me";
    vault.folders.add("Sync/Child");
    vault.addFile("Sync/Child/Task.md", renderNewTaskDocument(frontmatter, makeManagedBody(task)));

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
    expect(parseFrontmatter(vault.files.get("Sync/Child/Task.md")?.content ?? "")).toMatchObject({
      todoist_description: "Task description",
      todoist_project_path: ["Root", "Child"],
      todoist_project_id_path: ["root", "child"],
      user_property: "keep me",
    });
  });

  it("renames a legacy ID-suffixed note on the next sync without losing user content", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("6grv4CPC4VRF9MVj", {
      content: "国企求职老师沟通",
      project,
    });
    const oldPath = "Sync/国企求职老师沟通 -- 6grv4CPC4VRF9MVj.md";
    const newPath = "Sync/国企求职老师沟通.md";
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
      todoist_task_id: task.id,
      todoist_content: task.content,
    });

    const second = await adapter.reconcile(snapshot, mapping);

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 1 });
    expect(second.conflicts).toEqual([]);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(newPath)?.file).toBe(oldFile);
  });

  it("keeps duplicate task titles distinct and stable when snapshot order changes", async () => {
    const project = makeProject("root", { name: "Root" });
    const firstTask = makeTask("task-a", { content: "Same title", project });
    const secondTask = makeTask("task-b", { content: "Same title", project });
    const firstSnapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [
        { task: firstTask, completed: false },
        { task: secondTask, completed: false },
      ],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(firstSnapshot, mapping);
    const canonical = vault.files.get("Sync/Same title.md");
    const alternate = vault.files.get("Sync/Same title (2).md");

    expect(first).toMatchObject({ created: 2, moved: 0 });
    expect(first.conflicts).toEqual([]);
    expect(parseFrontmatter(canonical?.content ?? "").todoist_task_id).toBe(firstTask.id);
    expect(parseFrontmatter(alternate?.content ?? "").todoist_task_id).toBe(secondTask.id);
    expect(vault.files.size).toBe(2);

    const second = await adapter.reconcile(
      { ...firstSnapshot, tasks: [...firstSnapshot.tasks].reverse() },
      mapping,
    );

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 2 });
    expect(second.conflicts).toEqual([]);
    expect(vault.files.get("Sync/Same title.md")?.file).toBe(canonical?.file);
    expect(vault.files.get("Sync/Same title (2).md")?.file).toBe(alternate?.file);
    expect(
      parseFrontmatter(vault.files.get("Sync/Same title.md")?.content ?? "").todoist_task_id,
    ).toBe(firstTask.id);
    expect(
      parseFrontmatter(vault.files.get("Sync/Same title (2).md")?.content ?? "").todoist_task_id,
    ).toBe(secondTask.id);
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
    const originalPath = "Sync/Original title.md";
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

    const renamedPath = "Sync/Renamed title.md";
    expect(result).toMatchObject({ created: 0, moved: 1, updated: 1 });
    expect(result.conflicts).toEqual([]);
    expect(vault.files.has(originalPath)).toBe(false);
    expect(vault.files.get(renamedPath)?.file).toBe(originalEntry.file);
    expect(vault.files.get(renamedPath)?.content).toContain("# Renamed title");
    expect(vault.files.get(renamedPath)?.content).toContain("User-authored notes stay here.");
    expect(parseFrontmatter(vault.files.get(renamedPath)?.content ?? "")).toMatchObject({
      todoist_task_id: originalTask.id,
      todoist_content: "Renamed title",
    });
  });

  it.each([
    ["exact", "Sync/Task.md", "Task", "Sync/Task (2).md"],
    ["case-insensitive", "Sync/TASK.md", "Task", "Sync/Task (2).md"],
    ["Unicode-normalized", "Sync/Cafe\u0301.md", "Café", "Sync/Café (2).md"],
  ])("preserves an unmanaged %s filename collision and reuses one alternate path", async (_kind, unmanagedPath, taskTitle, managedPath) => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("collision-task", { content: taskTitle, project });
    const unmanaged = vault.addFile(unmanagedPath, "User-owned document\n");
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: project.id,
      projects: [project],
      tasks: [{ task, completed: false }],
      syncedAt: "2026-08-10T00:00:00.000Z",
    };

    const first = await adapter.reconcile(snapshot, mapping);
    const managed = vault.files.get(managedPath);

    expect(first).toMatchObject({ created: 1, moved: 0 });
    expect(first.conflicts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        path: managedPath,
        message: expect.stringContaining("occupied"),
      }),
    ]);
    expect(vault.files.get(unmanagedPath)?.file).toBe(unmanaged);
    expect(vault.files.get(unmanagedPath)?.content).toBe("User-owned document\n");
    expect(parseFrontmatter(managed?.content ?? "").todoist_task_id).toBe(task.id);

    const second = await adapter.reconcile(snapshot, mapping);

    expect(second).toMatchObject({ created: 0, moved: 0, unchanged: 1 });
    expect(vault.files.size).toBe(2);
    expect(vault.files.get(managedPath)?.file).toBe(managed?.file);
    expect(vault.files.has(managedPath.replace(" (2).md", " (3).md"))).toBe(false);
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
    const oldPath = "Old/Task.md";
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

    const newPath = "New/Task.md";
    expect(result).toMatchObject({ created: 0, moved: 1, settledMappingIds: [mapping.id] });
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.has(newPath)).toBe(true);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(newPath)?.file).toBe(oldEntry);
    expect(vault.files.get(newPath)?.content).toContain("User-authored notes stay here.");
  });

  it("resumes a multi-root migration and moves missing notes with their relative folders", async () => {
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

    const newPath = "Newest/Archived child/Missing task.md";
    expect(result).toMatchObject({ moved: 1, settledMappingIds: [mapping.id], updated: 1 });
    expect(vault.files.has(oldPath)).toBe(false);
    expect(vault.files.has(newPath)).toBe(true);
    expect(vault.folders.has("Newest/Archived child")).toBe(true);
    expect(parseFrontmatter(vault.files.get(newPath)?.content ?? "")).toMatchObject({
      todoist_sync_mapping_id: mapping.id,
      todoist_sync_missing_count: 1,
    });
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
    expect(vault.files.has("New/Open task.md")).toBe(false);
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
    expect(vault.files.has("New/Task.md")).toBe(true);
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
    const originalPath = "Sync/Moving task.md";
    const originalEntry = vault.files.get(originalPath);
    if (originalEntry === undefined) {
      throw new Error("Expected the original managed note");
    }
    originalEntry.content += "\nUser-authored notes stay here.\n";

    // Match service ordering where the old mapping is reconciled before the destination mapping.
    const scanToken = {};
    await adapter.reconcile(emptySnapshot(first), firstMapping, {
      assertValid: () => undefined,
      mappingRoots,
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
      { assertValid: () => undefined, mappingRoots, scanToken },
    );

    const destinationPath = "Archive/Moving task.md";
    expect(destination).toMatchObject({ created: 0, moved: 1 });
    expect(vault.files.has(originalPath)).toBe(false);
    expect(vault.files.has(destinationPath)).toBe(true);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(destinationPath)?.content).toContain("User-authored notes stay here.");
    expect(parseFrontmatter(vault.files.get(destinationPath)?.content ?? "")).toMatchObject({
      todoist_sync_root_id: second.id,
      todoist_project_id: second.id,
      todoist_sync_missing_count: 0,
      todoist_status: "active",
    });
  });

  it("shares one managed-note Vault scan across every mapping in the same sync run", async () => {
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
        `${currentMapping.folder}/${project.name}.md`,
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

    expect(read).toHaveBeenCalledTimes(2);
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
      "Archive/Moving task.md",
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

    const content = vault.files.get("Sync/Moving task.md")?.content ?? "";
    expect(vault.files.size).toBe(1);
    expect(parseFrontmatter(content)).toMatchObject({
      todoist_sync_mapping_id: destinationMapping.id,
      todoist_sync_root_id: destinationProject.id,
      todoist_sync_missing_count: 0,
      todoist_status: "active",
    });
  });

  it("preflights every configured folder synchronously", () => {
    expect(() => adapter.validateConfig(config)).not.toThrow();
    vault.folders.add("Archive");
    expect(() =>
      adapter.validateConfig({
        enabled: false,
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
    expect(vault.files.get("Elsewhere/Outside -- outside.md")?.content).toContain(
      "todoist_sync_missing_count: 0",
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
    const path = "Sync/Task.md";
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
    const targetPath = "Sync/Open legacy task.md";
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
    const path = "Sync/Original.md";
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

  it.each([
    "frontmatter",
    "body",
  ] as const)("checks cancellation after the %s mutation before starting the next stage", async (cancelAfter) => {
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
      "Sync/Original.md",
      renderNewTaskDocument(frontmatter, makeManagedBody(originalTask)),
    );

    let valid = true;
    if (cancelAfter === "frontmatter") {
      fileManager.afterProcessFrontMatter = () => {
        valid = false;
      };
    } else {
      vault.afterProcess = () => {
        valid = false;
      };
    }
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

    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    expect(vault.process).toHaveBeenCalledTimes(cancelAfter === "body" ? 1 : 0);
    expect(fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("marks a missing task stale on the second full miss and stops rewriting it", async () => {
    const project = makeProject("root", { name: "Root" });
    const task = makeTask("missing", { content: "Missing", project });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      project.id,
      testProjectPath(project),
      "2026-08-09T00:00:00.000Z",
    );
    const legacyPath = "Sync/Missing -- missing.md";
    const canonicalPath = "Sync/Missing.md";
    vault.addFile(legacyPath, renderNewTaskDocument(frontmatter, makeManagedBody(task)));

    const first = await adapter.reconcile(emptySnapshot(project), mapping);
    const second = await adapter.reconcile(emptySnapshot(project), mapping);
    const third = await adapter.reconcile(emptySnapshot(project), mapping);

    expect(first).toMatchObject({ moved: 1, stale: 0 });
    expect(second.stale).toBe(1);
    expect(third).toMatchObject({ moved: 0, updated: 0 });
    expect(vault.files.has(legacyPath)).toBe(false);
    const parsed = parseFrontmatter(vault.files.get(canonicalPath)?.content ?? "");
    expect(parsed).toMatchObject({
      todoist_sync_missing_count: 2,
      todoist_status: "stale",
    });
    expect(parsed.todoist_stale_since).toBeTypeOf("string");
  });

  it("marks former child-project notes out of scope and does not rewrite them again", async () => {
    const root = makeProject("root", { name: "Root" });
    const child = makeProject("child", { name: "Child", parentId: root.id });
    const task = makeTask("child-task", { content: "Child task", project: child });
    const frontmatter = makeTaskFrontmatter(
      { task, completed: false },
      root.id,
      testProjectPath(root, child),
      "2026-08-09T00:00:00.000Z",
    );
    frontmatter.todoist_status = "stale";
    frontmatter.todoist_sync_missing_count = 2;
    frontmatter.todoist_stale_since = "2026-08-09T12:00:00.000Z";
    const legacyPath = "Sync/Child/Child task -- child-task.md";
    const canonicalPath = "Sync/Child/Child task.md";
    vault.addFile(legacyPath, renderNewTaskDocument(frontmatter, makeManagedBody(task)));
    const rootOnlyMapping = { ...mapping, includeSubprojects: false };

    const first = await adapter.reconcile(emptySnapshot(root), rootOnlyMapping);
    const second = await adapter.reconcile(emptySnapshot(root), rootOnlyMapping);

    expect(first).toMatchObject({ moved: 1, outOfScope: 1, updated: 1, unchanged: 0, stale: 0 });
    expect(second).toMatchObject({ moved: 0, outOfScope: 1, updated: 0, unchanged: 1, stale: 0 });
    expect(vault.files.has(legacyPath)).toBe(false);
    expect(parseFrontmatter(vault.files.get(canonicalPath)?.content ?? "")).toMatchObject({
      todoist_status: "out_of_scope",
      todoist_sync_missing_count: 0,
    });
    expect(parseFrontmatter(vault.files.get(canonicalPath)?.content ?? "")).not.toHaveProperty(
      "todoist_stale_since",
    );
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
