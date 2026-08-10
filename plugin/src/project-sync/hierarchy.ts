import type { Project } from "@/api/domain/project";

const compareProjects = (left: Project, right: Project): number => {
  const byOrder = left.childOrder - right.childOrder;
  if (byOrder !== 0) {
    return byOrder;
  }

  const byName = left.name.localeCompare(right.name);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
};

export const selectProjectHierarchy = (
  projects: Project[],
  rootProjectId: string,
  includeSubprojects: boolean,
): Project[] => {
  const active = projects.filter((project) => !project.isDeleted && !project.isArchived);
  const byId = new Map<string, Project>();

  for (const project of active) {
    if (byId.has(project.id)) {
      throw new Error(`Todoist returned duplicate project ID '${project.id}'`);
    }
    byId.set(project.id, project);
  }

  const root = byId.get(rootProjectId);
  if (root === undefined) {
    throw new Error("The selected Todoist project is no longer available");
  }

  if (!includeSubprojects) {
    return [root];
  }

  const children = new Map<string, Project[]>();
  for (const project of active) {
    if (project.parentId === null) {
      continue;
    }
    const siblings = children.get(project.parentId) ?? [];
    siblings.push(project);
    children.set(project.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(compareProjects);
  }

  const selected: Project[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (project: Project): void => {
    if (visiting.has(project.id)) {
      throw new Error(`Todoist project hierarchy contains a cycle at '${project.id}'`);
    }
    if (visited.has(project.id)) {
      return;
    }

    visiting.add(project.id);
    selected.push(project);
    for (const child of children.get(project.id) ?? []) {
      visit(child);
    }
    visiting.delete(project.id);
    visited.add(project.id);
  };

  visit(root);
  return selected;
};

export type ProjectHierarchyPath = {
  ids: string[];
  names: string[];
};

export const projectHierarchyPath = (
  projectId: string,
  projects: ReadonlyMap<string, Project>,
): ProjectHierarchyPath => {
  const path: Project[] = [];
  const seen = new Set<string>();
  let current = projects.get(projectId);

  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new Error(`Todoist project hierarchy contains a cycle at '${current.id}'`);
    }
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : projects.get(current.parentId);
  }

  path.reverse();
  return {
    ids: path.map(({ id }) => id),
    names: path.map(({ name }) => name),
  };
};

export const projectNamePath = (
  projectId: string,
  projects: ReadonlyMap<string, Project>,
): string[] => projectHierarchyPath(projectId, projects).names;
