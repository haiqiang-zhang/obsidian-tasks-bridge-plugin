import type { App, EventRef } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OBSIDIAN_SYNC_SETTLE_MS,
  ObsidianSyncActivityGate,
  observeSyncPhase,
} from "./obsidianSyncGate";

type MutableSyncInstance = {
  dataLoaded: boolean;
  getStatus: () => string;
  gettingServer: unknown;
  initial: boolean;
  initialized: boolean;
  newServerFiles: unknown[];
  off: (name: string, listener: () => void) => void;
  on: (name: string, listener: () => void) => EventRef;
  pause: boolean;
  ready: boolean;
  syncStatus: string;
};

const makeSyncHarness = (
  overrides: Partial<Omit<MutableSyncInstance, "getStatus" | "off" | "on">> & {
    coreStatus?: string;
  } = {},
) => {
  const listeners = new Set<() => void>();
  let coreStatus = overrides.coreStatus ?? "syncing";
  const eventRef = {} as EventRef;
  const instance: MutableSyncInstance = {
    dataLoaded: true,
    getStatus: () => coreStatus,
    gettingServer: null,
    initial: false,
    initialized: true,
    newServerFiles: [],
    off: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)),
    on: vi.fn((_name: string, listener: () => void) => {
      listeners.add(listener);
      return eventRef;
    }),
    pause: false,
    ready: true,
    syncStatus: "Fully synced",
    ...overrides,
  };
  const internalPlugins = {
    getEnabledPluginById: vi.fn(() => instance),
  };
  const app = { internalPlugins } as unknown as App;

  return {
    app,
    emitStatusChange: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    eventRef,
    instance,
    setCoreStatus: (status: string) => {
      coreStatus = status;
    },
  };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("observeSyncPhase", () => {
  it("treats Fully synced as idle even while the coarse engine status remains syncing", () => {
    const { instance } = makeSyncHarness({
      coreStatus: "syncing",
      newServerFiles: [],
      syncStatus: "Fully synced",
    });

    expect(observeSyncPhase(instance)).toBe("idle");
  });

  it.each([
    "Uploading Tasks/Work.md",
    "Comparing Tasks/Work.md",
    "Deleting remote file Tasks/Work.md",
    "Deleting remote folder Tasks/Work",
  ])("allows an upload-only phase: %s", (syncStatus) => {
    const { instance } = makeSyncHarness({ syncStatus });

    expect(observeSyncPhase(instance)).toBe("outbound");
  });

  it.each([
    "Downloading Tasks/Work.md",
    "Deleting Tasks/Work.md",
    "Merging Tasks/Work.md",
    "Renaming conflicted file Tasks/Work.md",
  ])("blocks a known incoming phase: %s", (syncStatus) => {
    const { instance } = makeSyncHarness({ syncStatus });

    expect(observeSyncPhase(instance)).toBe("inbound");
  });

  it("gives the incoming queue priority over an upload status", () => {
    const { instance } = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Remote.md" }],
      syncStatus: "Uploading Tasks/Local.md",
    });

    expect(observeSyncPhase(instance)).toBe("inbound");
  });

  it("gives a known incoming detail priority over a stale coarse synced status", () => {
    const { instance } = makeSyncHarness({
      coreStatus: "synced",
      syncStatus: "Downloading Tasks/Remote.md",
    });

    expect(observeSyncPhase(instance)).toBe("inbound");
  });

  it.each([
    "Indexing...",
    "Initializing...",
    "Computing hash Tasks/Work.md",
  ])("waits for direction during a transient phase: %s", (syncStatus) => {
    const { instance } = makeSyncHarness({ syncStatus });

    expect(observeSyncPhase(instance)).toBe("indeterminate");
  });

  it("does not block indefinitely while Sync is only connecting", () => {
    const { instance } = makeSyncHarness({ syncStatus: "Connecting to server" });

    expect(observeSyncPhase(instance)).toBe("preparing");
  });

  it.each([
    "paused",
    "error",
    "disconnected",
    "uninitialized",
  ])("does not block an inactive Sync engine with an empty inbound queue: %s", (coreStatus) => {
    const { instance } = makeSyncHarness({ coreStatus, syncStatus: "" });

    expect(observeSyncPhase(instance)).toBe("inactive");
  });

  it("fails open when the private Sync surface is missing or only exposes coarse status", () => {
    expect(observeSyncPhase(undefined)).toBe("unavailable");
    expect(observeSyncPhase({ getStatus: () => "syncing" })).toBe("unavailable");
    expect(observeSyncPhase({ getStatus: () => "unknown", newServerFiles: undefined })).toBe(
      "unavailable",
    );
  });

  it("uses coarse syncing only when the incoming queue surface is valid", () => {
    expect(
      observeSyncPhase({
        getStatus: () => "syncing",
        newServerFiles: [],
      }),
    ).toBe("indeterminate");
    expect(
      observeSyncPhase({
        getStatus: () => "syncing",
        newServerFiles: { length: "invalid" },
      }),
    ).toBe("unavailable");
  });
});

describe("ObsidianSyncActivityGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers and detaches the private status-change listener", () => {
    const harness = makeSyncHarness();
    const registerEvent = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app);

    gate.start(registerEvent);

    expect(harness.instance.on).toHaveBeenCalledWith("status-change", expect.any(Function));
    expect(registerEvent).toHaveBeenCalledWith(harness.eventRef);

    gate.dispose();
    expect(harness.instance.off).toHaveBeenCalledWith("status-change", expect.any(Function));
  });

  it("does not defer a pure local upload", async () => {
    const harness = makeSyncHarness({ syncStatus: "Uploading Tasks/Local.md" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toEqual({ inboundGeneration: 0 });
  });

  it("does not defer a persistent connection attempt", async () => {
    const harness = makeSyncHarness({ syncStatus: "Connecting to server" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toEqual({ inboundGeneration: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["missing", {}],
    [
      "disabled",
      {
        internalPlugins: {
          getEnabledPluginById: (): undefined => undefined,
          getPluginById: () => ({
            enabled: false,
            instance: { getStatus: () => "syncing" },
          }),
        },
      },
    ],
    [
      "disabled direct descriptor",
      {
        internalPlugins: {
          getEnabledPluginById: () => ({
            enabled: false,
            syncStatus: "Downloading Tasks/Remote.md",
          }),
        },
      },
    ],
    [
      "malformed",
      {
        internalPlugins: {
          getEnabledPluginById: (): { getStatus: () => string } => ({
            getStatus: () => "syncing",
          }),
        },
      },
    ],
  ])("fails open for a %s private Sync API", async (_label, appShape) => {
    const gate = new ObsidianSyncActivityGate(appShape as unknown as App);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toEqual({ inboundGeneration: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits through the complete incoming cycle and a short settle window", async () => {
    const harness = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Remote.md" }],
      syncStatus: "Downloading Tasks/Remote.md",
    });
    const onInbound = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app, { onInbound });
    gate.start(vi.fn());
    let permit: unknown;
    void gate.waitForSafePermit().then((value) => {
      permit = value;
    });

    expect(onInbound).toHaveBeenCalledOnce();
    expect(permit).toBeUndefined();

    harness.instance.newServerFiles = [];
    harness.instance.syncStatus = "Uploading Tasks/Local.md";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS * 2);
    expect(permit).toBeUndefined();

    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(permit).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(permit).toEqual({ inboundGeneration: 1 });
  });

  it("releases an indeterminate upload-only cycle as soon as its direction is known", async () => {
    const harness = makeSyncHarness({ syncStatus: "Indexing..." });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    let permit: unknown;
    void gate.waitForSafePermit().then((value) => {
      permit = value;
    });

    harness.instance.syncStatus = "Uploading Tasks/Local.md";
    harness.emitStatusChange();
    await flushPromises();

    expect(permit).toEqual({ inboundGeneration: 0 });
  });

  it("polls the inbound queue while an automatic operation is active", async () => {
    const harness = makeSyncHarness({ syncStatus: "Uploading Tasks/Local.md" });
    const onInbound = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app, { onInbound });
    gate.start(vi.fn());
    const permit = await gate.waitForSafePermit();
    expect(permit).not.toBeNull();
    if (permit === null) {
      throw new Error("Expected an initial Sync permit");
    }
    let finishOperation: (() => void) | undefined;
    const operation = gate.monitor(
      async () =>
        await new Promise<void>((resolve) => {
          finishOperation = resolve;
        }),
    );

    harness.instance.newServerFiles = [{ path: "Tasks/Remote.md" }];
    await vi.advanceTimersByTimeAsync(250);

    expect(onInbound).toHaveBeenCalledOnce();
    expect(gate.isPermitCurrent(permit)).toBe(false);
    finishOperation?.();
    await operation;
  });

  it("advances the inbound generation only once per incoming cycle", async () => {
    const harness = makeSyncHarness({ syncStatus: "Uploading Tasks/Local.md" });
    const onInbound = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app, { onInbound });
    gate.start(vi.fn());
    const firstPermit = await gate.waitForSafePermit();
    if (firstPermit === null) {
      throw new Error("Expected the first Sync permit");
    }

    harness.instance.newServerFiles = [{ path: "Tasks/Remote.md" }];
    harness.instance.syncStatus = "Downloading Tasks/Remote.md";
    harness.emitStatusChange();
    harness.emitStatusChange();

    expect(onInbound).toHaveBeenCalledOnce();
    expect(gate.isPermitCurrent(firstPermit)).toBe(false);

    harness.instance.newServerFiles = [];
    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const secondPermit = await gate.waitForSafePermit();
    if (secondPermit === null) {
      throw new Error("Expected the second Sync permit");
    }

    harness.instance.newServerFiles = [{ path: "Tasks/Another remote.md" }];
    harness.instance.syncStatus = "Downloading Tasks/Another remote.md";
    harness.emitStatusChange();

    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(gate.isPermitCurrent(secondPermit)).toBe(false);
  });

  it("cancels a deferred operation on dispose", async () => {
    const harness = makeSyncHarness({
      newServerFiles: [{ path: "Tasks/Remote.md" }],
      syncStatus: "Downloading Tasks/Remote.md",
    });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const pending = gate.waitForSafePermit();

    gate.dispose();

    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a waiter whose owning plugin generation is no longer current", async () => {
    const harness = makeSyncHarness({ syncStatus: "Indexing..." });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    let current = true;
    const pending = gate.waitForSafePermit(() => current);

    current = false;
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a throwing cancellation predicate as cancelled and cleans up", async () => {
    const harness = makeSyncHarness({ syncStatus: "Indexing..." });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    await expect(
      gate.waitForSafePermit(() => {
        throw new Error("owner disposed");
      }),
    ).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
