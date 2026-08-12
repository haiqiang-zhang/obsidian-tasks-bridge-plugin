import classNames from "classnames";
import { domAnimation, LazyMotion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { COMPLETED_TASKS_WINDOW_MONTHS } from "@/api";
import type {
  CompletedTasksProgress,
  LoadMoreCompleted,
  OnSubscriptionChange,
  Refresh,
  SubscriptionResult,
} from "@/data";
import type { Task } from "@/data/task";
import { t } from "@/i18n";
import type TodoistPlugin from "@/index";
import type { QueryWarning } from "@/query/parser";
import type { TaskQuery } from "@/query/schema/tasks";
import { type Settings, useSettingsStore } from "@/settings";
import { ObsidianIcon, ObsidianLoadingIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";
import { Displays } from "@/ui/query/displays";
import { QueryHeader } from "@/ui/query/QueryHeader";
import { QueryResponseHandler } from "@/ui/query/QueryResponseHandler";
import { QueryWarnings } from "@/ui/query/QueryWarnings";
import "./styles.scss";

import { secondsToMillis } from "@/infra/time";

const useSubscription = (
  plugin: TodoistPlugin,
  query: TaskQuery,
  callback: OnSubscriptionChange,
  initialTasks: Task[],
  initialCompletedTasksProgress: CompletedTasksProgress | undefined,
  runRefresh: (refresh: Refresh) => Promise<void>,
): [Refresh, boolean, LoadMoreCompleted, boolean, boolean] => {
  const [refresher, setRefresher] = useState<{ query: TaskQuery; refresh: Refresh } | undefined>(
    undefined,
  );
  const [completedTasksLoader, setCompletedTasksLoader] = useState<LoadMoreCompleted | undefined>(
    undefined,
  );
  const [isFetching, setIsFetching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const refreshGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let isSubscribed = true;
    const [unsub, refresh, loadMoreCompleted] = plugin.services.todoist.subscribe(
      query.filter,
      (results) => {
        if (isSubscribed) {
          callback(results);
        }
      },
      initialTasks,
      query.completedTasks,
      initialCompletedTasksProgress,
    );
    setRefresher({ query, refresh });
    setCompletedTasksLoader(() => loadMoreCompleted);
    setLoadMoreError(false);
    return () => {
      isSubscribed = false;
      unsub();
    };
  }, [query, plugin, callback, initialTasks, initialCompletedTasksProgress]);

  const forceRefresh = useCallback(async () => {
    if (refresher === undefined || refresher.query !== query) {
      return;
    }

    const generation = ++refreshGeneration.current;
    if (isMounted.current) {
      setIsFetching(true);
    }
    try {
      await runRefresh(refresher.refresh);
    } catch (error: unknown) {
      console.error("Failed to refresh Todoist query:", error);
    } finally {
      if (isMounted.current && generation === refreshGeneration.current) {
        setIsFetching(false);
      }
    }
  }, [refresher, query, runRefresh]);

  useEffect(() => {
    forceRefresh();
  }, [forceRefresh]);

  const loadMoreCompleted = useCallback(async () => {
    if (completedTasksLoader === undefined) {
      return;
    }

    const generation = ++loadMoreGeneration.current;
    if (isMounted.current) {
      setIsLoadingMore(true);
      setLoadMoreError(false);
    }
    try {
      await completedTasksLoader();
    } catch (error: unknown) {
      console.error("Failed to load earlier completed tasks:", error);
      if (isMounted.current && generation === loadMoreGeneration.current) {
        setLoadMoreError(true);
      }
    } finally {
      if (isMounted.current && generation === loadMoreGeneration.current) {
        setIsLoadingMore(false);
      }
    }
  }, [completedTasksLoader]);

  return [forceRefresh, isFetching, loadMoreCompleted, isLoadingMore, loadMoreError];
};

type RefreshCadenceState = {
  configurationKey: string;
  configurationGeneration: number;
  refreshGeneration: number;
  activeRefreshGeneration: number | undefined;
  intervalMs: number | undefined;
  timerId: number | undefined;
  hasStarted: boolean;
  isMounted: boolean;
};

const useRefreshCadence = (
  interval: number | undefined,
  configurationKey: string,
): [(refresh: Refresh) => Promise<void>, React.MutableRefObject<Refresh | undefined>] => {
  const state = useRef<RefreshCadenceState>({
    configurationKey: "",
    configurationGeneration: 0,
    refreshGeneration: 0,
    activeRefreshGeneration: undefined,
    intervalMs: undefined,
    timerId: undefined,
    hasStarted: false,
    isMounted: true,
  });
  const refreshRef = useRef<Refresh | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (state.current.timerId !== undefined) {
      window.clearTimeout(state.current.timerId);
      state.current.timerId = undefined;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    const current = state.current;
    if (!current.isMounted || current.intervalMs === undefined) {
      return;
    }

    clearTimer();
    const configurationKey = current.configurationKey;
    const configurationGeneration = current.configurationGeneration;
    const refreshGeneration = current.refreshGeneration;
    const id = window.setTimeout(() => {
      const latest = state.current;
      if (
        !latest.isMounted ||
        latest.timerId !== id ||
        latest.configurationKey !== configurationKey ||
        latest.configurationGeneration !== configurationGeneration ||
        latest.refreshGeneration !== refreshGeneration
      ) {
        return;
      }

      latest.timerId = undefined;
      void refreshRef.current?.();
    }, current.intervalMs);
    current.timerId = id;
  }, [clearTimer]);

  const runRefresh = useCallback(
    async (refresh: Refresh) => {
      const current = state.current;
      if (!current.isMounted) {
        return;
      }

      clearTimer();
      const refreshGeneration = ++current.refreshGeneration;
      current.activeRefreshGeneration = refreshGeneration;
      current.hasStarted = true;

      try {
        await refresh();
      } finally {
        const latest = state.current;
        if (latest.isMounted && latest.activeRefreshGeneration === refreshGeneration) {
          latest.activeRefreshGeneration = undefined;
          scheduleNext();
        }
      }
    },
    [clearTimer, scheduleNext],
  );

  useEffect(() => {
    const current = state.current;
    clearTimer();
    const isNewConfiguration = current.configurationKey !== configurationKey;
    current.configurationKey = configurationKey;
    current.configurationGeneration++;
    current.intervalMs = interval === undefined ? undefined : secondsToMillis(interval);
    if (isNewConfiguration) {
      current.refreshGeneration++;
      current.activeRefreshGeneration = undefined;
      current.hasStarted = false;
    } else if (current.hasStarted && current.activeRefreshGeneration === undefined) {
      scheduleNext();
    }
  }, [interval, configurationKey, clearTimer, scheduleNext]);

  useEffect(() => {
    state.current.isMounted = true;
    return () => {
      const current = state.current;
      current.isMounted = false;
      current.configurationGeneration++;
      current.refreshGeneration++;
      current.activeRefreshGeneration = undefined;
      clearTimer();
    };
  }, [clearTimer]);

  return [runRefresh, refreshRef];
};

type Props = {
  query: TaskQuery;
  warnings: QueryWarning[];
};

export const QueryRoot: React.FC<Props> = ({ query, warnings }) => {
  const plugin = PluginContext.use();
  const settings = useSettingsStore();
  const interval = getAutorefreshInterval(query, settings);
  const queryConfigurationKey = JSON.stringify([
    query.name,
    query.filter,
    query.completedTasks,
    query.autorefresh,
    query.sorting,
    query.show === undefined ? undefined : [...query.show],
    query.groupBy,
    query.view,
  ]);
  const [runRefresh, scheduledRefresh] = useRefreshCadence(interval, queryConfigurationKey);
  const [cachedQuery] = useState(() => plugin.queryCache.get(query.filter, query.completedTasks));
  const [initialTasks] = useState(() => cachedQuery?.tasks ?? []);
  const [initialCompletedTasksProgress] = useState(() => cachedQuery?.completedTasksProgress);
  const [result, setResult] = useState<SubscriptionResult | undefined>(() => {
    if (cachedQuery === undefined) {
      return undefined;
    }

    return {
      type: "success",
      tasks: cachedQuery.tasks,
      ...(query.completedTasks
        ? { completedTasksProgress: cachedQuery.completedTasksProgress }
        : {}),
      cacheEffect: { type: "none" },
    };
  });
  const [refreshedTimestamp, setRefreshedTimestamp] = useState<Date | undefined>(
    cachedQuery?.updatedAt,
  );

  useEffect(() => {
    return plugin.queryCache.onClear(() => {
      setResult(undefined);
      setRefreshedTimestamp(undefined);
    });
  }, [plugin]);

  const onSubscriptionChange = useCallback<OnSubscriptionChange>(
    (nextResult) => {
      if (nextResult.type === "not-ready") {
        return;
      }

      if (nextResult.type === "error") {
        setResult((currentResult) =>
          currentResult?.type === "success" ? currentResult : nextResult,
        );
        return;
      }

      setResult(nextResult);

      if (nextResult.cacheEffect.type === "replace") {
        const { requestedAt } = nextResult.cacheEffect;
        setRefreshedTimestamp(requestedAt);
        plugin
          .writeQueryCache(
            query.filter,
            nextResult.tasks,
            requestedAt,
            query.completedTasks,
            nextResult.completedTasksProgress,
          )
          .catch((error: unknown) => {
            console.error("Failed to save Todoist query cache:", error);
          });
      }
    },
    [plugin, query.filter, query.completedTasks],
  );

  const [refresh, isFetching, loadMoreCompleted, isLoadingMore, loadMoreError] = useSubscription(
    plugin,
    query,
    onSubscriptionChange,
    initialTasks,
    initialCompletedTasksProgress,
    runRefresh,
  );
  scheduledRefresh.current = refresh;

  const title = getTitle(query, result ?? { type: "not-ready" });
  const isLoading = result === undefined;
  const canLoadEarlierCompletedTasks =
    query.completedTasks &&
    result?.type === "success" &&
    (result.completedTasksProgress?.frontiers.length ?? 0) > 0;
  const loadedCompletedWindowCount =
    (result?.type === "success" ? result.completedTasksProgress?.loadedWindowCount : undefined) ??
    1;
  const nextCompletedHistoryMonths =
    (loadedCompletedWindowCount + 1) * COMPLETED_TASKS_WINDOW_MONTHS;
  const completedHistoryText = t().query.completedHistory;

  return (
    <LazyMotion features={domAnimation}>
      <div
        className={classNames("todoist-query", {
          "is-untitled": title.trim().length === 0,
        })}
      >
        <QueryHeader
          title={title}
          isFetching={isFetching}
          refresh={refresh}
          refreshedTimestamp={refreshedTimestamp}
        />
        <div className="todoist-query-content">
          <QueryWarnings warnings={warnings} />
          {isLoading && <Displays.NotReady />}
          {result !== undefined && <QueryResponseHandler result={result} query={query} />}
          {canLoadEarlierCompletedTasks && (
            <div className="todoist-completed-history-controls">
              <button
                type="button"
                className="todoist-load-earlier-completed"
                disabled={isLoadingMore}
                onClick={loadMoreCompleted}
              >
                {isLoadingMore ? (
                  <ObsidianLoadingIcon size="s" />
                ) : (
                  <ObsidianIcon id="history" size="s" />
                )}
                <span>
                  {isLoadingMore
                    ? completedHistoryText.loadingEarlier(nextCompletedHistoryMonths)
                    : completedHistoryText.loadEarlier(nextCompletedHistoryMonths)}
                </span>
              </button>
              {loadMoreError && (
                <div className="todoist-completed-history-error" role="alert">
                  {completedHistoryText.loadError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </LazyMotion>
  );
};

const getAutorefreshInterval = (query: TaskQuery, settings: Settings): number | undefined => {
  if (query.autorefresh !== undefined && query.autorefresh !== 0) {
    return query.autorefresh;
  }

  if (!settings.autoRefreshToggle) {
    return undefined;
  }

  if (settings.autoRefreshInterval !== 0) {
    return settings.autoRefreshInterval;
  }

  return undefined;
};

const getTitle = (query: TaskQuery, result: SubscriptionResult): string => {
  const name = query.name ?? "";
  if (name.length === 0) {
    return "";
  }

  switch (result.type) {
    case "error": {
      const postfix = t().query.header.errorPostfix;
      return `${query.name} ${postfix}`;
    }
    case "success":
      return replaceTaskCountPlaceholder(name, result.tasks.length.toString());
    case "not-ready":
      return replaceTaskCountPlaceholder(name, "…");
    default: {
      const _: never = result;
      throw new Error("Unknown result type");
    }
  }
};

const replaceTaskCountPlaceholder = (name: string, replacement: string): string => {
  return name.split("{task_count}").join(replacement);
};
