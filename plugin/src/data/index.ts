import type { CompletedTasksPageRequest, TodoistApiClient } from "@/api";
import type { Label, LabelId } from "@/api/domain/label";
import type { Project, ProjectId } from "@/api/domain/project";
import type { Section, SectionId } from "@/api/domain/section";
import type { SyncToken } from "@/api/domain/sync";
import type {
  Task as ApiTask,
  CreateTaskParams,
  TaskId,
  UpdateTaskParams,
} from "@/api/domain/task";
import type { UserInfo } from "@/api/domain/user";
import { mapApiError } from "@/data/errors";
import { type DataAccessor, hydrate } from "@/data/hydrate";
import { Repository } from "@/data/repository";
import {
  type CompletedTasksProgress,
  type LoadMoreCompleted,
  type OnSubscriptionChange,
  type Refresh,
  SubscriptionManager,
  type SubscriptionResult,
  type UnsubscribeCallback,
} from "@/data/subscriptions";
import type { Task } from "@/data/task";
import { Maybe } from "@/utils/maybe";

export { QueryErrorKind } from "@/data/errors";
export type {
  CompletedTasksProgress,
  LoadMoreCompleted,
  OnSubscriptionChange,
  Refresh,
  SubscriptionResult,
} from "@/data/subscriptions";

export type TodoistRemoteMutationAction =
  | "closeProjectTask"
  | "reopenProjectTask"
  | "reopenTask"
  | "updateTask";

export class TodoistRemoteMutationFollowupError extends Error {
  public readonly remoteMutationSucceeded = true;
  public readonly action: TodoistRemoteMutationAction;
  public readonly cause: unknown;

  constructor(action: TodoistRemoteMutationAction, cause: unknown) {
    super(`Todoist ${action} succeeded, but its local follow-up failed`);
    this.name = "TodoistRemoteMutationFollowupError";
    this.action = action;
    this.cause = cause;
  }
}

type TodoistAdapterOptions = {
  onTaskClosed?: (taskId: TaskId, completedAt: Date) => Promise<void> | void;
};

export type ProjectTaskSnapshot = {
  activeTasks: Task[];
  completedTasks: Task[];
};

type InFlightMetadataSync = {
  accountGeneration: number;
  promise: Promise<boolean>;
};

export class TodoistAdapter {
  public actions = {
    closeTask: async (id: TaskId) => await this.closeTask(id),
    closeProjectTask: async (id: TaskId): Promise<Date> => await this.closeProjectTask(id),
    createTask: async (content: string, params: CreateTaskParams): Promise<ApiTask> =>
      await this.api.withInner((api) => api.createTask(content, params)),
    getTask: async (id: TaskId): Promise<ApiTask> => await this.getTask(id),
    reopenProjectTask: async (id: TaskId): Promise<void> => await this.reopenProjectTask(id),
    reopenTask: async (id: TaskId): Promise<void> => await this.reopenTask(id),
    updateTask: async (id: TaskId, params: UpdateTaskParams): Promise<ApiTask> =>
      await this.updateTask(id, params),
  };

  private readonly api: Maybe<TodoistApiClient> = Maybe.Empty();
  private readonly projects: Repository<ProjectId, Project>;
  private readonly sections: Repository<SectionId, Section>;
  private readonly labels: Repository<LabelId, Label>;
  private readonly subscriptions: SubscriptionManager<Subscription>;
  private readonly completedSubscriptions: Map<string, CompletedSubscriptionEntry>;

  private readonly tasksPendingClose: TaskId[];
  private userInfo: UserInfo | undefined;

  private accountGeneration = 0;
  private hasSynced = false;
  private metadataSyncInFlight: InFlightMetadataSync | undefined;
  private readonly onTaskClosed: TodoistAdapterOptions["onTaskClosed"];
  private syncToken: SyncToken = "*";

  constructor(options: TodoistAdapterOptions = {}) {
    this.projects = new Repository<ProjectId, Project>();
    this.sections = new Repository<SectionId, Section>();
    this.labels = new Repository<LabelId, Label>();
    this.subscriptions = new SubscriptionManager<Subscription>();
    this.completedSubscriptions = new Map();
    this.tasksPendingClose = [];
    this.onTaskClosed = options.onTaskClosed;
  }

  public isReady(): boolean {
    return this.api.hasValue() && this.hasSynced;
  }

  public isPremium(): boolean {
    return this.userInfo?.isPremium ?? true;
  }

  public async initialize(api: TodoistApiClient) {
    this.api.insert(api);
    await this.sync();
  }

  /**
   * Refresh shared metadata and every mounted query-block subscription.
   *
   * The boolean reports whether repository metadata was refreshed for the current account. Query
   * subscriptions are still refreshed when metadata fails so the original query-block mode keeps
   * its previous best-effort behavior.
   */
  public async sync(): Promise<boolean> {
    if (!this.api.hasValue()) {
      return false;
    }

    const accountGeneration = this.accountGeneration;
    const metadataSucceeded = await this.syncMetadata();

    if (accountGeneration !== this.accountGeneration) {
      return false;
    }

    for (const subscription of this.subscriptions.list()) {
      if (accountGeneration !== this.accountGeneration) {
        return false;
      }
      await subscription.update();
    }

    if (accountGeneration === this.accountGeneration) {
      this.hasSynced = true;
      return metadataSucceeded;
    }

    return false;
  }

  /** Returns true only when Todoist repository metadata was applied for the current account. */
  public syncMetadata(): Promise<boolean> {
    if (!this.api.hasValue()) {
      return Promise.resolve(false);
    }

    const accountGeneration = this.accountGeneration;
    if (this.metadataSyncInFlight?.accountGeneration === accountGeneration) {
      return this.metadataSyncInFlight.promise;
    }

    const promise = this.performMetadataSync(accountGeneration).finally(() => {
      if (this.metadataSyncInFlight?.promise === promise) {
        this.metadataSyncInFlight = undefined;
      }
    });
    this.metadataSyncInFlight = { accountGeneration, promise };
    return promise;
  }

  private async performMetadataSync(accountGeneration: number): Promise<boolean> {
    const [, metadataSucceeded] = await Promise.all([
      this.syncUserInfo(accountGeneration),
      this.syncMetadataRepositories(accountGeneration),
    ]);
    return metadataSucceeded;
  }

  private async syncUserInfo(accountGeneration: number): Promise<void> {
    try {
      if (!this.api.hasValue()) {
        return;
      }
      const userInfo = await this.api.withInner((api) => api.getUser());
      if (accountGeneration === this.accountGeneration) {
        this.userInfo = userInfo;
      }
    } catch (error) {
      console.error("Failed to fetch user info:", error);
    }
  }

  private async syncMetadataRepositories(accountGeneration: number): Promise<boolean> {
    try {
      if (!this.api.hasValue()) {
        return false;
      }

      const response = await this.api.withInner((api) => api.sync(this.syncToken));
      if (accountGeneration !== this.accountGeneration) {
        return false;
      }

      this.projects.applyDiff(response.projects);
      this.sections.applyDiff(response.sections);
      this.labels.applyDiff(response.labels);
      this.syncToken = response.syncToken;
      return true;
    } catch (error) {
      console.error("Failed to sync metadata:", error);
      return false;
    }
  }

  public data(): DataAccessor {
    return {
      projects: this.projects,
      sections: this.sections,
      labels: this.labels,
    };
  }

  public listActiveProjects(): Project[] {
    return Array.from(this.projects.iterActive());
  }

  public async getProjectTasks(projectId: ProjectId): Promise<ProjectTaskSnapshot> {
    const accountGeneration = this.accountGeneration;
    const activeTasks = await this.api.withInner((api) => api.getActiveTasksByProject(projectId));
    if (accountGeneration !== this.accountGeneration) {
      throw new Error("Todoist account changed during project task sync");
    }
    // Capture the completed-task boundary only after the active snapshot returns. This includes
    // tasks completed while the active request was in flight instead of leaving the previous
    // boundary gap between the two scans.
    const completedUntil = new Date().toISOString();
    const completedTasks = await this.api.withInner((api) =>
      api.getCompletedTasksByProject(projectId, completedUntil),
    );

    if (accountGeneration !== this.accountGeneration) {
      throw new Error("Todoist account changed during project task sync");
    }

    const tasksById = new Map<TaskId, ApiTask>();

    for (const task of activeTasks) {
      tasksById.set(task.id, task);
    }
    // Annotated completion entries are fetched after the active snapshot and carry the current
    // `checked` state. Let that later observation win for both newly completed and reopened tasks.
    for (const task of completedTasks) {
      tasksById.set(task.id, task);
    }

    const snapshot: ProjectTaskSnapshot = { activeTasks: [], completedTasks: [] };
    for (const task of tasksById.values()) {
      const hydrated = hydrate(task, this.data());
      if (task.checked ?? task.completedAt != null) {
        snapshot.completedTasks.push(hydrated);
      } else {
        snapshot.activeTasks.push(hydrated);
      }
    }

    return snapshot;
  }

  public subscribe(
    query: string,
    callback: OnSubscriptionChange,
    initialTasks: Task[] = [],
    completedTasks = false,
    completedTasksProgress?: CompletedTasksProgress,
  ): [UnsubscribeCallback, Refresh, LoadMoreCompleted] {
    const fetcher = this.buildQueryFetcher(query, completedTasks);
    const completedTasksFetcher = completedTasks
      ? this.buildCompletedTasksFetcher(query)
      : undefined;

    if (completedTasks) {
      let entry = this.completedSubscriptions.get(query);
      const isExisting = entry !== undefined;
      if (entry === undefined) {
        entry = {
          subscription: new Subscription(
            fetcher,
            completedTasksFetcher,
            (task) => !this.tasksPendingClose.includes(task.id),
            initialTasks,
            true,
            completedTasksProgress,
          ),
        };
        this.completedSubscriptions.set(query, entry);
      }

      const unsubscribeCallback = entry.subscription.subscribe(callback, isExisting);
      if (entry.unsubscribeFromManager === undefined) {
        entry.unsubscribeFromManager = this.subscriptions.subscribe(entry.subscription);
      }

      let isSubscribed = true;
      const unsubscribe = () => {
        if (!isSubscribed) {
          return;
        }
        isSubscribed = false;
        unsubscribeCallback();
        if (!entry.subscription.hasSubscribers()) {
          entry.unsubscribeFromManager?.();
          entry.unsubscribeFromManager = undefined;
        }
      };

      return [unsubscribe, entry.subscription.update, entry.subscription.loadMoreCompleted];
    }

    const subscription = new Subscription(
      fetcher,
      completedTasksFetcher,
      (task) => !this.tasksPendingClose.includes(task.id),
      initialTasks,
      false,
      undefined,
    );
    const unsubscribeCallback = subscription.subscribe(callback);
    const unsubscribeFromManager = this.subscriptions.subscribe(subscription);
    return [
      () => {
        unsubscribeCallback();
        unsubscribeFromManager();
      },
      subscription.update,
      subscription.loadMoreCompleted,
    ];
  }

  public reset(): void {
    this.accountGeneration++;
    this.api.clear();
    this.hasSynced = false;
    this.metadataSyncInFlight = undefined;
    this.syncToken = "*";
    this.userInfo = undefined;
    this.projects.clear();
    this.sections.clear();
    this.labels.clear();
    this.tasksPendingClose.length = 0;

    for (const subscription of this.allSubscriptions()) {
      subscription.reset();
    }
  }

  private buildQueryFetcher(query: string, completedTasks: boolean): SubscriptionFetcher {
    return async () => {
      if (!this.api.hasValue()) {
        return undefined;
      }
      return await this.api.withInner(async (api) => {
        const activeTasksPromise = api.getTasks(query);
        if (!completedTasks) {
          const activeTasks = await activeTasksPromise;
          return {
            activeTasks: activeTasks.map((task) => hydrate(task, this.data())),
          };
        }

        const completedTasksPagePromise = api.getCompletedTasksPage(
          query,
          undefined,
          this.userInfo?.joinedAt ?? undefined,
        );
        const [activeTasks, completedTasksPage] = await Promise.all([
          activeTasksPromise,
          completedTasksPagePromise,
        ]);
        return {
          activeTasks: activeTasks.map((task) => hydrate(task, this.data())),
          completedTasksPage: {
            tasks: completedTasksPage.tasks.map((task) => hydrate(task, this.data())),
            request: completedTasksPage.request,
            nextPage: completedTasksPage.nextPage,
          },
        };
      });
    };
  }

  private buildCompletedTasksFetcher(query: string): CompletedTasksFetcher {
    return async (request) => {
      if (!this.api.hasValue()) {
        return undefined;
      }

      return await this.api.withInner(async (api) => {
        const page = await api.getCompletedTasksPage(query, request);
        return {
          tasks: page.tasks.map((task) => hydrate(task, this.data())),
          request: page.request,
          nextPage: page.nextPage,
        };
      });
    };
  }

  private async closeTask(id: TaskId): Promise<void> {
    const accountGeneration = this.accountGeneration;
    this.tasksPendingClose.push(id);

    for (const subscription of this.allSubscriptions()) {
      subscription.localCallback();
    }

    try {
      await this.api.withInner((api) => api.closeTask(id));
    } catch (error: unknown) {
      if (accountGeneration !== this.accountGeneration) {
        return;
      }
      this.tasksPendingClose.remove(id);

      for (const subscription of this.allSubscriptions()) {
        subscription.localCallback();
      }

      throw error;
    }

    if (accountGeneration !== this.accountGeneration) {
      return;
    }

    this.tasksPendingClose.remove(id);
    const completedAt = new Date();
    const cacheUpdate = this.notifyTaskClosed(id, completedAt);

    for (const subscription of this.allSubscriptions()) {
      subscription.complete(id, completedAt);
    }

    await cacheUpdate;
  }

  private async getTask(id: TaskId): Promise<ApiTask> {
    const accountGeneration = this.accountGeneration;
    const task = await this.api.withInner((api) => api.getTask(id));
    this.assertAccountGeneration(accountGeneration, "fetching a task");
    return task;
  }

  private async updateTask(id: TaskId, params: UpdateTaskParams): Promise<ApiTask> {
    const accountGeneration = this.accountGeneration;
    const task = await this.api.withInner((api) => api.updateTask(id, params));
    await this.runRemoteMutationFollowup("updateTask", async () => {
      this.assertAccountGeneration(accountGeneration, "updating a task");
      await this.refreshActiveSubscriptions(accountGeneration, "updating a task");
    });
    return task;
  }

  private async reopenTask(id: TaskId): Promise<void> {
    const accountGeneration = this.accountGeneration;
    await this.api.withInner((api) => api.reopenTask(id));
    await this.runRemoteMutationFollowup("reopenTask", async () => {
      this.assertAccountGeneration(accountGeneration, "reopening a task");
      await this.refreshActiveSubscriptions(accountGeneration, "reopening a task");
    });
  }

  private async reopenProjectTask(id: TaskId): Promise<void> {
    const accountGeneration = this.accountGeneration;
    await this.api.withInner((api) => api.reopenTask(id));
    await this.runRemoteMutationFollowup("reopenProjectTask", async () => {
      this.assertAccountGeneration(accountGeneration, "reopening a project task");
    });

    void this.refreshActiveSubscriptions(accountGeneration, "reopening a project task").catch(
      (error: unknown) => {
        console.error("Failed to refresh task queries after reopening a project task:", error);
      },
    );
  }

  private async closeProjectTask(id: TaskId): Promise<Date> {
    const accountGeneration = this.accountGeneration;
    await this.api.withInner((api) => api.closeTask(id));
    return await this.runRemoteMutationFollowup("closeProjectTask", async () => {
      this.assertAccountGeneration(accountGeneration, "closing a project task");
      const completedAt = new Date();
      for (const subscription of this.allSubscriptions()) {
        subscription.complete(id, completedAt);
      }
      void this.notifyTaskClosed(id, completedAt);
      return completedAt;
    });
  }

  private async runRemoteMutationFollowup<T>(
    action: TodoistRemoteMutationAction,
    followup: () => Promise<T>,
  ): Promise<T> {
    try {
      return await followup();
    } catch (cause: unknown) {
      throw new TodoistRemoteMutationFollowupError(action, cause);
    }
  }

  private async refreshActiveSubscriptions(
    accountGeneration: number,
    operation: string,
  ): Promise<void> {
    const refreshes = Array.from(this.subscriptions.list(), (subscription) => {
      this.assertAccountGeneration(accountGeneration, operation);
      return subscription.update();
    });
    await Promise.all(refreshes);
    this.assertAccountGeneration(accountGeneration, operation);
  }

  private assertAccountGeneration(accountGeneration: number, operation: string): void {
    if (accountGeneration !== this.accountGeneration) {
      throw new Error(`Todoist account changed while ${operation}`);
    }
  }

  private async notifyTaskClosed(id: TaskId, completedAt: Date): Promise<void> {
    try {
      await this.onTaskClosed?.(id, completedAt);
    } catch (error: unknown) {
      console.error("Failed to update Todoist query cache after closing a task:", error);
    }
  }

  private *allSubscriptions(): IterableIterator<Subscription> {
    const seen = new Set<Subscription>();

    for (const subscription of this.subscriptions.list()) {
      seen.add(subscription);
      yield subscription;
    }

    for (const { subscription } of this.completedSubscriptions.values()) {
      if (!seen.has(subscription)) {
        yield subscription;
      }
    }
  }
}

type CompletedTasksPage = {
  tasks: Task[];
  request: CompletedTasksPageRequest;
  nextPage: CompletedTasksPageRequest | null;
};

type CompletedSubscriptionEntry = {
  subscription: Subscription;
  unsubscribeFromManager?: UnsubscribeCallback;
};

type QueryFetchResult = {
  activeTasks: Task[];
  completedTasksPage?: CompletedTasksPage;
};

type SubscriptionFetcher = () => Promise<QueryFetchResult | undefined>;
type CompletedTasksFetcher = (
  request: CompletedTasksPageRequest,
) => Promise<CompletedTasksPage | undefined>;

class Subscription {
  private readonly userCallbacks = new Set<OnSubscriptionChange>();
  private readonly fetch: SubscriptionFetcher;
  private readonly fetchCompletedTasksPage: CompletedTasksFetcher | undefined;
  private readonly filter: (task: Task) => boolean;
  private readonly completedTasks: boolean;

  private result: SubscriptionResult;
  private lastSuccessfulTasks: Task[];
  private completedTasksProgress: CompletedTasksProgress | undefined;
  private updateGeneration = 0;
  private resetGeneration = 0;
  private refreshInFlight: Promise<void> | undefined;
  private loadMoreInFlight: Promise<void> | undefined;

  constructor(
    fetch: SubscriptionFetcher,
    fetchCompletedTasksPage: CompletedTasksFetcher | undefined,
    filter: (task: Task) => boolean,
    initialTasks: Task[],
    completedTasks: boolean,
    completedTasksProgress: CompletedTasksProgress | undefined,
  ) {
    this.fetch = fetch;
    this.fetchCompletedTasksPage = fetchCompletedTasksPage;
    this.filter = filter;
    this.completedTasks = completedTasks;
    this.completedTasksProgress = cloneCompletedTasksProgress(completedTasksProgress);
    this.result = this.makeSuccessResult(initialTasks, { type: "none" });
    this.lastSuccessfulTasks = initialTasks;
  }

  public subscribe(callback: OnSubscriptionChange, emitCurrent = false): UnsubscribeCallback {
    this.userCallbacks.add(callback);
    if (emitCurrent) {
      this.emitResultTo(callback, false);
    }
    return () => this.userCallbacks.delete(callback);
  }

  public hasSubscribers(): boolean {
    return this.userCallbacks.size > 0;
  }

  public update = async (): Promise<void> => {
    if (!this.completedTasks) {
      await this.performUpdate();
      return;
    }

    if (this.refreshInFlight !== undefined) {
      await this.refreshInFlight;
      return;
    }

    const refresh = this.performUpdate();
    this.refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = undefined;
      }
    }
  };

  private async performUpdate(): Promise<void> {
    const generation = ++this.updateGeneration;
    let nextResult: SubscriptionResult;

    try {
      const data = await this.fetch();
      if (generation !== this.updateGeneration) {
        return;
      }
      if (data === undefined) {
        nextResult = {
          type: "not-ready",
        };
      } else {
        let tasks = data.activeTasks;
        if (this.completedTasks && data.completedTasksPage !== undefined) {
          const cachedCompletedTasks = this.lastSuccessfulTasks.filter(isCompletedTask);
          tasks = mergeActiveAndCompletedTasks(
            data.activeTasks,
            data.completedTasksPage.tasks,
            cachedCompletedTasks,
          );
          this.completedTasksProgress = mergeCompletedTasksRefresh(
            this.completedTasksProgress,
            data.completedTasksPage,
          );
        }
        nextResult = this.makeSuccessResult(tasks, {
          type: "replace",
          requestedAt: new Date(),
        });
      }
    } catch (error: unknown) {
      console.error(`Failed to refresh task query: ${error}`);

      nextResult = {
        type: "error",
        kind: mapApiError(error),
      };
    }

    if (generation !== this.updateGeneration) {
      return;
    }

    this.result = nextResult;
    if (nextResult.type === "success") {
      this.lastSuccessfulTasks = nextResult.tasks;
    }
    this.callback();
  }

  public callback = () => {
    this.emitResult(true);
  };

  public localCallback = () => {
    if (this.result.type === "success") {
      this.emitResult(false);
      return;
    }

    const result = this.makeSuccessResult(this.lastSuccessfulTasks.filter(this.filter), {
      type: "none",
    });
    for (const callback of this.userCallbacks) {
      callback(result);
    }
  };

  private emitResult(includePersistenceMetadata: boolean): void {
    for (const callback of this.userCallbacks) {
      this.emitResultTo(callback, includePersistenceMetadata);
    }
  }

  private emitResultTo(callback: OnSubscriptionChange, includePersistenceMetadata: boolean): void {
    // Apply filtering, without mutating the actual state of the result.
    const result = { ...this.result };
    if (result.type === "success") {
      result.tasks = result.tasks.filter(this.filter);
      if (!includePersistenceMetadata) {
        result.cacheEffect = { type: "none" };
      }
    }
    callback(result);
  }

  public complete(id: TaskId, completedAt: Date) {
    this.updateGeneration++;
    if (this.completedTasks) {
      const completedAtIso = completedAt.toISOString();
      this.lastSuccessfulTasks = this.lastSuccessfulTasks.map((task) =>
        task.id === id ? { ...task, completedAt: completedAtIso } : task,
      );
    } else {
      this.lastSuccessfulTasks = this.lastSuccessfulTasks.filter((task) => task.id !== id);
    }
    this.result = this.makeSuccessResult(this.lastSuccessfulTasks, { type: "none" });
    this.callback();
  }

  public loadMoreCompleted = async (): Promise<void> => {
    if (this.loadMoreInFlight !== undefined) {
      await this.loadMoreInFlight;
      return;
    }

    const loadMore = this.performLoadMoreCompleted();
    this.loadMoreInFlight = loadMore;
    try {
      await loadMore;
    } finally {
      if (this.loadMoreInFlight === loadMore) {
        this.loadMoreInFlight = undefined;
      }
    }
  };

  private async performLoadMoreCompleted(): Promise<void> {
    const request = this.completedTasksProgress?.frontiers[0];
    if (
      !this.completedTasks ||
      request === undefined ||
      this.fetchCompletedTasksPage === undefined
    ) {
      return;
    }

    const generation = this.resetGeneration;
    const page = await this.fetchCompletedTasksPage(request);
    if (page === undefined || generation !== this.resetGeneration) {
      return;
    }

    this.completedTasksProgress = advanceCompletedTasksProgress(this.completedTasksProgress, page);
    this.lastSuccessfulTasks = mergeActiveAndCompletedTasks(
      this.lastSuccessfulTasks.filter((task) => !isCompletedTask(task)),
      page.tasks,
      this.lastSuccessfulTasks.filter(isCompletedTask),
    );
    this.result = this.makeSuccessResult(this.lastSuccessfulTasks, {
      type: "replace",
      requestedAt: new Date(),
    });
    this.callback();
  }

  private makeSuccessResult(
    tasks: Task[],
    cacheEffect: Extract<SubscriptionResult, { type: "success" }>["cacheEffect"],
  ): Extract<SubscriptionResult, { type: "success" }> {
    return {
      type: "success",
      tasks,
      ...(this.completedTasks
        ? { completedTasksProgress: cloneCompletedTasksProgress(this.completedTasksProgress) }
        : {}),
      cacheEffect,
    };
  }

  public reset(): void {
    this.updateGeneration++;
    this.resetGeneration++;
    this.refreshInFlight = undefined;
    this.loadMoreInFlight = undefined;
    this.lastSuccessfulTasks = [];
    this.completedTasksProgress = undefined;
    this.result = { type: "not-ready" };
    this.callback();
  }
}

const cloneCompletedTasksProgress = (
  progress: CompletedTasksProgress | undefined,
): CompletedTasksProgress | undefined => {
  if (progress === undefined) {
    return undefined;
  }

  return {
    ...progress,
    frontiers: progress.frontiers.map((frontier) => ({ ...frontier })),
  };
};

const mergeCompletedTasksRefresh = (
  progress: CompletedTasksProgress | undefined,
  page: CompletedTasksPage,
): CompletedTasksProgress => {
  if (progress === undefined) {
    return {
      latestUntil: page.request.until,
      historyStart: page.request.historyStart,
      loadedWindowCount: 1,
      frontiers: page.nextPage === null ? [] : [{ ...page.nextPage }],
    };
  }

  const latestUntil = laterTimestamp(progress.latestUntil, page.request.until);
  const hasGap = Date.parse(page.request.since) > Date.parse(progress.latestUntil);
  const hasCurrentWindowCursor = page.nextPage?.cursor !== undefined;

  // A complete newest window that overlaps the already cached newest range does not
  // change the older history frontier. Only its upper coverage bound advances.
  if (!hasGap && !hasCurrentWindowCursor) {
    return {
      ...progress,
      latestUntil,
      frontiers: progress.frontiers.map((frontier) => ({ ...frontier })),
    };
  }

  if (page.nextPage === null) {
    return {
      ...progress,
      latestUntil,
      frontiers: progress.frontiers.map((frontier) => ({ ...frontier })),
    };
  }

  const catchUpHistoryStart = getCatchUpHistoryStart(progress);
  const boundedCatchUp = boundCatchUpFrontier(page.nextPage, catchUpHistoryStart);
  const globalHistoryFrontiers = progress.frontiers.filter(
    (frontier) => frontier.historyStart === progress.historyStart,
  );

  return {
    latestUntil,
    historyStart: progress.historyStart,
    loadedWindowCount: progress.loadedWindowCount,
    frontiers: deduplicateFrontiers([boundedCatchUp, ...globalHistoryFrontiers]),
  };
};

const getCatchUpHistoryStart = (progress: CompletedTasksProgress): string => {
  let historyStart = progress.latestUntil;

  for (const frontier of progress.frontiers) {
    if (
      frontier.historyStart !== progress.historyStart &&
      Date.parse(frontier.historyStart) < Date.parse(historyStart)
    ) {
      historyStart = frontier.historyStart;
    }
  }

  return historyStart;
};

const boundCatchUpFrontier = (
  frontier: CompletedTasksPageRequest,
  historyStart: string,
): CompletedTasksPageRequest => {
  if (frontier.cursor !== undefined) {
    return { ...frontier, historyStart };
  }

  return {
    ...frontier,
    since: laterTimestamp(frontier.since, historyStart),
    historyStart,
  };
};

const advanceCompletedTasksProgress = (
  progress: CompletedTasksProgress | undefined,
  page: CompletedTasksPage,
): CompletedTasksProgress | undefined => {
  if (progress === undefined) {
    return undefined;
  }

  const claimedIndex = progress.frontiers.findIndex(
    (frontier) => completedTasksRequestKey(frontier) === completedTasksRequestKey(page.request),
  );
  if (claimedIndex === -1) {
    return cloneCompletedTasksProgress(progress);
  }

  const frontiers = [...progress.frontiers];
  if (page.nextPage === null) {
    frontiers.splice(claimedIndex, 1);
  } else {
    frontiers.splice(claimedIndex, 1, { ...page.nextPage });
  }

  return {
    ...progress,
    loadedWindowCount: progress.loadedWindowCount + 1,
    frontiers: deduplicateFrontiers(frontiers),
  };
};

const deduplicateFrontiers = (
  frontiers: CompletedTasksPageRequest[],
): CompletedTasksPageRequest[] => {
  const seen = new Set<string>();
  return frontiers.filter((frontier) => {
    const key = completedTasksRequestKey(frontier);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const completedTasksRequestKey = (request: CompletedTasksPageRequest): string =>
  JSON.stringify([request.since, request.until, request.historyStart, request.cursor ?? null]);

const laterTimestamp = (left: string, right: string): string =>
  Date.parse(left) >= Date.parse(right) ? left : right;

const isCompletedTask = (task: Task): boolean => task.completedAt !== undefined;

const mergeActiveAndCompletedTasks = (
  activeTasks: Task[],
  freshCompletedTasks: Task[],
  cachedCompletedTasks: Task[],
): Task[] => {
  const activeIds = new Set(activeTasks.map((task) => task.id));
  const completedById = new Map<TaskId, Task>();

  for (const task of [...freshCompletedTasks, ...cachedCompletedTasks]) {
    if (!activeIds.has(task.id) && !completedById.has(task.id)) {
      completedById.set(task.id, task);
    }
  }

  return [...activeTasks, ...completedById.values()];
};
