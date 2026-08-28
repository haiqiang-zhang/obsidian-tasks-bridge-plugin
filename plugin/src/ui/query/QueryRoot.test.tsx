import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownRenderChild } from "obsidian";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CompletedTasksProgress, QueryErrorKind, type SubscriptionResult } from "@/data";
import { makeTask } from "@/factories/data";
import { makeQuery } from "@/factories/query";
import { makeSettings } from "@/factories/settings";
import type TodoistPlugin from "@/index";
import { useSettingsStore } from "@/settings";
import { PluginContext, RenderChildContext } from "@/ui/context";

import { QueryRoot } from "./QueryRoot";

vi.mock("motion/react", () => ({
  domAnimation: {},
  LazyMotion: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/ui/query/QueryResponseHandler", () => ({
  QueryResponseHandler: ({ result }: { result: SubscriptionResult }) => {
    if (result.type === "error") {
      return <div>Error</div>;
    }

    if (result.type === "not-ready") {
      return null;
    }

    if (result.tasks.length === 0) {
      return <div>The query returned no tasks</div>;
    }

    return result.tasks.map((task) => <div key={task.id}>{task.content}</div>);
  },
}));

type SubscriptionCallback = (result: SubscriptionResult) => void;
type CompletedPageRequest = CompletedTasksProgress["frontiers"][number];

const cachedAt = "2026-08-09T05:00:00.000Z";
const makeProgress = (
  nextPage: CompletedPageRequest | null,
  loadedWindowCount = 1,
): CompletedTasksProgress => ({
  latestUntil: cachedAt,
  historyStart: nextPage?.historyStart ?? "2007-01-01T00:00:00.000Z",
  loadedWindowCount,
  frontiers: nextPage === null ? [] : [nextPage],
});

const makePlugin = (
  cachedTasks?: ReturnType<typeof makeTask>[],
  cachedCompletedTasksNextPage?: CompletedPageRequest | null,
  loadedCompletedWindowCount = 1,
) => {
  let subscriptionCallback: SubscriptionCallback | undefined;
  let cacheClearCallback: (() => void) | undefined;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const loadMoreCompleted = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();
  const unsubscribeCache = vi.fn();
  const rebindTaskMetadata = vi.fn((tasks: ReturnType<typeof makeTask>[]) => tasks);
  const subscribe = vi.fn((_filter: string, callback: SubscriptionCallback) => {
    subscriptionCallback = callback;
    return [unsubscribe, refresh, loadMoreCompleted] as const;
  });
  const writeQueryCache = vi.fn().mockResolvedValue(undefined);
  const updatedAt = new Date(cachedAt);

  const plugin = {
    queryCache: {
      get: vi.fn().mockReturnValue(
        cachedTasks === undefined
          ? undefined
          : {
              tasks: cachedTasks,
              updatedAt,
              ...(cachedCompletedTasksNextPage !== undefined
                ? {
                    completedTasksProgress: makeProgress(
                      cachedCompletedTasksNextPage,
                      loadedCompletedWindowCount,
                    ),
                  }
                : {}),
            },
      ),
      onClear: vi.fn((callback: () => void) => {
        cacheClearCallback = callback;
        return unsubscribeCache;
      }),
    },
    writeQueryCache,
    services: {
      todoist: {
        rebindTaskMetadata,
        subscribe,
        actions: {
          closeTask: vi.fn(),
        },
      },
    },
  } as unknown as TodoistPlugin;

  return {
    plugin,
    refresh,
    subscribe,
    loadMoreCompleted,
    unsubscribe,
    unsubscribeCache,
    rebindTaskMetadata,
    writeQueryCache,
    callback: () => {
      if (subscriptionCallback === undefined) {
        throw new Error("Subscription callback was not registered");
      }
      return subscriptionCallback;
    },
    clearCache: () => {
      if (cacheClearCallback === undefined) {
        throw new Error("Cache clear callback was not registered");
      }
      cacheClearCallback();
    },
  };
};

const renderQuery = (plugin: TodoistPlugin, query = makeQuery({ filter: "today" })) => {
  const host = document.createElement("div");
  const renderContainer = document.createElement("div");
  host.append(renderContainer);
  const renderChild = new MarkdownRenderChild(renderContainer);

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <PluginContext.Provider value={plugin}>
      <RenderChildContext.Provider value={renderChild}>{children}</RenderChildContext.Provider>
    </PluginContext.Provider>
  );

  return render(<QueryRoot query={query} warnings={[]} />, { wrapper: Wrapper });
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("QueryRoot auto-refresh cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.setState(
      makeSettings({ autoRefreshToggle: true, autoRefreshInterval: 30 }),
      true,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits a full interval after each refresh settles", async () => {
    const opening = deferred();
    const automatic = deferred();
    const mock = makePlugin();
    mock.refresh
      .mockImplementationOnce(() => opening.promise)
      .mockImplementationOnce(() => automatic.promise);

    renderQuery(mock.plugin);
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledOnce();
    expect(mock.refresh).toHaveBeenNthCalledWith(1, undefined);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mock.refresh).toHaveBeenCalledOnce();

    await act(async () => opening.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(mock.refresh).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => automatic.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mock.refresh).toHaveBeenCalledTimes(3);
  });

  it("waits a full interval after a failed refresh settles", async () => {
    const failed = deferred();
    const mock = makePlugin();
    mock.refresh
      .mockImplementationOnce(() => failed.promise.then(() => Promise.reject(new Error("offline"))))
      .mockResolvedValue(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    renderQuery(mock.plugin);
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mock.refresh).toHaveBeenCalledOnce();

    await act(async () => failed.resolve());
    expect(error).toHaveBeenCalledWith("Failed to refresh Todoist query:", expect.any(Error));
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(mock.refresh).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mock.refresh).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("manual refresh resets the single automatic cadence", async () => {
    const manual = deferred();
    const mock = makePlugin();
    mock.refresh.mockResolvedValueOnce(undefined).mockImplementationOnce(() => manual.promise);

    renderQuery(mock.plugin);
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledOnce();
    expect(mock.refresh).toHaveBeenNthCalledWith(1, undefined);

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    fireEvent.click(screen.getByRole("button", { name: "Refresh tasks" }));
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledTimes(2);
    expect(mock.refresh).toHaveBeenNthCalledWith(2, { forceMetadata: true });

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => manual.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mock.refresh).toHaveBeenCalledTimes(3);
    expect(mock.refresh).toHaveBeenNthCalledWith(3, undefined);
  });

  it("applies an interval change only after the active refresh settles", async () => {
    const opening = deferred();
    const mock = makePlugin();
    mock.refresh.mockImplementationOnce(() => opening.promise);

    renderQuery(mock.plugin);
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledOnce();

    act(() => {
      useSettingsStore.setState({ autoRefreshInterval: 5 });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mock.refresh).toHaveBeenCalledOnce();

    await act(async () => opening.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(mock.refresh).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mock.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale refresh revive the previous query cadence", async () => {
    const previousQueryRefresh = deferred();
    const mock = makePlugin();
    mock.refresh
      .mockImplementationOnce(() => previousQueryRefresh.promise)
      .mockResolvedValue(undefined);

    const view = renderQuery(mock.plugin, makeQuery({ filter: "today" }));
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledOnce();

    view.rerender(<QueryRoot query={makeQuery({ filter: "tomorrow" })} warnings={[]} />);
    await act(async () => Promise.resolve());
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => previousQueryRefresh.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(mock.refresh).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mock.refresh).toHaveBeenCalledTimes(3);
  });

  it("does not revive auto-refresh after it is disabled or unmounted", async () => {
    const disabledOpening = deferred();
    const disabledMock = makePlugin();
    disabledMock.refresh.mockImplementationOnce(() => disabledOpening.promise);
    const disabledView = renderQuery(disabledMock.plugin);
    await act(async () => Promise.resolve());

    act(() => {
      useSettingsStore.setState({ autoRefreshToggle: false });
    });
    await act(async () => disabledOpening.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(disabledMock.refresh).toHaveBeenCalledOnce();
    disabledView.unmount();

    useSettingsStore.setState(
      makeSettings({ autoRefreshToggle: true, autoRefreshInterval: 30 }),
      true,
    );
    const unmountedOpening = deferred();
    const unmountedMock = makePlugin();
    unmountedMock.refresh.mockImplementationOnce(() => unmountedOpening.promise);
    const unmountedView = renderQuery(unmountedMock.plugin);
    await act(async () => Promise.resolve());

    unmountedView.unmount();
    await act(async () => unmountedOpening.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(unmountedMock.refresh).toHaveBeenCalledOnce();
  });
});

describe("QueryRoot cache-first rendering", () => {
  beforeEach(() => {
    useSettingsStore.setState(makeSettings(), true);
  });

  it("renders cached tasks immediately and replaces them with fresh tasks", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const freshTask = makeTask("fresh", { content: "Fresh task" });
    const mock = makePlugin([cachedTask]);

    renderQuery(mock.plugin);

    expect(await screen.findByText("Cached task")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());
    expect(mock.subscribe).toHaveBeenCalledWith(
      "today",
      expect.any(Function),
      [cachedTask],
      false,
      undefined,
    );

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [freshTask],
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(await screen.findByText("Fresh task")).toBeInTheDocument();
    expect(screen.queryByText("Cached task")).not.toBeInTheDocument();
    expect(mock.writeQueryCache).toHaveBeenCalledWith(
      "today",
      [freshTask],
      expect.any(Date),
      false,
      undefined,
    );
  });

  it("rebinds cache-first task metadata before seeding the subscription", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const reboundTask = {
      ...cachedTask,
      project: { ...cachedTask.project, name: "Renamed project" },
    };
    const mock = makePlugin([cachedTask]);
    mock.rebindTaskMetadata.mockReturnValueOnce([reboundTask]);

    renderQuery(mock.plugin);

    expect(await screen.findByText("Cached task")).toBeInTheDocument();
    expect(mock.rebindTaskMetadata).toHaveBeenCalledWith([cachedTask]);
    expect(mock.subscribe).toHaveBeenCalledWith(
      "today",
      expect.any(Function),
      [reboundTask],
      false,
      undefined,
    );
  });

  it("shows a loading indicator on a cache miss until fresh tasks arrive", async () => {
    const freshTask = makeTask("fresh", { content: "Fresh task" });
    const mock = makePlugin();

    renderQuery(mock.plugin);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading Todoist tasks");
    expect(status.querySelector(".loader-spinner")).toBeInTheDocument();
    expect(status.querySelector(".is-loading")).not.toBeInTheDocument();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [freshTask],
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(await screen.findByText("Fresh task")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("uses the compact untitled layout without rendering a spacer header", async () => {
    const mock = makePlugin();

    const { container } = renderQuery(mock.plugin);
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh tasks" })).not.toHaveClass(
        "is-refreshing",
      ),
    );

    expect(container.querySelector(".todoist-query")).toHaveClass("is-untitled");
    expect(container.querySelector(".todoist-query-header")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Todoist tasks");
  });

  it("replaces every unresolved task-count placeholder with an ellipsis", async () => {
    const mock = makePlugin();
    const query = makeQuery({
      name: "Tasks ({task_count}) / {task_count}",
      filter: "today",
    });

    renderQuery(mock.plugin, query);
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());

    expect(screen.getByRole("heading", { name: "Tasks (…) / …" })).toBeInTheDocument();
    expect(screen.queryByText("{task_count}", { exact: false })).not.toBeInTheDocument();
  });

  it("keeps loading when the API is not ready and no cache exists", async () => {
    const mock = makePlugin();

    renderQuery(mock.plugin);
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());

    act(() => {
      mock.callback()({ type: "not-ready" });
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading Todoist tasks");
    expect(mock.writeQueryCache).not.toHaveBeenCalled();
  });

  it("keeps cached tasks when the background refresh is not ready or fails", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const mock = makePlugin([cachedTask]);

    renderQuery(mock.plugin);
    expect(await screen.findByText("Cached task")).toBeInTheDocument();

    act(() => {
      mock.callback()({ type: "not-ready" });
      mock.callback()({ type: "error", kind: QueryErrorKind.ServerError });
    });

    expect(screen.getByText("Cached task")).toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(mock.writeQueryCache).not.toHaveBeenCalled();
  });

  it("clears mounted tasks when the Todoist credential changes", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const mock = makePlugin([cachedTask]);

    renderQuery(mock.plugin);
    expect(await screen.findByText("Cached task")).toBeInTheDocument();

    act(() => {
      mock.clearCache();
    });

    expect(screen.queryByText("Cached task")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Todoist tasks");
  });

  it("replaces cached tasks with a successful empty response", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const mock = makePlugin([cachedTask]);

    renderQuery(mock.plugin);
    expect(await screen.findByText("Cached task")).toBeInTheDocument();

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [],
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(await screen.findByText("The query returned no tasks")).toBeInTheDocument();
    expect(screen.queryByText("Cached task")).not.toBeInTheDocument();
    expect(mock.writeQueryCache).toHaveBeenCalledWith(
      "today",
      [],
      expect.any(Date),
      false,
      undefined,
    );
  });

  it("shows a refresh error when no cached result exists", async () => {
    const mock = makePlugin();

    renderQuery(mock.plugin);

    act(() => {
      mock.callback()({ type: "error", kind: QueryErrorKind.ServerError });
    });

    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("updates a task-count title from cached to fresh data", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const freshTasks = [makeTask("fresh-1"), makeTask("fresh-2")];
    const mock = makePlugin([cachedTask]);
    const query = makeQuery({ name: "Tasks ({task_count})", filter: "today" });

    renderQuery(mock.plugin, query);

    expect(screen.getByRole("heading", { name: "Tasks (1)" })).toBeInTheDocument();

    act(() => {
      mock.callback()({
        type: "success",
        tasks: freshTasks,
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(await screen.findByRole("heading", { name: "Tasks (2)" })).toBeInTheDocument();
  });

  it("keeps the refresh control active until the latest refresh finishes", async () => {
    let resolveInitialRefresh: () => void = () => {};
    let resolveLatestRefresh: () => void = () => {};
    const mock = makePlugin([makeTask("cached", { content: "Cached task" })]);
    mock.refresh
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveInitialRefresh = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveLatestRefresh = resolve;
          }),
      );

    renderQuery(mock.plugin);
    const refreshButton = screen.getByRole("button", { name: "Refresh tasks" });
    await waitFor(() => expect(refreshButton).toHaveClass("is-refreshing"));

    fireEvent.click(refreshButton);
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledTimes(2));

    await act(async () => resolveInitialRefresh());
    expect(refreshButton).toHaveClass("is-refreshing");

    await act(async () => resolveLatestRefresh());
    await waitFor(() => expect(refreshButton).not.toHaveClass("is-refreshing"));
  });

  it("unsubscribes and ignores callbacks after unmount", () => {
    const mock = makePlugin();
    const view = renderQuery(mock.plugin);
    const callback = mock.callback();

    view.unmount();
    callback({ type: "success", tasks: [makeTask("late")], cacheEffect: { type: "none" } });

    expect(mock.unsubscribe).toHaveBeenCalledOnce();
    expect(mock.unsubscribeCache).toHaveBeenCalledOnce();
    expect(mock.writeQueryCache).not.toHaveBeenCalled();
  });

  it("does not replace shared cache content for a local-only task snapshot", async () => {
    const cachedTask = makeTask("cached", { content: "Cached task" });
    const mock = makePlugin([cachedTask]);

    renderQuery(mock.plugin);
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce());
    act(() => {
      mock.callback()({ type: "success", tasks: [], cacheEffect: { type: "none" } });
    });

    expect(screen.getByText("The query returned no tasks")).toBeInTheDocument();
    expect(mock.writeQueryCache).not.toHaveBeenCalled();
  });

  it("uses a separate completed-inclusive subscription and cache identity", async () => {
    const completedTask = makeTask("completed", {
      content: "Completed task",
      completedAt: "2026-08-09T04:00:00.000Z",
    });
    const completedTasksNextPage = {
      since: "2026-02-10T06:00:00.000Z",
      until: "2026-05-11T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
    };
    const completedTasksProgress = makeProgress(completedTasksNextPage);
    const mock = makePlugin([completedTask], completedTasksNextPage);
    const query = makeQuery({ filter: "today", completedTasks: true });

    renderQuery(mock.plugin, query);

    expect(await screen.findByText("Completed task")).toBeInTheDocument();
    expect(mock.plugin.queryCache.get).toHaveBeenCalledWith("today", true);
    expect(mock.subscribe).toHaveBeenCalledWith(
      "today",
      expect.any(Function),
      [completedTask],
      true,
      completedTasksProgress,
    );

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [completedTask],
        completedTasksProgress: { ...completedTasksProgress, frontiers: [] },
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(mock.writeQueryCache).toHaveBeenCalledWith(
      "today",
      [completedTask],
      expect.any(Date),
      true,
      { ...completedTasksProgress, frontiers: [] },
    );
  });

  it("advances the completed-history month label after each loaded window", async () => {
    const completedTask = makeTask("completed", {
      content: "Completed task",
      completedAt: "2026-08-09T04:00:00.000Z",
    });
    const nextPage = {
      since: "2026-05-11T06:00:00.000Z",
      until: "2026-08-09T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
    };
    const completedTasksProgress = makeProgress(nextPage);
    const mock = makePlugin([completedTask], nextPage);
    let resolveLoadMore!: () => void;
    mock.loadMoreCompleted.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoadMore = resolve;
        }),
    );
    const followingPage = {
      since: "2026-02-10T06:00:00.000Z",
      until: nextPage.since,
      historyStart: nextPage.historyStart,
    };

    renderQuery(mock.plugin, makeQuery({ filter: "today", completedTasks: true }));

    const button = await screen.findByRole("button", {
      name: "Load 6 months",
    });
    fireEvent.click(button);
    await waitFor(() => expect(mock.loadMoreCompleted).toHaveBeenCalledOnce());
    await waitFor(() => expect(button.querySelector(".loader-spinner")).toBeInTheDocument());
    expect(button.querySelector(".is-loading")).not.toBeInTheDocument();

    await act(async () => resolveLoadMore());
    await waitFor(() => expect(button).not.toBeDisabled());

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [completedTask],
        completedTasksProgress: {
          ...completedTasksProgress,
          loadedWindowCount: 2,
          frontiers: [followingPage],
        },
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(screen.getByRole("button", { name: "Load 9 months" })).toBeInTheDocument();

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [completedTask],
        completedTasksProgress: {
          ...completedTasksProgress,
          loadedWindowCount: 2,
          frontiers: [],
        },
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(screen.queryByRole("button", { name: "Load 9 months" })).not.toBeInTheDocument();
  });

  it("restores the next completed-history month label from cache", async () => {
    const nextPage = {
      since: "2026-02-10T06:00:00.000Z",
      until: "2026-05-11T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
    };
    const mock = makePlugin(
      [makeTask("completed", { completedAt: "2026-08-09T04:00:00.000Z" })],
      nextPage,
      2,
    );

    renderQuery(mock.plugin, makeQuery({ filter: "today", completedTasks: true }));

    expect(await screen.findByRole("button", { name: "Load 9 months" })).toBeInTheDocument();
  });

  it("keeps the earlier-history control available after a failed request", async () => {
    const nextPage = {
      since: "2026-05-11T06:00:00.000Z",
      until: "2026-08-09T06:00:00.000Z",
      historyStart: "2024-01-01T00:00:00.000Z",
    };
    const mock = makePlugin(
      [makeTask("completed", { completedAt: "2026-08-09T04:00:00.000Z" })],
      nextPage,
    );
    mock.loadMoreCompleted.mockRejectedValueOnce(new Error("rate limited"));

    renderQuery(mock.plugin, makeQuery({ filter: "today", completedTasks: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Load 6 months" }));

    expect(
      await screen.findByText("Could not load earlier completed tasks. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 6 months" })).toBeEnabled();
  });
});
