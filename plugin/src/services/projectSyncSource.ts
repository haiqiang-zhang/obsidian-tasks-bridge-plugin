import type { TodoistAdapter } from "@/data";
import type { ProjectSyncSource, ProjectTaskPage } from "@/project-sync";

export class TodoistProjectSyncSource implements ProjectSyncSource {
  private readonly todoist: TodoistAdapter;

  constructor(todoist: TodoistAdapter) {
    this.todoist = todoist;
  }

  public listProjects() {
    return this.todoist.listActiveProjects();
  }

  public async fetchProjectTasks(projectId: string): Promise<ProjectTaskPage> {
    return await this.todoist.getProjectTasks(projectId);
  }
}
