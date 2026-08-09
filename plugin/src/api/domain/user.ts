import { z } from "zod";

export const userInfoSchema = z.object({
  isPremium: z.boolean(),
  joinedAt: z.string().nullable().optional(),
});

export type UserInfo = z.infer<typeof userInfoSchema>;
