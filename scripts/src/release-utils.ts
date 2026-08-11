const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

type VersionParts = readonly [major: number, minor: number, patch: number];

export type ReleaseVersionInput = "major" | "minor" | "patch" | string;

export function validateReleaseVersionInput(input: ReleaseVersionInput): void {
  if (VERSION_PATTERN.test(input) || input === "major" || input === "minor" || input === "patch") {
    return;
  }

  throw new Error(`Invalid release target: ${input}. Expected x.y.z, major, minor, or patch.`);
}

export function parseVersion(version: string): VersionParts {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version format: ${version}. Expected x.y.z, major, minor, or patch.`);
  }

  return version.split(".").map(Number) as unknown as VersionParts;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function resolveReleaseVersion(input: ReleaseVersionInput, currentVersion: string): string {
  validateReleaseVersionInput(input);
  if (VERSION_PATTERN.test(input)) {
    return input;
  }

  const [major, minor, patch] = parseVersion(currentVersion);
  switch (input) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unsupported release target: ${input}`);
  }
}

export function prepareChangelog(changelog: string, version: string, releaseDate: string): string {
  parseVersion(version);

  if (changelog.includes(`## v${version} (`)) {
    return changelog;
  }

  const marker = "## Unreleased";
  const markerIndex = changelog.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error('Could not find the "## Unreleased" changelog section.');
  }

  const contentStart = markerIndex + marker.length;
  const nextReleaseIndex = changelog.indexOf("\n## v", contentStart);
  const contentEnd = nextReleaseIndex < 0 ? changelog.length : nextReleaseIndex;
  const unreleasedContent = changelog.slice(contentStart, contentEnd).trim();

  if (unreleasedContent.length === 0) {
    throw new Error(
      'The "## Unreleased" changelog section is empty. Add user-visible release notes before releasing.',
    );
  }

  const prefix = changelog.slice(0, contentStart).trimEnd();
  const suffix = changelog.slice(contentEnd).trimStart();
  const releasedSection = `## v${version} (${releaseDate})\n\n${unreleasedContent}`;

  return suffix.length > 0
    ? `${prefix}\n\n${releasedSection}\n\n${suffix}`
    : `${prefix}\n\n${releasedSection}\n`;
}

export function extractChangelogContent(changelog: string, version: string): string {
  parseVersion(version);
  const escapedVersion = version.replace(/\./g, "\\.");
  const match = changelog.match(
    new RegExp(`## v${escapedVersion} \\([^)]+\\)([\\s\\S]*?)(?=\\n## v|$)`),
  );

  if (!match) {
    throw new Error(`Could not find changelog content for version ${version}.`);
  }

  const content = match[1].trim();
  if (content.length === 0) {
    throw new Error(`The changelog content for version ${version} is empty.`);
  }

  return content;
}
