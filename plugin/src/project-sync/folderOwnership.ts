export const PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY = "projectSyncFolderOwnership";
export const PROJECT_SYNC_FOLDER_OWNERSHIP_SCHEMA_VERSION = 2;

export type ManagedFolderOwnerKind = "project" | "task";

export type ManagedFolderCreation = {
  mappingId: string;
  rootProjectId: string;
  ownerKind: ManagedFolderOwnerKind;
  ownerId: string;
  path: string;
};

export type ManagedFolderOwnership = ManagedFolderCreation & {
  /** Unique ID for this observed folder-creation event. */
  creationId: string;
  /** Monotonic generation for one mapping/path. A release removes every observed generation. */
  generation: number;
};

export type ManagedFolderPathTombstone = {
  mappingId: string;
  path: string;
  generation: number;
};

export type ProjectSyncFolderOwnershipRegistry = Readonly<{
  records: readonly ManagedFolderOwnership[];
  /** Removed or untrusted creation IDs are retained so an older device cannot restore them. */
  tombstones: readonly string[];
  /** Remove-wins generations prevent an unseen concurrent record for the same path resurfacing. */
  pathTombstones: readonly ManagedFolderPathTombstone[];
}>;

export type ProjectSyncFolderOwnershipOpaqueData = Readonly<{ value: unknown }>;

export type ProjectSyncFolderOwnershipReadResult = Readonly<{
  registry: ProjectSyncFolderOwnershipRegistry;
  status: "missing" | "valid" | "opaque";
  opaque?: ProjectSyncFolderOwnershipOpaqueData;
}>;

export interface ProjectSyncFolderOwnershipStorage {
  listOwnedFolders(mappingId: string): readonly ManagedFolderOwnership[];
  /** Call only for a folder that Tasks Bridge successfully created, never for a mapping root. */
  recordCreatedFolder(input: ManagedFolderCreation): Promise<void>;
  /** Batch variant that persists at most once. An empty batch retries a previously failed save. */
  recordCreatedFolders(inputs: readonly ManagedFolderCreation[]): Promise<void>;
  releaseOwnedFolderPath(mappingId: string, path: string): Promise<void>;
  /** Revokes every observed generation for the supplied portable paths. */
  releaseOwnedFolderPaths(mappingId: string, paths: readonly string[]): Promise<void>;
}

type StoredProjectSyncFolderOwnership = {
  version: typeof PROJECT_SYNC_FOLDER_OWNERSHIP_SCHEMA_VERSION;
  records: ManagedFolderOwnership[];
  tombstones: string[];
  pathTombstones: ManagedFolderPathTombstone[];
};

let fallbackCreationId = 0;

export const emptyProjectSyncFolderOwnershipRegistry = (): ProjectSyncFolderOwnershipRegistry => ({
  records: [],
  tombstones: [],
  pathTombstones: [],
});

export const cloneProjectSyncFolderOwnershipRegistry = (
  registry: ProjectSyncFolderOwnershipRegistry,
): ProjectSyncFolderOwnershipRegistry =>
  normalizeRegistry(registry.records, registry.tombstones, registry.pathTombstones);

export const decodeProjectSyncFolderOwnershipRegistry = (
  storedData: unknown,
): ProjectSyncFolderOwnershipReadResult => {
  if (!isRecord(storedData) || !(PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY in storedData)) {
    return { registry: emptyProjectSyncFolderOwnershipRegistry(), status: "missing" };
  }

  const stored = storedData[PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY];
  if (!isRecord(stored)) {
    return opaqueRead(stored);
  }

  if (stored.version === 1) {
    const legacy = parseStoredV1(stored);
    return legacy === null ? opaqueRead(stored) : { registry: legacy, status: "valid" };
  }
  if (stored.version !== PROJECT_SYNC_FOLDER_OWNERSHIP_SCHEMA_VERSION) {
    return opaqueRead(stored);
  }

  const current = parseStoredV2(stored);
  return current === null ? opaqueRead(stored) : { registry: current, status: "valid" };
};

export const readProjectSyncFolderOwnershipRegistry = (
  storedData: unknown,
): ProjectSyncFolderOwnershipRegistry =>
  decodeProjectSyncFolderOwnershipRegistry(storedData).registry;

export const withProjectSyncFolderOwnershipRegistry = (
  data: Record<string, unknown>,
  registry: ProjectSyncFolderOwnershipRegistry,
  opaque?: ProjectSyncFolderOwnershipOpaqueData,
): Record<string, unknown> => {
  const result = { ...data };
  if (opaque !== undefined) {
    result[PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY] = opaque.value;
    return result;
  }

  const normalized = normalizeRegistry(
    registry.records,
    registry.tombstones,
    registry.pathTombstones,
  );
  if (
    normalized.records.length === 0 &&
    normalized.tombstones.length === 0 &&
    normalized.pathTombstones.length === 0
  ) {
    delete result[PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY];
    return result;
  }
  result[PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY] = {
    version: PROJECT_SYNC_FOLDER_OWNERSHIP_SCHEMA_VERSION,
    records: normalized.records.map((record) => ({ ...record })),
    tombstones: [...normalized.tombstones],
    pathTombstones: normalized.pathTombstones.map((tombstone) => ({ ...tombstone })),
  } satisfies StoredProjectSyncFolderOwnership;
  return result;
};

export const mergeProjectSyncFolderOwnershipRegistries = (
  current: ProjectSyncFolderOwnershipRegistry,
  incoming: ProjectSyncFolderOwnershipRegistry,
): ProjectSyncFolderOwnershipRegistry =>
  makeSafeRegistry(
    [...current.records, ...incoming.records],
    [...current.tombstones, ...incoming.tombstones],
    [...current.pathTombstones, ...incoming.pathTombstones],
  );

export const listOwnedFolders = (
  registry: ProjectSyncFolderOwnershipRegistry,
  mappingId: string,
): ManagedFolderOwnership[] => {
  const normalizedMappingId = requireNonEmptyString(mappingId, "mappingId");
  return registry.records
    .filter((record) => record.mappingId === normalizedMappingId)
    .map((record) => ({ ...record }));
};

export const recordCreatedFolders = (
  registry: ProjectSyncFolderOwnershipRegistry,
  inputs: readonly ManagedFolderCreation[],
  createId: () => string = createFolderOwnershipId,
): ProjectSyncFolderOwnershipRegistry => {
  const normalizedRegistry = cloneProjectSyncFolderOwnershipRegistry(registry);
  const records = normalizedRegistry.records.map((record) => ({ ...record }));
  const tombstones = [...normalizedRegistry.tombstones];
  const pathTombstones = normalizedRegistry.pathTombstones.map((tombstone) => ({
    ...tombstone,
  }));
  const usedIds = new Set([...records.map((record) => record.creationId), ...tombstones]);

  for (const input of inputs) {
    const normalized = normalizeCreation(input);
    if (
      records.some(
        (record) =>
          record.mappingId === normalized.mappingId &&
          portablePathKey(record.path) === portablePathKey(normalized.path),
      )
    ) {
      continue;
    }

    let creationId = requireNonEmptyString(createId(), "creationId");
    while (usedIds.has(creationId)) {
      creationId = requireNonEmptyString(createId(), "creationId");
    }
    usedIds.add(creationId);
    const releasedGeneration = pathTombstones
      .filter((tombstone) => sameLogicalPath(tombstone, normalized.mappingId, normalized.path))
      .reduce((maximum, tombstone) => Math.max(maximum, tombstone.generation), 0);
    records.push({ creationId, generation: releasedGeneration + 1, ...normalized });
  }
  return makeSafeRegistry(records, tombstones, pathTombstones);
};

export const releaseOwnedFolderPaths = (
  registry: ProjectSyncFolderOwnershipRegistry,
  mappingId: string,
  paths: readonly string[],
): ProjectSyncFolderOwnershipRegistry => {
  const normalizedRegistry = cloneProjectSyncFolderOwnershipRegistry(registry);
  const normalizedMappingId = requireNonEmptyString(mappingId, "mappingId");
  const normalizedPaths = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    const key = portablePathKey(normalized);
    const current = normalizedPaths.get(key);
    if (current === undefined || compareStrings(normalized, current) < 0) {
      normalizedPaths.set(key, normalized);
    }
  }
  if (normalizedPaths.size === 0) {
    return normalizedRegistry;
  }

  const releasedIds = new Set(normalizedRegistry.tombstones);
  const pathTombstones = normalizedRegistry.pathTombstones.map((tombstone) => ({
    ...tombstone,
  }));
  let changed = false;
  for (const [pathKey, path] of normalizedPaths) {
    const matchingRecords = normalizedRegistry.records.filter(
      (record) =>
        record.mappingId === normalizedMappingId && portablePathKey(record.path) === pathKey,
    );
    const existingTombstones = pathTombstones.filter((tombstone) =>
      sameLogicalPath(tombstone, normalizedMappingId, path),
    );
    if (matchingRecords.length === 0 && existingTombstones.length === 0) {
      continue;
    }

    const releasedGeneration = Math.max(
      1,
      ...matchingRecords.map(({ generation }) => generation),
      ...existingTombstones.map(({ generation }) => generation),
    );
    for (const { creationId } of matchingRecords) {
      releasedIds.add(creationId);
    }
    pathTombstones.push({
      mappingId: normalizedMappingId,
      path,
      generation: releasedGeneration,
    });
    changed = true;
  }
  if (!changed) {
    return normalizedRegistry;
  }
  return makeSafeRegistry(normalizedRegistry.records, [...releasedIds], pathTombstones);
};

const parseStoredV1 = (
  stored: Record<string, unknown>,
): ProjectSyncFolderOwnershipRegistry | null => {
  if (!Array.isArray(stored.records) || !Array.isArray(stored.tombstones)) {
    return null;
  }
  const records: ManagedFolderOwnership[] = [];
  for (const candidate of stored.records) {
    const parsed = parseOwnership(candidate, 1);
    if (parsed === null) {
      return null;
    }
    records.push(parsed);
  }
  const tombstones = parseCreationIdTombstones(stored.tombstones);
  return tombstones === null ? null : makeSafeRegistry(records, tombstones, []);
};

const parseStoredV2 = (
  stored: Record<string, unknown>,
): ProjectSyncFolderOwnershipRegistry | null => {
  if (
    !Array.isArray(stored.records) ||
    !Array.isArray(stored.tombstones) ||
    !Array.isArray(stored.pathTombstones)
  ) {
    return null;
  }
  const records: ManagedFolderOwnership[] = [];
  for (const candidate of stored.records) {
    const parsed = parseOwnership(candidate);
    if (parsed === null) {
      return null;
    }
    records.push(parsed);
  }
  const tombstones = parseCreationIdTombstones(stored.tombstones);
  if (tombstones === null) {
    return null;
  }
  const pathTombstones: ManagedFolderPathTombstone[] = [];
  for (const candidate of stored.pathTombstones) {
    const parsed = parsePathTombstone(candidate);
    if (parsed === null) {
      return null;
    }
    pathTombstones.push(parsed);
  }
  return makeSafeRegistry(records, tombstones, pathTombstones);
};

const parseCreationIdTombstones = (values: readonly unknown[]): string[] | null => {
  const result: string[] = [];
  for (const candidate of values) {
    const parsed = readNonEmptyString(candidate);
    if (parsed === null) {
      return null;
    }
    result.push(parsed);
  }
  return result;
};

const opaqueRead = (value: unknown): ProjectSyncFolderOwnershipReadResult => ({
  registry: emptyProjectSyncFolderOwnershipRegistry(),
  status: "opaque",
  opaque: { value },
});

const createFolderOwnershipId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackCreationId++;
  return `folder-${Date.now()}-${fallbackCreationId}`;
};

const makeSafeRegistry = (
  records: readonly ManagedFolderOwnership[],
  tombstones: readonly string[],
  pathTombstones: readonly ManagedFolderPathTombstone[],
): ProjectSyncFolderOwnershipRegistry => {
  const removed = new Set(tombstones.map((value) => requireNonEmptyString(value, "tombstone")));
  const byId = new Map<string, ManagedFolderOwnership>();
  for (const candidate of records) {
    const record = normalizeOwnership(candidate);
    const current = byId.get(record.creationId);
    if (current !== undefined && !sameOwnership(current, record)) {
      // A creation ID must identify one immutable observation. Conflicting payloads are untrusted,
      // so revocation wins and neither path receives deletion authority.
      removed.add(record.creationId);
      byId.delete(record.creationId);
      continue;
    }
    if (!removed.has(record.creationId)) {
      byId.set(record.creationId, record);
    }
  }
  for (const creationId of removed) {
    byId.delete(creationId);
  }
  return normalizeRegistry([...byId.values()], [...removed], pathTombstones);
};

const normalizeRegistry = (
  records: readonly ManagedFolderOwnership[],
  tombstones: readonly string[],
  pathTombstones: readonly ManagedFolderPathTombstone[],
): ProjectSyncFolderOwnershipRegistry => {
  const uniqueTombstones = Array.from(
    new Set(tombstones.map((value) => requireNonEmptyString(value, "tombstone"))),
  ).sort(compareStrings);
  const removed = new Set(uniqueTombstones);
  const tombstonesByPath = new Map<string, ManagedFolderPathTombstone>();
  for (const candidate of pathTombstones) {
    const tombstone = normalizePathTombstone(candidate);
    const key = logicalPathKey(tombstone.mappingId, tombstone.path);
    const current = tombstonesByPath.get(key);
    if (
      current === undefined ||
      tombstone.generation > current.generation ||
      (tombstone.generation === current.generation &&
        compareStrings(tombstone.path, current.path) < 0)
    ) {
      tombstonesByPath.set(key, tombstone);
    }
  }

  const byId = new Map<string, ManagedFolderOwnership>();
  for (const candidate of records) {
    const record = normalizeOwnership(candidate);
    const releasedGeneration =
      tombstonesByPath.get(logicalPathKey(record.mappingId, record.path))?.generation ?? 0;
    if (
      !removed.has(record.creationId) &&
      record.generation > releasedGeneration &&
      !byId.has(record.creationId)
    ) {
      byId.set(record.creationId, record);
    }
  }
  const orderedRecords = [...byId.values()].sort(compareOwnership);
  const orderedPathTombstones = [...tombstonesByPath.values()].sort(comparePathTombstones);
  return {
    records: orderedRecords,
    tombstones: uniqueTombstones,
    pathTombstones: orderedPathTombstones,
  };
};

const parseOwnership = (
  value: unknown,
  legacyGeneration?: number,
): ManagedFolderOwnership | null => {
  if (!isRecord(value)) {
    return null;
  }
  const creationId = readNonEmptyString(value.creationId);
  const mappingId = readNonEmptyString(value.mappingId);
  const rootProjectId = readNonEmptyString(value.rootProjectId);
  const ownerKind =
    value.ownerKind === "project" || value.ownerKind === "task" ? value.ownerKind : null;
  const ownerId = readNonEmptyString(value.ownerId);
  const path = typeof value.path === "string" ? tryNormalizeVaultPath(value.path) : null;
  const generation =
    legacyGeneration ?? (isPositiveSafeInteger(value.generation) ? value.generation : null);
  return creationId === null ||
    mappingId === null ||
    rootProjectId === null ||
    ownerKind === null ||
    ownerId === null ||
    path === null ||
    generation === null
    ? null
    : { creationId, generation, mappingId, rootProjectId, ownerKind, ownerId, path };
};

const parsePathTombstone = (value: unknown): ManagedFolderPathTombstone | null => {
  if (!isRecord(value)) {
    return null;
  }
  const mappingId = readNonEmptyString(value.mappingId);
  const path = typeof value.path === "string" ? tryNormalizeVaultPath(value.path) : null;
  const generation = isPositiveSafeInteger(value.generation) ? value.generation : null;
  return mappingId === null || path === null || generation === null
    ? null
    : { mappingId, path, generation };
};

const normalizeOwnership = (record: ManagedFolderOwnership): ManagedFolderOwnership => ({
  creationId: requireNonEmptyString(record.creationId, "creationId"),
  generation: requirePositiveSafeInteger(record.generation, "generation"),
  ...normalizeCreation(record),
});

const normalizeCreation = (input: ManagedFolderCreation): ManagedFolderCreation => {
  if (input.ownerKind !== "project" && input.ownerKind !== "task") {
    throw new TypeError("ownerKind must be 'project' or 'task'");
  }
  return {
    mappingId: requireNonEmptyString(input.mappingId, "mappingId"),
    rootProjectId: requireNonEmptyString(input.rootProjectId, "rootProjectId"),
    ownerKind: input.ownerKind,
    ownerId: requireNonEmptyString(input.ownerId, "ownerId"),
    path: normalizeVaultPath(input.path),
  };
};

const normalizePathTombstone = (
  tombstone: ManagedFolderPathTombstone,
): ManagedFolderPathTombstone => ({
  mappingId: requireNonEmptyString(tombstone.mappingId, "mappingId"),
  path: normalizeVaultPath(tombstone.path),
  generation: requirePositiveSafeInteger(tombstone.generation, "generation"),
});

const tryNormalizeVaultPath = (value: string): string | null => {
  try {
    return normalizeVaultPath(value);
  } catch {
    return null;
  }
};

const normalizeVaultPath = (value: string): string => {
  const raw = value.trim().split("\\").join("/");
  if (
    raw === "" ||
    raw === "/" ||
    raw.startsWith("/") ||
    raw.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("Managed folder ownership requires a safe Vault-relative path");
  }
  const normalized = raw
    .split("/")
    .filter((segment) => segment !== "")
    .join("/")
    .normalize("NFC");
  if (normalized === "") {
    throw new TypeError("Managed folder ownership requires a safe Vault-relative path");
  }
  return normalized;
};

const portablePathKey = (path: string): string =>
  normalizeVaultPath(path).normalize("NFC").toLocaleLowerCase("en-US");

const logicalPathKey = (mappingId: string, path: string): string =>
  `${mappingId}\u0000${portablePathKey(path)}`;

const sameLogicalPath = (
  tombstone: ManagedFolderPathTombstone,
  mappingId: string,
  path: string,
): boolean =>
  logicalPathKey(tombstone.mappingId, tombstone.path) === logicalPathKey(mappingId, path);

const sameCreation = (record: ManagedFolderOwnership, creation: ManagedFolderCreation): boolean =>
  record.mappingId === creation.mappingId &&
  record.rootProjectId === creation.rootProjectId &&
  record.ownerKind === creation.ownerKind &&
  record.ownerId === creation.ownerId &&
  portablePathKey(record.path) === portablePathKey(creation.path);

const sameOwnership = (left: ManagedFolderOwnership, right: ManagedFolderOwnership): boolean =>
  left.creationId === right.creationId &&
  left.generation === right.generation &&
  sameCreation(left, right) &&
  left.path === right.path;

const compareOwnership = (left: ManagedFolderOwnership, right: ManagedFolderOwnership): number => {
  for (const comparison of [
    compareStrings(left.mappingId, right.mappingId),
    compareStrings(portablePathKey(left.path), portablePathKey(right.path)),
    compareNumbers(left.generation, right.generation),
    compareStrings(left.path, right.path),
    compareStrings(left.ownerKind, right.ownerKind),
    compareStrings(left.ownerId, right.ownerId),
    compareStrings(left.creationId, right.creationId),
  ]) {
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const comparePathTombstones = (
  left: ManagedFolderPathTombstone,
  right: ManagedFolderPathTombstone,
): number => {
  for (const comparison of [
    compareStrings(left.mappingId, right.mappingId),
    compareStrings(portablePathKey(left.path), portablePathKey(right.path)),
    compareNumbers(left.generation, right.generation),
    compareStrings(left.path, right.path),
  ]) {
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const compareStrings = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const compareNumbers = (left: number, right: number): number => left - right;

const requireNonEmptyString = (value: unknown, field: string): string => {
  const parsed = readNonEmptyString(value);
  if (parsed === null) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return parsed;
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const requirePositiveSafeInteger = (value: unknown, field: string): number => {
  if (!isPositiveSafeInteger(value)) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
