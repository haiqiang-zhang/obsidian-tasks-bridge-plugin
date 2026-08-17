import { z } from "zod";

import { dueDateSchema } from "@/api/domain/dueDate";
import { projectIdSchema } from "@/api/domain/project";
import { sectionIdSchema } from "@/api/domain/section";

export const taskIdSchema = z.string();
export type TaskId = z.infer<typeof taskIdSchema>;

export const deadlineSchema = z.object({
  date: z.string(),
});
export type Deadline = z.infer<typeof deadlineSchema>;

export const durationSchema = z.object({
  amount: z.number(),
  unit: z.enum(["minute", "day"]),
});
export type Duration = z.infer<typeof durationSchema>;

// Keep the Priorities const for application use
export const Priorities = {
  P4: 1,
  P3: 2,
  P2: 3,
  P1: 4,
} as const;

export const prioritySchema = z.union([
  z.literal(Priorities.P1),
  z.literal(Priorities.P2),
  z.literal(Priorities.P3),
  z.literal(Priorities.P4),
]);

export type Priority = z.infer<typeof prioritySchema>;

export const todoistTimestampSchema = z.iso.datetime({ offset: true });

const rawTaskSchema = z.object({
  id: taskIdSchema,
  addedAt: todoistTimestampSchema,
  content: z.string(),
  description: z.string(),
  projectId: projectIdSchema,
  sectionId: sectionIdSchema.nullable(),
  parentId: taskIdSchema.nullable(),
  labels: z.array(z.string()),
  priority: prioritySchema,
  due: dueDateSchema.nullable(),
  duration: durationSchema.nullable(),
  deadline: deadlineSchema.nullable(),
  childOrder: z.number(),
  checked: z.boolean().optional(),
  updatedAt: todoistTimestampSchema.optional(),
});

export const taskSchema = rawTaskSchema.transform((task) => ({
  ...task,
  addedAtIsAuthoritative: task.addedAt.length > 0,
}));

const UNKNOWN_ADDED_AT = "1970-01-01T00:00:00.000Z";

const itemSyncTaskSchema = rawTaskSchema.extend({
  addedAt: todoistTimestampSchema.nullable(),
  checked: z.boolean(),
  updatedAt: todoistTimestampSchema.nullable(),
});

export const projectTaskSchema = itemSyncTaskSchema.transform((task) => ({
  ...task,
  addedAtIsAuthoritative: task.addedAt !== null,
  addedAt: task.addedAt ?? UNKNOWN_ADDED_AT,
  updatedAt: task.updatedAt ?? undefined,
}));

const annotatedCompletedTaskSchema = itemSyncTaskSchema.transform((task) => ({
  ...task,
  addedAtIsAuthoritative: task.addedAt !== null,
  addedAt: task.addedAt ?? UNKNOWN_ADDED_AT,
  updatedAt: task.updatedAt ?? undefined,
}));

export const completedTaskSchema = rawTaskSchema
  .extend({
    addedAt: todoistTimestampSchema.nullable(),
    completedAt: todoistTimestampSchema.nullable(),
  })
  .transform((task) => ({
    ...task,
    addedAtIsAuthoritative: task.addedAt !== null,
    // Keep an explicit non-authoritative sentinel for legacy sorting code, but never substitute
    // `completedAt`: completion time is not task creation time.
    addedAt: task.addedAt ?? UNKNOWN_ADDED_AT,
    // A completion-history record can describe a task that has since been
    // reopened. In that case `checked` is the current source of truth and the
    // historical timestamp must not make the current task look completed.
    completedAt: task.checked === false ? null : task.completedAt,
  }));

export const completedTaskEntrySchema = z
  .object({
    id: z.string(),
    taskId: taskIdSchema,
    projectId: projectIdSchema,
    completedAt: todoistTimestampSchema,
    itemObject: annotatedCompletedTaskSchema,
  })
  .superRefine((entry, context) => {
    if (entry.taskId !== entry.itemObject.id) {
      context.addIssue({
        code: "custom",
        path: ["itemObject", "id"],
        message: "Annotated task ID must match the completion entry task ID",
      });
    }

    if (entry.projectId !== entry.itemObject.projectId) {
      context.addIssue({
        code: "custom",
        path: ["itemObject", "projectId"],
        message: "Annotated task project ID must match the completion entry project ID",
      });
    }
  });

export type CompletedTaskEntry = z.infer<typeof completedTaskEntrySchema>;

/** A single Todoist completion occurrence, including repeated completions of the same task. */
export type ProjectCompletionEvent = Readonly<
  Pick<CompletedTaskEntry, "id" | "taskId" | "projectId" | "completedAt">
>;

export type Task = z.infer<typeof taskSchema> & {
  completedAt?: string | null;
};

export const createTaskParamsSchema = z.object({
  priority: prioritySchema,
  projectId: projectIdSchema,
  description: z.string().optional(),
  sectionId: sectionIdSchema.optional(),
  dueDate: z.string().optional(),
  dueDatetime: z.string().optional(),
  labels: z.array(z.string()).optional(),
  deadlineDate: z.string().optional(),
});
export type CreateTaskParams = z.infer<typeof createTaskParamsSchema>;

export const updateTaskParamsSchema = z.object({
  content: z.string().optional(),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: prioritySchema.optional(),
  dueString: z.string().optional(),
  dueDate: z.string().optional(),
  dueDatetime: z.string().optional(),
  duration: durationSchema.nullable().optional(),
  deadlineDate: z.string().nullable().optional(),
});
export type UpdateTaskParams = z.infer<typeof updateTaskParamsSchema>;
