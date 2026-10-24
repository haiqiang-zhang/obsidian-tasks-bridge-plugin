import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, type Vault } from "obsidian";

import { migrateBasePropertyReferences } from "./basePropertyMigration";
import { MANAGED_BODY_START, readManagedNoteIdentity, requireManagedTaskBody } from "./document";
import {
  assertTaskPropertyMigrationSafe,
  migrateTaskProperties,
  TASK_PROPERTY_NAMES,
} from "./properties";

type MutationRunner = <T>(paths: readonly string[], operation: () => Promise<T>) => Promise<T>;
type PlannedMigration = { file: TFile; original: string; updated: string; taskId?: string };

const noValidation = (): void => undefined;
const runDirectly: MutationRunner = async (_paths, operation) => await operation();
const legacyPropertyNames = new Set(Object.keys(TASK_PROPERTY_NAMES));

/** Only an error-classification fallback; valid YAML is always identified by its parsed keys. */
export const hasRawLegacyTaskIdentity = (frontmatter: string): boolean =>
  /(?:^|[{\n,])[\t ]*(?:\?[\t ]*)?(?:"todoist_task_id"|'todoist_task_id'|todoist_task_id)[\t ]*(?::|\r?\n[\t ]*:)/u.test(
    frontmatter,
  );

export class TaskPropertyMigrationError extends Error {
  public readonly path: string;
  public readonly deferred: boolean;
  public readonly taskId?: string;

  constructor(
    path: string,
    message: string,
    options: { deferred?: boolean; taskId?: string } = {},
  ) {
    super(`Cannot migrate task properties in '${path}': ${message}`);
    this.path = path;
    this.deferred = options.deferred === true;
    this.taskId = options.taskId;
    this.name = "TaskPropertyMigrationError";
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const migrateTaskDocument = (content: string): { updated: string; taskId: string } | null => {
  const info = getFrontMatterInfo(content);
  if (!info.exists) {
    return null;
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(info.frontmatter);
  } catch (error: unknown) {
    // Unrelated malformed notes must not prevent synchronization. Malformed legacy tasks cannot
    // be left behind while their editable Base columns switch to the new property names.
    if (
      hasRawLegacyTaskIdentity(info.frontmatter) ||
      (content.includes(MANAGED_BODY_START) &&
        [...legacyPropertyNames].some((key) => info.frontmatter.includes(key)))
    ) {
      throw error;
    }
    return null;
  }
  if (
    !isRecord(frontmatter) ||
    !Object.keys(frontmatter).some((key) => legacyPropertyNames.has(key))
  ) {
    return null;
  }
  const identity = readManagedNoteIdentity({
    todoist_task_id:
      frontmatter.todoist_task_id ?? frontmatter[TASK_PROPERTY_NAMES.todoist_task_id],
  });
  if (identity === null) {
    return null;
  }
  assertTaskPropertyMigrationSafe(frontmatter);
  requireManagedTaskBody(content, info.contentStart, identity.taskId);
  const migrated = { ...frontmatter };
  if (!migrateTaskProperties(migrated)) {
    return null;
  }
  // Native YAML serialization retains unknown field values. Everything after frontmatter is exact.
  const yaml = stringifyYaml(migrated);
  return {
    taskId: identity.taskId,
    updated: `---\n${yaml}${yaml.endsWith("\n") ? "" : "\n"}---\n${content.slice(info.contentStart)}`,
  };
};

/**
 * Prepare the complete local task schema before switching native Base columns. Closed tasks in
 * disabled mappings are included; this changes local property names only and never calls Todoist.
 */
export const prepareTaskPropertyMigration = async (
  vault: Vault,
  assertValid: () => void = noValidation,
  assertWritable: (file: TFile) => void = noValidation,
  runMutation: MutationRunner = runDirectly,
): Promise<void> => {
  const requireWritable = (file: TFile, taskId?: string): void => {
    try {
      assertWritable(file);
    } catch (error: unknown) {
      throw new TaskPropertyMigrationError(file.path, errorMessage(error), {
        deferred: true,
        taskId,
      });
    }
  };
  const tasks: PlannedMigration[] = [];
  const bases: PlannedMigration[] = [];
  for (const entry of vault.getAllLoadedFiles()) {
    if (
      !(entry instanceof TFile) ||
      (!entry.path.endsWith(".md") && !entry.path.endsWith(".base"))
    ) {
      continue;
    }
    assertValid();
    let original: string;
    try {
      original = await vault.read(entry);
    } catch (error: unknown) {
      throw new TaskPropertyMigrationError(entry.path, errorMessage(error));
    }
    assertValid();
    try {
      if (entry.path.endsWith(".md")) {
        const migration = migrateTaskDocument(original);
        if (migration !== null) {
          requireWritable(entry, migration.taskId);
          tasks.push({ file: entry, original, ...migration });
        }
      } else if (original.includes("todoist_")) {
        const migration = migrateBasePropertyReferences(original);
        if (migration.issues.length > 0) {
          throw new TaskPropertyMigrationError(entry.path, migration.issues.join("; "));
        }
        if (migration.changed) {
          requireWritable(entry);
          bases.push({ file: entry, original, updated: migration.text });
        }
      }
    } catch (error: unknown) {
      if (error instanceof TaskPropertyMigrationError) {
        throw error;
      }
      throw new TaskPropertyMigrationError(entry.path, errorMessage(error));
    }
  }

  // No task or Base is written until every legacy task and every affected Base passes preflight.
  const committed: PlannedMigration[] = [];
  let current: PlannedMigration | undefined;
  try {
    for (const plan of [...tasks, ...bases]) {
      current = plan;
      assertValid();
      requireWritable(plan.file, plan.taskId);
      await runMutation([plan.file.path], async () => {
        await vault.process(plan.file, (content) => {
          assertValid();
          requireWritable(plan.file, plan.taskId);
          if (content !== plan.original) {
            throw new TaskPropertyMigrationError(
              plan.file.path,
              "The file changed after migration was prepared; its current content was preserved",
            );
          }
          return plan.updated;
        });
      });
      committed.push(plan);
      current = undefined;
    }
    assertValid();
  } catch (error: unknown) {
    // Some adapters can report a write error after persisting. Include that file if it matches.
    if (current !== undefined) {
      try {
        if ((await vault.read(current.file)) === current.updated) {
          committed.push(current);
        }
      } catch {
        // The original error still identifies this file; recovery must never guess its content.
      }
    }
    const recoveryIssues: string[] = [];
    for (const plan of committed.reverse()) {
      try {
        requireWritable(plan.file, plan.taskId);
        await runMutation([plan.file.path], async () => {
          await vault.process(plan.file, (content) => {
            requireWritable(plan.file, plan.taskId);
            if (content !== plan.updated) {
              throw new Error("The file changed again; its current content was preserved");
            }
            return plan.original;
          });
        });
      } catch (recoveryError: unknown) {
        recoveryIssues.push(`${plan.file.path}: ${errorMessage(recoveryError)}`);
      }
    }
    if (recoveryIssues.length > 0) {
      throw new TaskPropertyMigrationError(
        error instanceof TaskPropertyMigrationError ? error.path : (current?.file.path ?? "vault"),
        `${errorMessage(error)}. Some files could not be restored without overwriting newer changes: ${recoveryIssues.join("; ")}`,
      );
    }
    // Preserve cancellation errors after safely undoing this preparation's writes.
    assertValid();
    if (error instanceof TaskPropertyMigrationError) {
      throw error;
    }
    throw new TaskPropertyMigrationError(current?.file.path ?? "vault", errorMessage(error));
  }
};
