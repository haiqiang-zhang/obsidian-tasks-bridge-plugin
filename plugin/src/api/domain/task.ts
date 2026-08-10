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

const todoistTimestampSchema = z.iso.datetime({ offset: true });

export const taskSchema = z.object({
  id: taskIdSchema,
  addedAt: z.string(),
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

const UNKNOWN_ADDED_AT = "1970-01-01T00:00:00.000Z";

const itemSyncTaskSchema = taskSchema.extend({
  addedAt: z.string().nullable(),
  checked: z.boolean(),
  updatedAt: todoistTimestampSchema.nullable(),
});

export const projectTaskSchema = itemSyncTaskSchema.transform((task) => ({
  ...task,
  addedAt: task.addedAt ?? UNKNOWN_ADDED_AT,
  updatedAt: task.updatedAt ?? undefined,
}));

const annotatedCompletedTaskSchema = itemSyncTaskSchema.transform((task) => ({
  ...task,
  updatedAt: task.updatedAt ?? undefined,
}));

export const completedTaskSchema = taskSchema
  .extend({
    addedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .transform((task) => ({
    ...task,
    addedAt: task.addedAt ?? task.completedAt ?? UNKNOWN_ADDED_AT,
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
