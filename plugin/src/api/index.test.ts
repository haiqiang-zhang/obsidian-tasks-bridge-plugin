import { describe, expect, it, vi } from "vitest";

import type { RequestParams, WebFetcher, WebResponse } from "@/api/fetcher";
import { TodoistApiClient, TodoistApiError } from "@/api/index";

function parseUrl(url: string) {
  const parsed = new URL(url);
  return { pathname: parsed.pathname, params: parsed.searchParams };
}

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "123",
    added_at: "2024-01-01T00:00:00Z",
    content: "Test task",
    description: "",
    project_id: "456",
    section_id: null,
    parent_id: null,
    labels: [],
    priority: 1,
    due: null,
    duration: null,
    deadline: null,
    child_order: 0,
    ...overrides,
  };
}

function makePaginatedResponse(
  tasks: Record<string, unknown>[],
  nextCursor: string | null = null,
): WebResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({
      results: tasks,
      next_cursor: nextCursor,
    }),
  };
}

function makeCompletedPaginatedResponse(
  tasks: Record<string, unknown>[],
  nextCursor: string | null = null,
): WebResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({
      items: tasks,
      next_cursor: nextCursor,
    }),
  };
}

function makeFetcher(): WebFetcher & {
  fetch: ReturnType<typeof vi.fn<(params: RequestParams) => Promise<WebResponse>>>;
} {
  return { fetch: vi.fn<(params: RequestParams) => Promise<WebResponse>>() };
}

describe("TodoistApiClient", () => {
  describe("getTasks", () => {
    it("calls /tasks endpoint when no filter is provided", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(makePaginatedResponse([makeTask()]));

      const client = new TodoistApiClient("test-token", fetcher);
      const tasks = await client.getTasks();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("123");

      const call = fetcher.fetch.mock.calls[0][0];
      const { pathname } = parseUrl(call.url);
      expect(pathname).toBe("/api/v1/tasks");
    });

    it("calls /tasks/filter with query param when filter is provided", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(makePaginatedResponse([makeTask()]));

      const client = new TodoistApiClient("test-token", fetcher);
      await client.getTasks("today");

      const call = fetcher.fetch.mock.calls[0][0];
      const { pathname, params } = parseUrl(call.url);
      expect(pathname).toBe("/api/v1/tasks/filter");
      expect(params.get("query")).toBe("today");
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it("coalesces identical active task queries while a refresh is in flight", async () => {
      const fetcher = makeFetcher();
      let resolveActive: (response: WebResponse) => void = () => {};
      fetcher.fetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveActive = resolve;
          }),
      );

      const client = new TodoistApiClient("test-token", fetcher);
      const first = client.getTasks("today");
      const second = client.getTasks("today");

      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
      resolveActive(makePaginatedResponse([makeTask({ id: "active" })]));

      await expect(Promise.all([first, second])).resolves.toMatchObject([
        [{ id: "active" }],
        [{ id: "active" }],
      ]);
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it("clears a failed active request so it can be retried", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(makePaginatedResponse([makeTask({ id: "retried" })]));
      const client = new TodoistApiClient("test-token", fetcher);

      await expect(client.getTasks("today")).rejects.toThrow("network error");
      await expect(client.getTasks("today")).resolves.toMatchObject([{ id: "retried" }]);
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("getCompletedTasksPage", () => {
    it("loads every page in the newest 90-day window with a limit of 200", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-09T06:00:00.000Z"));

      try {
        const fetcher = makeFetcher();
        fetcher.fetch
          .mockResolvedValueOnce(
            makeCompletedPaginatedResponse(
              [
                makeTask({
                  id: "completed-1",
                  added_at: null,
                  completed_at: "2026-08-08T12:00:00.000Z",
                }),
              ],
              "newest-window-cursor",
            ),
          )
          .mockResolvedValueOnce(
            makeCompletedPaginatedResponse([
              makeTask({
                id: "completed-2",
                completed_at: "2026-08-08T13:00:00.000Z",
              }),
            ]),
          );
        const client = new TodoistApiClient("test-token", fetcher);

        const page = await client.getCompletedTasksPage(
          "##Computer Networking",
          undefined,
          "2026-02-10T06:00:00.000Z",
        );

        expect(page.tasks).toMatchObject([
          {
            id: "completed-1",
            addedAt: "2026-08-08T12:00:00.000Z",
            completedAt: "2026-08-08T12:00:00.000Z",
          },
          {
            id: "completed-2",
            completedAt: "2026-08-08T13:00:00.000Z",
          },
        ]);
        expect(page.request).toEqual({
          since: "2026-05-11T06:00:00.000Z",
          until: "2026-08-09T06:00:00.000Z",
          historyStart: "2026-02-10T06:00:00.000Z",
        });
        expect(page.nextPage).toEqual({
          since: "2026-02-10T06:00:00.000Z",
          until: "2026-05-11T06:00:00.000Z",
          historyStart: "2026-02-10T06:00:00.000Z",
        });
        expect(fetcher.fetch).toHaveBeenCalledTimes(2);

        const { pathname, params } = parseUrl(fetcher.fetch.mock.calls[0][0].url);
        const nextParams = parseUrl(fetcher.fetch.mock.calls[1][0].url).params;
        expect(pathname).toBe("/api/v1/tasks/completed/by_completion_date");
        expect(params.get("since")).toBe("2026-05-11T06:00:00.000Z");
        expect(params.get("until")).toBe("2026-08-09T06:00:00.000Z");
        expect(params.get("filter_query")).toBe("##Computer Networking");
        expect(params.get("limit")).toBe("200");
        expect(params.has("cursor")).toBe(false);
        expect(nextParams.get("since")).toBe(params.get("since"));
        expect(nextParams.get("until")).toBe(params.get("until"));
        expect(nextParams.get("filter_query")).toBe(params.get("filter_query"));
        expect(nextParams.get("limit")).toBe("200");
        expect(nextParams.get("cursor")).toBe("newest-window-cursor");
      } finally {
        vi.useRealTimers();
      }
    });

    it("exhausts the current window cursor before returning the adjacent older window", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockResolvedValueOnce(
          makeCompletedPaginatedResponse(
            [makeTask({ id: "first", completed_at: "2026-08-08T12:00:00.000Z" })],
            "same-window-cursor",
          ),
        )
        .mockResolvedValueOnce(
          makeCompletedPaginatedResponse([
            makeTask({ id: "second", completed_at: "2026-08-08T13:00:00.000Z" }),
          ]),
        );
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2026-02-10T06:00:00.000Z",
      };

      const page = await client.getCompletedTasksPage("today", request);

      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
      expect(parseUrl(fetcher.fetch.mock.calls[1][0].url).params.get("cursor")).toBe(
        "same-window-cursor",
      );
      expect(page.tasks.map((task) => task.id)).toEqual(["first", "second"]);
      expect(page.request).toEqual(request);
      expect(page.nextPage).toEqual({
        since: "2026-02-10T06:00:00.000Z",
        until: request.since,
        historyStart: request.historyStart,
      });
    });

    it("rejects a repeated completed-task cursor instead of looping forever", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValue(makeCompletedPaginatedResponse([], "repeated-window-cursor"));
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };

      await expect(client.getCompletedTasksPage("today", request)).rejects.toThrow(
        "repeated cursor",
      );
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });

    it("clamps adjacent older windows to historyStart and then stops", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValue(makeCompletedPaginatedResponse([]));
      const client = new TodoistApiClient("test-token", fetcher);
      const newest = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2026-04-01T00:00:00.000Z",
      };

      const firstPage = await client.getCompletedTasksPage(undefined, newest);
      expect(firstPage.nextPage).toEqual({
        since: newest.historyStart,
        until: newest.since,
        historyStart: newest.historyStart,
      });

      const secondPage = await client.getCompletedTasksPage(
        undefined,
        firstPage.nextPage ?? undefined,
      );
      expect(secondPage.nextPage).toBeNull();
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);

      const firstParams = parseUrl(fetcher.fetch.mock.calls[0][0].url).params;
      const secondParams = parseUrl(fetcher.fetch.mock.calls[1][0].url).params;
      expect(secondParams.get("until")).toBe(firstParams.get("since"));
      expect(secondParams.get("since")).toBe(newest.historyStart);
    });

    it("uses a recent account join time as the initial history boundary", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-09T06:00:00.000Z"));

      try {
        const fetcher = makeFetcher();
        fetcher.fetch.mockResolvedValueOnce(makeCompletedPaginatedResponse([]));
        const client = new TodoistApiClient("test-token", fetcher);

        const page = await client.getCompletedTasksPage(
          undefined,
          undefined,
          "2026-08-01T12:00:00.000Z",
        );

        const params = parseUrl(fetcher.fetch.mock.calls[0][0].url).params;
        expect(params.get("since")).toBe("2026-08-01T12:00:00.000Z");
        expect(params.get("until")).toBe("2026-08-09T06:00:00.000Z");
        expect(page.nextPage).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to and clamps at Todoist's launch epoch", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2007-04-02T00:00:00.000Z"));

      try {
        const fetcher = makeFetcher();
        fetcher.fetch.mockResolvedValue(makeCompletedPaginatedResponse([]));
        const client = new TodoistApiClient("test-token", fetcher);

        const fallbackPage = await client.getCompletedTasksPage();
        expect(fallbackPage.nextPage).toEqual({
          since: "2007-01-01T00:00:00.000Z",
          until: "2007-01-02T00:00:00.000Z",
          historyStart: "2007-01-01T00:00:00.000Z",
        });
        const clampedPage = await client.getCompletedTasksPage(
          undefined,
          undefined,
          "2000-01-01T00:00:00.000Z",
        );
        expect(clampedPage.nextPage).toEqual(fallbackPage.nextPage);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats a missing next_cursor as the end of the current window", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify({
          items: [makeTask({ id: "completed", completed_at: "2026-08-09T05:00:00.000Z" })],
        }),
      });
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-09T00:00:00.000Z",
        historyStart: "2026-08-01T00:00:00.000Z",
      };

      await expect(client.getCompletedTasksPage(undefined, request)).resolves.toMatchObject({
        tasks: [{ id: "completed" }],
        nextPage: null,
      });
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
      expect(parseUrl(fetcher.fetch.mock.calls[0][0].url).params.has("filter_query")).toBe(false);
    });

    it("coalesces identical completed page requests", async () => {
      const fetcher = makeFetcher();
      let resolvePage: (response: WebResponse) => void = () => {};
      fetcher.fetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePage = resolve;
          }),
      );
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-09T00:00:00.000Z",
        historyStart: "2026-08-01T00:00:00.000Z",
      };

      const first = client.getCompletedTasksPage("today", request);
      const second = client.getCompletedTasksPage("today", request);

      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
      resolvePage(makeCompletedPaginatedResponse([]));
      await expect(Promise.all([first, second])).resolves.toEqual([
        { tasks: [], request, nextPage: null },
        { tasks: [], request, nextPage: null },
      ]);
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it("clears a failed completed page request so it can be retried", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(makeCompletedPaginatedResponse([]));
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-09T00:00:00.000Z",
        historyStart: "2026-08-01T00:00:00.000Z",
      };

      await expect(client.getCompletedTasksPage("today", request)).rejects.toThrow("network error");
      await expect(client.getCompletedTasksPage("today", request)).resolves.toEqual({
        tasks: [],
        request,
        nextPage: null,
      });
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });

    it("restarts an atomic window after a cursor page fails", async () => {
      const firstPage = makeCompletedPaginatedResponse(
        [makeTask({ id: "first", completed_at: "2026-08-08T12:00:00.000Z" })],
        "second-page-cursor",
      );
      const finalPage = makeCompletedPaginatedResponse([
        makeTask({ id: "second", completed_at: "2026-08-08T13:00:00.000Z" }),
      ]);
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockResolvedValueOnce(firstPage)
        .mockRejectedValueOnce(new Error("second page failed"))
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(finalPage);
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-05-11T06:00:00.000Z",
        until: "2026-08-09T06:00:00.000Z",
        historyStart: "2024-01-01T00:00:00.000Z",
      };

      await expect(client.getCompletedTasksPage("today", request)).rejects.toThrow(
        "second page failed",
      );

      await expect(client.getCompletedTasksPage("today", request)).resolves.toMatchObject({
        tasks: [{ id: "first" }, { id: "second" }],
        request,
      });
      expect(fetcher.fetch).toHaveBeenCalledTimes(4);
      expect(parseUrl(fetcher.fetch.mock.calls[2][0].url).params.has("cursor")).toBe(false);
      expect(parseUrl(fetcher.fetch.mock.calls[3][0].url).params.get("cursor")).toBe(
        "second-page-cursor",
      );
    });

    it("preserves nullable completion identity and normalizes missing addedAt", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(
        makeCompletedPaginatedResponse([
          makeTask({ id: "completed", added_at: null, completed_at: null }),
        ]),
      );
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-09T00:00:00.000Z",
        historyStart: "2026-08-01T00:00:00.000Z",
      };

      const page = await client.getCompletedTasksPage(undefined, request);

      expect(page.tasks[0]).toHaveProperty("completedAt", null);
      expect(page.tasks[0].addedAt).toBe("1970-01-01T00:00:00.000Z");
    });

    it("rejects completed responses that omit completed_at", async () => {
      const fetcher = makeFetcher();
      const completedTask = makeTask();
      delete completedTask.completed_at;
      fetcher.fetch.mockResolvedValueOnce(makeCompletedPaginatedResponse([completedTask]));
      const client = new TodoistApiClient("test-token", fetcher);
      const request = {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-09T00:00:00.000Z",
        historyStart: "2026-08-01T00:00:00.000Z",
      };

      await expect(client.getCompletedTasksPage(undefined, request)).rejects.toThrow(
        "Todoist API validation failed",
      );
    });
  });

  describe("pagination", () => {
    it("returns results from a single page when nextCursor is null", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(
        makePaginatedResponse([makeTask(), makeTask({ id: "456" })]),
      );

      const client = new TodoistApiClient("test-token", fetcher);
      const tasks = await client.getTasks();

      expect(tasks).toHaveLength(2);
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it("follows pagination cursor across multiple pages", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockResolvedValueOnce(makePaginatedResponse([makeTask({ id: "1" })], "cursor-abc"))
        .mockResolvedValueOnce(makePaginatedResponse([makeTask({ id: "2" })]));

      const client = new TodoistApiClient("test-token", fetcher);
      const tasks = await client.getTasks();

      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("1");
      expect(tasks[1].id).toBe("2");
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);

      const secondCall = fetcher.fetch.mock.calls[1][0];
      const { params } = parseUrl(secondCall.url);
      expect(params.get("cursor")).toBe("cursor-abc");
    });

    it("preserves filter query params across paginated requests", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch
        .mockResolvedValueOnce(makePaginatedResponse([makeTask({ id: "1" })], "cursor-1"))
        .mockResolvedValueOnce(makePaginatedResponse([makeTask({ id: "2" })]));

      const client = new TodoistApiClient("test-token", fetcher);
      await client.getTasks("today");

      const firstCall = fetcher.fetch.mock.calls[0][0];
      const firstParams = parseUrl(firstCall.url).params;
      expect(firstParams.get("query")).toBe("today");

      const secondCall = fetcher.fetch.mock.calls[1][0];
      const secondParams = parseUrl(secondCall.url).params;
      expect(secondParams.get("query")).toBe("today");
      expect(secondParams.get("cursor")).toBe("cursor-1");
    });

    it("returns empty array when results are empty", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(makePaginatedResponse([]));

      const client = new TodoistApiClient("test-token", fetcher);
      const tasks = await client.getTasks();

      expect(tasks).toHaveLength(0);
    });
  });

  describe("createTask", () => {
    it("sends POST with correct body serialization including options", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify(makeTask({ content: "New task", project_id: "proj-1", priority: 4 })),
      });

      const client = new TodoistApiClient("test-token", fetcher);
      const task = await client.createTask("New task", {
        projectId: "proj-1",
        priority: 4,
      });

      expect(task.content).toBe("New task");

      const call = fetcher.fetch.mock.calls[0][0];
      expect(call.method).toBe("POST");
      const { pathname } = parseUrl(call.url);
      expect(pathname).toBe("/api/v1/tasks");
      expect(call.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(call.body as string);
      expect(body.content).toBe("New task");
      expect(body.project_id).toBe("proj-1");
      expect(body.priority).toBe(4);
    });

    it("sends POST with only content when no options provided", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify(makeTask({ content: "Simple task" })),
      });

      const client = new TodoistApiClient("test-token", fetcher);
      await client.createTask("Simple task");

      const call = fetcher.fetch.mock.calls[0][0];
      const body = JSON.parse(call.body as string);
      expect(body.content).toBe("Simple task");
      expect(Object.keys(body)).toEqual(["content"]);
    });
  });

  describe("closeTask", () => {
    it("sends POST to /tasks/{id}/close without body or Content-Type", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({ statusCode: 204, body: "" });

      const client = new TodoistApiClient("test-token", fetcher);
      await client.closeTask("task-789");

      const call = fetcher.fetch.mock.calls[0][0];
      expect(call.method).toBe("POST");
      const { pathname } = parseUrl(call.url);
      expect(pathname).toBe("/api/v1/tasks/task-789/close");
      expect(call.body).toBeUndefined();
      expect(call.headers["Content-Type"]).toBeUndefined();
    });
  });

  describe("getUser", () => {
    it("calls /user endpoint and parses response", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify({
          is_premium: true,
          joined_at: "2018-04-12T09:30:00.000Z",
        }),
      });

      const client = new TodoistApiClient("test-token", fetcher);
      const user = await client.getUser();

      expect(user.isPremium).toBe(true);
      expect(user.joinedAt).toBe("2018-04-12T09:30:00.000Z");

      const call = fetcher.fetch.mock.calls[0][0];
      expect(call.method).toBe("GET");
      const { pathname } = parseUrl(call.url);
      expect(pathname).toBe("/api/v1/user");
    });

    it("accepts a nullable account join time", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify({ is_premium: false, joined_at: null }),
      });

      const client = new TodoistApiClient("test-token", fetcher);

      await expect(client.getUser()).resolves.toEqual({
        isPremium: false,
        joinedAt: null,
      });
    });
  });

  describe("sync", () => {
    it("calls /sync with snakified query params", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify({
          sync_token: "new-token",
          projects: [],
          sections: [],
          labels: [],
        }),
      });

      const client = new TodoistApiClient("test-token", fetcher);
      const result = await client.sync("old-token");

      expect(result.syncToken).toBe("new-token");

      const call = fetcher.fetch.mock.calls[0][0];
      expect(call.method).toBe("POST");
      const { params } = parseUrl(call.url);
      expect(params.get("sync_token")).toBe("old-token");
      expect(params.get("resource_types")).not.toBeNull();
    });
  });

  describe("error handling", () => {
    it("throws TodoistApiError with correct statusCode on 4xx", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 401,
        body: "Unauthorized",
      });

      const client = new TodoistApiClient("test-token", fetcher);
      await expect(client.getTasks()).rejects.toSatisfy((e) => {
        expect(e).toBeInstanceOf(TodoistApiError);
        expect((e as TodoistApiError).statusCode).toBe(401);
        return true;
      });
    });

    it("throws TodoistApiError with correct statusCode on 5xx", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce({
        statusCode: 500,
        body: "Internal Server Error",
      });

      const client = new TodoistApiClient("test-token", fetcher);
      await expect(client.getTasks()).rejects.toSatisfy((e) => {
        expect(e).toBeInstanceOf(TodoistApiError);
        expect((e as TodoistApiError).statusCode).toBe(500);
        return true;
      });
    });
  });

  describe("authorization", () => {
    it("includes Bearer token in Authorization header for all requests", async () => {
      const fetcher = makeFetcher();
      fetcher.fetch.mockResolvedValueOnce(makePaginatedResponse([makeTask()]));

      const client = new TodoistApiClient("my-secret-token", fetcher);
      await client.getTasks();

      const call = fetcher.fetch.mock.calls[0][0];
      expect(call.headers.Authorization).toBe("Bearer my-secret-token");
    });
  });
});
