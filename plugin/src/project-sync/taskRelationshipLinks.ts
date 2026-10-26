import type { TFile } from "obsidian";

export type TaskRelationshipLinkResolver = (linkpath: string, sourcePath: string) => TFile | null;

type TaskRelationshipLink = { path: string; label: string };

const readTaskRelationshipLink = (value: unknown): TaskRelationshipLink | null => {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) {
    return null;
  }
  const wiki = value.match(/^\[\[([^|[\]#]+)(?:\|([^[\]]*))?\]\]$/u);
  if (wiki !== null) {
    return { path: wiki[1], label: wiki[2] ?? wiki[1].split("/").pop() ?? "" };
  }
  const boundary = value.lastIndexOf("](");
  if (!value.startsWith("[") || !value.endsWith(")") || boundary < 1) {
    return null;
  }
  const destination = value.slice(boundary + 2, -1);
  // A hierarchy property links to the whole local note, never an external URL or a heading.
  if (destination === "" || /[\s#]/u.test(destination)) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(destination);
  } catch {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(path)) {
    return null;
  }
  return {
    path,
    label: value.slice(1, boundary).replace(/\\([[\]\\])/gu, "$1"),
  };
};

/** Keep a valid existing link when another device prefers a different link representation. */
export const preserveTaskRelationshipLink = (
  current: unknown,
  target: TFile,
  sourcePath: string,
  label: string,
  generate: () => string,
  resolve: TaskRelationshipLinkResolver | undefined,
): string => {
  if (resolve !== undefined && typeof current === "string") {
    const existing = readTaskRelationshipLink(current);
    if (
      existing !== null &&
      existing.label === label &&
      resolve(existing.path, sourcePath) === target
    ) {
      return current;
    }
  }
  return generate();
};
