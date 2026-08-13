import pc from "picocolors";

import {
  compareVersions,
  extractChangelogContent,
  parseVersion,
  prepareChangelog,
  resolveReleaseVersion,
  validateReleaseVersionInput,
} from "./release-utils";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const EXPECTED_REPOSITORY = "haiqiang-zhang/obsidian-tasks-bridge-plugin";
const RELEASE_WORKFLOW = "release.yml";
const RELEASE_STATE_FILENAME = "tasks-bridge-release-state.json";
const RELEASE_ASSETS = ["main.js", "manifest.json", "styles.css"] as const;
const RELEASE_FILES = [
  "docs/docs/changelog.md",
  "docs/docs/translation-status.json",
  "docs/package.json",
  "manifest.json",
  "package.json",
  "package-lock.json",
  "plugin/package.json",
  "scripts/package.json",
  "versions.json",
] as const;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const WORKFLOW_TIMEOUT_MINUTES = 10;
const DRAFT_RELEASE_TIMEOUT_MINUTES = 1;
const POLL_INTERVAL_SECONDS = 5;
const STATUS_INTERVAL_SECONDS = 30;
const MAX_CONSECUTIVE_GITHUB_ERRORS = 3;
const RERUN_PROPAGATION_SECONDS = 30;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;
const POLL_INTERVAL_MS = POLL_INTERVAL_SECONDS * MS_PER_SECOND;
const STATUS_INTERVAL_MS = STATUS_INTERVAL_SECONDS * MS_PER_SECOND;
const WORKFLOW_TIMEOUT_MS = WORKFLOW_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const DRAFT_RELEASE_TIMEOUT_MS = DRAFT_RELEASE_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const RERUN_PROPAGATION_MS = RERUN_PROPAGATION_SECONDS * MS_PER_SECOND;

let preparationRollback: (() => void) | null = null;
let handlingShutdownSignal = false;

type RunOptions = {
  cwd?: string;
  inherit?: boolean;
  silent?: boolean;
};

type Manifest = {
  id: string;
  minAppVersion: string;
  name: string;
  version: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
  version: string;
};

type PackageLock = {
  packages: Record<string, { version?: string }>;
  version: string;
};

type ReleaseInfo = {
  assets: Array<{ name: string }>;
  isDraft: boolean;
  isPrerelease: boolean;
  tagName: string;
  url: string;
};

type ReleaseState = {
  baseHead: string;
  input: string;
  releaseHead?: string;
  targetVersion: string;
};

type WorkflowRun = {
  conclusion: string | null;
  databaseId: number;
  headBranch: string;
  headSha: string;
  status: string;
  url: string;
};

class CommandError extends Error {
  readonly output: string;

  constructor(command: string, args: readonly string[], output: string) {
    super(
      output.length > 0
        ? `Command failed: ${formatCommand(command, args)}\n${output}`
        : `Command failed: ${formatCommand(command, args)}`,
    );
    this.name = "CommandError";
    this.output = output;
  }
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (/^[a-zA-Z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function run(command: string, args: readonly string[] = [], options: RunOptions = {}): string {
  if (!options.silent) {
    console.log(pc.dim(`$ ${formatCommand(command, args)}`));
  }

  try {
    if (options.inherit) {
      execFileSync(command, args, {
        cwd: options.cwd ?? REPO_ROOT,
        stdio: "inherit",
      });
      return "";
    }

    return execFileSync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    const error = cause as { stderr?: Buffer | string; stdout?: Buffer | string };
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .map((value) => value?.toString().trim())
      .filter(Boolean)
      .join("\n");
    if (output.length > 0 && !options.silent) {
      console.error(pc.dim(output));
    }
    throw new CommandError(command, args, output);
  }
}

function tryRun(command: string, args: readonly string[] = []): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, output };
  } catch {
    return { ok: false, output: "" };
  }
}

function logStarted(message: string): void {
  console.log(pc.cyan(`→ ${message}`));
}

function logCompleted(message: string): void {
  console.log(pc.green(`✓ ${message}`));
}

function fail(message: string): never {
  throw new Error(message);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseStatePath(): string {
  const gitDirectory = run("git", ["rev-parse", "--absolute-git-dir"], { silent: true });
  return join(gitDirectory, RELEASE_STATE_FILENAME);
}

function readReleaseState(): ReleaseState | null {
  const path = releaseStatePath();
  if (!existsSync(path)) {
    return null;
  }

  const state = readJson<Partial<ReleaseState>>(path);
  if (
    typeof state.baseHead !== "string" ||
    typeof state.input !== "string" ||
    (state.releaseHead !== undefined && typeof state.releaseHead !== "string") ||
    typeof state.targetVersion !== "string"
  ) {
    fail(`Invalid release recovery state at ${path}.`);
  }
  validateReleaseVersionInput(state.input);
  parseVersion(state.targetVersion);
  return state as ReleaseState;
}

function writeReleaseState(state: ReleaseState): void {
  writeJson(releaseStatePath(), state);
}

function clearReleaseState(): void {
  const path = releaseStatePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function manifestPath(): string {
  return join(REPO_ROOT, "manifest.json");
}

function changelogPath(): string {
  return join(REPO_ROOT, "docs", "docs", "changelog.md");
}

function readManifest(): Manifest {
  return readJson<Manifest>(manifestPath());
}

function localDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function checkPrerequisites(): void {
  logStarted("Checking release prerequisites...");

  run("gh", ["--version"], { silent: true });
  run("gh", ["auth", "status"], { silent: true });

  const repository = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { silent: true },
  );
  if (repository !== EXPECTED_REPOSITORY) {
    fail(`Expected GitHub repository ${EXPECTED_REPOSITORY}, found ${repository}.`);
  }

  const branch = run("git", ["branch", "--show-current"], { silent: true });
  if (branch !== "master") {
    fail(`Release from master, not ${branch}.`);
  }

  const status = run("git", ["status", "--porcelain"], { silent: true });
  if (status.length > 0) {
    fail("The worktree must be clean before releasing.");
  }

  run("git", ["pull", "--ff-only", "origin", "master"]);
  run("git", ["fetch", "origin", "--tags"]);
  logCompleted("Release prerequisites passed");
}

function isExpectedReleaseCommit(baseHead: string, head: string, version: string): boolean {
  const parent = tryRun("git", ["rev-parse", `${head}^`]);
  if (!parent.ok || parent.output !== baseHead) {
    return false;
  }

  const subject = run("git", ["log", "-1", "--format=%s", head], { silent: true });
  const files = run("git", ["diff", "--name-only", baseHead, head], { silent: true })
    .split("\n")
    .filter(Boolean);
  const allowedFiles = new Set<string>(RELEASE_FILES);
  return (
    subject === releaseCommitMessage(version) &&
    files.length > 0 &&
    files.every((path) => allowedFiles.has(path))
  );
}

function recoverInterruptedRelease(state: ReleaseState, input: string): void {
  if (input !== state.input && input !== state.targetVersion) {
    fail(
      `Release ${state.targetVersion} is still in progress. Rerun with ${state.input} or ${state.targetVersion}.`,
    );
  }

  const branch = run("git", ["branch", "--show-current"], { silent: true });
  if (branch !== "master") {
    fail(`Release ${state.targetVersion} recovery must run from master, not ${branch}.`);
  }

  const head = run("git", ["rev-parse", "HEAD"], { silent: true });
  const changes = changedFiles();
  const allowedFiles = new Set<string>(RELEASE_FILES);
  const unexpected = changes.filter((path) => !allowedFiles.has(path));
  if (unexpected.length > 0) {
    fail(
      `Release recovery found unrelated worktree changes:\n${unexpected.join("\n")}\nPreserve them before resuming.`,
    );
  }

  if (state.releaseHead) {
    const releaseCommitIsValid = isExpectedReleaseCommit(
      state.baseHead,
      state.releaseHead,
      state.targetVersion,
    );
    const releaseIsAncestor =
      head === state.releaseHead ||
      tryRun("git", ["merge-base", "--is-ancestor", state.releaseHead, head]).ok;
    if (changes.length > 0 || !releaseCommitIsValid || !releaseIsAncestor) {
      fail(`Release recovery could not verify the recorded commit ${state.releaseHead}.`);
    }
    return;
  }

  if (head === state.baseHead) {
    if (changes.length > 0) {
      logStarted(`Recovering interrupted preparation for Tasks Bridge ${state.targetVersion}...`);
      run("git", [
        "restore",
        "--source",
        state.baseHead,
        "--staged",
        "--worktree",
        "--",
        ...RELEASE_FILES,
      ]);
      logCompleted("Interrupted release files restored; preparation will restart automatically");
    }
    return;
  }

  if (changes.length > 0 || !isExpectedReleaseCommit(state.baseHead, head, state.targetVersion)) {
    fail(
      `Release recovery expected only the ${state.targetVersion} release commit after ${state.baseHead}.`,
    );
  }

  state.releaseHead = head;
  writeReleaseState(state);
}

function reconcileReleaseStateAfterPull(
  state: ReleaseState,
  currentVersion: string,
  targetVersion: string,
): void {
  const head = run("git", ["rev-parse", "HEAD"], { silent: true });

  if (state.releaseHead) {
    const releaseIsAncestor =
      head === state.releaseHead ||
      tryRun("git", ["merge-base", "--is-ancestor", state.releaseHead, head]).ok;
    if (!releaseIsAncestor) {
      fail(`Master no longer contains the recorded release commit ${state.releaseHead}.`);
    }
    return;
  }

  if (head === state.baseHead) {
    return;
  }

  const comparison = compareVersions(targetVersion, currentVersion);
  if (comparison > 0) {
    state.baseHead = head;
    writeReleaseState(state);
    return;
  }

  if (comparison === 0 && isExpectedReleaseCommit(state.baseHead, head, targetVersion)) {
    state.releaseHead = head;
    writeReleaseState(state);
    return;
  }

  fail(
    `Master changed while release ${targetVersion} was interrupted. Remove ${releaseStatePath()} after reviewing the repository state.`,
  );
}

function assertMasterCanRelease(currentVersion: string, targetVersion: string): void {
  const head = run("git", ["rev-parse", "HEAD"], { silent: true });
  const originMaster = run("git", ["rev-parse", "origin/master"], { silent: true });
  const comparison = compareVersions(targetVersion, currentVersion);

  if (comparison < 0) {
    fail(`Cannot release ${targetVersion}; the repository is already at ${currentVersion}.`);
  }

  if (head === originMaster) {
    return;
  }

  if (comparison === 0 && isExpectedReleaseCommit(originMaster, head, targetVersion)) {
    return;
  }

  fail("Local master and origin/master have diverged or contain unrelated unpushed commits.");
}

function snapshotReleaseFiles(): Map<string, string> {
  return new Map(RELEASE_FILES.map((path) => [path, readFileSync(join(REPO_ROOT, path), "utf8")]));
}

function restoreReleaseFiles(snapshot: ReadonlyMap<string, string>): void {
  logStarted("Restoring release preparation files after failure...");
  run("git", ["restore", "--staged", "--", ...RELEASE_FILES], { silent: true });
  for (const [path, content] of snapshot) {
    writeFileSync(join(REPO_ROOT, path), content);
  }
  logCompleted("Release preparation files restored");
}

function rollbackPreparationIfNeeded(): void {
  const rollback = preparationRollback;
  preparationRollback = null;
  rollback?.();
}

function handleShutdownSignal(signal: "SIGINT" | "SIGTERM"): never {
  const exitCode = signal === "SIGINT" ? SIGINT_EXIT_CODE : SIGTERM_EXIT_CODE;
  if (handlingShutdownSignal) {
    process.exit(exitCode);
  }

  handlingShutdownSignal = true;
  try {
    rollbackPreparationIfNeeded();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(pc.red(`✗ Could not restore release files: ${message}`));
  }
  console.error(pc.yellow(`Release interrupted by ${signal}.`));
  process.exit(exitCode);
}

process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));

function updateChangelog(version: string): void {
  const path = changelogPath();
  const changelog = readFileSync(path, "utf8");
  writeFileSync(path, prepareChangelog(changelog, version, localDate()));
}

function updateVersionFiles(version: string): void {
  const manifest = readManifest();
  const packagePaths = [
    join(REPO_ROOT, "package.json"),
    join(REPO_ROOT, "plugin", "package.json"),
    join(REPO_ROOT, "docs", "package.json"),
    join(REPO_ROOT, "scripts", "package.json"),
  ];
  const packageJsons = packagePaths.map((path) => ({
    path,
    value: readJson<PackageJson>(path),
  }));
  const pluginPackage = packageJsons.find(({ path }) => path.endsWith("/plugin/package.json"));
  if (!pluginPackage) {
    fail("Could not find the plugin package.json.");
  }

  manifest.version = version;
  for (const packageJson of packageJsons) {
    packageJson.value.version = version;
  }

  const obsidianVersion = pluginPackage.value.dependencies?.obsidian;
  if (obsidianVersion) {
    manifest.minAppVersion = obsidianVersion;
  }

  writeJson(manifestPath(), manifest);
  for (const packageJson of packageJsons) {
    writeJson(packageJson.path, packageJson.value);
  }

  const packageLockPath = join(REPO_ROOT, "package-lock.json");
  const packageLock = readJson<PackageLock>(packageLockPath);
  packageLock.version = version;
  for (const workspace of ["", "plugin", "docs", "scripts"]) {
    const lockedPackage = packageLock.packages[workspace];
    if (!lockedPackage) {
      fail(`package-lock.json does not contain the "${workspace || "root"}" workspace.`);
    }
    lockedPackage.version = version;
  }
  writeJson(packageLockPath, packageLock);

  const versionsPath = join(REPO_ROOT, "versions.json");
  const versions = readJson<Record<string, string>>(versionsPath);
  versions[version] = manifest.minAppVersion;

  const sortedVersions = Object.fromEntries(
    Object.entries(versions).sort(([left], [right]) => compareVersions(right, left)),
  );
  writeJson(versionsPath, sortedVersions);
}

function validatePreparedVersion(version: string): void {
  const manifest = readManifest();
  const packageVersions = [
    readJson<PackageJson>(join(REPO_ROOT, "package.json")).version,
    readJson<PackageJson>(join(REPO_ROOT, "plugin", "package.json")).version,
    readJson<PackageJson>(join(REPO_ROOT, "docs", "package.json")).version,
    readJson<PackageJson>(join(REPO_ROOT, "scripts", "package.json")).version,
  ];
  const packageLock = readJson<PackageLock>(join(REPO_ROOT, "package-lock.json"));
  const versions = readJson<Record<string, string>>(join(REPO_ROOT, "versions.json"));

  if (manifest.version !== version || packageVersions.some((value) => value !== version)) {
    fail(`Version files do not consistently contain ${version}.`);
  }
  if (
    packageLock.version !== version ||
    ["", "plugin", "docs", "scripts"].some(
      (workspace) => packageLock.packages[workspace]?.version !== version,
    )
  ) {
    fail(`package-lock.json does not consistently contain version ${version}.`);
  }
  if (versions[version] !== manifest.minAppVersion) {
    fail(`versions.json does not map ${version} to ${manifest.minAppVersion}.`);
  }

  extractChangelogContent(readFileSync(changelogPath(), "utf8"), version);
}

function runReleaseChecks(version: string): void {
  logStarted("Running release checks...");
  run("npm", ["run", "gen"], { inherit: true });
  run("npm", ["run", "check", "--workspace=plugin"], { inherit: true });
  run("npm", ["run", "lint:check", "--workspace=plugin"], { inherit: true });
  run("npm", ["test", "--workspace=plugin", "--", "--run"], { inherit: true });
  run("npm", ["run", "check", "--workspace=scripts"], { inherit: true });
  run("npm", ["run", "lint:check", "--workspace=scripts"], { inherit: true });
  run("npm", ["test", "--workspace=scripts"], { inherit: true });
  run("npm", ["run", "typecheck", "--workspace=docs"], { inherit: true });
  run("npm", ["run", "build", "--workspace=docs"], { inherit: true });

  const buildDirectory = mkdtempSync(join(tmpdir(), "tasks-bridge-release-build-"));
  try {
    run("npm", ["run", "build", "--workspace=plugin", "--", "--outDir", buildDirectory], {
      inherit: true,
    });
    const builtManifest = readJson<Manifest>(join(buildDirectory, "manifest.json"));
    if (builtManifest.version !== version) {
      fail(`Built manifest is ${builtManifest.version}, expected ${version}.`);
    }
  } finally {
    rmSync(buildDirectory, { force: true, recursive: true });
  }

  run("git", ["diff", "--check"]);
  logCompleted("Release checks passed");
}

function changedFiles(): string[] {
  const tracked = run("git", ["diff", "--name-only"], { silent: true });
  const staged = run("git", ["diff", "--cached", "--name-only"], { silent: true });
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], {
    silent: true,
  });
  return [
    ...new Set([...tracked.split("\n"), ...staged.split("\n"), ...untracked.split("\n")]),
  ].filter(Boolean);
}

function releaseCommitMessage(version: string): string {
  return `Prepare Tasks Bridge ${version} release`;
}

function commitRelease(version: string): void {
  const allowedFiles = new Set<string>(RELEASE_FILES);
  const changes = changedFiles();
  const unexpected = changes.filter((path) => !allowedFiles.has(path));
  if (unexpected.length > 0) {
    fail(`Release preparation changed unexpected files:\n${unexpected.join("\n")}`);
  }
  if (changes.length === 0) {
    fail("Release preparation did not change any files.");
  }

  run("git", ["add", "--", ...changes]);
  run("git", ["diff", "--cached", "--check"]);
  run("git", ["commit", "-m", releaseCommitMessage(version)], {
    inherit: true,
  });
}

function prepareRelease(version: string): void {
  logStarted(`Preparing Tasks Bridge ${version}...`);
  updateChangelog(version);
  updateVersionFiles(version);
  validatePreparedVersion(version);
  runReleaseChecks(version);
  commitRelease(version);
  logCompleted(`Prepared Tasks Bridge ${version}`);
}

function pushMasterIfNeeded(): void {
  const head = run("git", ["rev-parse", "HEAD"], { silent: true });
  const originMaster = run("git", ["rev-parse", "origin/master"], { silent: true });
  if (head === originMaster) {
    return;
  }

  if (!tryRun("git", ["merge-base", "--is-ancestor", originMaster, head]).ok) {
    fail("Refusing to push because origin/master is not an ancestor of local master.");
  }

  logStarted("Pushing the release commit to master...");
  run("git", ["push", "origin", "master"], { inherit: true });
  run("git", ["fetch", "origin", "master"], { silent: true });
  logCompleted("Release commit pushed");
}

function remoteTagCommit(version: string): string | null {
  const directRef = `refs/tags/${version}`;
  const peeledRef = `${directRef}^{}`;
  const result = tryRun("git", [
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    directRef,
    peeledRef,
  ]);
  if (!result.ok) {
    return null;
  }

  const refs = new Map(
    result.output.split("\n").map((line) => {
      const [commit, ref] = line.trim().split(/\s+/, 2);
      return [ref, commit] as const;
    }),
  );
  return refs.get(peeledRef) ?? refs.get(directRef) ?? null;
}

function ensureReleaseTag(version: string, releaseHead: string): string {
  const localTag = run("git", ["tag", "--list", version], { silent: true });

  if (localTag.length > 0) {
    const tagCommit = run("git", ["rev-list", "-n", "1", version], { silent: true });
    if (tagCommit !== releaseHead) {
      fail(`Tag ${version} points to ${tagCommit}, expected ${releaseHead}.`);
    }
  } else {
    logStarted(`Creating annotated tag ${version}...`);
    run("git", ["tag", "-a", version, "-m", version, releaseHead]);
    logCompleted(`Tag ${version} created`);
  }

  const remoteCommit = remoteTagCommit(version);
  if (remoteCommit && remoteCommit !== releaseHead) {
    fail(`Remote tag ${version} points to ${remoteCommit}, expected ${releaseHead}.`);
  }

  if (!remoteCommit) {
    logStarted(`Pushing tag ${version}...`);
    run("git", ["push", "origin", version], { inherit: true });
    logCompleted(`Tag ${version} pushed`);
  }

  return releaseHead;
}

function getRelease(version: string): ReleaseInfo | null {
  try {
    const output = run(
      "gh",
      ["release", "view", version, "--json", "assets,isDraft,isPrerelease,tagName,url"],
      { silent: true },
    );
    return JSON.parse(output) as ReleaseInfo;
  } catch (cause) {
    if (cause instanceof CommandError && /release not found/i.test(cause.output)) {
      return null;
    }
    throw cause;
  }
}

function releaseWorkflowRun(version: string, headSha: string): WorkflowRun | null {
  const runs = JSON.parse(
    run(
      "gh",
      [
        "run",
        "list",
        `--workflow=${RELEASE_WORKFLOW}`,
        "--json",
        "conclusion,databaseId,headBranch,headSha,status,url",
        "--limit",
        "20",
      ],
      { silent: true },
    ),
  ) as WorkflowRun[];

  return runs.find((item) => item.headBranch === version && item.headSha === headSha) ?? null;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function elapsedSeconds(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / MS_PER_SECOND);
}

async function waitForReleaseBuild(version: string, headSha: string): Promise<void> {
  logStarted("Waiting for the GitHub release build...");
  const startedAt = Date.now();
  let consecutiveErrors = 0;
  let lastReportedAt = 0;
  let lastStatus = "";
  let rerunRequestedAt: number | null = null;

  while (Date.now() - startedAt <= WORKFLOW_TIMEOUT_MS) {
    let workflow: WorkflowRun | null;
    try {
      workflow = releaseWorkflowRun(version, headSha);
      consecutiveErrors = 0;
    } catch (cause) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_GITHUB_ERRORS) {
        throw cause;
      }
      console.log(
        pc.yellow(
          `  GitHub status check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_GITHUB_ERRORS}); retrying...`,
        ),
      );
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!workflow) {
      if (Date.now() - lastReportedAt >= STATUS_INTERVAL_MS) {
        console.log(pc.dim(`  Waiting for the workflow to start (${elapsedSeconds(startedAt)}s)`));
        lastReportedAt = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const workflowStatus = `${workflow.status}:${workflow.conclusion ?? "pending"}`;
    if (workflowStatus !== lastStatus || Date.now() - lastReportedAt >= STATUS_INTERVAL_MS) {
      console.log(
        pc.dim(`  Workflow ${workflow.status} (${elapsedSeconds(startedAt)}s): ${workflow.url}`),
      );
      lastStatus = workflowStatus;
      lastReportedAt = Date.now();
    }

    if (workflow.status === "completed") {
      if (workflow.conclusion !== "success") {
        if (rerunRequestedAt === null) {
          logStarted(`Retrying failed release workflow ${workflow.databaseId} once...`);
          run("gh", ["run", "rerun", String(workflow.databaseId)]);
          rerunRequestedAt = Date.now();
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (Date.now() - rerunRequestedAt <= RERUN_PROPAGATION_MS) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        fail(`Release workflow failed (${workflow.conclusion}): ${workflow.url}`);
      }
      logCompleted(`GitHub release build passed: ${workflow.url}`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail(
    `Timed out after ${WORKFLOW_TIMEOUT_MINUTES} minutes waiting for the ${version} release workflow.`,
  );
}

async function waitForDraftRelease(version: string): Promise<ReleaseInfo> {
  logStarted("Waiting for the draft GitHub Release...");
  const startedAt = Date.now();
  let consecutiveErrors = 0;
  let lastReportedAt = 0;

  while (Date.now() - startedAt <= DRAFT_RELEASE_TIMEOUT_MS) {
    let release: ReleaseInfo | null;
    try {
      release = getRelease(version);
      consecutiveErrors = 0;
    } catch (cause) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_GITHUB_ERRORS) {
        throw cause;
      }
      console.log(
        pc.yellow(
          `  GitHub release lookup failed (${consecutiveErrors}/${MAX_CONSECUTIVE_GITHUB_ERRORS}); retrying...`,
        ),
      );
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (release) {
      return release;
    }
    if (Date.now() - lastReportedAt >= STATUS_INTERVAL_MS) {
      console.log(pc.dim(`  Draft not visible yet (${elapsedSeconds(startedAt)}s)`));
      lastReportedAt = Date.now();
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return fail(
    `Timed out after ${DRAFT_RELEASE_TIMEOUT_MINUTES} minute waiting for the ${version} GitHub Release.`,
  );
}

function publishRelease(version: string, release: ReleaseInfo): ReleaseInfo {
  if (!release.isDraft) {
    return release;
  }

  const notes = extractChangelogContent(readFileSync(changelogPath(), "utf8"), version);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tasks-bridge-release-notes-"));
  const notesPath = join(temporaryDirectory, "release-notes.md");
  writeFileSync(notesPath, `${notes}\n`);

  try {
    logStarted(`Publishing Tasks Bridge ${version}...`);
    run("gh", [
      "release",
      "edit",
      version,
      "--title",
      `Tasks Bridge - v${version}`,
      "--notes-file",
      notesPath,
      "--draft=false",
      "--prerelease=false",
    ]);
    logCompleted(`Tasks Bridge ${version} published`);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  return getRelease(version) ?? fail(`Could not read the published ${version} release.`);
}

function validatePublishedRelease(version: string, release: ReleaseInfo): void {
  validateReleaseContents(version, release);
  if (release.isDraft) {
    fail(`GitHub Release ${version} is still a draft.`);
  }
}

function validateReleaseContents(version: string, release: ReleaseInfo): void {
  if (release.tagName !== version || release.isPrerelease) {
    fail(`GitHub Release ${version} does not match the stable release tag.`);
  }

  const assetNames = new Set(release.assets.map((asset) => asset.name));
  const missingAssets = RELEASE_ASSETS.filter((asset) => !assetNames.has(asset));
  if (missingAssets.length > 0) {
    fail(`GitHub Release ${version} is missing: ${missingAssets.join(", ")}.`);
  }
}

function installPublishedReleaseIntoLinkedVault(version: string): void {
  const distPath = join(REPO_ROOT, "plugin", "dist");
  if (!existsSync(distPath) || !lstatSync(distPath).isSymbolicLink()) {
    return;
  }

  logStarted(`Installing Tasks Bridge ${version} into the linked development Vault...`);
  run("gh", [
    "release",
    "download",
    version,
    "--repo",
    EXPECTED_REPOSITORY,
    "--dir",
    distPath,
    "--pattern",
    "main.js",
    "--pattern",
    "manifest.json",
    "--pattern",
    "styles.css",
    "--clobber",
  ]);
  const installedManifest = readJson<Manifest>(join(distPath, "manifest.json"));
  if (installedManifest.id !== "tasks-bridge" || installedManifest.version !== version) {
    fail(`The linked development Vault did not receive Tasks Bridge ${version}.`);
  }
  logCompleted(`Linked development Vault updated to Tasks Bridge ${version}`);
}

function printUsage(): void {
  console.log(`Usage:
  npm run release -- <x.y.z|major|minor|patch>

Examples:
  npm run release -- 2.9.0
  npm run release -- minor`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printUsage();
    return;
  }
  if (args.length !== 1) {
    printUsage();
    fail("Expected exactly one release target.");
  }

  const releaseInput = args[0];
  validateReleaseVersionInput(releaseInput);
  let releaseState = readReleaseState();
  if (releaseState) {
    recoverInterruptedRelease(releaseState, releaseInput);
  }

  checkPrerequisites();
  const currentVersion = readManifest().version;
  const version =
    releaseState?.targetVersion ?? resolveReleaseVersion(releaseInput, currentVersion);
  if (releaseState) {
    reconcileReleaseStateAfterPull(releaseState, currentVersion, version);
  }
  logStarted(`Starting one-command release for Tasks Bridge ${version}...`);

  const existingRelease = getRelease(version);
  if (existingRelease && !existingRelease.isDraft) {
    const head = run("git", ["rev-parse", "HEAD"], { silent: true });
    const expectedReleaseHead = releaseState?.releaseHead ?? head;
    const remoteCommit = remoteTagCommit(version);
    if (remoteCommit !== expectedReleaseHead) {
      fail(
        `Tasks Bridge ${version} is already released from ${remoteCommit ?? "an unknown commit"}, not expected commit ${expectedReleaseHead}.`,
      );
    }
    validatePublishedRelease(version, existingRelease);
    installPublishedReleaseIntoLinkedVault(version);
    clearReleaseState();
    logCompleted(`Tasks Bridge ${version} is already released: ${existingRelease.url}`);
    return;
  }

  assertMasterCanRelease(currentVersion, version);

  try {
    if (compareVersions(version, currentVersion) > 0) {
      if (
        run("git", ["rev-parse", "HEAD"], { silent: true }) !==
        run("git", ["rev-parse", "origin/master"], { silent: true })
      ) {
        fail("Pull or push master before preparing a new release.");
      }
      if (run("git", ["tag", "--list", version], { silent: true }).length > 0) {
        fail(`Tag ${version} already exists before its version files are prepared.`);
      }

      const snapshot = snapshotReleaseFiles();
      const preparationHead = run("git", ["rev-parse", "HEAD"], { silent: true });
      releaseState = {
        baseHead: preparationHead,
        input: releaseState?.input ?? releaseInput,
        targetVersion: version,
      };
      writeReleaseState(releaseState);
      preparationRollback = () => {
        const currentHead = tryRun("git", ["rev-parse", "HEAD"]).output;
        if (currentHead !== preparationHead) {
          logCompleted("Release commit already exists; keeping it so the release can resume");
          return;
        }
        restoreReleaseFiles(snapshot);
        clearReleaseState();
      };
      prepareRelease(version);
      const releaseHead = run("git", ["rev-parse", "HEAD"], { silent: true });
      releaseState.releaseHead = releaseHead;
      writeReleaseState(releaseState);
      preparationRollback = null;
    } else {
      validatePreparedVersion(version);
      if (!releaseState) {
        const snapshot = snapshotReleaseFiles();
        const validationHead = run("git", ["rev-parse", "HEAD"], { silent: true });
        preparationRollback = () => {
          if (tryRun("git", ["rev-parse", "HEAD"]).output === validationHead) {
            restoreReleaseFiles(snapshot);
          }
        };
        runReleaseChecks(version);
        const generatedChanges = changedFiles();
        if (generatedChanges.length > 0) {
          fail(
            `Release checks changed files that are not committed:\n${generatedChanges.join("\n")}`,
          );
        }
        preparationRollback = null;
      }
    }

    pushMasterIfNeeded();
    const releaseHead =
      releaseState?.releaseHead ?? run("git", ["rev-parse", "HEAD"], { silent: true });
    const headSha = ensureReleaseTag(version, releaseHead);
    await waitForReleaseBuild(version, headSha);
    const draft = await waitForDraftRelease(version);
    validateReleaseContents(version, draft);
    const published = publishRelease(version, draft);
    validatePublishedRelease(version, published);
    installPublishedReleaseIntoLinkedVault(version);

    clearReleaseState();
    logCompleted(`Release complete: ${published.url}`);
  } catch (cause) {
    rollbackPreparationIfNeeded();
    throw cause;
  }
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(pc.red(`✗ ${message}`));
  process.exitCode = 1;
});
