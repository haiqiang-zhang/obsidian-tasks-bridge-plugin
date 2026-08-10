import type { Project } from "@/api/domain/project";

const DEFAULT_PROJECT_SEGMENT_BYTES = 96;
const DEFAULT_TASK_FILENAME_BYTES = 200;
const LAST_C0_CONTROL_CODE_POINT = 31;
const DELETE_CONTROL_CODE_POINT = 127;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_VISIBLE_PATH_CHARACTERS = new Set('<>:"/\\|?*');

const replaceInvalidPathCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= LAST_C0_CONTROL_CODE_POINT ||
      codePoint === DELETE_CONTROL_CODE_POINT ||
      INVALID_VISIBLE_PATH_CHARACTERS.has(character)
      ? "-"
      : character;
  }).join("");

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;
const portableNameKey = (value: string): string => value.toLocaleLowerCase("en-US");

export const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return "";
  }
  if (utf8Length(value) <= maxBytes) {
    return value;
  }

  let result = "";
  for (const character of value) {
    if (utf8Length(result + character) > maxBytes) {
      break;
    }
    result += character;
  }
  return result;
};

export const sanitizePathSegment = (
  value: string,
  fallback: string,
  maxBytes = DEFAULT_PROJECT_SEGMENT_BYTES,
): string => {
  let sanitized = replaceInvalidPathCharacters(value.normalize("NFC"))
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");

  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    sanitized = fallback;
  }
  if (WINDOWS_RESERVED_NAME.test(sanitized)) {
    sanitized = `${sanitized}-item`;
  }

  sanitized = truncateUtf8(sanitized, maxBytes).replace(/[. ]+$/g, "");
  return sanitized === "" ? truncateUtf8(fallback, maxBytes) : sanitized;
};

export const makeTaskFilename = (content: string, collisionIndex = 1): string => {
  const normalizedCollisionIndex = Number.isFinite(collisionIndex)
    ? Math.max(1, Math.floor(collisionIndex))
    : 1;
  const suffix = normalizedCollisionIndex === 1 ? ".md" : ` (${normalizedCollisionIndex}).md`;
  const availableBytes = Math.max(1, DEFAULT_TASK_FILENAME_BYTES - utf8Length(suffix));
  const stem = sanitizePathSegment(content, "Untitled task", availableBytes);
  return `${stem}${suffix}`;
};

export const makeDisambiguatedProjectSegment = (
  segment: string,
  projectId: string,
  collisionIndex?: number,
): string => {
  const collisionSuffix = collisionIndex === undefined ? "" : ` (${collisionIndex})`;
  const fixedSuffix = ` -- ${collisionSuffix}`;
  const idBudget = Math.max(1, DEFAULT_PROJECT_SEGMENT_BYTES - utf8Length(fixedSuffix) - 1);
  const id = sanitizePathSegment(projectId, "unknown-project", idBudget);
  const suffix = ` -- ${id}${collisionSuffix}`;
  const stem = truncateUtf8(
    segment,
    Math.max(1, DEFAULT_PROJECT_SEGMENT_BYTES - utf8Length(suffix)),
  );
  return `${stem}${suffix}`;
};

export const makeProjectSegments = (projects: Project[]): Map<string, string> => {
  const siblingNames = new Map<string, Map<string, number>>();

  for (const project of projects) {
    const parentKey = project.parentId ?? "<root>";
    const segment = sanitizePathSegment(project.name, "Untitled project");
    const counts = siblingNames.get(parentKey) ?? new Map<string, number>();
    const nameKey = portableNameKey(segment);
    counts.set(nameKey, (counts.get(nameKey) ?? 0) + 1);
    siblingNames.set(parentKey, counts);
  }

  return new Map(
    projects.map((project) => {
      const segment = sanitizePathSegment(project.name, "Untitled project");
      const duplicateCount =
        siblingNames.get(project.parentId ?? "<root>")?.get(portableNameKey(segment)) ?? 0;
      if (duplicateCount <= 1) {
        return [project.id, segment];
      }

      return [project.id, makeDisambiguatedProjectSegment(segment, project.id)];
    }),
  );
};

export const isPathInside = (root: string, candidate: string): boolean => {
  return candidate === root || candidate.startsWith(`${root}/`);
};
