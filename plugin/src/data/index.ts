import type { TodoistApiClient } from "@/api";
import type { Label, LabelId } from "@/api/domain/label";
import type { Project, ProjectId } from "@/api/domain/project";
import type { Section, SectionId } from "@/api/domain/section";
import type { SyncToken } from "@/api/domain/sync";
import type { Task as ApiTask, CreateTaskParams, TaskId } from "@/api/domain/task";
import type { UserInfo } from "@/api/domain/user";
import { mapApiError } from "@/data/errors";
import { type DataAccessor, hydrate } from "@/data/hydrate";
import { Repository } from "@/data/repository";
import {
  type OnSubscriptionChange,
  type Refresh,
  SubscriptionManager,
  type SubscriptionResult,
  type UnsubscribeCallback,
} from "@/data/subscriptions";
import type { Task } from "@/data/task";
import { Maybe } from "@/utils/maybe";

export { QueryErrorKind } from "@/data/errors";
export type { OnSubscriptionChange, Refresh, SubscriptionResult } from "@/data/subscriptions";

type TodoistAdapterOptions = {
  onTaskClosed?: (taskId: TaskId, completedAt: Date) => Promise<void> | void;
};

export class TodoistAdapter {
  public actions = {
    closeTask: async (id: TaskId) => await this.closeTask(id),
    createTask: async (content: string, params: CreateTaskParams): Promise<ApiTask> =>
      await this.api.withInner((api) => api.createTask(content, params)),
  };

  private readonly api: Maybe<TodoistApiClient> = Maybe.Empty();
  private readonly projects: Repository<ProjectId, Project>;
  private readonly sections: Repository<SectionId, Section>;
  private readonly labels: Repository<LabelId, Label>;
  private readonly subscriptions: SubscriptionManager<Subscription>;

  private readonly tasksPendingClose: TaskId[];
  private userInfo: UserInfo | undefined;

  private accountGeneration = 0;
  private hasSynced = false;
  private readonly onTaskClosed: TodoistAdapterOptions["onTaskClosed"];
  private syncToken: SyncToken = "*";

  constructor(options: TodoistAdapterOptions = {}) {
    this.projects = new Repository<ProjectId, Project>();
    this.sections = new Repository<SectionId, Section>();
    this.labels = new Repository<LabelId, Label>();
    this.subscriptions = new SubscriptionManager<Subscription>();
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

  public async sync(): Promise<void> {
    if (!this.api.hasValue()) {
      return;
    }

    const accountGeneration = this.accountGeneration;
    await Promise.all([this.syncUserInfo(accountGeneration), this.syncMetadata(accountGeneration)]);

    if (accountGeneration !== this.accountGeneration) {
      return;
    }

    for (const subscription of this.subscriptions.list()) {
      if (accountGeneration !== this.accountGeneration) {
        return;
      }
      await subscription.update();
    }

    if (accountGeneration === this.accountGeneration) {
      this.hasSynced = true;
    }
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

  private async syncMetadata(accountGeneration: number): Promise<void> {
    try {
      if (!this.api.hasValue()) {
        return;
      }

      const response = await this.api.withInner((api) => api.sync(this.syncToken));
      if (accountGeneration !== this.accountGeneration) {
        return;
      }

      this.projects.applyDiff(response.projects);
      this.sections.applyDiff(response.sections);
      this.labels.applyDiff(response.labels);
      this.syncToken = response.syncToken;
    } catch (error) {
      console.error("Failed to sync metadata:", error);
    }
  }

  public data(): DataAccessor {
    return {
      projects: this.projects,
      sections: this.sections,
      labels: this.labels,
    };
  }

  public subscribe(
    query: string,
    callback: OnSubscriptionChange,
    initialTasks: Task[] = [],
  ): [UnsubscribeCallback, Refresh] {
    const fetcher = this.buildQueryFetcher(query);
    const subscription = new Subscription(
      callback,
      fetcher,
      (task) => !this.tasksPendingClose.includes(task.id),
      initialTasks,
    );
    return [this.subscriptions.subscribe(subscription), subscription.update];
  }

  public reset(): void {
    this.accountGeneration++;
    this.hasSynced = false;
    this.syncToken = "*";
    this.userInfo = undefined;
    this.projects.clear();
    this.sections.clear();
    this.labels.clear();
    this.tasksPendingClose.length = 0;

    for (const subscription of this.subscriptions.list()) {
      subscription.reset();
    }
  }

  private buildQueryFetcher(query: string): SubscriptionFetcher {
    return async () => {
      if (!this.api.hasValue()) {
        return undefined;
      }
      const data = await this.api.withInner((api) => api.getTasks(query));
      const hydrated = data.map((t) => hydrate(t, this.data()));
      return hydrated;
    };
  }

  private async closeTask(id: TaskId): Promise<void> {
    const accountGeneration = this.accountGeneration;
    this.tasksPendingClose.push(id);

    for (const subscription of this.subscriptions.list()) {
      subscription.localCallback();
    }

    try {
      await this.api.withInner((api) => api.closeTask(id));
    } catch (error: unknown) {
      if (accountGeneration !== this.accountGeneration) {
        return;
      }
      this.tasksPendingClose.remove(id);

      for (const subscription of this.subscriptions.list()) {
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

    for (const subscription of this.subscriptions.list()) {
      subscription.remove(id);
    }

    await cacheUpdate;
  }

  private async notifyTaskClosed(id: TaskId, completedAt: Date): Promise<void> {
    try {
      await this.onTaskClosed?.(id, completedAt);
    } catch (error: unknown) {
      console.error("Failed to update Todoist query cache after closing a task:", error);
    }
  }
}

type SubscriptionFetcher = () => Promise<Task[] | undefined>;

class Subscription {
  private readonly userCallback: OnSubscriptionChange;
  private readonly fetch: SubscriptionFetcher;
  private readonly filter: (task: Task) => boolean;

  private result: SubscriptionResult;
  private lastSuccessfulTasks: Task[];
  private updateGeneration = 0;

  constructor(
    userCallback: OnSubscriptionChange,
    fetch: SubscriptionFetcher,
    filter: (task: Task) => boolean,
    initialTasks: Task[],
  ) {
    this.userCallback = userCallback;
    this.fetch = fetch;
    this.filter = filter;
    this.result = { type: "success", tasks: initialTasks, cacheEffect: { type: "none" } };
    this.lastSuccessfulTasks = initialTasks;
  }

  public update = async () => {
    const generation = ++this.updateGeneration;
    const requestedAt = new Date();
    let nextResult: SubscriptionResult;

    try {
      const data = await this.fetch();
      if (data === undefined) {
        nextResult = {
          type: "not-ready",
        };
      } else {
        nextResult = {
          type: "success",
          tasks: data,
          cacheEffect: { type: "replace", requestedAt },
        };
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
  };

  public callback = () => {
    this.emitResult(true);
  };

  public localCallback = () => {
    if (this.result.type === "success") {
      this.emitResult(false);
      return;
    }

    this.userCallback({
      type: "success",
      tasks: this.lastSuccessfulTasks.filter(this.filter),
      cacheEffect: { type: "none" },
    });
  };

  private emitResult(includePersistenceMetadata: boolean): void {
    // Apply filtering, without mutating the actual state of the result.
    const result = { ...this.result };
    if (result.type === "success") {
      result.tasks = result.tasks.filter(this.filter);
      if (!includePersistenceMetadata) {
        result.cacheEffect = { type: "none" };
      }
    }
    this.userCallback(result);
  }

  public remove(id: TaskId) {
    this.updateGeneration++;
    this.lastSuccessfulTasks = this.lastSuccessfulTasks.filter((task) => task.id !== id);
    this.result = {
      type: "success",
      tasks: this.lastSuccessfulTasks,
      cacheEffect: { type: "none" },
    };
    this.callback();
  }

  public reset(): void {
    this.updateGeneration++;
    this.lastSuccessfulTasks = [];
    this.result = { type: "not-ready" };
    this.callback();
  }
}
