import snakify from "snakify-ts";
import { z } from "zod";

import type { SyncResponse, SyncToken } from "@/api/domain/sync";
import { syncResponseSchema } from "@/api/domain/sync";
import type { CreateTaskParams, Task, TaskId } from "@/api/domain/task";
import { completedTaskSchema, taskSchema } from "@/api/domain/task";
import type { UserInfo } from "@/api/domain/user";
import { userInfoSchema } from "@/api/domain/user";
import { type RequestParams, StatusCode, type WebFetcher, type WebResponse } from "@/api/fetcher";
import { parseApiResponse } from "@/api/validation";
import { debug } from "@/log";

const COMPLETED_TASKS_LOOKBACK_DAYS = 90;
const COMPLETED_TASKS_PAGE_LIMIT = "200";
const MILLISECONDS_PER_DAY = 86_400_000;
const TODOIST_SERVICE_LAUNCH_AT = Date.parse("2007-01-01T00:00:00.000Z");

export const COMPLETED_TASKS_WINDOW_MONTHS = 3;

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

export class TodoistApiClient {
  private readonly token: string;
  private readonly fetcher: WebFetcher;
  private readonly taskQueriesInFlight = new Map<string, Promise<Task[]>>();
  private readonly completedTaskPagesInFlight = new Map<string, Promise<CompletedTasksPage>>();

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

  public async closeTask(id: TaskId): Promise<void> {
    await this.do(`/tasks/${id}/close`, "POST", {});
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
      return await this.doPaginated("/tasks/filter", taskSchema, { query: filter });
    }

    return await this.doPaginated("/tasks", taskSchema);
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
