import {
  compareVersions,
  extractChangelogContent,
  prepareChangelog,
  resolveReleaseVersion,
  validateReleaseVersionInput,
} from "./release-utils";
import assert from "node:assert/strict";

assert.equal(resolveReleaseVersion("2.9.0", "2.8.0"), "2.9.0");
assert.equal(resolveReleaseVersion("patch", "2.8.0"), "2.8.1");
assert.equal(resolveReleaseVersion("minor", "2.8.4"), "2.9.0");
assert.equal(resolveReleaseVersion("major", "2.8.4"), "3.0.0");

assert.throws(() => validateReleaseVersionInput("v2.9.0"), /Invalid release target/);
assert.throws(() => validateReleaseVersionInput("latest"), /Invalid release target/);

assert.equal(compareVersions("2.8.0", "2.8.0"), 0);
assert.ok(compareVersions("2.8.1", "2.8.0") > 0);
assert.ok(compareVersions("2.7.9", "2.8.0") < 0);

const changelog = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Features",
  "",
  "- Added one-command releases.",
  "",
  "## v2.8.0 (2026-08-10)",
  "",
  "- Previous release.",
  "",
].join("\n");

const prepared = prepareChangelog(changelog, "2.9.0", "2026-08-11");
assert.ok(prepared.includes("## Unreleased\n\n## v2.9.0 (2026-08-11)"));
assert.equal(
  extractChangelogContent(prepared, "2.9.0"),
  "### Features\n\n- Added one-command releases.",
);
assert.equal(prepareChangelog(prepared, "2.9.0", "2026-08-11"), prepared);

assert.throws(
  () =>
    prepareChangelog(
      "# Changelog\n\n## Unreleased\n\n## v2.8.0 (2026-08-10)\n\n- Previous.",
      "2.9.0",
      "2026-08-11",
    ),
  /is empty/,
);

console.log("✓ release utility tests passed");
