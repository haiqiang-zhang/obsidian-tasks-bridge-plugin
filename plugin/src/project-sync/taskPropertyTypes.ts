import type { App, EventRef, TFile } from "obsidian";

import { readManagedNoteIdentity } from "./document";
import { TASK_TEMPORAL_PROPERTY_TYPES } from "./properties";

type TemporalPropertyName = keyof typeof TASK_TEMPORAL_PROPERTY_TYPES;
type TemporalPropertyType = (typeof TASK_TEMPORAL_PROPERTY_TYPES)[TemporalPropertyName];

type NativePropertyTypeManager = {
  getAssignedWidget(name: string): unknown;
  setType(name: string, type: TemporalPropertyType): void | Promise<void>;
  on?(name: "changed", listener: (name: string) => void): EventRef;
};

/** The type manager is native but not part of Obsidian's public TypeScript API. */
const getTypeManager = (app: App): NativePropertyTypeManager | undefined => {
  const candidate = (app as App & { metadataTypeManager?: unknown }).metadataTypeManager;
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const manager = candidate as Partial<NativePropertyTypeManager> & { _loaded?: boolean };
  if (
    manager._loaded === false ||
    typeof manager.getAssignedWidget !== "function" ||
    typeof manager.setType !== "function"
  ) {
    return undefined;
  }
  return manager as NativePropertyTypeManager;
};

const temporalPropertyNames = Object.keys(TASK_TEMPORAL_PROPERTY_TYPES) as TemporalPropertyName[];
const hasOwn = (frontmatter: Record<string, unknown>, name: string): boolean =>
  // biome-ignore lint/suspicious/noPrototypeBuiltins: The supported Obsidian target does not include ES2022 Object.hasOwn.
  Object.prototype.hasOwnProperty.call(frontmatter, name);

/** Assign native types without rewriting timestamps or any part of a task document. */
export class TaskPropertyTypes {
  private readonly app: App;
  private readonly pending = new Set<TemporalPropertyName>();
  private readonly failed = new Set<TemporalPropertyName>();
  private readonly discovered = new Set<TemporalPropertyName>();
  private readonly observedManagers = new WeakSet<NativePropertyTypeManager>();
  private registerEvent: ((eventRef: EventRef) => void) | undefined;
  private ready = false;
  private started = false;
  private disposed = false;
  private scheduled = false;
  private draining = false;
  private requestedDuringDrain = false;
  private scanRequested = false;
  private writing: TemporalPropertyName | undefined;

  constructor(app: App) {
    this.app = app;
  }

  public start(registerEvent: (eventRef: EventRef) => void): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.registerEvent = registerEvent;
    registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        this.observe(file, cache.frontmatter);
        this.schedule();
      }),
    );
    registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.scanRequested = true;
        this.schedule();
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) {
        return;
      }
      this.ready = true;
      this.scanRequested = true;
      this.schedule();
    });
  }

  private observe(file: TFile, frontmatter: Record<string, unknown> | undefined): void {
    if (
      this.disposed ||
      frontmatter === undefined ||
      (!file.path.endsWith(".task.md") &&
        (!file.path.endsWith(".md") || !hasOwn(frontmatter, "todoist_task_id"))) ||
      readManagedNoteIdentity(frontmatter) === null
    ) {
      return;
    }
    for (const name of temporalPropertyNames) {
      if (hasOwn(frontmatter, name)) {
        this.pending.add(name);
        this.discovered.add(name);
      }
    }
  }

  private schedule(): void {
    if (this.disposed || !this.ready) {
      return;
    }
    if (this.draining) {
      this.requestedDuringDrain = true;
      return;
    }
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private observeManager(manager: NativePropertyTypeManager): void {
    if (this.observedManagers.has(manager) || typeof manager.on !== "function") {
      return;
    }
    this.observedManagers.add(manager);
    this.registerEvent?.(
      manager.on("changed", (name) => {
        if (typeof name !== "string") {
          return;
        }
        const normalized = name.toLowerCase() as TemporalPropertyName;
        if (this.disposed || normalized === this.writing || !this.discovered.has(normalized)) {
          return;
        }
        // A synchronized types.json can arrive after the task metadata. Reconcile only names
        // that have actually appeared on managed tasks, not arbitrary native properties.
        this.pending.add(normalized);
        this.schedule();
      }),
    );
  }

  private async drain(): Promise<void> {
    if (this.disposed || !this.ready) {
      return;
    }
    this.draining = true;
    this.requestedDuringDrain = false;
    let reportedError = false;
    const report = (error: unknown) => {
      if (!reportedError) {
        console.error("Failed to register Tasks Bridge date property types:", error);
        reportedError = true;
      }
    };
    try {
      if (this.scanRequested) {
        this.scanRequested = false;
        this.discovered.clear();
        for (const file of this.app.vault.getMarkdownFiles()) {
          this.observe(file, this.app.metadataCache.getFileCache(file)?.frontmatter);
        }
      }
      const manager = getTypeManager(this.app);
      if (manager === undefined) {
        // Retain pending names and retry on a later metadata/layout signal, never in a timer loop.
        return;
      }
      this.observeManager(manager);
      const names = new Set([...this.pending, ...this.failed]);
      this.pending.clear();
      for (const name of names) {
        if (this.disposed) {
          break;
        }
        try {
          const expected = TASK_TEMPORAL_PROPERTY_TYPES[name];
          if (!this.failed.has(name) && manager.getAssignedWidget(name) === expected) {
            continue;
          }
          this.writing = name;
          await manager.setType(name, expected);
          this.failed.delete(name);
        } catch (error) {
          // Native setType mutates memory before saving. A failed save must retry even when
          // getAssignedWidget already reports the requested type on the next signal.
          this.failed.add(name);
          report(error);
        } finally {
          this.writing = undefined;
        }
      }
    } catch (error) {
      report(error);
    } finally {
      this.draining = false;
      if (this.requestedDuringDrain && !this.disposed) {
        this.schedule();
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.failed.clear();
    this.discovered.clear();
  }
}
