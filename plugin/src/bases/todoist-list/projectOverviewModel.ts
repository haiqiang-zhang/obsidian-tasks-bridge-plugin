import type { ProjectSyncStatisticsSnapshot } from "@/project-sync";

import type { TodoistListProjectOption } from "./types";

export type ProjectOverviewCounts = {
  active: number;
  completed: number;
};

export type ProjectOverviewNode = {
  id: string;
  name: string;
  pathIds: string[];
  pathNames: string[];
  directCounts: ProjectOverviewCounts;
  counts: ProjectOverviewCounts;
  children: ProjectOverviewNode[];
  taskCount: number;
  projectCount: number;
  completionRate: number | null;
};

export type ProjectOverviewModel = {
  syncedAt: string;
  rootProjectId: string | null;
  rootAvailable: boolean;
  projectOptions: TodoistListProjectOption[];
  roots: ProjectOverviewNode[];
  counts: ProjectOverviewCounts;
  taskCount: number;
  projectCount: number;
  completionRate: number | null;
};

type StatisticsScope = ProjectSyncStatisticsSnapshot["scopes"][number];
type StatisticsProject = StatisticsScope["projects"][number];

type ScopeOverview = {
  root: ProjectOverviewNode;
  rootProject: StatisticsProject;
  nodesById: ReadonlyMap<string, ProjectOverviewNode>;
  projectOptions: TodoistListProjectOption[];
};

const emptyCounts = (): ProjectOverviewCounts => ({ active: 0, completed: 0 });

const addCounts = (
  target: ProjectOverviewCounts,
  source: ProjectOverviewCounts,
): ProjectOverviewCounts => {
  target.active += source.active;
  target.completed += source.completed;
  return target;
};

const taskCount = (counts: ProjectOverviewCounts): number => counts.active + counts.completed;

const completionRate = (counts: ProjectOverviewCounts): number | null => {
  const total = taskCount(counts);
  return total === 0 ? null : counts.completed / total;
};

const compareProjects = (left: StatisticsProject, right: StatisticsProject): number => {
  const byOrder = left.childOrder - right.childOrder;
  if (byOrder !== 0) {
    return byOrder;
  }
  const byName = left.name.localeCompare(right.name);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
};

/**
 * Builds a presentation-only statistics tree from the last complete Project Sync snapshot.
 * The input remains untouched, and every returned count is cloned before aggregation.
 */
export const buildProjectOverviewModel = (
  snapshot: ProjectSyncStatisticsSnapshot | null,
  rootProjectId: string | null,
): ProjectOverviewModel | null => {
  if (snapshot === null) {
    return null;
  }

  const scopes = snapshot.scopes
    .map(buildScopeOverview)
    .filter((scope): scope is ScopeOverview => scope !== null)
    .sort((left, right) => compareProjects(left.rootProject, right.rootProject));
  const projectOptions = collectProjectOptions(scopes);

  let roots: ProjectOverviewNode[];
  let rootAvailable = true;
  if (rootProjectId === null) {
    roots = deduplicateForest(scopes.map(({ root }) => root));
  } else {
    const selected = selectProjectOccurrence(scopes, rootProjectId);
    rootAvailable = selected !== undefined;
    roots = selected === undefined ? [] : [cloneNode(selected)];
  }

  const counts = roots.reduce(
    (result, project) => addCounts(result, project.counts),
    emptyCounts(),
  );
  const totalTasks = taskCount(counts);

  return {
    syncedAt: snapshot.syncedAt,
    rootProjectId,
    rootAvailable,
    projectOptions,
    roots,
    counts,
    taskCount: totalTasks,
    projectCount: roots.reduce((total, project) => total + project.projectCount, 0),
    completionRate: completionRate(counts),
  };
};

const buildScopeOverview = (scope: StatisticsScope): ScopeOverview | null => {
  const projectsById = new Map<string, StatisticsProject>();
  for (const project of scope.projects) {
    if (!projectsById.has(project.id)) {
      projectsById.set(project.id, project);
    }
  }

  const rootProject = projectsById.get(scope.rootProjectId);
  if (rootProject === undefined) {
    return null;
  }

  const pathCache = new Map<string, StatisticsProject[] | null>();
  const resolvePath = (
    projectId: string,
    visiting: ReadonlySet<string> = new Set(),
  ): StatisticsProject[] | null => {
    const cached = pathCache.get(projectId);
    if (cached !== undefined) {
      return cached;
    }

    const project = projectsById.get(projectId);
    if (project === undefined || visiting.has(projectId)) {
      pathCache.set(projectId, null);
      return null;
    }
    if (projectId === scope.rootProjectId) {
      const path = [project];
      pathCache.set(projectId, path);
      return path;
    }
    if (project.parentId === null || !projectsById.has(project.parentId)) {
      pathCache.set(projectId, null);
      return null;
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(projectId);
    const parentPath = resolvePath(project.parentId, nextVisiting);
    const path = parentPath === null ? null : [...parentPath, project];
    pathCache.set(projectId, path);
    return path;
  };

  const validProjects = [...projectsById.values()].filter(
    (project) => resolvePath(project.id) !== null,
  );
  const childrenByParentId = new Map<string, StatisticsProject[]>();
  for (const project of validProjects) {
    if (project.id === scope.rootProjectId || project.parentId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(project.parentId) ?? [];
    siblings.push(project);
    childrenByParentId.set(project.parentId, siblings);
  }
  for (const children of childrenByParentId.values()) {
    children.sort(compareProjects);
  }

  const nodesById = new Map<string, ProjectOverviewNode>();
  const buildNode = (project: StatisticsProject): ProjectOverviewNode => {
    const path = resolvePath(project.id) ?? [project];
    const directCounts = { ...project.directCounts };
    const children = (childrenByParentId.get(project.id) ?? []).map(buildNode);
    const counts = children.reduce((result, child) => addCounts(result, child.counts), {
      ...directCounts,
    });
    const node: ProjectOverviewNode = {
      id: project.id,
      name: project.name,
      pathIds: path.map(({ id }) => id),
      pathNames: path.map(({ name }) => name),
      directCounts,
      counts,
      children,
      taskCount: taskCount(counts),
      projectCount: 1 + children.reduce((total, child) => total + child.projectCount, 0),
      completionRate: completionRate(counts),
    };
    nodesById.set(node.id, node);
    return node;
  };

  const root = buildNode(rootProject);
  const projectOptions: TodoistListProjectOption[] = [];
  const collectOptions = (node: ProjectOverviewNode): void => {
    projectOptions.push({
      id: node.id,
      name: node.name,
      pathIds: [...node.pathIds],
      pathNames: [...node.pathNames],
    });
    for (const child of node.children) {
      collectOptions(child);
    }
  };
  collectOptions(root);

  return { root, rootProject, nodesById, projectOptions };
};

const collectProjectOptions = (scopes: readonly ScopeOverview[]): TodoistListProjectOption[] => {
  const options: TodoistListProjectOption[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const project of scope.projectOptions) {
      if (seen.has(project.id)) {
        continue;
      }
      seen.add(project.id);
      options.push({
        ...project,
        pathIds: [...project.pathIds],
        pathNames: [...project.pathNames],
      });
    }
  }
  return options;
};

const selectProjectOccurrence = (
  scopes: readonly ScopeOverview[],
  projectId: string,
): ProjectOverviewNode | undefined => {
  const occurrences = scopes
    .map(({ nodesById }) => nodesById.get(projectId))
    .filter((node): node is ProjectOverviewNode => node !== undefined);

  return occurrences.sort((left, right) => {
    const byPathCompleteness = right.pathIds.length - left.pathIds.length;
    if (byPathCompleteness !== 0) {
      return byPathCompleteness;
    }
    const bySubtreeSize = right.projectCount - left.projectCount;
    if (bySubtreeSize !== 0) {
      return bySubtreeSize;
    }
    return left.pathIds.join("\u0000").localeCompare(right.pathIds.join("\u0000"));
  })[0];
};

const deduplicateForest = (roots: readonly ProjectOverviewNode[]): ProjectOverviewNode[] => {
  const seen = new Set<string>();
  const claim = (node: ProjectOverviewNode): ProjectOverviewNode | null => {
    if (seen.has(node.id)) {
      return null;
    }
    seen.add(node.id);
    const children = node.children
      .map(claim)
      .filter((child): child is ProjectOverviewNode => child !== null);
    return aggregateNode(node, children);
  };

  return roots.map(claim).filter((root): root is ProjectOverviewNode => root !== null);
};

const cloneNode = (node: ProjectOverviewNode): ProjectOverviewNode =>
  aggregateNode(
    node,
    node.children.map((child) => cloneNode(child)),
  );

const aggregateNode = (
  source: ProjectOverviewNode,
  children: ProjectOverviewNode[],
): ProjectOverviewNode => {
  const directCounts = { ...source.directCounts };
  const counts = children.reduce((result, child) => addCounts(result, child.counts), {
    ...directCounts,
  });
  return {
    id: source.id,
    name: source.name,
    pathIds: [...source.pathIds],
    pathNames: [...source.pathNames],
    directCounts,
    counts,
    children,
    taskCount: taskCount(counts),
    projectCount: 1 + children.reduce((total, child) => total + child.projectCount, 0),
    completionRate: completionRate(counts),
  };
};
