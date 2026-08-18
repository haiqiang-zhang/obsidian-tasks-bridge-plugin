import { dump as dumpYaml, load as loadYaml } from "js-yaml";

import type { ProjectCompletionEvent } from "@/api/domain/task";
import type { Task } from "@/data/task";
import { todoistTaskWebUrl } from "@/todoist/taskLinks";

import type { ProjectHierarchyPath } from "./hierarchy";
import type { SnapshotTask } from "./types";

export const MANAGED_BODY_START = "<!-- todoist-sync-plus:managed:start -->";
export const MANAGED_BODY_END = "<!-- todoist-sync-plus:managed:end -->";
export const PROJECT_TASK_CODE_BLOCK = "tasks-bridge-project-task";
export const LEGACY_PROJECT_TASK_CODE_BLOCK = "tasks-bridge-task";

export const LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS = [
  "todoist_sync_managed",
  "todoist_sync_mapping_id",
  "todoist_sync_root_id",
  "todoist_sync_missing_count",
  "todoist_project_id",
  "todoist_project_id_path",
  "todoist_parent_task_id",
  "todoist_section_id",
  "todoist_completion_events",
  "todoist_order",
  "todoist_stale_since",
] as const;

export const MANAGED_FRONTMATTER_KEYS = [
  // Legacy implementation metadata remains in the allowlist so the next Project sync removes it
  // from existing notes instead of reclassifying it as user-authored frontmatter.
  ...LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS,
  "todoist_task_id",
  "todoist_content",
  "todoist_description",
  "todoist_status",
  "todoist_completed",
  "todoist_project",
  "todoist_project_path",
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
  "todoist_url",
  "todoist_synced_at",
] as const;

export const MANAGED_TASK_RELATIONSHIP_FRONTMATTER_KEYS = [
  "todoist_parent_task",
  "todoist_subtasks",
] as const;

export type ManagedFrontmatter = Record<string, unknown>;

/** The parts of a projected task note that belong to the user, not Tasks Bridge. */
export type UserOwnedTaskDocument = {
  frontmatter: ManagedFrontmatter;
  body: string;
};

export type ManagedNoteIdentity = {
  taskId: string;
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
  completionEvents: readonly ProjectCompletionEvent[] = [],
): ManagedFrontmatter => {
  const { task, completed } = snapshotTask;
  const frontmatter: ManagedFrontmatter = {
    todoist_task_id: task.id,
    todoist_content: task.content,
    todoist_description: task.description,
    todoist_status: completed ? "completed" : "active",
    todoist_completed: completed,
    todoist_project: task.project.name,
    todoist_project_path: projectPath.names,
    todoist_labels: task.labels.map((label) => label.name),
    todoist_priority: priorityName(task.priority),
    todoist_url: todoistTaskWebUrl(task.project.id, task.id),
  };

  if (task.authoritativeCreatedAt !== undefined) {
    frontmatter.todoist_created_at = task.authoritativeCreatedAt;
  }

  // Project IDs, mapping IDs, parent IDs, section IDs, Todoist order, missing counters, and raw
  // completion history belong to the plugin's local catalog. The Markdown task binds to Todoist
  // through one immutable key only: todoist_task_id.
  void rootProjectId;
  void projectPath.ids;
  void mappingId;
  void completionEvents;
  // The local projection time is intentionally not serialized into task Markdown. Two devices
  // projecting the same Todoist snapshot must produce byte-identical managed content so Obsidian
  // Sync never manufactures a conflict copy solely because their clocks differ.
  void syncedAt;

  if (task.updatedAt !== undefined) {
    frontmatter.todoist_updated_at = task.updatedAt;
  }

  if (task.section !== undefined) {
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

export type ManagedTaskRelationships = {
  parentTask?: string;
  subtasks: readonly string[];
};

/** Project the user-facing Obsidian links that describe one task's direct hierarchy. */
export const applyManagedTaskRelationships = (
  target: ManagedFrontmatter,
  relationships: ManagedTaskRelationships,
): boolean => {
  const desired: ManagedFrontmatter = {
    ...(relationships.parentTask === undefined
      ? {}
      : { todoist_parent_task: relationships.parentTask }),
    ...(relationships.subtasks.length === 0
      ? {}
      : { todoist_subtasks: [...relationships.subtasks] }),
  };
  let changed = false;

  for (const key of MANAGED_TASK_RELATIONSHIP_FRONTMATTER_KEYS) {
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

export const removeLegacyImplementationFrontmatter = (frontmatter: ManagedFrontmatter): boolean => {
  let changed = false;
  for (const key of LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS) {
    if (key in frontmatter) {
      delete frontmatter[key];
      changed = true;
    }
  }
  return changed;
};

const isSameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const makeProjectTaskBlock = (taskId: string): string =>
  `\`\`\`${PROJECT_TASK_CODE_BLOCK}\ntask_id: ${JSON.stringify(taskId)}\n\`\`\``;

export const makeManagedBody = (task: Task): string => {
  // The immutable ID belongs in the block because it identifies the card independently from the
  // note's Bases-facing properties. JSON string syntax is valid YAML and keeps numeric-looking
  // Todoist IDs quoted so JavaScript never rounds them while parsing.
  return `${MANAGED_BODY_START}\n${makeProjectTaskBlock(task.id)}\n${MANAGED_BODY_END}`;
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

const managedFrontmatterKeys = new Set<string>([
  ...MANAGED_FRONTMATTER_KEYS,
  ...MANAGED_TASK_RELATIONSHIP_FRONTMATTER_KEYS,
]);

const normalizeUserBody = (value: string): string =>
  value
    .replace(/\r\n?/gu, "\n")
    .replace(/^(?:[\t ]*\n)+/gu, "")
    .replace(/(?:\n[\t ]*)+$/gu, "");

export const isRecoverableManagedFrontmatterResidue = (value: string): boolean => {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const match = normalized.match(/^'?([a-z0-9_]+):[^\n]*\n---$/u);
  return match !== null && managedFrontmatterKeys.has(match[1]);
};

/**
 * Read the user-owned frontmatter and body around a valid managed task region.
 *
 * Older concurrent Obsidian Sync writes could leave one duplicated managed YAML scalar and a
 * second YAML boundary immediately before the managed marker. That exact, generated-only residue
 * is ignored so a clean same-ID projection can safely repair it; arbitrary surrounding text is
 * always treated as user content.
 */
export const readUserOwnedTaskDocument = (
  content: string,
  frontmatter: ManagedFrontmatter,
  contentStart: number,
): UserOwnedTaskDocument => {
  const starts = findAll(content, MANAGED_BODY_START);
  const ends = findAll(content, MANAGED_BODY_END);
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0] < contentStart ||
    starts[0] >= ends[0]
  ) {
    throw new ManagedBodyConflictError("The managed Todoist body markers are malformed");
  }

  const managedEnd = ends[0] + MANAGED_BODY_END.length;
  const rawPrefix = content.slice(contentStart, starts[0]);
  const prefix = isRecoverableManagedFrontmatterResidue(rawPrefix) ? "" : rawPrefix;
  const suffix = content.slice(managedEnd);
  const userSegments = [normalizeUserBody(prefix), normalizeUserBody(suffix)].filter(
    (segment) => segment !== "",
  );
  const userFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => !managedFrontmatterKeys.has(key)),
  );

  return {
    frontmatter: userFrontmatter,
    body: userSegments.join("\n\n"),
  };
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

export const isSameUserOwnedTaskDocument = (
  left: UserOwnedTaskDocument,
  right: UserOwnedTaskDocument,
): boolean => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

export const isEmptyUserOwnedTaskDocument = (document: UserOwnedTaskDocument): boolean =>
  Object.keys(document.frontmatter).length === 0 && document.body === "";

/** Build a fresh projection while retaining only the explicitly user-owned portions. */
export const renderTaskDocumentWithUserContent = (
  managedFrontmatter: ManagedFrontmatter,
  managedBody: string,
  userDocument: UserOwnedTaskDocument,
): string => {
  const content = renderNewTaskDocument(
    { ...userDocument.frontmatter, ...managedFrontmatter },
    managedBody,
  );
  return userDocument.body === "" ? content : `${content}\n${userDocument.body}\n`;
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
    // Obsidian's FrontMatterInfo.contentStart points after the line break following the closing
    // delimiter. Restore that separator explicitly instead of accidentally joining `---` to the
    // managed marker and making the note invisible to getFrontMatterInfo() on the next scan.
    content: `---\n${yaml}---\n${bodyUpdate.content.slice(contentStart)}`,
    changed: true,
  };
};

const todoistTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const readTodoistTaskId = (value: unknown): ManagedNoteIdentity | null => {
  if (typeof value !== "string" || value !== value.trim() || !todoistTaskIdPattern.test(value)) {
    return null;
  }
  return { taskId: value };
};

/** Read the immutable identity serialized inside a `tasks-bridge-project-task` block. */
export const readProjectTaskBlockIdentity = (source: string): ManagedNoteIdentity | null => {
  let value: unknown;
  try {
    value = loadYaml(source);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "task_id")) {
    return null;
  }
  return readTodoistTaskId(record.task_id);
};

export const readManagedNoteIdentity = (
  frontmatter: ManagedFrontmatter,
): ManagedNoteIdentity | null => readTodoistTaskId(frontmatter.todoist_task_id);

/**
 * Recover only the immutable task identity from otherwise malformed managed frontmatter.
 *
 * This deliberately accepts one narrow shape: exactly one top-level scalar task ID plus one valid
 * Tasks Bridge managed-body region. No other frontmatter value is trusted or recovered.
 */
export const readRecoverableManagedNoteIdentity = (
  content: string,
  rawFrontmatter: string,
): ManagedNoteIdentity | null => {
  const starts = findAll(content, MANAGED_BODY_START);
  const ends = findAll(content, MANAGED_BODY_END);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    return null;
  }

  const candidates = rawFrontmatter
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^todoist_task_id:[\t ]*(.*)$/u);
      return match === null ? [] : [match[1]?.trim() ?? ""];
    });
  if (candidates.length !== 1) {
    return null;
  }

  const scalar = candidates[0] ?? "";
  const quoted = scalar.match(/^(['"])([A-Za-z0-9][A-Za-z0-9_-]*)\1$/u);
  const taskId = quoted?.[2] ?? (todoistTaskIdPattern.test(scalar) ? scalar : null);
  if (taskId === null) {
    return null;
  }

  return { taskId };
};
