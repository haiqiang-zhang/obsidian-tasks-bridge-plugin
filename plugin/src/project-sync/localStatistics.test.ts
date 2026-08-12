import type { TAbstractFile, TFile, Vault } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import { makeManagedBody, makeTaskFrontmatter, renderNewTaskDocument } from "./document";
import { projectHierarchyPath } from "./hierarchy";
import { ObsidianProjectSyncStatisticsRepository, projectCatalogPath } from "./localStatistics";
import type { ProjectSyncConfig, ProjectSyncMapping, ProjectSyncSnapshot } from "./types";

vi.mock("obsidian", async () => {
  const { load } = await import("js-yaml");
  return {
    normalizePath: (path: string) =>
      path
        .split("/")
        .filter((segment) => segment !== "")
        .join("/"),
    getFrontMatterInfo: (content: string) => {
      if (!content.startsWith("---\n")) {
        return { exists: false, frontmatter: "", contentStart: 0 };
      }
      const closing = content.indexOf("\n---\n", 4);
      return closing < 0
        ? { exists: false, frontmatter: "", contentStart: 0 }
        : {
            exists: true,
            frontmatter: content.slice(4, closing),
            contentStart: closing + 5,
          };
    },
    parseYaml: (yaml: string) => load(yaml),
  };
});

type FakeFile = TFile & { path: string; name: string };

class FakeVault {
  readonly files = new Map<string, { file: FakeFile; content: string }>();
  readonly folders = new Set<string>(["Todoist", "Todoist/Root"]);

  getFileByPath(path: string): FakeFile | null {
    return this.files.get(path)?.file ?? null;
  }

  getFolderByPath(path: string): TAbstractFile | null {
    const segments = path.split("/");
    return this.folders.has(path)
      ? ({ path, name: segments[segments.length - 1] ?? path } as TAbstractFile)
      : null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.getFolderByPath(path) ?? this.getFileByPath(path);
  }

  getMarkdownFiles(): FakeFile[] {
    return [...this.files.values()].map(({ file }) => file);
  }

  async createFolder(path: string): Promise<TAbstractFile> {
    this.folders.add(path);
    return this.getFolderByPath(path) as TAbstractFile;
  }

  async create(path: string, content: string): Promise<FakeFile> {
    const segments = path.split("/");
    const file = { path, name: segments[segments.length - 1] ?? path } as FakeFile;
    this.files.set(path, { file, content });
    return file;
  }

  async read(file: TFile): Promise<string> {
    const content = this.files.get(file.path)?.content;
    if (content === undefined) {
      throw new Error("Missing fake file");
    }
    return content;
  }

  async process(file: TFile, update: (content: string) => string): Promise<string> {
    const entry = this.files.get(file.path);
    if (entry === undefined) {
      throw new Error("Missing fake file");
    }
    entry.content = update(entry.content);
    return entry.content;
  }
}

const mapping: ProjectSyncMapping = {
  id: "mapping-root",
  project: { projectId: "root", projectName: "Root" },
  folder: "Todoist/Root",
  includeSubprojects: true,
  previousFolders: [],
};

const config: ProjectSyncConfig = { enabled: true, mappings: [mapping] };

describe("ObsidianProjectSyncStatisticsRepository", () => {
  let vault: FakeVault;
  let repository: ObsidianProjectSyncStatisticsRepository;
  const root = makeProject("root", { name: "Root" });
  const emptyChild = makeProject("empty", { name: "Empty", parentId: root.id, childOrder: 2 });

  beforeEach(() => {
    vault = new FakeVault();
    repository = new ObsidianProjectSyncStatisticsRepository(vault as unknown as Vault, config);
  });

  it("rebuilds cold-start statistics from the project catalog and task Markdown", async () => {
    const active = makeTask("active", { project: root });
    const completed = makeTask("completed", {
      completedAt: "2026-08-10T01:00:00.000Z",
      project: root,
    });
    const events = [
      {
        id: "completed-first",
        taskId: completed.id,
        projectId: root.id,
        completedAt: "2026-08-09T01:00:00.000Z",
      },
      {
        id: "completed-second",
        taskId: completed.id,
        projectId: root.id,
        completedAt: "2026-08-10T01:00:00.000Z",
      },
    ];
    const snapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root, emptyChild],
      tasks: [
        { task: active, completed: false },
        { task: completed, completed: true },
      ],
      completionEvents: events,
      syncedAt: "2026-08-12T01:00:00.000Z",
    };
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    await vault.create(
      "Todoist/Root/Active.md",
      renderNewTaskDocument(
        makeTaskFrontmatter(
          snapshot.tasks[0],
          root.id,
          projectHierarchyPath(root.id, projects),
          snapshot.syncedAt,
          mapping.id,
        ),
        makeManagedBody(active),
      ),
    );
    await vault.create(
      "Todoist/Root/Completed.md",
      renderNewTaskDocument(
        makeTaskFrontmatter(
          snapshot.tasks[1],
          root.id,
          projectHierarchyPath(root.id, projects),
          snapshot.syncedAt,
          mapping.id,
          events,
        ),
        makeManagedBody(completed),
      ),
    );
    await repository.persistProjectCatalog(snapshot, mapping, { assertValid: () => undefined });

    const afterRestart = new ObsidianProjectSyncStatisticsRepository(
      vault as unknown as Vault,
      config,
    );
    await afterRestart.refresh();

    expect(afterRestart.getSnapshot()).toEqual({
      syncedAt: snapshot.syncedAt,
      scopes: [
        expect.objectContaining({
          mappingId: mapping.id,
          rootProjectId: root.id,
          projects: [
            expect.objectContaining({
              id: root.id,
              directCounts: { active: 1, completed: 1 },
              directCompletionEvents: events,
            }),
            expect.objectContaining({
              id: emptyChild.id,
              directCounts: { active: 0, completed: 0 },
              directCompletionEvents: [],
            }),
          ],
        }),
      ],
    });
  });

  it("ignores stale notes and rejects catalog identity mismatches", async () => {
    const stale = makeTask("stale", { project: root });
    const frontmatter = makeTaskFrontmatter(
      { task: stale, completed: false },
      root.id,
      { ids: [root.id], names: [root.name] },
      "2026-08-12T01:00:00.000Z",
      mapping.id,
    );
    frontmatter.todoist_status = "stale";
    await vault.create(
      "Todoist/Root/Stale.md",
      renderNewTaskDocument(frontmatter, makeManagedBody(stale)),
    );
    await repository.persistProjectCatalog(
      {
        rootProjectId: root.id,
        projects: [root],
        tasks: [],
        syncedAt: "2026-08-12T01:00:00.000Z",
      },
      mapping,
      { assertValid: () => undefined },
    );
    await repository.refresh();
    expect(repository.getSnapshot()?.scopes[0]?.projects[0]?.directCounts).toEqual({
      active: 0,
      completed: 0,
    });

    const catalog = vault.files.get(projectCatalogPath(mapping.id));
    if (catalog === undefined) {
      throw new Error("Missing catalog");
    }
    catalog.content = catalog.content.replace(
      "tasks_bridge_mapping_id: mapping-root",
      "tasks_bridge_mapping_id: another-mapping",
    );
    repository.clearSnapshot();
    await repository.refresh();
    expect(repository.getSnapshot()).toBeNull();
  });

  it("restores locally projected completion events across restart", async () => {
    const task = makeTask("repeated", { project: root });
    const localEvent = {
      id: `local:${JSON.stringify([mapping.id, root.id, task.id, "2026-08-12T01:00:00.000Z"])}`,
      taskId: task.id,
      projectId: root.id,
      completedAt: "2026-08-12T01:00:00.000Z",
    };
    await vault.create(
      "Todoist/Root/Repeated.md",
      renderNewTaskDocument(
        makeTaskFrontmatter(
          { task, completed: false },
          root.id,
          { ids: [root.id], names: [root.name] },
          "2026-08-12T01:00:00.000Z",
          mapping.id,
          [localEvent],
        ),
        makeManagedBody(task),
      ),
    );
    const initialSnapshot: ProjectSyncSnapshot = {
      rootProjectId: root.id,
      projects: [root],
      tasks: [{ task, completed: false }],
      completionEvents: [],
      syncedAt: "2026-08-12T01:01:00.000Z",
    };
    await repository.persistProjectCatalog(initialSnapshot, mapping, {
      assertValid: () => undefined,
    });
    await repository.refresh();
    expect(repository.getSnapshot()?.scopes[0]?.projects[0]?.directCompletionEvents).toEqual([
      localEvent,
    ]);

    const afterRestart = new ObsidianProjectSyncStatisticsRepository(
      vault as unknown as Vault,
      config,
    );
    await afterRestart.refresh();
    expect(afterRestart.getSnapshot()?.scopes[0]?.projects[0]?.directCompletionEvents).toEqual([
      localEvent,
    ]);
  });
});
