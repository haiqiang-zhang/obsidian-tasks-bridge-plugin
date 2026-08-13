import type { FileManager, MetadataCache, TFile, Vault } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateTaskParams } from "@/api/domain/task";
import { type TodoistAdapter, TodoistRemoteMutationFollowupError } from "@/data";
import { makeApiTask } from "@/factories/data";
import type { ProjectFolderSyncService } from "@/project-sync";
import type { ProjectCatalog, ProjectCatalogStorage } from "@/project-sync/catalog";
import type { ManagedFrontmatter } from "@/project-sync/document";
import type { ProjectSyncMapping, ProjectSyncResult } from "@/project-sync/types";

import {
  ProjectTaskCommandError,
  ProjectTaskCommandService,
  type ProjectTaskProjectionCoordinator,
  ProjectTaskProjectionError,
} from "./projectTaskCommands";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) =>
    path
      .split("/")
      .filter((segment) => segment !== "")
      .join("/"),
}));

const TASK_ID = "task-1";
const ROOT_PROJECT_ID = "root-1";
const MAPPING_ID = "mapping-1";
const FILE_PATH = "Todoist/Root/Task.md";
const COMPLETED_AT = new Date("2026-08-10T05:00:00.000Z");

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const successResult = (): ProjectSyncResult => ({
  created: 0,
  updated: 1,
  moved: 0,
  unchanged: 0,
  stale: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
  pausedMappingIds: [],
  settledMappingIds: [MAPPING_ID],
});

const mapping = (overrides: Partial<ProjectSyncMapping> = {}): ProjectSyncMapping => ({
  id: MAPPING_ID,
  project: { projectId: ROOT_PROJECT_ID, projectName: "Root" },
  folder: "Todoist/Root",
  includeSubprojects: true,
  previousFolders: [],
  ...overrides,
});

const managedFrontmatter = (overrides: ManagedFrontmatter = {}): ManagedFrontmatter => ({
  todoist_task_id: TASK_ID,
  todoist_status: "active",
  ...overrides,
});

type HarnessOptions = {
  automaticProjectionAllowed?: boolean;
  availableRootProjectIds?: string[];
  enabled?: boolean;
  filePath?: string;
  frontmatter?: ManagedFrontmatter | undefined;
  mappings?: ProjectSyncMapping[];
  ready?: boolean;
  catalog?: ProjectCatalog | null;
};

const makeHarness = (options: HarnessOptions = {}) => {
  const filePath = options.filePath ?? FILE_PATH;
  const file = { path: filePath, name: "Task.md" } as TFile;
  const frontmatter = "frontmatter" in options ? options.frontmatter : managedFrontmatter();
  const getFileByPath = vi.fn((_path: string) => file as TFile | null);
  const getFileCache = vi.fn(() => (frontmatter === undefined ? null : { frontmatter }));
  const processFrontMatter = vi.fn(
    async (_file: TFile, update: (value: ManagedFrontmatter) => void): Promise<void> => {
      if (frontmatter === undefined) {
        throw new Error("Frontmatter is unavailable");
      }
      update(frontmatter);
    },
  );

  const task = makeApiTask({ id: TASK_ID, checked: false });
  const actions = {
    closeProjectTask: vi.fn(async (_id: string) => COMPLETED_AT),
    closeTask: vi.fn(async (_id: string) => undefined),
    getTask: vi.fn(async (_id: string) => task),
    reopenProjectTask: vi.fn(async (_id: string) => undefined),
    reopenTask: vi.fn(async (_id: string) => undefined),
    updateTask: vi.fn(async (_id: string, _params: UpdateTaskParams) => task),
  };
  const todoist = {
    actions,
    isReady: vi.fn(() => options.ready ?? true),
  } as unknown as TodoistAdapter;

  const invalidate = vi.fn(() => undefined);
  const sync = vi.fn(async () => successResult() as ProjectSyncResult | null);
  const getConfig = vi.fn(() => ({
    enabled: options.enabled ?? true,
    mappings: options.mappings ?? [mapping()],
  }));
  const listProjects = vi.fn(() =>
    (options.availableRootProjectIds ?? [ROOT_PROJECT_ID]).map((id) => ({ id })),
  );
  const projectSync = {
    getConfig,
    invalidate,
    listProjects,
    sync,
  } as unknown as ProjectFolderSyncService;
  const runAutomaticProjection = vi.fn(
    async <T>(operation: (assertValid: () => void) => Promise<T>) => {
      if (options.automaticProjectionAllowed === false) {
        return { performed: false } as const;
      }
      return { performed: true, value: await operation(() => undefined) } as const;
    },
  );
  const runInternalMutation = vi.fn(
    async <T>(_affectedPaths: readonly string[], operation: () => Promise<T>) => await operation(),
  );
  const projectionCoordinator = {
    runAutomaticProjection,
    runInternalMutation,
  } as ProjectTaskProjectionCoordinator;
  let catalog =
    "catalog" in options
      ? options.catalog
      : ({
          mappingId: MAPPING_ID,
          rootProjectId: ROOT_PROJECT_ID,
          includeSubprojects: true,
          syncedAt: "2026-08-10T00:00:00.000Z",
          projects: [
            { id: ROOT_PROJECT_ID, parentId: null, name: "Root", childOrder: 0 },
            { id: "child-1", parentId: ROOT_PROJECT_ID, name: "Child", childOrder: 0 },
          ],
          tasks: [{ id: TASK_ID, projectId: "child-1", order: 0 }],
          completionEvents: [],
        } satisfies ProjectCatalog);
  const persistCatalogs = vi.fn(async (catalogs: readonly ProjectCatalog[]) => {
    const incoming = catalogs.find((candidate) => candidate.mappingId === MAPPING_ID);
    if (incoming !== undefined) {
      catalog = structuredClone(incoming);
    }
  });
  const catalogStorage: ProjectCatalogStorage = {
    getCatalog: (mappingId) => (catalog?.mappingId === mappingId ? structuredClone(catalog) : null),
    persistCatalogs,
  };

  const service = new ProjectTaskCommandService(
    { getFileByPath } as unknown as Vault,
    { processFrontMatter } as unknown as FileManager,
    { getFileCache } as unknown as MetadataCache,
    todoist,
    projectSync,
    projectionCoordinator,
    catalogStorage,
  );

  return {
    actions,
    file,
    getFileByPath,
    getFileCache,
    invalidate,
    listProjects,
    get catalog() {
      return catalog;
    },
    persistCatalogs,
    frontmatter,
    processFrontMatter,
    runAutomaticProjection,
    runInternalMutation,
    service,
    sync,
    task,
  };
};

const reference = { id: TASK_ID, filePath: FILE_PATH };

describe("ProjectTaskCommandService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports readiness only when Todoist and Project sync are both ready", () => {
    expect(makeHarness().service.isReady()).toBe(true);
    expect(makeHarness({ ready: false }).service.isReady()).toBe(false);
    expect(makeHarness({ enabled: false }).service.isReady()).toBe(false);
    expect(makeHarness({ availableRootProjectIds: [] }).service.isReady()).toBe(false);
  });

  it("applies a changed todoist_completed property through the existing complete action", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: true, todoist_status: "active" }),
    });

    await harness.service.applyCompletedProperty(reference, true);

    expect(harness.actions.closeProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: true,
      todoist_status: "completed",
    });
  });

  it("applies an unchecked todoist_completed property through the existing reopen action", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: false, todoist_status: "completed" }),
    });

    await harness.service.applyCompletedProperty(reference, false);

    expect(harness.actions.reopenProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: false,
      todoist_status: "active",
    });
  });

  it("restores todoist_completed when Todoist rejects a property mutation", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: true, todoist_status: "active" }),
    });
    harness.actions.closeProjectTask.mockRejectedValueOnce(new Error("Todoist unavailable"));

    await expect(harness.service.applyCompletedProperty(reference, true)).rejects.toThrow(
      "Todoist unavailable",
    );

    expect(harness.frontmatter).toMatchObject({
      todoist_completed: false,
      todoist_status: "active",
    });
    expect(harness.runInternalMutation).toHaveBeenCalled();
  });

  it("preserves a newer completion-property edit when the rejected request rolls back", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: true, todoist_status: "active" }),
    });
    const remoteMutation = deferred<Date>();
    harness.actions.closeProjectTask.mockReturnValueOnce(remoteMutation.promise);

    const mutation = harness.service.applyCompletedProperty(reference, true);
    if (harness.frontmatter === undefined) {
      throw new Error("Expected managed frontmatter");
    }
    harness.frontmatter.todoist_completed = false;
    remoteMutation.reject(new Error("Todoist unavailable"));

    await expect(mutation).rejects.toThrow("Todoist unavailable");
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: false,
      todoist_status: "active",
    });
  });

  it("uses a confirmed remote status when the metadata cache has not indexed the prior projection", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: false, todoist_status: "active" }),
    });

    const result = await harness.service.applyCompletedProperty(reference, false, "completed");

    expect(result).not.toBeNull();
    expect(harness.actions.reopenProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.actions.closeProjectTask).not.toHaveBeenCalled();
    await expect(result?.targetedProjection).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "Todoist is unavailable",
      options: { ready: false },
      message: "Todoist is not ready yet",
    },
    {
      name: "Project sync is disabled",
      options: { enabled: false },
      message: "Project sync is disabled",
    },
    {
      name: "the metadata cache is not ready",
      options: { frontmatter: undefined },
      message: "The managed task note metadata is not ready yet",
    },
    {
      name: "the note has no Todoist task ID",
      options: { frontmatter: { todoist_status: "active" } },
      message: "This note is not the selected managed Todoist task",
    },
    {
      name: "the frontmatter task ID differs from the selected Base entry",
      options: { frontmatter: managedFrontmatter({ todoist_task_id: "other-task" }) },
      message: "This note is not the selected managed Todoist task",
    },
    {
      name: "the mapping belongs to a project unavailable in the current account",
      options: { availableRootProjectIds: [] },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "the task is absent from the selected project catalog",
      options: { catalog: null },
      message: "This task is unavailable until Project sync confirms its Todoist project",
    },
    {
      name: "the note path is outside the mapping folder",
      options: { filePath: "Todoist/Root copy/Task.md" },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "more than one mapping owns an identity without a mapping ID",
      options: {
        mappings: [mapping(), mapping({ id: "mapping-2" })],
      },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "the managed status is unavailable",
      options: { frontmatter: managedFrontmatter({ todoist_status: "stale" }) },
      message: "This task is unavailable until Project sync restores it",
    },
  ])("rejects before Todoist access when $name", async ({ options, message }) => {
    const harness = makeHarness(options);

    await expect(harness.service.loadEditableTask(reference)).rejects.toMatchObject({
      constructor: ProjectTaskCommandError,
      message,
    });
    expect(harness.actions.getTask).not.toHaveBeenCalled();
  });

  it("rejects a missing managed note before reading metadata", async () => {
    const harness = makeHarness();
    harness.getFileByPath.mockReturnValue(null);

    await expect(harness.service.loadEditableTask(reference)).rejects.toMatchObject({
      constructor: ProjectTaskCommandError,
      message: "The managed task note no longer exists",
    });
    expect(harness.getFileCache).not.toHaveBeenCalled();
    expect(harness.actions.getTask).not.toHaveBeenCalled();
  });

  it("accepts an exact mapping through one of its recorded previous folders", async () => {
    const previousPath = "Todoist/Previous Root/Task.md";
    const harness = makeHarness({
      filePath: previousPath,
      mappings: [
        mapping({ folder: "Todoist/New Root", previousFolders: ["Todoist/Previous Root"] }),
      ],
    });

    await expect(
      harness.service.loadEditableTask({ id: TASK_ID, filePath: previousPath }),
    ).resolves.toEqual(harness.task);
    expect(harness.actions.getTask).toHaveBeenCalledWith(TASK_ID);
  });

  it("loads the canonical active Todoist task for editing", async () => {
    const harness = makeHarness();

    await expect(harness.service.loadEditableTask(reference)).resolves.toEqual(harness.task);
    expect(harness.actions.getTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it.each([
    ["a different task", makeApiTask({ id: "other-task", checked: false })],
    ["a completed task", makeApiTask({ id: TASK_ID, checked: true })],
  ])("rejects editing when Todoist returns %s", async (_name, returnedTask) => {
    const harness = makeHarness();
    harness.actions.getTask.mockResolvedValue(returnedTask);

    await expect(harness.service.loadEditableTask(reference)).rejects.toMatchObject({
      constructor: ProjectTaskCommandError,
      message:
        "The Todoist task changed while it was being prepared for editing. Synchronize and try again.",
    });
  });

  it("updates an active task remotely, then invalidates and refreshes its Vault projection", async () => {
    const harness = makeHarness();
    const params: UpdateTaskParams = {
      content: "Updated task",
      description: "Updated description",
      labels: ["work"],
      priority: 4,
    };

    await expect(harness.service.updateTask(reference, params)).resolves.toEqual(harness.task);
    expect(harness.actions.updateTask).toHaveBeenCalledWith(TASK_ID, params);
    expect(harness.actions.updateTask.mock.invocationCallOrder[0]).toBeLessThan(
      harness.invalidate.mock.invocationCallOrder[0],
    );
    expect(harness.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sync.mock.invocationCallOrder[0],
    );
    expect(harness.runAutomaticProjection).toHaveBeenCalledWith(expect.any(Function));
    expect(harness.runInternalMutation).not.toHaveBeenCalled();
  });

  it("updates Todoist without writing or reconciling when automatic projection is cancelled", async () => {
    const harness = makeHarness({ automaticProjectionAllowed: false });
    const params: UpdateTaskParams = { content: "Updated remotely" };

    await expect(harness.service.updateTask(reference, params)).resolves.toEqual(harness.task);

    expect(harness.actions.updateTask).toHaveBeenCalledWith(TASK_ID, params);
    expect(harness.runAutomaticProjection).toHaveBeenCalledOnce();
    expect(harness.runInternalMutation).not.toHaveBeenCalled();
    expect(harness.processFrontMatter).not.toHaveBeenCalled();
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("completes only an active managed task and atomically projects its status", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({
        todoist_completed: false,
      }),
    });

    const result = await harness.service.completeTask(reference);
    await expect(result.projection).resolves.toBeUndefined();

    expect(harness.actions.closeProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.processFrontMatter).toHaveBeenCalledWith(harness.file, expect.any(Function));
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: true,
      todoist_completed_at: COMPLETED_AT.toISOString(),
      todoist_status: "completed",
      todoist_synced_at: expect.any(String),
    });
    expect(harness.catalog?.completionEvents).toEqual([
      {
        id: expect.stringMatching(/^local:/u),
        taskId: TASK_ID,
        projectId: "child-1",
        completedAt: COMPLETED_AT.toISOString(),
      },
    ]);
    expect(harness.invalidate).toHaveBeenCalledOnce();
    expect(harness.actions.closeProjectTask.mock.invocationCallOrder[0]).toBeLessThan(
      harness.invalidate.mock.invocationCallOrder[0],
    );
    expect(harness.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.processFrontMatter.mock.invocationCallOrder[0],
    );
    await vi.waitFor(() => expect(harness.sync).toHaveBeenCalledOnce());

    const completed = makeHarness({
      frontmatter: managedFrontmatter({ todoist_status: "completed" }),
    });
    await expect(completed.service.completeTask(reference)).rejects.toThrow(
      "Only active tasks can be completed",
    );
    expect(completed.actions.closeProjectTask).not.toHaveBeenCalled();
  });

  it("returns after the remote status mutation without awaiting full sync or an open-note delay", async () => {
    const harness = makeHarness();
    const remoteMutation = deferred<Date>();
    const fullSyncOrOpenNoteDelay = deferred<ProjectSyncResult | null>();
    harness.actions.closeProjectTask.mockReturnValueOnce(remoteMutation.promise);
    harness.sync.mockReturnValueOnce(fullSyncOrOpenNoteDelay.promise);

    const mutation = harness.service.setCompleted(reference, true);
    let remoteSettled = false;
    void mutation.then(() => {
      remoteSettled = true;
    });
    await Promise.resolve();

    expect(remoteSettled).toBe(false);
    expect(harness.sync).not.toHaveBeenCalled();

    remoteMutation.resolve(COMPLETED_AT);
    const result = await mutation;

    expect(harness.actions.closeProjectTask).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.sync).toHaveBeenCalledOnce());

    let projectionSettled = false;
    void result.projection.then(() => {
      projectionSettled = true;
    });
    await Promise.resolve();
    expect(projectionSettled).toBe(false);

    fullSyncOrOpenNoteDelay.resolve(successResult());
    await expect(result.projection).resolves.toBeUndefined();
  });

  it("preserves a newer inverse property intent during targeted projection", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_completed: true, todoist_status: "active" }),
    });
    const remoteMutation = deferred<Date>();
    harness.actions.closeProjectTask.mockReturnValueOnce(remoteMutation.promise);

    const mutation = harness.service.applyCompletedProperty(reference, true);
    if (harness.frontmatter === undefined) {
      throw new Error("Expected managed frontmatter");
    }
    harness.frontmatter.todoist_completed = false;
    remoteMutation.resolve(COMPLETED_AT);
    const result = await mutation;

    expect(result).not.toBeNull();
    await expect(result?.targetedProjection).resolves.toBeUndefined();
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: false,
      todoist_status: "completed",
    });
  });

  it.each([
    {
      name: "complete",
      initial: managedFrontmatter({ todoist_completed: false, todoist_status: "active" }),
      action: "closeProjectTask",
      followupAction: "closeProjectTask",
      completed: true,
      expectedStatus: "completed",
    },
    {
      name: "reopen",
      initial: managedFrontmatter({
        todoist_completed: true,
        todoist_completed_at: COMPLETED_AT.toISOString(),
        todoist_status: "completed",
      }),
      action: "reopenProjectTask",
      followupAction: "reopenProjectTask",
      completed: false,
      expectedStatus: "active",
    },
  ] as const)("projects a direct $name after Todoist succeeds but its adapter follow-up fails", async ({
    initial,
    action,
    followupAction,
    completed,
    expectedStatus,
  }) => {
    const harness = makeHarness({ frontmatter: initial });
    const followupCause = new Error("Subscription callback failed");
    const followupError = new TodoistRemoteMutationFollowupError(followupAction, followupCause);
    harness.actions[action].mockRejectedValueOnce(followupError);

    const result = completed
      ? await harness.service.completeTask(reference)
      : await harness.service.reopenTask(reference);

    await expect(result.targetedProjection).resolves.toBeUndefined();
    await expect(result.projection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: followupError,
    });
    expect(harness.actions[action]).toHaveBeenCalledOnce();
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: completed,
      todoist_status: expectedStatus,
    });
  });

  it.each([
    {
      name: "complete",
      initial: managedFrontmatter({ todoist_completed: true, todoist_status: "active" }),
      action: "closeProjectTask",
      followupAction: "closeProjectTask",
      completed: true,
      expectedStatus: "completed",
    },
    {
      name: "reopen",
      initial: managedFrontmatter({ todoist_completed: false, todoist_status: "completed" }),
      action: "reopenProjectTask",
      followupAction: "reopenProjectTask",
      completed: false,
      expectedStatus: "active",
    },
  ] as const)("returns a projected property $name result without retrying a confirmed remote mutation", async ({
    initial,
    action,
    followupAction,
    completed,
    expectedStatus,
  }) => {
    const harness = makeHarness({ frontmatter: initial });
    const followupError = new TodoistRemoteMutationFollowupError(
      followupAction,
      new Error("Subscription callback failed"),
    );
    harness.actions[action].mockRejectedValueOnce(followupError);

    const result = await harness.service.applyCompletedProperty(reference, completed);

    expect(result).not.toBeNull();
    await expect(result?.targetedProjection).resolves.toBeUndefined();
    await expect(result?.projection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: followupError,
    });
    expect(harness.actions[action]).toHaveBeenCalledOnce();
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: completed,
      todoist_status: expectedStatus,
    });
  });

  it("reopens only a completed managed task and atomically projects its status", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({
        todoist_completed: true,
        todoist_completed_at: COMPLETED_AT.toISOString(),
        todoist_status: "completed",
      }),
    });

    const result = await harness.service.reopenTask(reference);
    await expect(result.projection).resolves.toBeUndefined();

    expect(harness.actions.reopenProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.frontmatter).toMatchObject({
      todoist_completed: false,
      todoist_status: "active",
      todoist_synced_at: expect.any(String),
    });
    expect(harness.frontmatter).not.toHaveProperty("todoist_completed_at");
    expect(harness.invalidate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.sync).toHaveBeenCalledOnce());

    const active = makeHarness();
    await expect(active.service.reopenTask(reference)).rejects.toThrow(
      "Only completed tasks can be reopened",
    );
    expect(active.actions.reopenProjectTask).not.toHaveBeenCalled();
  });

  it("retains every local completion occurrence after reopening and completing again", async () => {
    const harness = makeHarness();
    if (harness.frontmatter === undefined) {
      throw new Error("Expected managed frontmatter");
    }

    const first = await harness.service.completeTask(reference);
    await first.projection;
    harness.frontmatter.todoist_status = "completed";
    const reopened = await harness.service.reopenTask(reference);
    await reopened.projection;
    harness.frontmatter.todoist_status = "active";
    harness.actions.closeProjectTask.mockResolvedValueOnce(new Date("2026-08-11T05:00:00.000Z"));
    const second = await harness.service.completeTask(reference);
    await second.projection;

    expect(harness.catalog?.completionEvents).toEqual([
      expect.objectContaining({ completedAt: "2026-08-10T05:00:00.000Z" }),
      expect.objectContaining({ completedAt: "2026-08-11T05:00:00.000Z" }),
    ]);
  });

  it.each([
    {
      name: "complete",
      status: "active",
      action: "closeProjectTask",
      invoke: (service: ProjectTaskCommandService) => service.completeTask(reference),
    },
    {
      name: "reopen",
      status: "completed",
      action: "reopenProjectTask",
      invoke: (service: ProjectTaskCommandService) => service.reopenTask(reference),
    },
  ] as const)("changes Todoist for $name and rejects both projection milestones when automatic projection is cancelled", async (testCase) => {
    const harness = makeHarness({
      automaticProjectionAllowed: false,
      frontmatter: managedFrontmatter({ todoist_status: testCase.status }),
    });

    const result = await testCase.invoke(harness.service);
    await expect(result.targetedProjection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "Automatic Vault projection was deferred",
      }),
    });
    await expect(result.projection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "Automatic Vault projection was deferred",
      }),
    });

    expect(harness.actions[testCase.action]).toHaveBeenCalledWith(TASK_ID);
    expect(harness.runAutomaticProjection).toHaveBeenCalledOnce();
    expect(harness.runInternalMutation).not.toHaveBeenCalled();
    expect(harness.processFrontMatter).not.toHaveBeenCalled();
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("limits targeted projection suppression to the exact managed note path", async () => {
    const harness = makeHarness({
      mappings: [
        mapping({ previousFolders: ["Todoist/Previous Root"] }),
        mapping({
          folder: "Todoist/Other",
          id: "mapping-2",
          previousFolders: ["Todoist/Other Previous"],
          project: { projectId: "root-2", projectName: "Other" },
        }),
      ],
    });

    const result = await harness.service.completeTask(reference);
    await expect(result.targetedProjection).resolves.toBeUndefined();
    await expect(result.projection).resolves.toBeUndefined();

    expect(harness.runAutomaticProjection).toHaveBeenCalledWith(expect.any(Function));
    expect(harness.runInternalMutation).toHaveBeenCalledWith([FILE_PATH], expect.any(Function));
  });

  it("keeps targeted status projection and canonical reconciliation in one coordinated write", async () => {
    const harness = makeHarness();
    const projectionWrite = deferred<void>();
    const canonicalSync = deferred<ProjectSyncResult | null>();
    harness.processFrontMatter.mockImplementationOnce(async (_file, update) => {
      if (harness.frontmatter === undefined) {
        throw new Error("Frontmatter is unavailable");
      }
      update(harness.frontmatter);
      await projectionWrite.promise;
    });
    harness.sync.mockReturnValueOnce(canonicalSync.promise);

    const result = await harness.service.completeTask(reference);

    expect(harness.invalidate).toHaveBeenCalledOnce();
    expect(harness.sync).not.toHaveBeenCalled();

    projectionWrite.resolve(undefined);
    await vi.waitFor(() => expect(harness.sync).toHaveBeenCalledOnce());
    expect(harness.runAutomaticProjection).toHaveBeenCalledOnce();

    let projectionSettled = false;
    void result.projection.finally(() => {
      projectionSettled = true;
    });
    await Promise.resolve();
    expect(projectionSettled).toBe(false);

    canonicalSync.resolve(successResult());
    await expect(result.projection).resolves.toBeUndefined();
  });

  it("does not write or reconcile when coordinator validity is lost before the atomic callback", async () => {
    const harness = makeHarness();
    const policyLost = new Error("Automatic projection policy changed");
    let validityChecks = 0;
    harness.runAutomaticProjection.mockImplementationOnce(async (operation) => {
      try {
        const value = await operation(() => {
          validityChecks++;
          if (validityChecks >= 2) {
            throw policyLost;
          }
        });
        return { performed: true, value } as const;
      } catch (error: unknown) {
        if (error === policyLost) {
          return { performed: false } as const;
        }
        throw error;
      }
    });

    const result = await harness.service.completeTask(reference);
    await expect(result.targetedProjection).rejects.toBeInstanceOf(ProjectTaskProjectionError);
    await expect(result.projection).rejects.toBeInstanceOf(ProjectTaskProjectionError);

    expect(validityChecks).toBe(3);
    expect(harness.processFrontMatter).toHaveBeenCalledOnce();
    expect(harness.frontmatter).toMatchObject({ todoist_status: "active" });
    expect(harness.frontmatter).not.toHaveProperty("todoist_completed");
    expect(harness.frontmatter).not.toHaveProperty("todoist_completed_at");
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("wraps an atomic status projection failure after the remote mutation succeeds", async () => {
    const harness = makeHarness();
    const projectionCause = new Error("Vault is read-only");
    harness.processFrontMatter.mockRejectedValueOnce(projectionCause);

    const result = await harness.service.completeTask(reference);

    await expect(result.targetedProjection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause,
    });
    await expect(result.projection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      message: "Todoist was updated, but the Vault projection could not be refreshed",
      projectionCause,
      remoteMutationSucceeded: true,
    });
    expect(harness.actions.closeProjectTask).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.sync).toHaveBeenCalledOnce());
  });

  it("revalidates the managed note identity inside the atomic projection", async () => {
    const harness = makeHarness();
    harness.processFrontMatter.mockImplementationOnce(async (_file, update) => {
      if (harness.frontmatter === undefined) {
        throw new Error("Frontmatter is unavailable");
      }
      harness.frontmatter.todoist_task_id = "replacement-task";
      update(harness.frontmatter);
    });

    const result = await harness.service.completeTask(reference);

    await expect(result.projection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "The managed Todoist task identity changed before its status was projected",
      }),
      remoteMutationSucceeded: true,
    });
    await expect(result.targetedProjection).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "The managed Todoist task identity changed before its status was projected",
      }),
    });
    expect(harness.frontmatter).not.toHaveProperty("todoist_completed_at");
  });

  it("logs a queued canonical sync failure without rejecting the targeted projection", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({
        todoist_completed: true,
        todoist_completed_at: COMPLETED_AT.toISOString(),
        todoist_status: "completed",
      }),
    });
    const syncError = new Error("Canonical sync failed");
    harness.sync.mockRejectedValueOnce(syncError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await harness.service.reopenTask(reference);
      await expect(result.projection).resolves.toBeUndefined();
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "Background Project sync failed after a Todoist task status change:",
          syncError,
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    {
      name: "update",
      status: "active",
      action: "updateTask",
      invoke: (service: ProjectTaskCommandService) => service.updateTask(reference, {}),
    },
    {
      name: "complete",
      status: "active",
      action: "closeProjectTask",
      invoke: (service: ProjectTaskCommandService) => service.completeTask(reference),
    },
    {
      name: "reopen",
      status: "completed",
      action: "reopenProjectTask",
      invoke: (service: ProjectTaskCommandService) => service.reopenTask(reference),
    },
  ] as const)("does not start Project sync when remote $name fails", async (testCase) => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_status: testCase.status }),
    });
    const remoteError = new Error("Todoist request failed");
    harness.actions[testCase.action].mockRejectedValue(remoteError);

    await expect(testCase.invoke(harness.service)).rejects.toBe(remoteError);
    expect(harness.processFrontMatter).not.toHaveBeenCalled();
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
    expect(harness.runAutomaticProjection).not.toHaveBeenCalled();
  });

  it("wraps projection failure after a successful remote mutation without hiding its cause", async () => {
    const harness = makeHarness();
    const projectionCause = new Error("Vault is read-only");
    harness.sync.mockRejectedValue(projectionCause);

    const mutation = harness.service.updateTask(reference, { content: "Already updated" });

    await expect(mutation).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      message: "Todoist was updated, but the Vault projection could not be refreshed",
      projectionCause,
      remoteMutationSucceeded: true,
    });
    expect(harness.actions.updateTask).toHaveBeenCalledOnce();
    expect(harness.invalidate).toHaveBeenCalledOnce();
    expect(harness.sync).toHaveBeenCalledOnce();
  });

  it("does not retry or sync after a confirmed remote mutation has a local follow-up failure", async () => {
    const harness = makeHarness();
    const followupCause = new Error("A query callback failed");
    const followupError = new TodoistRemoteMutationFollowupError("updateTask", followupCause);
    harness.actions.updateTask.mockRejectedValue(followupError);

    await expect(
      harness.service.updateTask(reference, { content: "Already updated remotely" }),
    ).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: followupError,
      remoteMutationSucceeded: true,
    });
    expect(harness.actions.updateTask).toHaveBeenCalledOnce();
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
    expect(harness.runAutomaticProjection).not.toHaveBeenCalled();
  });

  it("reports a deferred target note as a post-mutation projection failure", async () => {
    const harness = makeHarness();
    harness.sync.mockResolvedValue({
      ...successResult(),
      deferred: 1,
      conflicts: [
        {
          taskId: TASK_ID,
          path: FILE_PATH,
          message: `Managed note '${FILE_PATH}' is open in an editor; synchronization was deferred`,
          deferred: true,
          projectionBlocked: true,
        },
      ],
    });

    await expect(
      harness.service.updateTask(reference, { description: "Already updated remotely" }),
    ).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: expect.stringContaining("synchronization was deferred"),
      }),
      remoteMutationSucceeded: true,
    });
  });

  it("reports a non-deferred target conflict that blocked the post-mutation projection", async () => {
    const harness = makeHarness();
    harness.sync.mockResolvedValue({
      ...successResult(),
      updated: 0,
      conflicts: [
        {
          taskId: TASK_ID,
          path: FILE_PATH,
          message: "The managed Todoist body markers are malformed",
          projectionBlocked: true,
        },
      ],
    });

    await expect(
      harness.service.updateTask(reference, { content: "Already updated remotely" }),
    ).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "The managed Todoist body markers are malformed",
      }),
      remoteMutationSucceeded: true,
    });
  });

  it("accepts a non-blocking target conflict when the canonical update used a safe alternate path", async () => {
    const harness = makeHarness();
    harness.sync.mockResolvedValue({
      ...successResult(),
      conflicts: [
        {
          taskId: TASK_ID,
          path: "Todoist/Root/Task (2).md",
          message: "The preferred path was occupied; a safe alternate path was used",
        },
      ],
    });

    await expect(harness.service.updateTask(reference, {})).resolves.toEqual(harness.task);
  });

  it("treats a null sync result as a post-mutation projection failure", async () => {
    const harness = makeHarness();
    harness.sync.mockResolvedValue(null);

    await expect(harness.service.updateTask(reference, {})).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "Project sync did not produce a Vault projection",
      }),
      remoteMutationSucceeded: true,
    });
    expect(harness.actions.updateTask).toHaveBeenCalledOnce();
  });
});
