import snakify from "snakify-ts";
import { z } from "zod";

import type { ProjectId } from "@/api/domain/project";
import type { SyncResponse, SyncToken } from "@/api/domain/sync";
import { syncResponseSchema } from "@/api/domain/sync";
import type {
  CompletedTaskEntry,
  CreateTaskParams,
  ProjectCompletionEvent,
  Task,
  TaskId,
  UpdateTaskParams,
} from "@/api/domain/task";
import {
  completedTaskEntrySchema,
  completedTaskSchema,
  projectTaskSchema,
  taskSchema,
} from "@/api/domain/task";
import type { UserInfo } from "@/api/domain/user";
import { userInfoSchema } from "@/api/domain/user";
import { type RequestParams, StatusCode, type WebFetcher, type WebResponse } from "@/api/fetcher";
import { parseApiResponse } from "@/api/validation";
import { debug } from "@/log";

const COMPLETED_TASKS_LOOKBACK_DAYS = 90;
const COMPLETED_TASKS_PAGE_LIMIT = "200";
const TASKS_PAGE_LIMIT = "200";
const MILLISECONDS_PER_DAY = 86_400_000;
const TODOIST_SERVICE_LAUNCH_AT = Date.parse("2007-01-01T00:00:00.000Z");

export const COMPLETED_TASKS_WINDOW_MONTHS = 3;

const makeSubtaskFilter = (filter: string): string => `(${filter}) & subtask`;

export type { ProjectCompletionEvent } from "@/api/domain/task";

export type CompletedTasksPageRequest = {
  since: string;
  until: string;
  historyStart: string;
  cursor?: string;
};

export type CompletedTasksPage = {
  tasks: Task[];
  request: CompletedTasksPageRequest;
  nextPage: CompletedTasksPageRequest | null;
};

export type CompletedProjectTasks = Readonly<{
  tasks: readonly Task[];
  completionEvents: readonly ProjectCompletionEvent[];
}>;

export class TodoistApiClient {
  private readonly token: string;
  private readonly fetcher: WebFetcher;
  private readonly taskQueriesInFlight = new Map<string, Promise<Task[]>>();
  private readonly completedTaskPagesInFlight = new Map<string, Promise<CompletedTasksPage>>();
  private readonly activeProjectTasksInFlight = new Map<ProjectId, Promise<Task[]>>();
  private readonly completedProjectTasksInFlight = new Map<
    string,
    Promise<CompletedProjectTasks>
  >();

  constructor(token: string, fetcher: WebFetcher) {
    this.token = token;
    this.fetcher = fetcher;
  }

  public async getTasks(filter?: string): Promise<Task[]> {
    const requestKey = JSON.stringify({ filter: filter ?? null });
    const existingRequest = this.taskQueriesInFlight.get(requestKey);
    if (existingRequest !== undefined) {
      return await existingRequest;
    }

    const request = this.getActiveTasks(filter);
    this.taskQueriesInFlight.set(requestKey, request);

    try {
      return await request;
    } finally {
      if (this.taskQueriesInFlight.get(requestKey) === request) {
        this.taskQueriesInFlight.delete(requestKey);
      }
    }
  }

  public async getActiveTasksByProject(projectId: ProjectId): Promise<Task[]> {
    const existingRequest = this.activeProjectTasksInFlight.get(projectId);
    if (existingRequest !== undefined) {
      return await existingRequest;
    }

    const request = this.doPaginated("/tasks", projectTaskSchema, {
      project_id: projectId,
      limit: TASKS_PAGE_LIMIT,
    });
    this.activeProjectTasksInFlight.set(projectId, request);

    try {
      return await request;
    } finally {
      if (this.activeProjectTasksInFlight.get(projectId) === request) {
        this.activeProjectTasksInFlight.delete(projectId);
      }
    }
  }

  public async getCompletedTasksByProject(
    projectId: ProjectId,
    until?: string,
  ): Promise<CompletedProjectTasks> {
    const requestKey = JSON.stringify({ projectId, until: until ?? null });
    const existingRequest = this.completedProjectTasksInFlight.get(requestKey);
    if (existingRequest !== undefined) {
      return await existingRequest;
    }

    const request = this.fetchAllCompletedTasksByProject(
      projectId,
      until ?? new Date().toISOString(),
    );
    this.completedProjectTasksInFlight.set(requestKey, request);

    try {
      return await request;
    } finally {
      if (this.completedProjectTasksInFlight.get(requestKey) === request) {
        this.completedProjectTasksInFlight.delete(requestKey);
      }
    }
  }

  public async getCompletedTasksPage(
    filter?: string,
    request?: CompletedTasksPageRequest,
    completedTasksSince?: string,
  ): Promise<CompletedTasksPage> {
    const requestKey =
      request === undefined
        ? JSON.stringify({
            filter: filter ?? null,
            request: null,
            completedTasksSince: completedTasksSince ?? null,
          })
        : JSON.stringify({ filter: filter ?? null, request });
    const existingRequest = this.completedTaskPagesInFlight.get(requestKey);
    if (existingRequest !== undefined) {
      return await existingRequest;
    }

    const pageRequest = request ?? this.makeInitialCompletedTasksPageRequest(completedTasksSince);
    const page = this.fetchCompletedTasksWindow(filter, pageRequest);
    this.completedTaskPagesInFlight.set(requestKey, page);

    try {
      return await page;
    } finally {
      if (this.completedTaskPagesInFlight.get(requestKey) === page) {
        this.completedTaskPagesInFlight.delete(requestKey);
      }
    }
  }

  public async createTask(content: string, options?: CreateTaskParams): Promise<Task> {
    const body = snakify({
      content,
      ...(options ?? {}),
    });
    const response = await this.do("/tasks", "POST", { json: body });
    return parseApiResponse(taskSchema, response.body);
  }

  public async getTask(id: TaskId): Promise<Task> {
    const response = await this.do(`/tasks/${id}`, "GET", {});
    return parseApiResponse(projectTaskSchema, response.body);
  }

  public async updateTask(id: TaskId, options: UpdateTaskParams): Promise<Task> {
    const { duration, ...fields } = options;
    const bodyFields: Record<string, unknown> = { ...fields };
    if (duration === null) {
      bodyFields.duration = null;
      bodyFields.durationUnit = null;
    } else if (duration !== undefined) {
      bodyFields.duration = duration.amount;
      bodyFields.durationUnit = duration.unit;
    }
    const body = snakify(bodyFields);
    const response = await this.do(`/tasks/${id}`, "POST", { json: body });
    return parseApiResponse(projectTaskSchema, response.body);
  }

  public async closeTask(id: TaskId): Promise<void> {
    await this.do(`/tasks/${id}/close`, "POST", {});
  }

  public async reopenTask(id: TaskId): Promise<void> {
    await this.do(`/tasks/${id}/reopen`, "POST", {});
  }

  public async getUser(): Promise<UserInfo> {
    const response = await this.do("/user", "GET", {});
    return parseApiResponse(userInfoSchema, response.body);
  }

  public async sync(token: SyncToken): Promise<SyncResponse> {
    const queryParams = snakify({
      syncToken: token,
      resourceTypes: JSON.stringify(["projects", "labels", "sections"]),
    });
    const response = await this.do("/sync", "POST", { queryParams });
    return parseApiResponse(syncResponseSchema, response.body);
  }

  private async getActiveTasks(filter?: string): Promise<Task[]> {
    if (filter !== undefined) {
      const filteredTasks = await this.doPaginated("/tasks/filter", taskSchema, {
        query: filter,
        limit: TASKS_PAGE_LIMIT,
      });
      if (filter.length === 0) {
        return filteredTasks;
      }

      const subtaskTasks = await this.doPaginated("/tasks/filter", taskSchema, {
        query: makeSubtaskFilter(filter),
        limit: TASKS_PAGE_LIMIT,
      });
      if (filteredTasks.length === 0 && subtaskTasks.length === 0) {
        return [];
      }
      const activeTasks = await this.getAllActiveTasksSnapshot();

      return this.expandTaskSeedsWithActiveDescendants(filteredTasks, subtaskTasks, activeTasks);
    }

    return await this.getAllActiveTasksSnapshot();
  }

  private async getAllActiveTasksSnapshot(): Promise<Task[]> {
    const tasks = await this.doPaginated("/tasks", taskSchema, { limit: TASKS_PAGE_LIMIT });
    const tasksById = new Map<TaskId, Task>();
    for (const task of tasks) {
      tasksById.set(task.id, task);
    }
    return [...tasksById.values()];
  }

  private expandTaskSeedsWithActiveDescendants(
    filteredTasks: readonly Task[],
    subtaskTasks: readonly Task[],
    activeTasks: readonly Task[],
  ): Task[] {
    const activeTasksById = new Map<TaskId, Task>();
    for (const task of activeTasks) {
      // A later occurrence in the authoritative snapshot wins if Todoist
      // repeats an item across pages while its state is changing.
      activeTasksById.set(task.id, task);
    }

    const childIdsByParentId = new Map<TaskId, TaskId[]>();
    for (const task of activeTasksById.values()) {
      if (task.parentId === null) {
        continue;
      }

      const childIds = childIdsByParentId.get(task.parentId) ?? [];
      childIds.push(task.id);
      childIdsByParentId.set(task.parentId, childIds);
    }

    const includedTaskIds = new Set<TaskId>();
    const taskIdsInResultOrder: TaskId[] = [];
    const descendantQueue: TaskId[] = [];
    for (const seeds of [filteredTasks, subtaskTasks]) {
      for (const seed of seeds) {
        if (!activeTasksById.has(seed.id) || includedTaskIds.has(seed.id)) {
          continue;
        }

        includedTaskIds.add(seed.id);
        taskIdsInResultOrder.push(seed.id);
        descendantQueue.push(seed.id);
      }
    }

    for (const parentId of descendantQueue) {
      for (const childId of childIdsByParentId.get(parentId) ?? []) {
        if (includedTaskIds.has(childId)) {
          continue;
        }

        includedTaskIds.add(childId);
        taskIdsInResultOrder.push(childId);
        descendantQueue.push(childId);
      }
    }

    return taskIdsInResultOrder.map((taskId) => {
      const task = activeTasksById.get(taskId);
      if (task === undefined) {
        throw new Error(`Active task snapshot is missing included task '${taskId}'`);
      }
      return task;
    });
  }

  private async fetchAllCompletedTasksByProject(
    projectId: ProjectId,
    until: string,
  ): Promise<CompletedProjectTasks> {
    const responseSchema = z.object({
      items: z.array(completedTaskEntrySchema),
    });
    const entriesByTaskId = new Map<TaskId, CompletedTaskEntry>();
    const completionEventsById = new Map<string, ProjectCompletionEvent>();
    let offset = 0;

    while (true) {
      const response = await this.do("/tasks/completed", "GET", {
        queryParams: {
          project_id: projectId,
          limit: TASKS_PAGE_LIMIT,
          offset: offset.toString(),
          until,
          annotate_items: "true",
        },
      });
      const page = parseApiResponse(responseSchema, response.body);
      const eventCountBeforePage = completionEventsById.size;

      for (const entry of page.items) {
        if (!completionEventsById.has(entry.id)) {
          completionEventsById.set(entry.id, {
            id: entry.id,
            taskId: entry.taskId,
            projectId: entry.projectId,
            completedAt: entry.completedAt,
          });
        }
        const existingEntry = entriesByTaskId.get(entry.taskId);
        if (
          existingEntry === undefined ||
          this.compareCompletionEntries(entry, existingEntry) > 0
        ) {
          entriesByTaskId.set(entry.taskId, entry);
        }
      }

      if (
        page.items.length === Number(TASKS_PAGE_LIMIT) &&
        completionEventsById.size === eventCountBeforePage
      ) {
        throw new Error("Todoist completed-task pagination returned a repeated page");
      }

      if (page.items.length < Number(TASKS_PAGE_LIMIT)) {
        return {
          tasks: Array.from(entriesByTaskId.values(), (entry) => ({
            ...entry.itemObject,
            completedAt: entry.itemObject.checked ? entry.completedAt : null,
          })),
          completionEvents: [...completionEventsById.values()],
        };
      }

      offset += page.items.length;
    }
  }

  private compareCompletionEntries(
    candidate: CompletedTaskEntry,
    existing: CompletedTaskEntry,
  ): number {
    const completedAtDifference =
      Date.parse(candidate.completedAt) - Date.parse(existing.completedAt);
    if (completedAtDifference !== 0) {
      return completedAtDifference;
    }

    return candidate.id.localeCompare(existing.id);
  }

  private makeInitialCompletedTasksPageRequest(
    completedTasksSince?: string,
  ): CompletedTasksPageRequest {
    const until = new Date();
    const historyStart = this.getCompletedTasksHistoryStart(completedTasksSince, until);
    const since = new Date(
      Math.max(
        historyStart.getTime(),
        until.getTime() - COMPLETED_TASKS_LOOKBACK_DAYS * MILLISECONDS_PER_DAY,
      ),
    );

    return {
      since: since.toISOString(),
      until: until.toISOString(),
      historyStart: historyStart.toISOString(),
    };
  }

  private getCompletedTasksHistoryStart(
    completedTasksSince: string | undefined,
    until: Date,
  ): Date {
    if (completedTasksSince !== undefined) {
      const joinedAt = Date.parse(completedTasksSince);
      if (!Number.isNaN(joinedAt) && joinedAt <= until.getTime()) {
        return new Date(Math.max(joinedAt, TODOIST_SERVICE_LAUNCH_AT));
      }
    }

    return new Date(TODOIST_SERVICE_LAUNCH_AT);
  }

  private async doPaginated<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>,
  ): Promise<T[]> {
    const allResults: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    const paginatedSchema = z.object({
      results: z.array(schema),
      nextCursor: z.string().nullable(),
    });

    do {
      const queryParams: Record<string, string> = {
        ...(params ?? {}),
      };

      if (cursor) {
        queryParams.cursor = cursor;
      }

      const response = await this.do(path, "GET", { queryParams });
      const paginatedResponse = parseApiResponse(paginatedSchema, response.body);

      allResults.push(...paginatedResponse.results);
      cursor = paginatedResponse.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new Error("Todoist pagination returned a repeated cursor");
        }
        seenCursors.add(cursor);
      }
    } while (cursor);

    return allResults;
  }

  private async fetchCompletedTasksPage(
    filter: string | undefined,
    request: CompletedTasksPageRequest,
  ): Promise<CompletedTasksPage> {
    const paginatedSchema = z.object({
      items: z.array(completedTaskSchema),
      nextCursor: z.string().nullable().optional().default(null),
    });
    const queryParams: Record<string, string> = {
      since: request.since,
      until: request.until,
      limit: COMPLETED_TASKS_PAGE_LIMIT,
    };

    if (filter !== undefined && filter.length > 0) {
      queryParams.filter_query = filter;
    }
    if (request.cursor !== undefined) {
      queryParams.cursor = request.cursor;
    }

    const response = await this.do("/tasks/completed/by_completion_date", "GET", {
      queryParams,
    });
    const page = parseApiResponse(paginatedSchema, response.body);

    if (page.nextCursor !== null) {
      return {
        tasks: page.items,
        request,
        nextPage: {
          since: request.since,
          until: request.until,
          historyStart: request.historyStart,
          cursor: page.nextCursor,
        },
      };
    }

    return {
      tasks: page.items,
      request,
      nextPage: this.makeOlderCompletedTasksPageRequest(request),
    };
  }

  private async fetchCompletedTasksWindow(
    filter: string | undefined,
    request: CompletedTasksPageRequest,
  ): Promise<CompletedTasksPage> {
    const tasks: Task[] = [];
    const seenCursors = new Set<string>(request.cursor === undefined ? [] : [request.cursor]);
    let pageRequest = request;

    while (true) {
      const page = await this.fetchCompletedTasksPage(filter, pageRequest);
      tasks.push(...page.tasks);

      if (page.nextPage === null || page.nextPage.cursor === undefined) {
        return {
          tasks,
          request,
          nextPage: page.nextPage,
        };
      }

      const cursor = page.nextPage.cursor;
      if (seenCursors.has(cursor)) {
        throw new Error("Todoist completed-task pagination returned a repeated cursor");
      }
      seenCursors.add(cursor);
      pageRequest = page.nextPage;
    }
  }

  private makeOlderCompletedTasksPageRequest(
    request: CompletedTasksPageRequest,
  ): CompletedTasksPageRequest | null {
    const currentSince = Date.parse(request.since);
    const historyStart = Date.parse(request.historyStart);
    if (currentSince <= historyStart) {
      return null;
    }

    const since = new Date(
      Math.max(historyStart, currentSince - COMPLETED_TASKS_LOOKBACK_DAYS * MILLISECONDS_PER_DAY),
    );
    return {
      since: since.toISOString(),
      until: request.since,
      historyStart: request.historyStart,
    };
  }

  private async do(
    path: string,
    method: string,
    opts: { json?: object; queryParams?: Record<string, string> },
  ): Promise<WebResponse> {
    let queryString = "";
    if (opts.queryParams) {
      const urlParams = new URLSearchParams(opts.queryParams);
      queryString = `?${urlParams.toString()}`;
    }

    const params: RequestParams = {
      url: `https://api.todoist.com/api/v1${path}${queryString}`,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    };

    if (opts.json !== undefined) {
      params.body = JSON.stringify(opts.json);
      params.headers["Content-Type"] = "application/json";
    }

    debug({
      msg: "Sending Todoist API request",
      context: params,
    });

    const response = await this.fetcher.fetch(params);

    debug({
      msg: "Received Todoist API response",
      context: response,
    });

    if (StatusCode.isError(response.statusCode)) {
      throw new TodoistApiError(params, response);
    }

    return response;
  }
}

export class TodoistApiError extends Error {
  public statusCode: StatusCode;

  constructor(request: RequestParams, response: WebResponse) {
    const message = `[${request.method}] ${request.url} returned '${response.statusCode}: ${response.body}`;
    super(message);
    this.statusCode = response.statusCode;
  }
}
