import { describe, expect, it } from "vitest";

import {
  cloneProjectSyncFolderOwnershipRegistry,
  decodeProjectSyncFolderOwnershipRegistry,
  emptyProjectSyncFolderOwnershipRegistry,
  listOwnedFolders,
  type ManagedFolderCreation,
  mergeProjectSyncFolderOwnershipRegistries,
  PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY,
  type ProjectSyncFolderOwnershipRegistry,
  readProjectSyncFolderOwnershipRegistry,
  recordCreatedFolders,
  releaseOwnedFolderPaths,
  relocateOwnedFolders,
  withProjectSyncFolderOwnershipRegistry,
} from "./folderOwnership";

const projectFolder = (
  path: string,
  overrides: Partial<ManagedFolderCreation> = {},
): ManagedFolderCreation => ({
  mappingId: "mapping-root",
  rootProjectId: "root",
  ownerKind: "project",
  ownerId: "project-child",
  path,
  ...overrides,
});

const ids = (...values: string[]): (() => string) => {
  const remaining = [...values];
  return () => {
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error("Test creation ID sequence exhausted");
    }
    return next;
  };
};

describe("Project Sync folder ownership registry", () => {
  it.each([
    ["missing data", {}],
    ["an old schema", { [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: { version: 0 } }],
    ["a malformed container", { [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: [] }],
    [
      "a malformed record",
      {
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
          version: 1,
          records: [{ creationId: "created-a", mappingId: "mapping-root" }],
          tombstones: [],
        },
      },
    ],
    [
      "an unsafe path",
      {
        [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
          version: 1,
          records: [
            {
              creationId: "created-a",
              mappingId: "mapping-root",
              rootProjectId: "root",
              ownerKind: "project",
              ownerId: "project-child",
              path: "../Outside",
            },
          ],
          tombstones: [],
        },
      },
    ],
  ])("loads %s as an empty, non-authoritative registry", (_label, stored) => {
    expect(readProjectSyncFolderOwnershipRegistry(stored)).toEqual({
      records: [],
      tombstones: [],
      pathTombstones: [],
    });
  });

  it("records only explicit creation observations and deduplicates retries", () => {
    const registry = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [
        projectFolder("Task Projects/Root/Child"),
        projectFolder("task projects/root/child"),
        projectFolder("Task Projects/Root/Parent", {
          ownerKind: "task",
          ownerId: "task-parent",
        }),
      ],
      ids("created-child", "created-parent"),
    );

    expect(registry.records).toEqual([
      {
        creationId: "created-child",
        generation: 1,
        ...projectFolder("Task Projects/Root/Child"),
      },
      {
        creationId: "created-parent",
        generation: 1,
        ...projectFolder("Task Projects/Root/Parent", {
          ownerKind: "task",
          ownerId: "task-parent",
        }),
      },
    ]);
    expect(registry.tombstones).toEqual([]);
    expect(registry.pathTombstones).toEqual([]);
  });

  it("serializes deterministically and returns defensive clones", () => {
    const registry = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [
        projectFolder("Task Projects/Z", { ownerId: "z" }),
        projectFolder("Task Projects/A", { ownerId: "a" }),
      ],
      ids("created-z", "created-a"),
    );
    const cloned = cloneProjectSyncFolderOwnershipRegistry(registry);
    const listed = listOwnedFolders(cloned, "mapping-root");
    listed[0].path = "Mutated by caller";

    expect(cloned).toEqual(registry);
    expect(registry.records.map(({ path }) => path)).toEqual([
      "Task Projects/A",
      "Task Projects/Z",
    ]);
    expect(withProjectSyncFolderOwnershipRegistry({ setting: true }, registry)).toEqual({
      setting: true,
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 2,
        records: registry.records,
        tombstones: [],
        pathTombstones: [],
      },
    });
  });

  it("round-trips active records and tombstones through plugin data", () => {
    const created = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [
        projectFolder("Task Projects/Root/Child"),
        projectFolder("Task Projects/Root/Parent", {
          ownerKind: "task",
          ownerId: "task-parent",
        }),
      ],
      ids("created-child", "created-parent"),
    );
    const released = releaseOwnedFolderPaths(created, "mapping-root", ["Task Projects/Root/Child"]);
    const stored = withProjectSyncFolderOwnershipRegistry({}, released);

    expect(readProjectSyncFolderOwnershipRegistry(stored)).toEqual(released);
    expect(released).toEqual({
      records: [
        {
          creationId: "created-parent",
          generation: 1,
          ...projectFolder("Task Projects/Root/Parent", {
            ownerKind: "task",
            ownerId: "task-parent",
          }),
        },
      ],
      tombstones: ["created-child"],
      pathTombstones: [
        {
          mappingId: "mapping-root",
          path: "Task Projects/Root/Child",
          generation: 1,
        },
      ],
    });
  });

  it("releases all creation observations for one portable path and mapping only", () => {
    const initial: ProjectSyncFolderOwnershipRegistry = {
      records: [
        { creationId: "created-a", generation: 1, ...projectFolder("Task Projects/Café") },
        {
          creationId: "created-b",
          generation: 1,
          ...projectFolder("Task Projects/Cafe\u0301", { ownerId: "another-owner" }),
        },
        {
          creationId: "created-other-mapping",
          generation: 1,
          ...projectFolder("Task Projects/Café", { mappingId: "mapping-other" }),
        },
      ],
      tombstones: [],
      pathTombstones: [],
    };

    const released = releaseOwnedFolderPaths(initial, "mapping-root", ["task projects/café"]);

    expect(released.records).toEqual([
      expect.objectContaining({ creationId: "created-other-mapping" }),
    ]);
    expect(released.tombstones).toEqual(["created-a", "created-b"]);
    expect(released.pathTombstones).toEqual([
      {
        mappingId: "mapping-root",
        path: "task projects/café",
        generation: 1,
      },
    ]);
  });

  it("merges concurrent creations while deletion wins over a stale device", () => {
    const base = emptyProjectSyncFolderOwnershipRegistry();
    const deviceA = recordCreatedFolders(
      base,
      [projectFolder("Task Projects/A", { ownerId: "a" })],
      ids("created-a"),
    );
    const deviceB = recordCreatedFolders(
      base,
      [projectFolder("Task Projects/B", { ownerId: "b" })],
      ids("created-b"),
    );
    const merged = mergeProjectSyncFolderOwnershipRegistries(deviceA, deviceB);
    const deletedOnCurrentDevice = releaseOwnedFolderPaths(merged, "mapping-root", [
      "Task Projects/A",
    ]);
    const staleDeviceReturns = mergeProjectSyncFolderOwnershipRegistries(
      deletedOnCurrentDevice,
      deviceA,
    );

    expect(staleDeviceReturns.records).toEqual([
      expect.objectContaining({ creationId: "created-b", path: "Task Projects/B" }),
    ]);
    expect(staleDeviceReturns.tombstones).toEqual(["created-a"]);
    expect(staleDeviceReturns.pathTombstones).toEqual([
      { mappingId: "mapping-root", path: "Task Projects/A", generation: 1 },
    ]);
  });

  it("uses remove-wins generations for unseen concurrent records of one path", () => {
    const base = emptyProjectSyncFolderOwnershipRegistry();
    const deviceA = recordCreatedFolders(
      base,
      [projectFolder("Task Projects/Shared")],
      ids("created-a"),
    );
    const deviceB = recordCreatedFolders(
      base,
      [projectFolder("task projects/shared")],
      ids("created-b"),
    );

    const releasedOnA = releaseOwnedFolderPaths(deviceA, "mapping-root", ["Task Projects/Shared"]);
    const merged = mergeProjectSyncFolderOwnershipRegistries(releasedOnA, deviceB);

    expect(merged.records).toEqual([]);
    expect(merged.tombstones).toEqual(["created-a"]);
    expect(merged.pathTombstones).toEqual([
      { mappingId: "mapping-root", path: "Task Projects/Shared", generation: 1 },
    ]);

    const recreated = recordCreatedFolders(
      merged,
      [projectFolder("Task Projects/Shared")],
      ids("created-next"),
    );
    expect(recreated.records).toEqual([
      expect.objectContaining({ creationId: "created-next", generation: 2 }),
    ]);
  });

  it("relocates exact casing with a newer generation so stale devices cannot restore it", () => {
    const lowercase = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [projectFolder("Task Projects/Root/logistics")],
      ids("created-lowercase"),
    );
    const ownership = lowercase.records[0];
    if (ownership === undefined) {
      throw new Error("Expected an owned folder");
    }

    const canonical = relocateOwnedFolders(
      lowercase,
      [{ ownership, path: "Task Projects/Root/Logistics" }],
      ids("created-canonical"),
    );
    const staleDeviceReturns = mergeProjectSyncFolderOwnershipRegistries(canonical, lowercase);

    expect(canonical.records).toEqual([
      {
        creationId: "created-canonical",
        generation: 2,
        ...projectFolder("Task Projects/Root/Logistics"),
      },
    ]);
    expect(canonical.tombstones).toEqual(["created-lowercase"]);
    expect(canonical.pathTombstones).toEqual([
      {
        mappingId: "mapping-root",
        path: "Task Projects/Root/logistics",
        generation: 1,
      },
    ]);
    expect(staleDeviceReturns).toEqual(canonical);
  });

  it("rejects a relocation that changes the portable folder path", () => {
    const registry = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [projectFolder("Task Projects/Root/Logistics")],
      ids("created-logistics"),
    );
    const ownership = registry.records[0];
    if (ownership === undefined) {
      throw new Error("Expected an owned folder");
    }

    expect(() =>
      relocateOwnedFolders(registry, [{ ownership, path: "Task Projects/Root/Shipping" }]),
    ).toThrow("preserve the portable Vault path");
    expect(registry.records[0]?.path).toBe("Task Projects/Root/Logistics");
  });

  it("tombstones a creation ID with conflicting immutable ownership", () => {
    const left = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [projectFolder("Task Projects/A", { ownerId: "a" })],
      ids("same-creation"),
    );
    const right = recordCreatedFolders(
      emptyProjectSyncFolderOwnershipRegistry(),
      [projectFolder("Task Projects/B", { ownerId: "b" })],
      ids("same-creation"),
    );

    expect(mergeProjectSyncFolderOwnershipRegistries(left, right)).toEqual({
      records: [],
      tombstones: ["same-creation"],
      pathTombstones: [],
    });
  });

  it("migrates a valid v1 ledger but preserves malformed or future data opaquely", () => {
    const legacyData = {
      [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: {
        version: 1,
        records: [
          {
            creationId: "legacy-created",
            ...projectFolder("Task Projects/Legacy"),
          },
        ],
        tombstones: ["legacy-released"],
      },
    };
    const migrated = decodeProjectSyncFolderOwnershipRegistry(legacyData);
    expect(migrated.status).toBe("valid");
    expect(migrated.registry).toEqual({
      records: [expect.objectContaining({ creationId: "legacy-created", generation: 1 })],
      tombstones: ["legacy-released"],
      pathTombstones: [],
    });

    for (const opaqueValue of [
      { version: 9, records: [], tombstones: ["future-revocation"] },
      {
        version: 2,
        records: [{ creationId: "broken" }],
        tombstones: ["must-not-be-erased"],
        pathTombstones: [],
      },
    ]) {
      const stored = { [PROJECT_SYNC_FOLDER_OWNERSHIP_DATA_KEY]: opaqueValue };
      const decoded = decodeProjectSyncFolderOwnershipRegistry(stored);
      expect(decoded.status).toBe("opaque");
      expect(decoded.registry).toEqual(emptyProjectSyncFolderOwnershipRegistry());
      expect(withProjectSyncFolderOwnershipRegistry({}, decoded.registry, decoded.opaque)).toEqual(
        stored,
      );
    }
  });

  it("rejects unsafe write inputs without changing the registry", () => {
    const registry = emptyProjectSyncFolderOwnershipRegistry();

    expect(() =>
      recordCreatedFolders(registry, [projectFolder("Task Projects/../Outside")]),
    ).toThrow("safe Vault-relative path");
    expect(() => releaseOwnedFolderPaths(registry, "mapping-root", ["/Absolute"])).toThrow(
      "safe Vault-relative path",
    );
    expect(registry).toEqual({ records: [], tombstones: [], pathTombstones: [] });
  });
});
