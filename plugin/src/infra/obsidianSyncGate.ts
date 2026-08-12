import type { App, EventRef } from "obsidian";

export const OBSIDIAN_SYNC_POLL_INTERVAL_MS = 250;
export const OBSIDIAN_SYNC_SETTLE_MS = 750;

export type ObsidianSyncPermit = Readonly<{
  generation: number;
}>;

export type ObsidianSyncPhase =
  | "unavailable"
  | "inactive"
  | "idle"
  | "outbound"
  | "preparing"
  | "inbound"
  | "indeterminate";

type InternalSyncInstance = {
  dataLoaded?: unknown;
  getStatus?: () => unknown;
  gettingServer?: unknown;
  initial?: unknown;
  initialized?: unknown;
  newServerFiles?: unknown;
  off?: (name: string, callback: () => void) => void;
  on?: (name: string, callback: () => void) => EventRef;
  pause?: unknown;
  ready?: unknown;
  syncStatus?: unknown;
};

type InternalPluginDescriptor = {
  enabled?: unknown;
  instance?: unknown;
};

type InternalPlugins = {
  getEnabledPluginById?: (id: string) => unknown;
  getPluginById?: (id: string) => unknown;
  plugins?: Record<string, unknown>;
};

type InternalApp = App & {
  internalPlugins?: InternalPlugins;
};

type Waiter = {
  isCurrent: () => boolean;
  resolve: (permit: ObsidianSyncPermit | null) => void;
};

type GateOptions = {
  clearTimer?: (id: number) => void;
  now?: () => number;
  onInbound?: () => void;
  pollIntervalMs?: number;
  setTimer?: (callback: () => void, delay: number) => number;
  settleMs?: number;
};

/**
 * Allows automatic Vault projection only after this device has observed a fully converged
 * Obsidian Sync session.
 *
 * Obsidian currently has no public Sync-direction API. All private access is isolated here and
 * feature-detected. If the private surface is missing or changes, automatic projection fails
 * closed; manual Project sync remains available through its separate, explicit command path.
 */
export class ObsidianSyncActivityGate {
  private readonly app: InternalApp;
  private readonly clearTimer: (id: number) => void;
  private readonly now: () => number;
  private readonly onInbound: () => void;
  private readonly pollIntervalMs: number;
  private readonly setTimer: (callback: () => void, delay: number) => number;
  private readonly settleMs: number;

  private activeMonitors = 0;
  private baselineConfirmed = false;
  private disposed = false;
  private inboundLatched = false;
  private lastPhase: ObsidianSyncPhase = "unavailable";
  private permitGeneration = 0;
  private pollTimer: number | undefined;
  private registerEvent: ((eventRef: EventRef) => void) | undefined;
  private settleUntil = Number.NEGATIVE_INFINITY;
  private subscribedInstance: InternalSyncInstance | undefined;
  private readonly waiters = new Set<Waiter>();

  private readonly onStatusChange = () => {
    this.refresh();
  };

  constructor(app: App, options: GateOptions = {}) {
    this.app = app;
    this.now = options.now ?? Date.now;
    this.onInbound = options.onInbound ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? OBSIDIAN_SYNC_POLL_INTERVAL_MS;
    this.settleMs = options.settleMs ?? OBSIDIAN_SYNC_SETTLE_MS;
    this.setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id));
  }

  public start(registerEvent: (eventRef: EventRef) => void): void {
    if (this.disposed) {
      return;
    }
    this.registerEvent = registerEvent;
    this.refresh();
  }

  public async waitForSafePermit(
    isCurrent: () => boolean = () => true,
  ): Promise<ObsidianSyncPermit | null> {
    this.refresh();
    if (this.disposed || !safePredicate(isCurrent)) {
      return null;
    }
    if (this.shouldSkipAutomaticRun()) {
      return null;
    }
    if (!this.isPreflightBlocked()) {
      return this.makePermit();
    }

    return await new Promise<ObsidianSyncPermit | null>((resolve) => {
      const waiter = { isCurrent, resolve };
      this.waiters.add(waiter);
      this.flushWaiters();
      this.ensurePolling();
    });
  }

  /**
   * Rechecks Sync as an automatic operation progresses. A known outbound phase does not
   * invalidate the permit because this plugin's own writes can start an upload. Every phase that
   * could hide remote changes invalidates the startup/convergence baseline.
   */
  public isPermitCurrent(permit: ObsidianSyncPermit): boolean {
    this.refresh();
    return (
      !this.disposed &&
      permit.generation === this.permitGeneration &&
      !this.isPreflightBlocked() &&
      !this.shouldSkipAutomaticRun()
    );
  }

  public async monitor<T>(operation: () => Promise<T>): Promise<T> {
    this.activeMonitors++;
    this.ensurePolling();
    try {
      return await operation();
    } finally {
      this.activeMonitors--;
      if (this.activeMonitors === 0 && this.waiters.size === 0) {
        this.clearPolling();
      }
    }
  }

  public phase(): ObsidianSyncPhase {
    this.refresh();
    return this.lastPhase;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearPolling();
    this.detachCurrentInstance();
    for (const waiter of this.waiters) {
      waiter.resolve(null);
    }
    this.waiters.clear();
  }

  private refresh(): void {
    if (this.disposed) {
      return;
    }

    const instance = resolveSyncInstance(this.app);
    const instanceChanged = instance !== this.subscribedInstance;
    this.ensureSubscribed(instance);
    const phase = observeSyncPhase(instance);
    const hadConfirmedBaseline = this.baselineConfirmed;
    const wasInboundLatched = this.inboundLatched;
    const now = this.now();

    if (instanceChanged) {
      // Replacing the private Sync instance breaks continuity even if the replacement happens to
      // expose the same coarse status. Its own exact idle state below may establish a new baseline.
      this.baselineConfirmed = false;
      this.settleUntil = Number.NEGATIVE_INFINITY;
      if (hadConfirmedBaseline) {
        this.permitGeneration++;
      }
    }

    if (phase === "inbound") {
      this.baselineConfirmed = false;
      this.inboundLatched = true;
      this.settleUntil = Number.NEGATIVE_INFINITY;
    } else if (phase === "idle") {
      if (!this.baselineConfirmed) {
        if (this.lastPhase !== "idle" || !Number.isFinite(this.settleUntil)) {
          this.settleUntil = now + this.settleMs;
        }
        if (now >= this.settleUntil) {
          this.baselineConfirmed = true;
          this.inboundLatched = false;
          this.settleUntil = Number.NEGATIVE_INFINITY;
        }
      }
    } else if (phase === "outbound") {
      if (!this.baselineConfirmed) {
        // An upload seen before convergence cannot establish that delayed remote files are here.
        this.settleUntil = Number.NEGATIVE_INFINITY;
      }
    } else if (
      phase === "indeterminate" ||
      phase === "preparing" ||
      phase === "inactive" ||
      phase === "unavailable"
    ) {
      // Losing continuous, confirmed convergence resets the per-startup baseline. In particular,
      // a device that reconnects must not project during a local upload before delayed remote
      // downloads have arrived.
      this.baselineConfirmed = false;
      this.settleUntil = Number.NEGATIVE_INFINITY;
      if (phase === "preparing" || phase === "inactive" || phase === "unavailable") {
        this.inboundLatched = false;
      }
    }

    if (hadConfirmedBaseline && !this.baselineConfirmed && !instanceChanged) {
      this.permitGeneration++;
    }

    this.lastPhase = phase;
    if (!wasInboundLatched && this.inboundLatched) {
      this.onInbound();
    }

    this.flushWaiters();
  }

  private makePermit(): ObsidianSyncPermit {
    return { generation: this.permitGeneration };
  }

  private isPreflightBlocked(): boolean {
    return (
      !this.baselineConfirmed ||
      this.inboundLatched ||
      this.lastPhase === "inbound" ||
      this.lastPhase === "indeterminate" ||
      this.now() < this.settleUntil
    );
  }

  private shouldSkipAutomaticRun(): boolean {
    return (
      this.lastPhase === "preparing" ||
      this.lastPhase === "inactive" ||
      this.lastPhase === "unavailable"
    );
  }

  private flushWaiters(): void {
    if (this.disposed) {
      return;
    }

    const shouldSkip = this.shouldSkipAutomaticRun();
    const canProceed = !shouldSkip && !this.isPreflightBlocked();
    for (const waiter of [...this.waiters]) {
      if (!safePredicate(waiter.isCurrent)) {
        this.waiters.delete(waiter);
        waiter.resolve(null);
        continue;
      }
      if (shouldSkip) {
        this.waiters.delete(waiter);
        waiter.resolve(null);
      } else if (canProceed) {
        this.waiters.delete(waiter);
        waiter.resolve(this.makePermit());
      }
    }

    if (this.waiters.size === 0 && this.activeMonitors === 0) {
      this.clearPolling();
    }
  }

  private ensurePolling(): void {
    if (
      this.disposed ||
      this.pollTimer !== undefined ||
      (this.waiters.size === 0 && this.activeMonitors === 0)
    ) {
      return;
    }

    this.pollTimer = this.setTimer(() => {
      this.pollTimer = undefined;
      this.refresh();
      this.ensurePolling();
    }, this.pollIntervalMs);
  }

  private clearPolling(): void {
    if (this.pollTimer === undefined) {
      return;
    }
    this.clearTimer(this.pollTimer);
    this.pollTimer = undefined;
  }

  private ensureSubscribed(instance: InternalSyncInstance | undefined): void {
    if (instance === this.subscribedInstance) {
      return;
    }
    this.detachCurrentInstance();
    this.subscribedInstance = instance;
    if (instance === undefined || typeof instance.on !== "function") {
      return;
    }

    try {
      const eventRef = instance.on("status-change", this.onStatusChange);
      this.registerEvent?.(eventRef);
    } catch {
      // Private APIs are version-dependent. Polling and fail-open classification remain active.
    }
  }

  private detachCurrentInstance(): void {
    const instance = this.subscribedInstance;
    this.subscribedInstance = undefined;
    if (instance === undefined || typeof instance.off !== "function") {
      return;
    }
    try {
      instance.off("status-change", this.onStatusChange);
    } catch {
      // The EventRef is also registered with the plugin lifecycle when the API supports it.
    }
  }
}

export const observeSyncPhase = (instance: InternalSyncInstance | undefined): ObsidianSyncPhase => {
  if (instance === undefined) {
    return "unavailable";
  }

  const inboundCount = collectionLength(instance.newServerFiles);
  const hasIncomingQueueSurface = inboundCount !== undefined;
  if (inboundCount !== undefined && inboundCount > 0) {
    return "inbound";
  }

  const status = safeCoreStatus(instance);
  const detail = typeof instance.syncStatus === "string" ? instance.syncStatus.trim() : "";
  const normalizedDetail = detail.toLocaleLowerCase("en-US");

  if (
    status === "paused" ||
    status === "error" ||
    status === "disconnected" ||
    status === "uninitialized" ||
    instance.pause === true
  ) {
    return "inactive";
  }

  if (isInboundDetail(normalizedDetail)) {
    return "inbound";
  }

  // The coarse `synced` value can lag behind detailed incoming work and is not enough to prove
  // this device has completed a post-startup download pass. Only the exact detailed idle state
  // establishes the automatic-projection baseline.
  if (normalizedDetail === "fully synced") {
    return "idle";
  }

  if (isOutboundDetail(normalizedDetail)) {
    return "outbound";
  }

  // Connecting can persist while the device is offline. Automatic Project sync must skip this
  // interval rather than project from a potentially stale local Vault snapshot.
  if (isPreparingDetail(normalizedDetail)) {
    return "preparing";
  }

  if (isIndeterminateDetail(normalizedDetail)) {
    return "indeterminate";
  }

  if (
    hasIncomingQueueSurface &&
    (instance.initial === true ||
      instance.initialized === false ||
      instance.ready === false ||
      instance.dataLoaded === false ||
      (instance.gettingServer !== null && instance.gettingServer !== undefined) ||
      status === "syncing")
  ) {
    return "indeterminate";
  }

  // A missing or changed private surface cannot safely authorize automatic Vault writes.
  return "unavailable";
};

const isInboundDetail = (detail: string): boolean =>
  detail.startsWith("downloading ") ||
  detail.startsWith("merging ") ||
  detail.startsWith("renaming conflicted file ") ||
  (detail.startsWith("deleting ") && !detail.startsWith("deleting remote "));

const isOutboundDetail = (detail: string): boolean =>
  detail.startsWith("uploading ") ||
  detail.startsWith("comparing ") ||
  detail.startsWith("deleting remote file ") ||
  detail.startsWith("deleting remote folder ");

const isPreparingDetail = (detail: string): boolean => detail.includes("connecting to server");

const isIndeterminateDetail = (detail: string): boolean =>
  detail.startsWith("indexing") ||
  detail.startsWith("initializing") ||
  detail.startsWith("computing hash ");

const safeCoreStatus = (instance: InternalSyncInstance): string => {
  if (typeof instance.getStatus !== "function") {
    return "";
  }
  try {
    const status = instance.getStatus();
    return typeof status === "string" ? status.toLocaleLowerCase("en-US") : "";
  } catch {
    return "";
  }
};

const collectionLength = (value: unknown): number | undefined => {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value) && typeof value.length === "number" && Number.isFinite(value.length)) {
    return Math.max(0, Math.floor(value.length));
  }
  return undefined;
};

const resolveSyncInstance = (app: InternalApp): InternalSyncInstance | undefined => {
  const internalPlugins = app.internalPlugins;
  if (internalPlugins === undefined) {
    return undefined;
  }

  try {
    const enabled = internalPlugins.getEnabledPluginById?.("sync");
    if (isRecord(enabled) && enabled.enabled !== false) {
      if (isSyncInstance(enabled.instance)) {
        return enabled.instance;
      }
      if (isSyncInstance(enabled)) {
        return enabled;
      }
    }
  } catch {
    // Continue through the guarded compatibility fallbacks.
  }

  let descriptor: unknown;
  try {
    descriptor = internalPlugins.getPluginById?.("sync") ?? internalPlugins.plugins?.sync;
  } catch {
    return undefined;
  }
  if (!isRecord(descriptor)) {
    return undefined;
  }
  const plugin = descriptor as InternalPluginDescriptor;
  if (plugin.enabled === false) {
    return undefined;
  }
  if (isSyncInstance(plugin.instance)) {
    return plugin.instance;
  }
  return isSyncInstance(descriptor) ? descriptor : undefined;
};

const isSyncInstance = (value: unknown): value is InternalSyncInstance =>
  isRecord(value) &&
  ("newServerFiles" in value ||
    "syncStatus" in value ||
    typeof (value as InternalSyncInstance).getStatus === "function");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safePredicate = (predicate: () => boolean): boolean => {
  try {
    return predicate();
  } catch {
    return false;
  }
};
