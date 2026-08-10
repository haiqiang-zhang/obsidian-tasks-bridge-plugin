import type { ProjectId } from "@/api/domain/project";
import type { TaskId } from "@/api/domain/task";

export const todoistTaskAppUrl = (taskId: TaskId): string => {
  return `todoist://task?id=${taskId}`;
};

export const todoistTaskWebUrl = (projectId: ProjectId, taskId: TaskId): string => {
  return `https://todoist.com/app/project/${projectId}/task/${taskId}`;
};
