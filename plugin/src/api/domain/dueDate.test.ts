import { describe, expect, it } from "vitest";

import { dueDateSchema } from "./dueDate";

describe("dueDateSchema", () => {
  it("preserves Todoist datetime and timezone metadata", () => {
    expect(
      dueDateSchema.parse({
        date: "2026-08-12",
        datetime: "2026-08-12T09:30:00.000Z",
        timezone: "Asia/Shanghai",
        isRecurring: false,
      }),
    ).toEqual({
      date: "2026-08-12",
      datetime: "2026-08-12T09:30:00.000Z",
      timezone: "Asia/Shanghai",
      isRecurring: false,
    });
  });

  it("accepts absent or null optional time metadata", () => {
    expect(
      dueDateSchema.parse({
        date: "2026-08-12",
        datetime: null,
        timezone: null,
        isRecurring: true,
      }),
    ).toMatchObject({ datetime: null, timezone: null });

    expect(dueDateSchema.parse({ date: "2026-08-12", isRecurring: false })).not.toHaveProperty(
      "datetime",
    );
  });
});
