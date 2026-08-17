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
    "Comparing Tasks/Work.md",
    "Indexing...",
    "Initializing...",
    "Computing hash Tasks/Work.md",
  ])("waits for direction during a transient phase: %s", (syncStatus) => {
    const { instance } = makeSyncHarness({ syncStatus });

    expect(observeSyncPhase(instance)).toBe("indeterminate");
  });

  it("classifies a persistent connection attempt as preparing", () => {
    const { instance } = makeSyncHarness({ syncStatus: "Connecting to server" });

    expect(observeSyncPhase(instance)).toBe("preparing");
  });

  it.each([
    "paused",
    "error",
    "disconnected",
    "uninitialized",
  ])("classifies an inactive Sync engine with an empty inbound queue: %s", (coreStatus) => {
    const { instance } = makeSyncHarness({ coreStatus, syncStatus: "" });

    expect(observeSyncPhase(instance)).toBe("inactive");
  });

  it("classifies a missing or coarse-only private Sync surface as unavailable", () => {
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

  it("allows a pure local upload only after observing the startup Fully synced baseline", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    const pending = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    await expect(pending).resolves.toEqual({ generation: 0 });

    harness.instance.syncStatus = "Uploading Tasks/Local.md";
    harness.emitStatusChange();

    await expect(gate.waitForSafePermit()).resolves.toEqual({ generation: 0 });
  });

  it("skips an automatic run during a persistent connection attempt", async () => {
    const harness = makeSyncHarness({ syncStatus: "Connecting to server" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "absent",
      {
        internalPlugins: {
          getEnabledPluginById: (): undefined => undefined,
          getPluginById: (): undefined => undefined,
        },
      },
    ],
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
  ])("allows immediately when official Sync is confidently %s", async (_label, appShape) => {
    const gate = new ObsidianSyncActivityGate(appShape as unknown as App);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toEqual({ generation: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["missing registry", {}],
    [
      "malformed enabled instance",
      {
        internalPlugins: {
          getEnabledPluginById: (): { getStatus: () => string } => ({
            getStatus: () => "syncing",
          }),
        },
      },
    ],
    [
      "malformed enabled descriptor",
      {
        internalPlugins: {
          getEnabledPluginById: (): undefined => undefined,
          getPluginById: () => ({
            enabled: true,
            instance: {},
          }),
        },
      },
    ],
  ])("fails closed for a %s private Sync API", async (_label, appShape) => {
    const gate = new ObsidianSyncActivityGate(appShape as unknown as App);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires the first exact Fully synced state to remain stable after startup", async () => {
    const harness = makeSyncHarness({ syncStatus: "Uploading Tasks/Local.md" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    let permit: unknown;
    void gate.waitForSafePermit().then((value) => {
      permit = value;
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(permit).toBeUndefined();

    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(permit).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(permit).toEqual({ generation: 0 });
  });

  it("skips a startup run when stale Fully synced changes to Connecting during settling", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const pending = gate.waitForSafePermit();

    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    harness.instance.syncStatus = "Connecting to server";
    harness.emitStatusChange();

    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a coarse synced status as the startup baseline", async () => {
    const harness = makeSyncHarness({ coreStatus: "synced", syncStatus: "" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());

    await expect(gate.waitForSafePermit()).resolves.toBeNull();
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
    expect(permit).toEqual({ generation: 0 });
  });

  it("requires a new stable Fully synced baseline after an indeterminate phase", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const initialPermit = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    await expect(initialPermit).resolves.toEqual({ generation: 0 });
    harness.instance.syncStatus = "Indexing...";
    harness.emitStatusChange();
    let permit: unknown;
    void gate.waitForSafePermit().then((value) => {
      permit = value;
    });

    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);

    expect(permit).toEqual({ generation: 1 });
  });

  it("invalidates a confirmed baseline while Sync is comparing", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const firstPending = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const firstPermit = await firstPending;
    expect(firstPermit).toEqual({ generation: 0 });

    harness.instance.syncStatus = "Comparing Tasks/Work.md";
    harness.emitStatusChange();

    expect(gate.isPermitCurrent(firstPermit as { generation: number })).toBe(false);
    let nextPermit: unknown;
    void gate.waitForSafePermit().then((value) => {
      nextPermit = value;
    });
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    expect(nextPermit).toBeUndefined();

    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);

    expect(nextPermit).toEqual({ generation: 1 });
  });

  it("requires a fresh idle settle after external Vault activity", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const firstPending = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const firstPermit = await firstPending;
    expect(firstPermit).toEqual({ generation: 0 });

    gate.recordExternalVaultActivity();

    expect(gate.isPermitCurrent(firstPermit as { generation: number })).toBe(false);
    let nextPermit: unknown;
    void gate.waitForSafePermit().then((value) => {
      nextPermit = value;
    });
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(nextPermit).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(nextPermit).toEqual({ generation: 1 });
  });

  it("ignores external Vault activity when official Sync is absent", async () => {
    const app = {
      internalPlugins: {
        getEnabledPluginById: (): undefined => undefined,
        getPluginById: (): undefined => undefined,
      },
    } as unknown as App;
    const gate = new ObsidianSyncActivityGate(app);
    gate.start(vi.fn());
    const firstPermit = await gate.waitForSafePermit();
    expect(firstPermit).toEqual({ generation: 0 });

    gate.recordExternalVaultActivity();

    expect(gate.isPermitCurrent(firstPermit as { generation: number })).toBe(true);
    await expect(gate.waitForSafePermit()).resolves.toEqual({ generation: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls the inbound queue while an automatic operation is active", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const onInbound = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app, { onInbound });
    gate.start(vi.fn());
    const pendingPermit = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const permit = await pendingPermit;
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
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const onInbound = vi.fn();
    const gate = new ObsidianSyncActivityGate(harness.app, { onInbound });
    gate.start(vi.fn());
    const pendingFirstPermit = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const firstPermit = await pendingFirstPermit;
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

  it("resets convergence across disconnect and blocks the reconnect upload until Fully synced", async () => {
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    const pendingInitialPermit = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const initialPermit = await pendingInitialPermit;
    expect(initialPermit).toEqual({ generation: 0 });

    harness.setCoreStatus("disconnected");
    harness.instance.syncStatus = "";
    harness.emitStatusChange();
    expect(gate.isPermitCurrent(initialPermit as { generation: number })).toBe(false);

    harness.setCoreStatus("syncing");
    harness.instance.syncStatus = "Uploading Tasks/Local.md";
    harness.emitStatusChange();
    let reconnectPermit: unknown;
    void gate.waitForSafePermit().then((value) => {
      reconnectPermit = value;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(reconnectPermit).toBeUndefined();

    harness.instance.newServerFiles = [{ path: "Tasks/Delayed remote.md" }];
    harness.instance.syncStatus = "Downloading Tasks/Delayed remote.md";
    harness.emitStatusChange();
    harness.instance.newServerFiles = [];
    harness.instance.syncStatus = "Fully synced";
    harness.emitStatusChange();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);

    expect(reconnectPermit).toEqual({ generation: 1 });
  });

  it("requires a fresh stable baseline when the private Sync instance is replaced", async () => {
    const first = makeSyncHarness({ syncStatus: "Fully synced" });
    let currentInstance: MutableSyncInstance = first.instance;
    const app = {
      internalPlugins: {
        getEnabledPluginById: () => currentInstance,
      },
    } as unknown as App;
    const gate = new ObsidianSyncActivityGate(app);
    gate.start(vi.fn());
    const firstPending = gate.waitForSafePermit();
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS);
    const firstPermit = await firstPending;
    expect(firstPermit).toEqual({ generation: 0 });

    const replacement = makeSyncHarness({ syncStatus: "Fully synced" });
    currentInstance = replacement.instance;
    expect(gate.isPermitCurrent(firstPermit as { generation: number })).toBe(false);

    let replacementPermit: unknown;
    void gate.waitForSafePermit().then((value) => {
      replacementPermit = value;
    });
    await vi.advanceTimersByTimeAsync(OBSIDIAN_SYNC_SETTLE_MS - 1);
    expect(replacementPermit).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(replacementPermit).toEqual({ generation: 1 });
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
    const harness = makeSyncHarness({ syncStatus: "Fully synced" });
    const gate = new ObsidianSyncActivityGate(harness.app);
    gate.start(vi.fn());
    harness.instance.syncStatus = "Indexing...";
    harness.emitStatusChange();
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
