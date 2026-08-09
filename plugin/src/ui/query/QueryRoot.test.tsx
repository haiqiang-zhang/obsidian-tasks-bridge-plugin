import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownRenderChild } from "obsidian";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QueryErrorKind, type SubscriptionResult } from "@/data";
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

const makePlugin = (cachedTasks?: ReturnType<typeof makeTask>[]) => {
  let subscriptionCallback: SubscriptionCallback | undefined;
  let cacheClearCallback: (() => void) | undefined;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();
  const unsubscribeCache = vi.fn();
  const subscribe = vi.fn((_filter: string, callback: SubscriptionCallback) => {
    subscriptionCallback = callback;
    return [unsubscribe, refresh] as const;
  });
  const writeQueryCache = vi.fn().mockResolvedValue(undefined);
  const updatedAt = new Date("2026-08-09T05:00:00.000Z");

  const plugin = {
    queryCache: {
      get: vi.fn().mockReturnValue(
        cachedTasks === undefined
          ? undefined
          : {
              tasks: cachedTasks,
              updatedAt,
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
    unsubscribe,
    unsubscribeCache,
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
    expect(mock.subscribe).toHaveBeenCalledWith("today", expect.any(Function), [cachedTask]);

    act(() => {
      mock.callback()({
        type: "success",
        tasks: [freshTask],
        cacheEffect: { type: "replace", requestedAt: new Date() },
      });
    });

    expect(await screen.findByText("Fresh task")).toBeInTheDocument();
    expect(screen.queryByText("Cached task")).not.toBeInTheDocument();
    expect(mock.writeQueryCache).toHaveBeenCalledWith("today", [freshTask], expect.any(Date));
  });

  it("shows a loading indicator on a cache miss until fresh tasks arrive", async () => {
    const freshTask = makeTask("fresh", { content: "Fresh task" });
    const mock = makePlugin();

    renderQuery(mock.plugin);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Todoist tasks");
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
    expect(mock.writeQueryCache).toHaveBeenCalledWith("today", [], expect.any(Date));
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
});
