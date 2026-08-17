const DEFAULT_PROJECT_SEGMENT_BYTES = 96;
const DEFAULT_TASK_FOLDER_SEGMENT_BYTES = 96;
const DEFAULT_TASK_FILENAME_BYTES = 200;
const LAST_C0_CONTROL_CODE_POINT = 31;
const DELETE_CONTROL_CODE_POINT = 127;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_VISIBLE_PATH_CHARACTERS = new Set('<>:"/\\|?*');
const IDENTITY_MARKER_SEPARATOR = " · ";

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

const makeIdentityMarkedSegment = (
  value: string,
  fallback: string,
  maxBytes: number,
  identityMarker?: string,
): string => {
  if (identityMarker === undefined) {
    return sanitizePathSegment(value, fallback, maxBytes);
  }

  const markerBudget = Math.max(
    1,
    maxBytes - utf8Length(IDENTITY_MARKER_SEPARATOR) - utf8Length("x"),
  );
  const marker = sanitizePathSegment(identityMarker, "item", markerBudget);
  const suffix = `${IDENTITY_MARKER_SEPARATOR}${marker}`;
  const stem = sanitizePathSegment(value, fallback, Math.max(1, maxBytes - utf8Length(suffix)));
  return `${stem}${suffix}`;
};

export const makeProjectFolderSegment = (name: string, identityMarker?: string): string =>
  makeIdentityMarkedSegment(
    name,
    "Untitled project",
    DEFAULT_PROJECT_SEGMENT_BYTES,
    identityMarker,
  );

export const makeTaskFilename = (content: string, identityMarker?: string): string => {
  const suffix = ".md";
  const availableBytes = Math.max(1, DEFAULT_TASK_FILENAME_BYTES - utf8Length(suffix));
  const stem = makeIdentityMarkedSegment(content, "Untitled task", availableBytes, identityMarker);
  return `${stem}${suffix}`;
};

export const makeTaskFolderSegment = (content: string, identityMarker?: string): string =>
  makeIdentityMarkedSegment(
    content,
    "Untitled task",
    DEFAULT_TASK_FOLDER_SEGMENT_BYTES,
    identityMarker,
  );

export const isPathInside = (root: string, candidate: string): boolean => {
  return candidate === root || candidate.startsWith(`${root}/`);
};
