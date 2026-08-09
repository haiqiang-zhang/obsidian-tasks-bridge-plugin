import classNames from "classnames";
import { domAnimation, LazyMotion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OnSubscriptionChange, Refresh, SubscriptionResult } from "@/data";
import type { Task } from "@/data/task";
import { t } from "@/i18n";
import type TodoistPlugin from "@/index";
import type { QueryWarning } from "@/query/parser";
import type { TaskQuery } from "@/query/schema/tasks";
import { type Settings, useSettingsStore } from "@/settings";
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
): [Refresh, boolean] => {
  const [refresher, setRefresher] = useState<Refresh | undefined>(undefined);
  const [isFetching, setIsFetching] = useState(false);
  const refreshGeneration = useRef(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let isSubscribed = true;
    const [unsub, refresh] = plugin.services.todoist.subscribe(
      query.filter,
      (results) => {
        if (isSubscribed) {
          callback(results);
        }
      },
      initialTasks,
    );
    setRefresher(() => {
      return refresh;
    });
    return () => {
      isSubscribed = false;
      unsub();
    };
  }, [query, plugin, callback, initialTasks]);

  const forceRefresh = useCallback(async () => {
    if (refresher === undefined) {
      return;
    }

    const generation = ++refreshGeneration.current;
    if (isMounted.current) {
      setIsFetching(true);
    }
    try {
      await refresher();
    } finally {
      if (isMounted.current && generation === refreshGeneration.current) {
        setIsFetching(false);
      }
    }
  }, [refresher]);

  useEffect(() => {
    forceRefresh();
  }, [forceRefresh]);

  return [forceRefresh, isFetching];
};

type Props = {
  query: TaskQuery;
  warnings: QueryWarning[];
};

export const QueryRoot: React.FC<Props> = ({ query, warnings }) => {
  const plugin = PluginContext.use();
  const settings = useSettingsStore();
  const [cachedQuery] = useState(() => plugin.queryCache.get(query.filter));
  const [initialTasks] = useState(() => cachedQuery?.tasks ?? []);
  const [result, setResult] = useState<SubscriptionResult | undefined>(() => {
    if (cachedQuery === undefined) {
      return undefined;
    }

    return { type: "success", tasks: cachedQuery.tasks, cacheEffect: { type: "none" } };
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
          .writeQueryCache(query.filter, nextResult.tasks, requestedAt)
          .catch((error: unknown) => {
            console.error("Failed to save Todoist query cache:", error);
          });
      }
    },
    [plugin, query.filter],
  );

  const [refresh, isFetching] = useSubscription(plugin, query, onSubscriptionChange, initialTasks);

  useEffect(() => {
    const interval = getAutorefreshInterval(query, settings);

    if (interval === undefined) {
      return;
    }

    const id = window.setInterval(async () => {
      await refresh();
    }, secondsToMillis(interval));

    return () => window.clearInterval(id);
  }, [query, settings, refresh]);

  const title = getTitle(query, result ?? { type: "not-ready" });
  const isLoading = result === undefined;

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
