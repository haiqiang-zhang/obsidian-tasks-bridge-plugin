import { todoistTimestampSchema } from "@/api/domain/task";

/**
 * Format an authoritative Todoist creation timestamp for stable, readable disambiguation.
 *
 * Todoist timestamps are normalized to UTC so equivalent offsets produce the same marker. The
 * Unix epoch is reserved by the adapter as the sentinel for an unknown creation time and must not
 * be shown to users as real task metadata.
 */
export const makeCreationTimeMarker = (
  createdAt: string | null | undefined,
): string | undefined => {
  if (createdAt === null || createdAt === undefined) {
    return undefined;
  }
  if (!todoistTimestampSchema.safeParse(createdAt).success) {
    return undefined;
  }
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  const iso = new Date(timestamp).toISOString();
  const normalizedParts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{3})Z$/u.exec(iso);
  if (normalizedParts === null) {
    return undefined;
  }
  const [, date, rawTime, milliseconds] = normalizedParts;
  const time = rawTime?.replace(/:/g, ".");
  if (date === undefined || time === undefined || milliseconds === undefined) {
    return undefined;
  }
  return `${date} ${time}${milliseconds === "000" ? "" : `.${milliseconds}`}Z`;
};
