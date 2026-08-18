import type { CompletionHeatmapEvent } from "./completionHeatmapModel";
import type { TodoistListGroup, TodoistListProject, TodoistListTaskNode } from "./types";

export type ProjectOverviewCounts = {
  active: number;
  completed: number;
  unavailable: number;
};

export type ProjectOverviewModel = {
  counts: ProjectOverviewCounts;
  completionEvents: CompletionHeatmapEvent[];
  taskCount: number;
  projectCount: number;
  completionRate: number | null;
};

const emptyCounts = (): ProjectOverviewCounts => ({ active: 0, completed: 0, unavailable: 0 });

const addCounts = (
  target: ProjectOverviewCounts,
  source: ProjectOverviewCounts,
): ProjectOverviewCounts => {
  target.active += source.active;
  target.completed += source.completed;
  target.unavailable += source.unavailable;
  return target;
};

const availableTaskCount = (counts: ProjectOverviewCounts): number =>
  counts.active + counts.completed;

const taskCount = (counts: ProjectOverviewCounts): number =>
  availableTaskCount(counts) + counts.unavailable;

const completionRate = (counts: ProjectOverviewCounts): number | null => {
  const total = availableTaskCount(counts);
  return total === 0 ? null : counts.completed / total;
};

/** Summarizes exactly the task entries supplied by the root-scoped Base result. */
export const buildProjectOverviewModel = (
  groups: readonly TodoistListGroup[],
): ProjectOverviewModel => {
  const counts = groups.reduce((result, group) => addCounts(result, group.counts), emptyCounts());
  const projectScopeKeys = new Set<string>();
  const taskScopeKeys = new Set<string>();
  const completionEvents: CompletionHeatmapEvent[] = [];

  const collectTask = (task: TodoistListTaskNode): void => {
    if (taskScopeKeys.has(task.scopeKey)) {
      return;
    }
    taskScopeKeys.add(task.scopeKey);
    if (task.completedAt !== undefined) {
      completionEvents.push({
        id: `base:${task.scopeKey}`,
        completedAt: task.completedAt,
      });
    }
    for (const child of task.children) {
      collectTask(child);
    }
  };

  const collectProject = (project: TodoistListProject): void => {
    projectScopeKeys.add(project.scopeKey);
    for (const task of project.tasks) {
      collectTask(task);
    }
    for (const section of project.sections) {
      for (const task of section.tasks) {
        collectTask(task);
      }
    }
    for (const child of project.projects) {
      collectProject(child);
    }
  };

  for (const group of groups) {
    for (const project of group.projects) {
      collectProject(project);
    }
  }

  const totalTasks = taskCount(counts);
  return {
    counts,
    completionEvents,
    taskCount: totalTasks,
    projectCount: projectScopeKeys.size,
    completionRate: completionRate(counts),
  };
};
