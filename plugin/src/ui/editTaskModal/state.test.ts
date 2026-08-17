import { CalendarDate } from "@internationalized/date";
import { describe, expect, it } from "vitest";

import type { Label } from "@/api/domain/label";
import { Priorities, type Task } from "@/api/domain/task";

import {
  buildUpdateTaskParams,
  type EditTaskState,
  hasTaskUpdate,
  taskDeadlineSelection,
  taskDueDateSelection,
} from "./state";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  addedAt: "2026-08-01T00:00:00.000Z",
  addedAtIsAuthoritative: true,
  content: "Write the report",
  description: "Draft the first section",
  projectId: "project-1",
  sectionId: null,
  parentId: null,
  labels: ["work"],
  priority: Priorities.P3,
  due: null,
  duration: null,
  deadline: null,
  childOrder: 1,
  ...overrides,
});

const workLabel: Label = {
  id: "label-work",
  name: "work",
  color: "blue",
  isDeleted: false,
};

const makeState = (task: Task, overrides: Partial<EditTaskState> = {}): EditTaskState => ({
  content: task.content,
  description: task.description,
  priority: task.priority,
  labels: [workLabel],
  preservedLabelNames: [],
  dueDate: taskDueDateSelection(task),
  dueDateChanged: false,
  deadline: taskDeadlineSelection(task),
  deadlineChanged: false,
  ...overrides,
});

describe("taskDueDateSelection", () => {
  it("preserves a date-only Todoist due value", () => {
    const task = makeTask({
      due: { date: "2026-02-14", isRecurring: false },
    });

    expect(taskDueDateSelection(task)).toEqual({
      date: new CalendarDate(2026, 2, 14),
      timeInfo: undefined,
    });
  });

  it("uses the canonical datetime and duration when a task has a time", () => {
    const task = makeTask({
      due: {
        date: "2026-08-12",
        datetime: "2026-08-12T09:30:00",
        isRecurring: false,
      },
      duration: { amount: 45, unit: "minute" },
    });

    const selection = taskDueDateSelection(task);
    expect(selection?.date.toString()).toBe("2026-08-12");
    expect(selection?.timeInfo?.time.hour).toBe(9);
    expect(selection?.timeInfo?.time.minute).toBe(30);
    expect(selection?.timeInfo?.duration).toEqual({ amount: 45, unit: "minute" });
  });
});

describe("buildUpdateTaskParams", () => {
  it("does not replace an untouched recurring schedule", () => {
    const task = makeTask({
      due: {
        date: "2026-08-12",
        datetime: "2026-08-12T09:30:00",
        isRecurring: true,
      },
    });

    const params = buildUpdateTaskParams(task, makeState(task));

    expect(params).toEqual({});
    expect(hasTaskUpdate(params)).toBe(false);
  });

  it("builds only changed scalar fields and preserves unresolved labels", () => {
    const task = makeTask({ labels: ["work", "server-only"] });
    const params = buildUpdateTaskParams(
      task,
      makeState(task, {
        content: "Write the final report",
        description: "",
        priority: Priorities.P1,
        preservedLabelNames: ["server-only"],
      }),
    );

    expect(params).toEqual({
      content: "Write the final report",
      description: "",
      priority: Priorities.P1,
    });
  });

  it("clears due date, duration, and deadline explicitly", () => {
    const task = makeTask({
      due: { date: "2026-08-12", isRecurring: false },
      duration: { amount: 1, unit: "day" },
      deadline: { date: "2026-08-20" },
    });

    const params = buildUpdateTaskParams(
      task,
      makeState(task, {
        dueDate: undefined,
        dueDateChanged: true,
        deadline: undefined,
        deadlineChanged: true,
      }),
    );

    expect(params).toEqual({
      dueString: "no date",
      duration: null,
      deadlineDate: null,
    });
  });

  it("replaces a recurring schedule only after the user changes the due date", () => {
    const task = makeTask({
      due: { date: "2026-08-12", isRecurring: true },
    });

    const params = buildUpdateTaskParams(
      task,
      makeState(task, {
        dueDate: {
          date: new CalendarDate(2026, 8, 19),
          timeInfo: undefined,
        },
        dueDateChanged: true,
      }),
    );

    expect(params).toEqual({
      dueDate: "2026-08-19",
      duration: null,
    });
  });
});
