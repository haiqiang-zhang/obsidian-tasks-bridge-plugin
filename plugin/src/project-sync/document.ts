import { dump as dumpYaml } from "js-yaml";

import type { Task } from "@/data/task";
import { todoistTaskWebUrl } from "@/todoist/taskLinks";

import type { ProjectHierarchyPath } from "./hierarchy";
import type { SnapshotTask } from "./types";

export const MANAGED_BODY_START = "<!-- todoist-sync-plus:managed:start -->";
export const MANAGED_BODY_END = "<!-- todoist-sync-plus:managed:end -->";

export const MANAGED_FRONTMATTER_KEYS = [
  "todoist_sync_managed",
  "todoist_sync_mapping_id",
  "todoist_sync_root_id",
  "todoist_sync_missing_count",
  "todoist_task_id",
  "todoist_content",
  "todoist_description",
  "todoist_status",
  "todoist_completed",
  "todoist_project_id",
  "todoist_project",
  "todoist_project_path",
  "todoist_project_id_path",
  "todoist_parent_task_id",
  "todoist_section_id",
  "todoist_section",
  "todoist_labels",
  "todoist_priority",
  "todoist_created_at",
  "todoist_updated_at",
  "todoist_completed_at",
  "todoist_due_date",
  "todoist_due_datetime",
  "todoist_due_timezone",
  "todoist_due_is_recurring",
  "todoist_deadline",
  "todoist_duration",
  "todoist_duration_unit",
  "todoist_order",
  "todoist_url",
  "todoist_synced_at",
  "todoist_stale_since",
] as const;

export type ManagedFrontmatter = Record<string, unknown>;

export type ManagedNoteIdentity = {
  taskId: string;
  mappingId?: string;
  rootProjectId: string;
  projectId: string;
  missingCount: number;
};

export class ManagedBodyConflictError extends Error {}

const PRIORITY_INVERSION_BASE = 5;
const priorityName = (priority: Task["priority"]): string =>
  `P${PRIORITY_INVERSION_BASE - priority}`;

export const makeTaskFrontmatter = (
  snapshotTask: SnapshotTask,
  rootProjectId: string,
  projectPath: ProjectHierarchyPath,
  syncedAt: string,
  mappingId?: string,
): ManagedFrontmatter => {
  const { task, completed } = snapshotTask;
  const frontmatter: ManagedFrontmatter = {
    todoist_sync_managed: true,
    todoist_sync_root_id: rootProjectId,
    todoist_sync_missing_count: 0,
    todoist_task_id: task.id,
    todoist_content: task.content,
    todoist_description: task.description,
    todoist_status: completed ? "completed" : "active",
    todoist_completed: completed,
    todoist_project_id: task.project.id,
    todoist_project: task.project.name,
    todoist_project_path: projectPath.names,
    todoist_project_id_path: projectPath.ids,
    todoist_labels: task.labels.map((label) => label.name),
    todoist_priority: priorityName(task.priority),
    todoist_created_at: task.createdAt,
    todoist_order: task.order,
    todoist_url: todoistTaskWebUrl(task.project.id, task.id),
    todoist_synced_at: syncedAt,
  };

  if (mappingId !== undefined) {
    frontmatter.todoist_sync_mapping_id = mappingId;
  }

  if (task.updatedAt !== undefined) {
    frontmatter.todoist_updated_at = task.updatedAt;
  }

  if (task.parentId !== undefined) {
    frontmatter.todoist_parent_task_id = task.parentId;
  }
  if (task.section !== undefined) {
    frontmatter.todoist_section_id = task.section.id;
    frontmatter.todoist_section = task.section.name;
  }
  if (completed && task.completedAt != null) {
    frontmatter.todoist_completed_at = task.completedAt;
  }
  if (task.due !== undefined) {
    frontmatter.todoist_due_date = task.due.date.slice(0, 10);
    const dueDatetime =
      task.due.datetime ?? (task.due.date.includes("T") ? task.due.date : undefined);
    if (dueDatetime !== undefined) {
      frontmatter.todoist_due_datetime = dueDatetime;
    }
    if (task.due.timezone != null) {
      frontmatter.todoist_due_timezone = task.due.timezone;
    }
    frontmatter.todoist_due_is_recurring = task.due.isRecurring;
  }
  if (task.deadline !== undefined) {
    frontmatter.todoist_deadline = task.deadline.date;
  }
  if (task.duration !== undefined) {
    frontmatter.todoist_duration = task.duration.amount;
    frontmatter.todoist_duration_unit = task.duration.unit;
  }

  return frontmatter;
};

export const applyManagedFrontmatter = (
  target: ManagedFrontmatter,
  desired: ManagedFrontmatter,
): boolean => {
  let changed = false;

  for (const key of MANAGED_FRONTMATTER_KEYS) {
    if (!(key in desired)) {
      if (key in target) {
        delete target[key];
        changed = true;
      }
      continue;
    }

    if (!isSameValue(target[key], desired[key])) {
      target[key] = desired[key];
      changed = true;
    }
  }

  return changed;
};

const isSameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const escapeManagedMarkers = (value: string): string =>
  value.split("todoist-sync-plus:managed:").join("todoist-sync-plus:managed&#58;");

export const makeManagedBody = (task: Task): string => {
  const normalizedTitle = task.content.replace(/\s*\n\s*/g, " ").trim();
  const title = escapeManagedMarkers(normalizedTitle === "" ? "Untitled task" : normalizedTitle);
  const description = escapeManagedMarkers(task.description.trim());
  const descriptionSection = description === "" ? "" : `\n\n${description}`;

  return `${MANAGED_BODY_START}\n# ${title}\n\n[Open in Todoist](${todoistTaskWebUrl(task.project.id, task.id)})${descriptionSection}\n${MANAGED_BODY_END}`;
};

export const replaceManagedBody = (
  content: string,
  managedBody: string,
  insertionOffset = 0,
): { content: string; changed: boolean } => {
  const starts = findAll(content, MANAGED_BODY_START);
  const ends = findAll(content, MANAGED_BODY_END);

  if (starts.length === 0 && ends.length === 0) {
    const offset = Math.max(0, Math.min(insertionOffset, content.length));
    const before = content.slice(0, offset);
    const after = content.slice(offset);
    const beforeSeparator = before === "" || before.endsWith("\n") ? "" : "\n";
    let afterSeparator = "\n\n";
    if (after === "" || after.startsWith("\n")) {
      afterSeparator = "\n";
    }
    return {
      content: `${before}${beforeSeparator}${managedBody}${afterSeparator}${after}`,
      changed: true,
    };
  }

  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new ManagedBodyConflictError("The managed Todoist body markers are malformed");
  }

  const end = ends[0] + MANAGED_BODY_END.length;
  const next = `${content.slice(0, starts[0])}${managedBody}${content.slice(end)}`;
  return { content: next, changed: next !== content };
};

const findAll = (value: string, needle: string): number[] => {
  const offsets: number[] = [];
  let offset = value.indexOf(needle);
  while (offset >= 0) {
    offsets.push(offset);
    offset = value.indexOf(needle, offset + needle.length);
  }
  return offsets;
};

export const renderNewTaskDocument = (
  frontmatter: ManagedFrontmatter,
  managedBody: string,
): string => {
  const yaml = dumpYaml(frontmatter, { lineWidth: -1, noRefs: true });
  return `---\n${yaml}---\n${managedBody}\n`;
};

/**
 * Rebuild the managed portions of an existing task note as one document value.
 *
 * Callers are responsible for parsing and validating the live frontmatter immediately before
 * invoking this helper. Keeping the frontmatter and managed body in one returned value lets the
 * Vault adapter persist both changes with a single atomic `Vault.process()` operation while the
 * user-owned portion of the note remains untouched.
 */
export const replaceManagedTaskDocument = (
  content: string,
  currentFrontmatter: ManagedFrontmatter,
  desiredFrontmatter: ManagedFrontmatter,
  managedBody: string,
  contentStart: number,
): { content: string; changed: boolean } => {
  const bodyUpdate = replaceManagedBody(content, managedBody, contentStart);
  const nextFrontmatter = { ...currentFrontmatter };
  const frontmatterChanged = applyManagedFrontmatter(nextFrontmatter, desiredFrontmatter);
  if (!frontmatterChanged && !bodyUpdate.changed) {
    return { content, changed: false };
  }

  const yaml = dumpYaml(nextFrontmatter, { lineWidth: -1, noRefs: true });
  return {
    content: `---\n${yaml}---${bodyUpdate.content.slice(contentStart)}`,
    changed: true,
  };
};

export const readManagedNoteIdentity = (
  frontmatter: ManagedFrontmatter,
): ManagedNoteIdentity | null => {
  if (frontmatter.todoist_sync_managed !== true) {
    return null;
  }

  const taskId = frontmatter.todoist_task_id;
  const rawMappingId = frontmatter.todoist_sync_mapping_id;
  const rootProjectId = frontmatter.todoist_sync_root_id;
  const projectId = frontmatter.todoist_project_id;
  if (
    typeof taskId !== "string" ||
    taskId === "" ||
    typeof rootProjectId !== "string" ||
    rootProjectId === "" ||
    typeof projectId !== "string" ||
    projectId === ""
  ) {
    return null;
  }

  const rawMissingCount = frontmatter.todoist_sync_missing_count;
  const missingCount =
    typeof rawMissingCount === "number" && Number.isFinite(rawMissingCount)
      ? Math.max(0, Math.floor(rawMissingCount))
      : 0;

  const mappingId =
    typeof rawMappingId === "string" && rawMappingId !== "" ? rawMappingId : undefined;
  return { taskId, mappingId, rootProjectId, projectId, missingCount };
};
