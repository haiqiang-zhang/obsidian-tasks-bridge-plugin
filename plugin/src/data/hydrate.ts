import type { Label, LabelId } from "@/api/domain/label";
import type { Project, ProjectId } from "@/api/domain/project";
import type { Section, SectionId } from "@/api/domain/section";
import type { Task as ApiTask } from "@/api/domain/task";
import type { RepositoryReader } from "@/data/repository";
import type { Task } from "@/data/task";

export type DataAccessor = {
  projects: RepositoryReader<ProjectId, Project>;
  sections: RepositoryReader<SectionId, Section>;
  labels: RepositoryReader<LabelId, Label>;
};

export function hydrate(apiTask: ApiTask, data: DataAccessor): Task {
  const project = data.projects.byId(apiTask.projectId);
  const section = apiTask.sectionId
    ? (data.sections.byId(apiTask.sectionId) ?? makeUnknownSection(apiTask.sectionId))
    : undefined;

  // Todoist task payloads carry label names, not label IDs. Preserve that source identity when
  // metadata is temporarily unavailable so a later metadata sync can resolve the real Label.
  const labels = apiTask.labels.map(
    (name) => data.labels.byName(name) ?? makeUnresolvedLabel(name),
  );

  return {
    id: apiTask.id,
    createdAt: apiTask.addedAt,
    ...(apiTask.addedAtIsAuthoritative ? { authoritativeCreatedAt: apiTask.addedAt } : {}),
    ...(apiTask.updatedAt !== undefined ? { updatedAt: apiTask.updatedAt } : {}),
    ...(apiTask.completedAt != null ? { completedAt: apiTask.completedAt } : {}),

    content: apiTask.content,
    description: apiTask.description,

    project: project ?? makeUnknownProject(apiTask.projectId),
    section,
    parentId: apiTask.parentId ?? undefined,

    labels,
    priority: apiTask.priority,

    due: apiTask.due ?? undefined,
    duration: apiTask.duration ?? undefined,
    deadline: apiTask.deadline ?? undefined,
    order: apiTask.childOrder,
  };
}

/**
 * Rebind denormalized task metadata to the latest Todoist repositories by stable ID.
 *
 * Query caches intentionally retain complete metadata objects so they can render before the
 * network is ready. Once current metadata is available, those snapshots must not keep renamed
 * projects, sections, or labels alive. Missing current metadata keeps the cached fallback so an
 * offline or partial sync never degrades a previously useful display.
 */
export function rebindTaskMetadata(task: Task, data: DataAccessor): Task {
  const project = preferCurrentMetadata(task.project, data.projects.byId(task.project.id));
  const section =
    task.section === undefined
      ? undefined
      : preferCurrentMetadata(task.section, data.sections.byId(task.section.id));
  const labels = task.labels.map((label) => {
    const current =
      data.labels.byId(label.id) ??
      (isUnresolvedLabel(label) ? data.labels.byName(label.name) : undefined);
    return preferCurrentMetadata(label, current);
  });
  const labelsChanged = labels.some((label, index) => label !== task.labels[index]);

  if (project === task.project && section === task.section && !labelsChanged) {
    return task;
  }

  return {
    ...task,
    project,
    section,
    labels: labelsChanged ? labels : task.labels,
  };
}

export function rebindTaskMetadataList(tasks: Task[], data: DataAccessor): Task[] {
  const rebound = tasks.map((task) => rebindTaskMetadata(task, data));
  return rebound.some((task, index) => task !== tasks[index]) ? rebound : tasks;
}

const preferCurrentMetadata = <T extends object>(cached: T, current: T | undefined): T => {
  if (current === undefined || shallowMetadataEquals(cached, current)) {
    return cached;
  }
  return current;
};

const shallowMetadataEquals = (left: object, right: object): boolean => {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(leftRecord[key], rightRecord[key]))
  );
};

const makeUnknownProject = (id: string): Project => {
  return {
    id,
    parentId: null,
    name: "Unknown Project",
    childOrder: Number.MAX_SAFE_INTEGER,
    inboxProject: false,
    color: "grey",
    isDeleted: false,
    isArchived: false,
  };
};

const makeUnknownSection = (id: string): Section => {
  return {
    id,
    projectId: "unknown-project",
    name: "Unknown Section",
    sectionOrder: Number.MAX_SAFE_INTEGER,
    isDeleted: false,
    isArchived: false,
  };
};

const unresolvedLabelIdPrefix = "tasks-bridge:unresolved-label:";

const makeUnresolvedLabel = (name: string): Label => {
  return {
    id: `${unresolvedLabelIdPrefix}${encodeURIComponent(name)}`,
    name,
    color: "grey",
    isDeleted: false,
  };
};

const isUnresolvedLabel = (label: Label): boolean => label.id.startsWith(unresolvedLabelIdPrefix);
