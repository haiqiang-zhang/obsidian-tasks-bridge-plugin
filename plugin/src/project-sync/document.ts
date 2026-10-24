import { dump as dumpYaml, load as loadYaml } from "js-yaml";

import type { ProjectCompletionEvent } from "@/api/domain/task";
import type { Task } from "@/data/task";
import { todoistTaskWebUrl } from "@/todoist/taskLinks";

import type { ProjectHierarchyPath } from "./hierarchy";
import {
  assertTaskPropertyMigrationSafe,
  deleteTaskProperty,
  readTaskProperty,
  setTaskProperty,
  TASK_PROPERTY_NAMES,
  TaskPropertyConflictError,
  type TaskPropertyKey,
} from "./properties";
import type { SnapshotTask } from "./types";

export const MANAGED_BODY_START = "<!-- todoist-sync-plus:managed:start -->";
export const MANAGED_BODY_END = "<!-- todoist-sync-plus:managed:end -->";
export const MANAGED_TASK_ID_MARKER_PREFIX = "<!-- tasks-bridge:task-id ";
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

const taskPropertyKeys = [
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

export const MANAGED_FRONTMATTER_KEYS = [
  // Keep old spellings in the allowlist so migrations do not treat them as user properties.
  ...LEGACY_IMPLEMENTATION_FRONTMATTER_KEYS,
  ...taskPropertyKeys,
  ...taskPropertyKeys.map((key) => TASK_PROPERTY_NAMES[key]),
] as const;

const relationshipPropertyKeys = ["todoist_parent_task", "todoist_subtasks"] as const;

export const MANAGED_TASK_RELATIONSHIP_FRONTMATTER_KEYS = [
  ...relationshipPropertyKeys,
  ...relationshipPropertyKeys.map((key) => TASK_PROPERTY_NAMES[key]),
] as const;

export type ManagedFrontmatter = Record<string, unknown>;

const hasOwn = (frontmatter: ManagedFrontmatter, key: string): boolean =>
  // biome-ignore lint/suspicious/noPrototypeBuiltins: The supported Obsidian target does not include ES2022 Object.hasOwn.
  Object.prototype.hasOwnProperty.call(frontmatter, key);

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
    "task id": task.id,
    content: task.content,
    description: task.description,
    status: completed ? "completed" : "active",
    completed,
    project: task.project.name,
    "project path": projectPath.names,
    labels: task.labels.map((label) => label.name),
    priority: priorityName(task.priority),
    url: todoistTaskWebUrl(task.project.id, task.id),
  };

  if (task.authoritativeCreatedAt !== undefined) {
    frontmatter["created at"] = task.authoritativeCreatedAt;
  }

  // Project IDs, mapping IDs, parent IDs, section IDs, Todoist order, missing counters, and raw
  // completion history belong to the plugin's local catalog. The Markdown task binds to Todoist
  // through one immutable key only: task id.
  void rootProjectId;
  void projectPath.ids;
  void mappingId;
  void completionEvents;
  // The local projection time is intentionally not serialized into task Markdown. Two devices
  // projecting the same Todoist snapshot must produce byte-identical managed content so Obsidian
  // Sync never manufactures a conflict copy solely because their clocks differ.
  void syncedAt;

  if (task.updatedAt !== undefined) {
    frontmatter["updated at"] = task.updatedAt;
  }

  if (task.section !== undefined) {
    frontmatter.section = task.section.name;
  }
  if (completed && task.completedAt != null) {
    frontmatter["completed at"] = task.completedAt;
  }
  if (task.due !== undefined) {
    frontmatter["due date"] = task.due.date.slice(0, 10);
    const dueDatetime =
      task.due.datetime ?? (task.due.date.includes("T") ? task.due.date : undefined);
    if (dueDatetime !== undefined) {
      frontmatter["due datetime"] = dueDatetime;
    }
    if (task.due.timezone != null) {
      frontmatter["due timezone"] = task.due.timezone;
    }
    frontmatter.recurring = task.due.isRecurring;
  }
  if (task.deadline !== undefined) {
    frontmatter.deadline = task.deadline.date;
  }
  if (task.duration !== undefined) {
    frontmatter.duration = task.duration.amount;
    frontmatter["duration unit"] = task.duration.unit;
  }

  return frontmatter;
};

export const applyManagedFrontmatter = (
  target: ManagedFrontmatter,
  desired: ManagedFrontmatter,
): boolean => {
  assertTaskPropertyMigrationSafe(target);
  assertTaskPropertyMigrationSafe(desired);
  const targetId = readTaskProperty(target, "todoist_task_id");
  const desiredId = readTaskProperty(desired, "todoist_task_id");
  if (targetId !== undefined && desiredId !== undefined && targetId !== desiredId) {
    throw new TaskPropertyConflictError("task id");
  }
  const changed = applyTaskProperties(target, desired, taskPropertyKeys);
  return removeLegacyImplementationFrontmatter(target) || changed;
};

const applyTaskProperties = (
  target: ManagedFrontmatter,
  desired: ManagedFrontmatter,
  keys: readonly TaskPropertyKey[],
): boolean => {
  let changed = false;
  for (const key of keys) {
    const name = TASK_PROPERTY_NAMES[key];
    if (hasOwn(desired, name) || hasOwn(desired, key)) {
      changed = setTaskProperty(target, key, readTaskProperty(desired, key)) || changed;
    } else {
      changed = deleteTaskProperty(target, key) || changed;
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
  assertTaskPropertyMigrationSafe(target);
  const desired: ManagedFrontmatter = {
    ...(relationships.parentTask === undefined ? {} : { "parent task": relationships.parentTask }),
    ...(relationships.subtasks.length === 0 ? {} : { subtasks: [...relationships.subtasks] }),
  };
  return applyTaskProperties(target, desired, relationshipPropertyKeys);
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

export const makeProjectTaskBlock = (taskId: string): string =>
  `\`\`\`${PROJECT_TASK_CODE_BLOCK}\ntask_id: ${JSON.stringify(taskId)}\n\`\`\``;

/** A source-only identity marker; the native task header reads the note's frontmatter. */
export const makeManagedTaskIdentityMarker = (taskId: string): string => {
  if (readTodoistTaskId(taskId) === null) {
    throw new ManagedBodyConflictError("Cannot serialize an invalid managed task identity");
  }
  return `${MANAGED_TASK_ID_MARKER_PREFIX}${JSON.stringify(taskId)} -->`;
};

export const makeManagedBody = (task: Task): string =>
  `${MANAGED_BODY_START}\n${makeManagedTaskIdentityMarker(task.id)}\n${MANAGED_BODY_END}`;

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
  // Only the namespaced legacy fields match the historical duplicated-YAML corruption.
  // Ordinary prose such as `description: ...` followed by a rule belongs to the user.
  const match = normalized.match(/^'?(todoist_[a-z0-9_]+):[^\n]*\n---$/u);
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
  assertTaskPropertyMigrationSafe(frontmatter);
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
  for (const [key, value] of Object.entries(userDocument.frontmatter)) {
    if (
      hasOwn(managedFrontmatter, key) &&
      JSON.stringify(value) !== JSON.stringify(managedFrontmatter[key])
    ) {
      const property = Object.values(TASK_PROPERTY_NAMES).find((name) => name === key);
      if (property !== undefined) {
        throw new TaskPropertyConflictError(property);
      }
      throw new ManagedBodyConflictError(
        `The managed task property "${key}" conflicts with a user property`,
      );
    }
  }
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
  const identity = readManagedNoteIdentity(currentFrontmatter);
  if (
    identity !== null &&
    (content.includes(MANAGED_BODY_START) ||
      content.includes(MANAGED_BODY_END) ||
      content.includes(MANAGED_TASK_ID_MARKER_PREFIX))
  ) {
    requireManagedTaskBody(content, contentStart, identity.taskId);
  }
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

/** Read exactly one canonical identity comment, without accepting additional source text. */
export const readManagedTaskIdentityMarker = (source: string): ManagedNoteIdentity | null => {
  const match = source.match(/^<!-- tasks-bridge:task-id "([A-Za-z0-9][A-Za-z0-9_-]*)" -->$/u);
  return match === null ? null : readTodoistTaskId(match[1]);
};

/** Accept the source-only protocol and the two historical generated card formats. */
export const requireManagedTaskBody = (
  content: string,
  contentStart: number,
  taskId: string,
): void => {
  const starts = findAll(content, MANAGED_BODY_START);
  const ends = findAll(content, MANAGED_BODY_END);
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0] < contentStart ||
    ends[0] <= starts[0]
  ) {
    throw new ManagedBodyConflictError("The task's managed body markers are missing or duplicated");
  }
  const source = content.slice(starts[0] + MANAGED_BODY_START.length, ends[0]).trim();
  const identityMarkers = findAll(content, MANAGED_TASK_ID_MARKER_PREFIX);
  if (identityMarkers.length > 0) {
    if (identityMarkers.length !== 1 || readManagedTaskIdentityMarker(source)?.taskId !== taskId) {
      throw new ManagedBodyConflictError(
        "The task identity marker and frontmatter do not identify the same task, or the marker is duplicated",
      );
    }
    return;
  }
  const lines = source.split(/\r?\n/u);
  const opening = lines.shift()?.trim();
  const closing = lines.pop()?.trim();
  if (closing !== "```") {
    throw new ManagedBodyConflictError("The task's managed identity region is malformed");
  }
  const blockSource = lines.join("\n");
  if (opening === `\`\`\`${LEGACY_PROJECT_TASK_CODE_BLOCK}` && blockSource.trim() === "") {
    return;
  }
  if (
    opening !== `\`\`\`${PROJECT_TASK_CODE_BLOCK}` ||
    readProjectTaskBlockIdentity(blockSource)?.taskId !== taskId
  ) {
    throw new ManagedBodyConflictError(
      "The task card and frontmatter do not identify the same task",
    );
  }
};

export const hasManagedTaskBody = (
  content: string,
  contentStart: number,
  taskId: string,
): boolean => {
  try {
    requireManagedTaskBody(content, contentStart, taskId);
    return true;
  } catch {
    return false;
  }
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
): ManagedNoteIdentity | null => {
  try {
    assertTaskPropertyMigrationSafe(frontmatter);
    return readTodoistTaskId(readTaskProperty(frontmatter, "todoist_task_id"));
  } catch (error) {
    if (error instanceof TaskPropertyConflictError) {
      return null;
    }
    throw error;
  }
};

/**
 * Recover only the immutable task identity from otherwise malformed managed frontmatter.
 *
 * Accept one top-level scalar per supported ID spelling and require their values to agree, plus
 * one valid Tasks Bridge managed-body region. No other frontmatter value is trusted or recovered.
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
      const match = line.match(
        /^(?:(["'])(task id|todoist_task_id)\1|(task id|todoist_task_id)):[\t ]*(.*)$/u,
      );
      return match === null ? [] : [{ key: match[2] ?? match[3], scalar: match[4]?.trim() ?? "" }];
    });
  if (
    candidates.length === 0 ||
    new Set(candidates.map(({ key }) => key)).size !== candidates.length
  ) {
    return null;
  }

  const taskIds = candidates.map(({ scalar }) => {
    const quoted = scalar.match(/^(['"])([A-Za-z0-9][A-Za-z0-9_-]*)\1$/u);
    return quoted?.[2] ?? (todoistTaskIdPattern.test(scalar) ? scalar : null);
  });
  const taskId = taskIds[0];
  if (taskId == null || taskIds.some((candidate) => candidate !== taskId)) {
    return null;
  }

  const frontmatterStart = content.indexOf(rawFrontmatter);
  if (
    frontmatterStart < 0 ||
    !hasManagedTaskBody(content, frontmatterStart + rawFrontmatter.length, taskId)
  ) {
    return null;
  }
  return { taskId };
};
