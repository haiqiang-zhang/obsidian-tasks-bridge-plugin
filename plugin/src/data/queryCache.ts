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
import type { Task } from "@/data/task";

const cacheVersion = 2;
const maxCacheEntries = 100;

const cachedTaskSchema = z.object({
  id: taskIdSchema,
  createdAt: z.string(),
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

const cachedQuerySchema = z.object({
  tasks: z.array(cachedTaskSchema),
  updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
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
};

export type SerializedQueryCache = {
  version: typeof cacheVersion;
  credentialFingerprint: string | null;
  entries: Record<string, SerializedQuery>;
};

export class QueryCache {
  private entries: Record<string, SerializedQuery> = Object.create(null);
  private credentialFingerprint: string | null = null;
  private readonly clearListeners: Set<() => void> = new Set();

  public load(value: unknown): void {
    this.entries = Object.create(null);
    this.credentialFingerprint = null;

    const cache = serializedCacheSchema.safeParse(value);
    if (!cache.success) {
      return;
    }

    this.credentialFingerprint = cache.data.credentialFingerprint;
    for (const [key, entry] of Object.entries(cache.data.entries)) {
      const parsedEntry = cachedQuerySchema.safeParse(entry);
      if (parsedEntry.success) {
        this.entries[key] = parsedEntry.data;
      }
    }

    this.prune();
  }

  public get(filter: string): CachedQuery | undefined {
    const entry = this.entries[makeCacheKey(filter)];
    if (entry === undefined) {
      return undefined;
    }

    return {
      tasks: entry.tasks,
      updatedAt: new Date(entry.updatedAt),
    };
  }

  public set(filter: string, tasks: Task[], updatedAt: Date): boolean {
    const key = makeCacheKey(filter);
    const existing = this.entries[key];
    if (existing !== undefined && Date.parse(existing.updatedAt) >= updatedAt.getTime()) {
      return false;
    }

    this.entries[key] = {
      tasks,
      updatedAt: updatedAt.toISOString(),
    };
    this.prune();
    return true;
  }

  public removeTaskFromAll(taskId: TaskId, updatedAt: Date): boolean {
    let changed = false;

    for (const [key, existing] of Object.entries(this.entries)) {
      const tasks = existing.tasks.filter((task) => task.id !== taskId);
      if (tasks.length === existing.tasks.length) {
        continue;
      }

      const nextUpdatedAt = new Date(
        Math.max(Date.parse(existing.updatedAt), updatedAt.getTime()),
      ).toISOString();
      this.entries[key] = {
        tasks,
        updatedAt: nextUpdatedAt,
      };
      changed = true;
    }

    if (changed) {
      this.prune();
    }
    return changed;
  }

  public clear(): void {
    this.entries = Object.create(null);
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
      entries: { ...this.entries },
    };
  }

  private prune(): void {
    const entries = Object.entries(this.entries);
    if (entries.length <= maxCacheEntries) {
      return;
    }

    entries.sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    this.entries = Object.fromEntries(entries.slice(0, maxCacheEntries));
  }

  private notifyClear(): void {
    for (const listener of this.clearListeners) {
      listener();
    }
  }
}

const makeCacheKey = (filter: string): string => JSON.stringify({ filter });
