import {
  CalendarDate,
  fromDate,
  parseDate,
  parseDateTime,
  Time,
  toCalendarDateTime,
  toZoned,
} from "@internationalized/date";

import type { Label } from "@/api/domain/label";
import type { Priority, Task, UpdateTaskParams } from "@/api/domain/task";
import { timezone } from "@/infra/time";
import type { Deadline } from "@/ui/createTaskModal/DeadlineSelector";
import type { DueDate } from "@/ui/createTaskModal/DueDateSelector";

export type EditTaskState = {
  content: string;
  description: string;
  priority: Priority;
  labels: Label[];
  preservedLabelNames: string[];
  dueDate: DueDate | undefined;
  dueDateChanged: boolean;
  deadline: Deadline | undefined;
  deadlineChanged: boolean;
};

export const taskDueDateSelection = (task: Task): DueDate | undefined => {
  if (task.due === null) {
    return undefined;
  }

  const rawDateTime = task.due.datetime ?? (task.due.date.includes("T") ? task.due.date : null);
  if (rawDateTime === null) {
    return {
      date: parseDate(task.due.date.slice(0, 10)),
      timeInfo: undefined,
    };
  }

  const absolute = hasExplicitOffset(rawDateTime)
    ? new Date(rawDateTime)
    : parseDateTime(rawDateTime).toDate(timezone());
  if (Number.isNaN(absolute.getTime())) {
    throw new Error("Todoist returned an invalid due datetime");
  }
  const local = fromDate(absolute, timezone());
  return {
    date: new CalendarDate(local.year, local.month, local.day),
    timeInfo: {
      time: new Time(local.hour, local.minute, local.second, local.millisecond),
      duration: task.duration ?? undefined,
    },
  };
};

export const taskDeadlineSelection = (task: Task): Deadline | undefined =>
  task.deadline === null ? undefined : { date: parseDate(task.deadline.date) };

export const buildUpdateTaskParams = (task: Task, state: EditTaskState): UpdateTaskParams => {
  const params: UpdateTaskParams = {};

  if (state.content !== task.content) {
    params.content = state.content;
  }
  if (state.description !== task.description) {
    params.description = state.description;
  }
  if (state.priority !== task.priority) {
    params.priority = state.priority;
  }

  const labelNames = unique([
    ...state.labels.map((label) => label.name),
    ...state.preservedLabelNames,
  ]);
  if (!sameStringSet(labelNames, task.labels)) {
    params.labels = labelNames;
  }

  if (state.dueDateChanged) {
    if (state.dueDate === undefined) {
      params.dueString = "no date";
      params.duration = null;
    } else if (state.dueDate.timeInfo === undefined) {
      params.dueDate = state.dueDate.date.toString();
      params.duration = null;
    } else {
      params.dueDatetime = toZoned(
        toCalendarDateTime(state.dueDate.date, state.dueDate.timeInfo.time),
        timezone(),
      ).toAbsoluteString();
      params.duration = state.dueDate.timeInfo.duration ?? null;
    }
  }

  if (state.deadlineChanged) {
    params.deadlineDate = state.deadline?.date.toString() ?? null;
  }

  return params;
};

export const hasTaskUpdate = (params: UpdateTaskParams): boolean => Object.keys(params).length > 0;

const hasExplicitOffset = (value: string): boolean => /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(value);

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
};
