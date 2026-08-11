import { isPathInside } from "./paths";
import type { ProjectSyncMapping } from "./types";

export const PROJECT_SYNC_QUIET_PERIOD_MS = 30_000;

export class ProjectSyncActivityTracker {
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private activityGeneration = 0;
  private readonly internalMutationPaths = new Map<string, number>();
  private readonly now: () => number;
  private readonly quietPeriodMs: number;

  constructor(now: () => number = Date.now, quietPeriodMs: number = PROJECT_SYNC_QUIET_PERIOD_MS) {
    this.now = now;
    this.quietPeriodMs = quietPeriodMs;
  }

  public recordActivity(): void {
    this.lastActivityAt = this.now();
    this.activityGeneration++;
  }

  /**
   * Records a Vault event unless every affected path belongs to a Project sync mutation that is
   * currently in progress. Returns true when the event is external and invalidates a run.
   */
  public recordVaultActivity(paths: readonly string[]): boolean {
    const normalizedPaths = paths.map(normalizeVaultPath).filter((path) => path !== "");
    if (
      normalizedPaths.length > 0 &&
      normalizedPaths.every((path) => (this.internalMutationPaths.get(path) ?? 0) > 0)
    ) {
      return false;
    }

    this.recordActivity();
    return true;
  }

  /**
   * Marks the exact paths mutated by this plugin while the Vault operation is pending. Obsidian's
   * Vault events have no public origin marker, so path-scoped suppression keeps our own writes
   * from cancelling the run while unrelated Sync/user events still invalidate it.
   */
  public async runInternalMutation<T>(
    paths: readonly string[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const normalizedPaths = [
      ...new Set(paths.map(normalizeVaultPath).filter((path) => path !== "")),
    ];
    for (const path of normalizedPaths) {
      this.internalMutationPaths.set(path, (this.internalMutationPaths.get(path) ?? 0) + 1);
    }

    try {
      return await mutation();
    } finally {
      for (const path of normalizedPaths) {
        const remaining = (this.internalMutationPaths.get(path) ?? 1) - 1;
        if (remaining <= 0) {
          this.internalMutationPaths.delete(path);
        } else {
          this.internalMutationPaths.set(path, remaining);
        }
      }
    }
  }

  public generation(): number {
    return this.activityGeneration;
  }

  public isQuiet(): boolean {
    return this.remainingQuietMs() === 0;
  }

  public remainingQuietMs(): number {
    return Math.max(0, this.quietPeriodMs - (this.now() - this.lastActivityAt));
  }
}

export const isProjectSyncPath = (
  candidatePath: string,
  mappings: readonly ProjectSyncMapping[],
): boolean => {
  const candidate = normalizeVaultPath(candidatePath);
  if (candidate === "") {
    return false;
  }
  return mappings.some((mapping) =>
    [mapping.folder, ...mapping.previousFolders].some((folder) => {
      const normalizedFolder = normalizeVaultPath(folder);
      return (
        normalizedFolder !== "" &&
        (isPathInside(normalizedFolder, candidate) || isPathInside(candidate, normalizedFolder))
      );
    }),
  );
};

const normalizeVaultPath = (path: string): string =>
  path
    .trim()
    .split("\\")
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");

export const isAutomaticProjectSyncWriter = (
  configuredWriterId: string | null,
  deviceId: string,
): boolean => configuredWriterId !== null && configuredWriterId === deviceId;
