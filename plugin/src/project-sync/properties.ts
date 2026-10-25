/** Public task properties use readable names in Obsidian's native Properties editor. */
export const TASK_PROPERTY_NAMES = {
  todoist_task_id: "task id",
  todoist_content: "content",
  todoist_description: "description",
  todoist_status: "status",
  todoist_completed: "completed",
  todoist_project: "project",
  todoist_project_path: "project path",
  todoist_section: "section",
  todoist_labels: "labels",
  todoist_priority: "priority",
  todoist_created_at: "created at",
  todoist_updated_at: "updated at",
  todoist_completed_at: "completed at",
  todoist_due_date: "due date",
  todoist_due_datetime: "due datetime",
  todoist_due_timezone: "due timezone",
  todoist_due_is_recurring: "recurring",
  todoist_deadline: "deadline",
  todoist_duration: "duration",
  todoist_duration_unit: "duration unit",
  todoist_url: "url",
  // Read and remove old projection timestamps; new documents do not emit them.
  todoist_synced_at: "synced at",
  todoist_parent_task: "parent task",
  todoist_subtasks: "subtasks",
} as const;

export type TaskPropertyKey = keyof typeof TASK_PROPERTY_NAMES;
export type TaskPropertyName = (typeof TASK_PROPERTY_NAMES)[TaskPropertyKey];

/** Native Properties needs an explicit type for ISO timestamps with seconds or time zones. */
export const TASK_TEMPORAL_PROPERTY_TYPES = {
  [TASK_PROPERTY_NAMES.todoist_created_at]: "datetime",
  [TASK_PROPERTY_NAMES.todoist_updated_at]: "datetime",
  [TASK_PROPERTY_NAMES.todoist_completed_at]: "datetime",
  [TASK_PROPERTY_NAMES.todoist_due_date]: "date",
  [TASK_PROPERTY_NAMES.todoist_due_datetime]: "datetime",
  [TASK_PROPERTY_NAMES.todoist_deadline]: "date",
  [TASK_PROPERTY_NAMES.todoist_synced_at]: "datetime",
  todoist_created_at: "datetime",
  todoist_updated_at: "datetime",
  todoist_completed_at: "datetime",
  todoist_due_date: "date",
  todoist_due_datetime: "datetime",
  todoist_deadline: "date",
  todoist_synced_at: "datetime",
  // Older projections may still contain this implementation field until their next migration.
  todoist_stale_since: "datetime",
} as const;

const taskPropertyKeys = Object.keys(TASK_PROPERTY_NAMES) as TaskPropertyKey[];
type TaskFrontmatter = Record<string, unknown>;

export class TaskPropertyConflictError extends Error {
  readonly property: TaskPropertyName;

  constructor(property: TaskPropertyName, conflictingSpelling?: string) {
    super(
      conflictingSpelling === undefined
        ? `Cannot migrate task property "${property}": it conflicts with an existing value`
        : `Cannot migrate task property "${property}": existing property "${conflictingSpelling}" differs only by letter case`,
    );
    this.property = property;
    this.name = "TaskPropertyConflictError";
  }
}

const hasOwn = (frontmatter: TaskFrontmatter, key: string): boolean =>
  // biome-ignore lint/suspicious/noPrototypeBuiltins: The supported Obsidian target does not include ES2022 Object.hasOwn.
  Object.prototype.hasOwnProperty.call(frontmatter, key);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    Array.isArray(left) ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(right)
  ) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as TaskFrontmatter;
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(
      ([key, value]) => hasOwn(rightRecord, key) && sameValue(value, rightRecord[key]),
    )
  );
};

const assertCompatibleProperty = (frontmatter: TaskFrontmatter, key: TaskPropertyKey): void => {
  const name = TASK_PROPERTY_NAMES[key];
  const conflictingSpelling = Object.keys(frontmatter).find((existing) => {
    if (existing === name || existing === key) {
      return false;
    }
    const lowercase = existing.toLowerCase();
    return lowercase === name || lowercase === key;
  });
  if (conflictingSpelling !== undefined) {
    // Native Properties does not promise independent names/types differing only by letter case.
    // Keep the user's original spelling and value intact instead of creating an ambiguous pair.
    throw new TaskPropertyConflictError(name, conflictingSpelling);
  }
  if (!hasOwn(frontmatter, name)) {
    return;
  }
  if (hasOwn(frontmatter, key)) {
    if (!sameValue(frontmatter[name], frontmatter[key])) {
      throw new TaskPropertyConflictError(name);
    }
  } else if (hasOwn(frontmatter, "todoist_task_id")) {
    // Until its legacy identity is migrated, an unpaired readable property belongs to the user.
    // For example, an old task may already have a custom `status` unrelated to Todoist.
    throw new TaskPropertyConflictError(name);
  }
};

/** Validate the whole migration before changing any keys, including the schema's identity. */
export const assertTaskPropertyMigrationSafe = (frontmatter: TaskFrontmatter): void => {
  for (const key of taskPropertyKeys) {
    assertCompatibleProperty(frontmatter, key);
  }
};

/** Normalize existing values together so single-property edits cannot leave an ambiguous schema. */
export const migrateTaskProperties = (frontmatter: TaskFrontmatter): boolean => {
  assertTaskPropertyMigrationSafe(frontmatter);
  let changed = false;
  for (const key of taskPropertyKeys) {
    if (hasOwn(frontmatter, key)) {
      frontmatter[TASK_PROPERTY_NAMES[key]] = frontmatter[key];
      delete frontmatter[key];
      changed = true;
    }
  }
  return changed;
};

/** Read either schema without letting conflicting copies silently win over each other. */
export const readTaskProperty = (
  frontmatter: TaskFrontmatter | undefined,
  key: TaskPropertyKey,
): unknown => {
  if (frontmatter === undefined) {
    return undefined;
  }
  assertCompatibleProperty(frontmatter, key);
  const name = TASK_PROPERTY_NAMES[key];
  return hasOwn(frontmatter, name) ? frontmatter[name] : frontmatter[key];
};

/** Write one canonical value and retire its legacy spelling. Returns whether anything changed. */
export const setTaskProperty = (
  frontmatter: TaskFrontmatter,
  key: TaskPropertyKey,
  value: unknown,
): boolean => {
  assertTaskPropertyMigrationSafe(frontmatter);
  const name = TASK_PROPERTY_NAMES[key];
  if (key === "todoist_task_id") {
    const current = readTaskProperty(frontmatter, key);
    if (current !== undefined && !sameValue(current, value)) {
      throw new TaskPropertyConflictError(name);
    }
  }
  const migrated = migrateTaskProperties(frontmatter);
  const changed = migrated || !hasOwn(frontmatter, name) || !sameValue(frontmatter[name], value);
  frontmatter[name] = value;
  return changed;
};

/** Remove a managed value under either spelling, preserving unrelated user properties. */
export const deleteTaskProperty = (frontmatter: TaskFrontmatter, key: TaskPropertyKey): boolean => {
  const migrated = migrateTaskProperties(frontmatter);
  const name = TASK_PROPERTY_NAMES[key];
  const changed = migrated || hasOwn(frontmatter, name);
  delete frontmatter[name];
  return changed;
};
