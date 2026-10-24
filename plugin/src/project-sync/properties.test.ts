import { describe, expect, it } from "vitest";

import {
  assertTaskPropertyMigrationSafe,
  deleteTaskProperty,
  migrateTaskProperties,
  readTaskProperty,
  setTaskProperty,
  TaskPropertyConflictError,
} from "./properties";

describe("task property schema", () => {
  it("reads canonical and legacy values without losing false, zero, or empty values", () => {
    expect(readTaskProperty(undefined, "todoist_task_id")).toBeUndefined();
    expect(readTaskProperty({ "task id": "task-1" }, "todoist_task_id")).toBe("task-1");
    expect(readTaskProperty({ todoist_task_id: "task-1" }, "todoist_task_id")).toBe("task-1");
    expect(readTaskProperty({ completed: false }, "todoist_completed")).toBe(false);
    expect(readTaskProperty({ todoist_duration: 0 }, "todoist_duration")).toBe(0);
    expect(readTaskProperty({ description: "" }, "todoist_description")).toBe("");
  });

  it("migrates existing fields together when a completion property is changed", () => {
    const frontmatter = {
      todoist_task_id: "9007199254740993",
      todoist_completed: false,
      todoist_status: "active",
      todoist_due_is_recurring: false,
      todoist_subtasks: ["[[Child]]"],
      tags: ["study"],
      aliases: ["An alias"],
      cssclasses: ["my-style"],
      user_field: "keep me",
    };

    expect(setTaskProperty(frontmatter, "todoist_completed", true)).toBe(true);
    expect(frontmatter).toEqual({
      "task id": "9007199254740993",
      completed: true,
      status: "active",
      recurring: false,
      subtasks: ["[[Child]]"],
      tags: ["study"],
      aliases: ["An alias"],
      cssclasses: ["my-style"],
      user_field: "keep me",
    });
    expect(readTaskProperty(frontmatter, "todoist_completed")).toBe(true);
    expect(setTaskProperty(frontmatter, "todoist_completed", true)).toBe(false);
    expect(migrateTaskProperties(frontmatter)).toBe(false);
  });

  it("removes retired properties under either spelling", () => {
    const frontmatter = { todoist_task_id: "task-1", todoist_synced_at: "old", user: true };

    expect(deleteTaskProperty(frontmatter, "todoist_synced_at")).toBe(true);
    expect(frontmatter).toEqual({ "task id": "task-1", user: true });
    expect(deleteTaskProperty(frontmatter, "todoist_synced_at")).toBe(false);
  });

  it("coalesces identical old and new values without duplicating fields", () => {
    const frontmatter = {
      todoist_task_id: "task-1",
      "task id": "task-1",
      todoist_labels: ["study", "work"],
      labels: ["study", "work"],
    };

    expect(migrateTaskProperties(frontmatter)).toBe(true);
    expect(frontmatter).toEqual({ "task id": "task-1", labels: ["study", "work"] });
  });

  it.each([
    { todoist_task_id: "task-1", todoist_status: "active", status: "my workflow" },
    { todoist_task_id: "task-1", status: "my workflow" },
    { todoist_task_id: "task-1", "task id": "task-2" },
    { "task id": "task-1", todoist_status: "active", status: "completed" },
  ])("refuses conflicting migration without changing any values: %j", (original) => {
    const frontmatter = { ...original };

    expect(() => assertTaskPropertyMigrationSafe(frontmatter)).toThrow(TaskPropertyConflictError);
    expect(() => migrateTaskProperties(frontmatter)).toThrow(TaskPropertyConflictError);
    expect(() => setTaskProperty(frontmatter, "todoist_completed", true)).toThrow(
      TaskPropertyConflictError,
    );
    expect(() => deleteTaskProperty(frontmatter, "todoist_status")).toThrow(
      TaskPropertyConflictError,
    );
    expect(frontmatter).toEqual(original);
  });

  it("does not silently choose between conflicting aliases", () => {
    expect(() =>
      readTaskProperty({ status: "active", todoist_status: "completed" }, "todoist_status"),
    ).toThrow('Cannot migrate task property "status"');
  });

  it("keeps task identity immutable and leaves the legacy document intact on mismatch", () => {
    const frontmatter = { todoist_task_id: "task-1", todoist_status: "active" };

    expect(() => setTaskProperty(frontmatter, "todoist_task_id", "task-2")).toThrow(
      TaskPropertyConflictError,
    );
    expect(frontmatter).toEqual({ todoist_task_id: "task-1", todoist_status: "active" });
  });

  it.each([
    "Status",
    "STATUS",
    "Todoist_Status",
    "Task ID",
    "Due Date",
  ])("preserves a user's %s property instead of creating a case-only collision", (spelling) => {
    const frontmatter = {
      todoist_task_id: "task-1",
      todoist_status: "active",
      [spelling]: "active",
    };
    const before = { ...frontmatter };

    expect(() => migrateTaskProperties(frontmatter)).toThrow(
      `existing property "${spelling}" differs only by letter case`,
    );
    expect(() => setTaskProperty(frontmatter, "todoist_completed", true)).toThrow(
      TaskPropertyConflictError,
    );
    expect(() => deleteTaskProperty(frontmatter, "todoist_status")).toThrow(
      TaskPropertyConflictError,
    );
    expect(frontmatter).toEqual(before);
  });

  it("declines ambiguous case variants even after the task identity was migrated", () => {
    const frontmatter = { "task id": "task-1", status: "active", Status: "active" };
    expect(() => readTaskProperty(frontmatter, "todoist_status")).toThrow(
      TaskPropertyConflictError,
    );
    expect(() => migrateTaskProperties(frontmatter)).toThrow(TaskPropertyConflictError);
  });
});
