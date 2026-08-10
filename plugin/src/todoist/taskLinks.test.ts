import { describe, expect, it } from "vitest";

import { todoistTaskAppUrl, todoistTaskWebUrl } from "@/todoist/taskLinks";

describe("Todoist task links", () => {
  it("builds the app task URL", () => {
    expect(todoistTaskAppUrl("task-123")).toBe("todoist://task?id=task-123");
  });

  it("builds the project-aware web task URL", () => {
    expect(todoistTaskWebUrl("project-456", "task-123")).toBe(
      "https://todoist.com/app/project/project-456/task/task-123",
    );
  });
});
