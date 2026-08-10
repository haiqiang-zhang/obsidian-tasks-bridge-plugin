import type { MetadataCache, TFile, Vault } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateTaskParams } from "@/api/domain/task";
import { type TodoistAdapter, TodoistRemoteMutationFollowupError } from "@/data";
import { makeApiTask } from "@/factories/data";
import type { ProjectFolderSyncService } from "@/project-sync";
import type { ManagedFrontmatter } from "@/project-sync/document";
import type { ProjectSyncMapping, ProjectSyncResult } from "@/project-sync/types";

import {
  ProjectTaskCommandError,
  ProjectTaskCommandService,
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

const successResult = (): ProjectSyncResult => ({
  created: 0,
  updated: 1,
  moved: 0,
  unchanged: 0,
  stale: 0,
  outOfScope: 0,
  deferred: 0,
  conflicts: [],
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
  todoist_sync_managed: true,
  todoist_sync_mapping_id: MAPPING_ID,
  todoist_sync_root_id: ROOT_PROJECT_ID,
  todoist_sync_missing_count: 0,
  todoist_task_id: TASK_ID,
  todoist_project_id: "child-1",
  todoist_status: "active",
  ...overrides,
});

type HarnessOptions = {
  enabled?: boolean;
  filePath?: string;
  frontmatter?: ManagedFrontmatter | undefined;
  mappings?: ProjectSyncMapping[];
  ready?: boolean;
};

const makeHarness = (options: HarnessOptions = {}) => {
  const filePath = options.filePath ?? FILE_PATH;
  const file = { path: filePath, name: "Task.md" } as TFile;
  const frontmatter = "frontmatter" in options ? options.frontmatter : managedFrontmatter();
  const getFileByPath = vi.fn((_path: string) => file as TFile | null);
  const getFileCache = vi.fn(() => (frontmatter === undefined ? null : { frontmatter }));

  const task = makeApiTask({ id: TASK_ID, checked: false });
  const actions = {
    closeProjectTask: vi.fn(async (_id: string) => undefined),
    closeTask: vi.fn(async (_id: string) => undefined),
    getTask: vi.fn(async (_id: string) => task),
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
  const projectSync = { getConfig, invalidate, sync } as unknown as ProjectFolderSyncService;

  const service = new ProjectTaskCommandService(
    { getFileByPath } as unknown as Vault,
    { getFileCache } as unknown as MetadataCache,
    todoist,
    projectSync,
  );

  return {
    actions,
    file,
    getFileByPath,
    getFileCache,
    invalidate,
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
      name: "the note is not managed",
      options: { frontmatter: managedFrontmatter({ todoist_sync_managed: false }) },
      message: "This note is not the selected managed Todoist task",
    },
    {
      name: "the frontmatter task ID differs from the selected Base entry",
      options: { frontmatter: managedFrontmatter({ todoist_task_id: "other-task" }) },
      message: "This note is not the selected managed Todoist task",
    },
    {
      name: "the root project differs from the mapping",
      options: { frontmatter: managedFrontmatter({ todoist_sync_root_id: "other-root" }) },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "the mapping ID differs from the mapping",
      options: { frontmatter: managedFrontmatter({ todoist_sync_mapping_id: "other-mapping" }) },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "the note path is outside the mapping folder",
      options: { filePath: "Todoist/Root copy/Task.md" },
      message: "This managed task note does not belong to one configured Project sync mapping",
    },
    {
      name: "more than one mapping owns an identity without a mapping ID",
      options: {
        frontmatter: managedFrontmatter({ todoist_sync_mapping_id: undefined }),
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
  });

  it("completes only an active managed task and refreshes its projection", async () => {
    const harness = makeHarness();

    await expect(harness.service.completeTask(reference)).resolves.toBeUndefined();
    expect(harness.actions.closeProjectTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.invalidate).toHaveBeenCalledOnce();
    expect(harness.sync).toHaveBeenCalledOnce();

    const completed = makeHarness({
      frontmatter: managedFrontmatter({ todoist_status: "completed" }),
    });
    await expect(completed.service.completeTask(reference)).rejects.toThrow(
      "Only active tasks can be completed",
    );
    expect(completed.actions.closeProjectTask).not.toHaveBeenCalled();
  });

  it("reopens only a completed managed task and refreshes its projection", async () => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_status: "completed" }),
    });

    await expect(harness.service.reopenTask(reference)).resolves.toBeUndefined();
    expect(harness.actions.reopenTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.invalidate).toHaveBeenCalledOnce();
    expect(harness.sync).toHaveBeenCalledOnce();

    const active = makeHarness();
    await expect(active.service.reopenTask(reference)).rejects.toThrow(
      "Only completed tasks can be reopened",
    );
    expect(active.actions.reopenTask).not.toHaveBeenCalled();
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
      action: "reopenTask",
      invoke: (service: ProjectTaskCommandService) => service.reopenTask(reference),
    },
  ] as const)("does not start Project sync when remote $name fails", async (testCase) => {
    const harness = makeHarness({
      frontmatter: managedFrontmatter({ todoist_status: testCase.status }),
    });
    const remoteError = new Error("Todoist request failed");
    harness.actions[testCase.action].mockRejectedValue(remoteError);

    await expect(testCase.invoke(harness.service)).rejects.toBe(remoteError);
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
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

  it("accepts a non-blocking target conflict when the projection used a safe alternate path", async () => {
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

    await expect(harness.service.completeTask(reference)).resolves.toBeUndefined();
  });

  it("treats a null sync result as a post-mutation projection failure", async () => {
    const harness = makeHarness();
    harness.sync.mockResolvedValue(null);

    await expect(harness.service.completeTask(reference)).rejects.toMatchObject({
      constructor: ProjectTaskProjectionError,
      projectionCause: expect.objectContaining({
        message: "Project sync did not produce a Vault projection",
      }),
      remoteMutationSucceeded: true,
    });
    expect(harness.actions.closeProjectTask).toHaveBeenCalledOnce();
  });
});
