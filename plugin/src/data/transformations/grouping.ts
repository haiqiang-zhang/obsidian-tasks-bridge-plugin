import type { Project } from "@/api/domain/project";
import type { Section } from "@/api/domain/section";
import type { Priority } from "@/api/domain/task";
import { DueDate } from "@/data/dueDate";
import type { Task } from "@/data/task";
import { t } from "@/i18n";
import type { GroupingKey } from "@/query/schema/grouping";

export type GroupedTasks = {
  id: string;
  header: string;
  tasks: Task[];
};

export function groupBy(tasks: Task[], groupBy: GroupingKey): GroupedTasks[] {
  switch (groupBy) {
    case "priority":
      return groupByPriority(tasks);
    case "project":
      return groupByProject(tasks);
    case "section":
      return groupBySection(tasks);
    case "due":
      return groupByDate(tasks);
    case "label":
      return groupByLabel(tasks);
    default:
      throw new Error("Cannot group by an unsupported value");
  }
}

function groupByPriority(tasks: Task[]): GroupedTasks[] {
  const priorities = partitionBy(tasks, (task: Task) => task.priority);
  const groups = Array.from(priorities.entries());
  // We need to 'reverse' sort since priority of 4 is actually
  // priority 1 in Todoist.
  groups.sort((a, b) => b[0] - a[0]);

  return groups.map(([priority, tasks]) => {
    return {
      id: makeGroupId("priority", priority),
      header: priorityHeaderLookup[priority],
      tasks,
    };
  });
}

const priorityHeaderLookup: Record<Priority, string> = {
  1: "Priority 4",
  2: "Priority 3",
  3: "Priority 2",
  4: "Priority 1",
};

function groupByProject(tasks: Task[]): GroupedTasks[] {
  const projects = partitionBy(tasks, (task: Task) => task.project.id);
  const groups = Array.from(projects.entries());
  groups.sort((a, b) => {
    const aProject = firstTask(a[1]).project;
    const bProject = firstTask(b[1]).project;
    return aProject.childOrder - bProject.childOrder;
  });

  return groups.map(([projectId, tasks]) => {
    const project = firstTask(tasks).project;
    return {
      id: makeGroupId("project", projectId),
      header: project.name,
      tasks,
    };
  });
}

function groupBySection(tasks: Task[]): GroupedTasks[] {
  type SectionPartitionKey = {
    project: Project;
    section: Section | undefined;
  };

  const makeHeader = (key: SectionPartitionKey) => {
    const project = key.project.name;
    const section = key.section?.name;

    if (section === undefined) {
      return project;
    }

    return `${project} / ${section}`;
  };

  const sections = partitionBy<string>(tasks, (task: Task) =>
    JSON.stringify([task.project.id, task.section?.id ?? null]),
  );
  const groups = Array.from(sections.entries());
  groups.sort((a, b) => {
    const aTask = firstTask(a[1]);
    const bTask = firstTask(b[1]);
    const aKey: SectionPartitionKey = { project: aTask.project, section: aTask.section };
    const bKey: SectionPartitionKey = { project: bTask.project, section: bTask.section };

    // First compare by project
    const projectOrderDiff = aKey.project.childOrder - bKey.project.childOrder;
    if (projectOrderDiff !== 0) {
      return projectOrderDiff;
    }

    // Now lets compare by sections
    if (aKey.section === undefined && bKey.section === undefined) {
      return 0;
    }

    if (aKey.section === undefined) {
      return -1;
    }

    if (bKey.section === undefined) {
      return 1;
    }

    return aKey.section.sectionOrder - bKey.section.sectionOrder;
  });

  return groups.map(([id, tasks]) => {
    const task = firstTask(tasks);
    return {
      id: makeGroupId("section", id),
      header: makeHeader({ project: task.project, section: task.section }),
      tasks,
    };
  });
}

function groupByDate(tasks: Task[]): GroupedTasks[] {
  const i18n = t().query.groupedHeaders;
  const makeHeader = (date: string | undefined): string => {
    if (date === undefined) {
      return i18n.noDueDate;
    }

    if (date === "Overdue") {
      return i18n.overdue;
    }

    return DueDate.formatHeader(
      DueDate.parse({
        isRecurring: false,
        date,
      }),
    );
  };

  const dates = partitionBy(tasks, (task: Task) => {
    if (task.due?.date === undefined) {
      return undefined;
    }

    if (DueDate.parse(task.due).start.isOverdue) {
      return "Overdue";
    }

    // Discard any time component for grouping purposes
    return task.due.date.split("T")[0];
  });
  const groups = Array.from(dates.entries());
  groups.sort((a, b) => {
    const aDate = a[0];
    const bDate = b[0];

    if (aDate === undefined && bDate === undefined) {
      return 0;
    }

    if (aDate === undefined) {
      return 1;
    }

    if (bDate === undefined) {
      return -1;
    }

    if (aDate === "Overdue" && bDate === "Overdue") {
      return 0;
    }

    if (aDate === "Overdue") {
      return -1;
    }

    if (bDate === "Overdue") {
      return 1;
    }

    return aDate.localeCompare(bDate);
  });
  return groups.map(([date, tasks]) => {
    return {
      id: makeGroupId("due", date ?? null),
      header: makeHeader(date),
      tasks,
    };
  });
}

function groupByLabel(tasks: Task[]): GroupedTasks[] {
  const labels = partitionByMany(tasks, (task: Task) => task.labels.map((label) => label.id));
  const groups = Array.from(labels.entries());
  groups.sort((a, b) => {
    const aLabel = findLabel(a[0], a[1]);
    const bLabel = findLabel(b[0], b[1]);

    if (aLabel === undefined && bLabel === undefined) {
      return 0;
    }

    if (aLabel === undefined) {
      return 1;
    }

    if (bLabel === undefined) {
      return -1;
    }

    return aLabel.name.localeCompare(bLabel.name);
  });
  return groups.map(([labelId, tasks]) => {
    const label = findLabel(labelId, tasks);
    return {
      id: makeGroupId("label", labelId ?? null),
      header: label?.name ?? "No label",
      tasks,
    };
  });
}

function makeGroupId(kind: GroupingKey, value: unknown): string {
  return `${kind}:${JSON.stringify(value)}`;
}

function firstTask(tasks: Task[]): Task {
  const task = tasks[0];
  if (task === undefined) {
    throw new Error("Cannot create an empty task group");
  }
  return task;
}

function findLabel(labelId: string | undefined, tasks: Task[]) {
  if (labelId === undefined) {
    return undefined;
  }

  for (const task of tasks) {
    const label = task.labels.find((candidate) => candidate.id === labelId);
    if (label !== undefined) {
      return label;
    }
  }

  return undefined;
}

function partitionBy<T>(tasks: Task[], selector: (task: Task) => T): Map<T, Task[]> {
  const mapped = new Map<T, Task[]>();

  for (const task of tasks) {
    const key = selector(task);

    if (!mapped.has(key)) {
      mapped.set(key, []);
    }

    mapped.get(key)?.push(task);
  }

  return mapped;
}

function partitionByMany<T>(
  tasks: Task[],
  selector: (task: Task) => T[],
): Map<T | undefined, Task[]> {
  const mapped = new Map<T | undefined, Task[]>();

  const insertTask = (key: T | undefined, task: Task) => {
    if (!mapped.has(key)) {
      mapped.set(key, []);
    }

    mapped.get(key)?.push(task);
  };

  for (const task of tasks) {
    const keys = selector(task);

    if (keys.length === 0) {
      insertTask(undefined, task);
    }

    for (const key of keys) {
      insertTask(key, task);
    }
  }

  return mapped;
}
