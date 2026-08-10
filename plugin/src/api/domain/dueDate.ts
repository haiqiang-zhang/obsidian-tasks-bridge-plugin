import { z } from "zod";

export const dueDateSchema = z.object({
  isRecurring: z.boolean(),
  date: z.string(),
  datetime: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
});

export type DueDate = z.infer<typeof dueDateSchema>;
