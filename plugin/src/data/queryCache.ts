import { z } from "zod";

import { dueDateSchema } from "@/api/domain/dueDate";
import { labelSchema } from "@/api/domain/label";
import { projectSchema } from "@/api/domain/project";
import { sectionSchema } from "@/api/domain/section";
import {
  deadlineSchema,
  durationSchema,
  prioritySchema,
  type TaskId,
  taskIdSchema,
} from "@/api/domain/task";
import { type DataAccessor, rebindTaskMetadataList } from "@/data/hydrate";
import type { CompletedTasksProgress } from "@/data/subscriptions";
import { isTaskCompleted, type Task } from "@/data/task";

const cacheVersion = 2;
const maxCacheEntries = 100;
const TODOIST_SERVICE_LAUNCH_AT = "2007-01-01T00:00:00.000Z";

const cachedTaskSchema = z.object({
  id: taskIdSchema,
  createdAt: z.string(),
  authoritativeCreatedAt: z.string().optional(),
  updatedAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .optional(),
  completedAt: z.string().nullable().optional(),
  content: z.string(),
  description: z.string(),
  project: projectSchema,
  section: sectionSchema.optional(),
  parentId: taskIdSchema.optional(),
  labels: z.array(labelSchema),
  priority: prioritySchema,
  due: dueDateSchema.optional(),
  duration: durationSchema.optional(),
  deadline: deadlineSchema.optional(),
  order: z.number(),
});

const completedTasksPageRequestSchema = z.object({
  since: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  until: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  historyStart: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  cursor: z.string().optional(),
});

const completedTasksProgressSchema = z.object({
  latestUntil: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  historyStart: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  loadedWindowCount: z.number().int().min(1).optional(),
  frontiers: z.array(completedTasksPageRequestSchema),
});

const cachedQuerySchema = z.object({
  tasks: z.array(cachedTaskSchema),
  updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  completedTasksProgress: completedTasksProgressSchema.optional(),
  // Read the one-frontier format written by development builds before the
  // progressive coordinator was introduced. New writes use the progress object.
  completedTasksNextPage: completedTasksPageRequestSchema.nullable().optional(),
});

const serializedCacheSchema = z.object({
  version: z.literal(cacheVersion),
  credentialFingerprint: z.string().nullable(),
  entries: z.record(z.string(), z.unknown()),
});

type SerializedQuery = z.infer<typeof cachedQuerySchema>;

export type CachedQuery = {
  tasks: Task[];
  updatedAt: Date;
  completedTasksProgress?: CompletedTasksProgress;
};

export type SerializedQueryCache = {
  version: typeof cacheVersion;
  credentialFingerprint: string | null;
  entries: Record<string, SerializedQuery>;
};

export class QueryCache {
  private entries = new Map<string, SerializedQuery>();
  private credentialFingerprint: string | null = null;
  private readonly clearListeners: Set<() => void> = new Set();

  public load(value: unknown): void {
    this.entries.clear();
    this.credentialFingerprint = null;

    const cache = serializedCacheSchema.safeParse(value);
    if (!cache.success) {
      return;
    }

    this.credentialFingerprint = cache.data.credentialFingerprint;
    for (const [key, entry] of Object.entries(cache.data.entries)) {
      const parsedEntry = cachedQuerySchema.safeParse(entry);
      if (parsedEntry.success) {
        this.entries.set(key, {
          ...parsedEntry.data,
          tasks: normalizeTasksForCacheMode(parsedEntry.data.tasks, isCompletedTasksCacheKey(key)),
        });
      }
    }

    this.prune();
  }

  public get(filter: string, completedTasks = false): CachedQuery | undefined {
    const key = makeCacheKey(filter, completedTasks);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }

    const tasks = normalizeTasksForCacheMode(entry.tasks, completedTasks);
    if (tasks.length !== entry.tasks.length) {
      entry = { ...entry, tasks };
      this.entries.set(key, entry);
    }

    const completedTasksProgress = getCompletedTasksProgress(entry);

    return {
      tasks,
      updatedAt: new Date(entry.updatedAt),
      ...(completedTasksProgress !== undefined ? { completedTasksProgress } : {}),
    };
  }

  public set(
    filter: string,
    tasks: Task[],
    updatedAt: Date,
    completedTasks = false,
    completedTasksProgress?: CompletedTasksProgress,
  ): boolean {
    const key = makeCacheKey(filter, completedTasks);
    const existing = this.entries.get(key);
    if (existing !== undefined && Date.parse(existing.updatedAt) >= updatedAt.getTime()) {
      return false;
    }

    this.entries.set(key, {
      tasks: normalizeTasksForCacheMode(tasks, completedTasks),
      updatedAt: updatedAt.toISOString(),
      ...(completedTasksProgress !== undefined ? { completedTasksProgress } : {}),
    });
    this.prune();
    return true;
  }

  public removeTaskFromAll(taskId: TaskId, updatedAt: Date): boolean {
    let changed = false;

    for (const [key, existing] of this.entries) {
      const tasks = existing.tasks.filter((task) => task.id !== taskId);
      if (tasks.length === existing.tasks.length) {
        continue;
      }

      const nextUpdatedAt = new Date(
        Math.max(Date.parse(existing.updatedAt), updatedAt.getTime()),
      ).toISOString();
      this.entries.set(key, {
        ...existing,
        tasks,
        updatedAt: nextUpdatedAt,
      });
      changed = true;
    }

    if (changed) {
      this.prune();
    }
    return changed;
  }

  /** Rebind every cached query to current Todoist metadata without changing query freshness. */
  public rebindMetadata(data: DataAccessor): boolean {
    let changed = false;

    for (const [key, existing] of this.entries) {
      const tasks = rebindTaskMetadataList(existing.tasks, data);
      if (tasks === existing.tasks) {
        continue;
      }

      this.entries.set(key, { ...existing, tasks });
      changed = true;
    }

    return changed;
  }

  public completeTaskInAll(taskId: TaskId, completedAt: Date): boolean {
    let changed = false;
    const completedAtIso = completedAt.toISOString();

    for (const [key, existing] of this.entries) {
      if (!existing.tasks.some((task) => task.id === taskId)) {
        continue;
      }

      const tasks = isCompletedTasksCacheKey(key)
        ? existing.tasks.map((task) =>
            task.id === taskId ? { ...task, completedAt: completedAtIso } : task,
          )
        : existing.tasks.filter((task) => task.id !== taskId);
      const nextUpdatedAt = new Date(
        Math.max(Date.parse(existing.updatedAt), completedAt.getTime()),
      ).toISOString();
      this.entries.set(key, {
        ...existing,
        tasks,
        updatedAt: nextUpdatedAt,
      });
      changed = true;
    }

    if (changed) {
      this.prune();
    }
    return changed;
  }

  public clear(): void {
    this.entries.clear();
    this.notifyClear();
  }

  public bindCredential(fingerprint: string | null): boolean {
    if (this.credentialFingerprint === fingerprint) {
      return false;
    }

    this.credentialFingerprint = fingerprint;
    this.clear();
    return true;
  }

  public onClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  public serialize(): SerializedQueryCache {
    return {
      version: cacheVersion,
      credentialFingerprint: this.credentialFingerprint,
      entries: Object.fromEntries(this.entries),
    };
  }

  private prune(): void {
    const entries = [...this.entries];
    if (entries.length <= maxCacheEntries) {
      return;
    }

    entries.sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    this.entries = new Map(entries.slice(0, maxCacheEntries));
  }

  private notifyClear(): void {
    for (const listener of this.clearListeners) {
      listener();
    }
  }
}

const makeCacheKey = (filter: string, completedTasks: boolean): string =>
  completedTasks ? JSON.stringify({ filter, completedTasks: true }) : JSON.stringify({ filter });

const normalizeTasksForCacheMode = (tasks: Task[], completedTasks: boolean): Task[] =>
  completedTasks ? tasks : tasks.filter((task) => !isTaskCompleted(task));

const getCompletedTasksProgress = (entry: SerializedQuery): CompletedTasksProgress | undefined => {
  if (entry.completedTasksProgress !== undefined) {
    return {
      ...entry.completedTasksProgress,
      loadedWindowCount: entry.completedTasksProgress.loadedWindowCount ?? 1,
    };
  }
  if (entry.completedTasksNextPage === undefined) {
    return undefined;
  }

  return {
    latestUntil: entry.updatedAt,
    historyStart: entry.completedTasksNextPage?.historyStart ?? TODOIST_SERVICE_LAUNCH_AT,
    loadedWindowCount: 1,
    frontiers: entry.completedTasksNextPage === null ? [] : [entry.completedTasksNextPage],
  };
};

const isCompletedTasksCacheKey = (key: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(key);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "completedTasks" in parsed &&
      parsed.completedTasks === true
    );
  } catch {
    return false;
  }
};
