import { describe, expect, it } from "vitest";

import {
  isAutomaticProjectSyncWriter,
  isProjectSyncPath,
  ProjectSyncActivityTracker,
} from "./autoSync";
import type { ProjectSyncMapping } from "./types";

describe("ProjectSyncActivityTracker", () => {
  it("requires a quiet period after startup and relevant Vault activity", () => {
    let now = 1000;
    const tracker = new ProjectSyncActivityTracker(() => now, 500);
    tracker.recordActivity();

    expect(tracker.isQuiet()).toBe(false);
    expect(tracker.remainingQuietMs()).toBe(500);

    now = 1500;
    expect(tracker.isQuiet()).toBe(true);

    tracker.recordActivity();
    now = 1999;
    expect(tracker.isQuiet()).toBe(false);
    expect(tracker.remainingQuietMs()).toBe(1);

    now = 2000;
    expect(tracker.isQuiet()).toBe(true);
  });

  it("distinguishes plugin mutations from external Vault activity", async () => {
    let now = 1000;
    const tracker = new ProjectSyncActivityTracker(() => now, 500);
    tracker.recordActivity();
    const initialGeneration = tracker.generation();

    await tracker.runInternalMutation(["Tasks/Work/Task.md"], async () => {
      expect(tracker.recordVaultActivity(["Tasks/Work/Task.md"])).toBe(false);
      expect(tracker.generation()).toBe(initialGeneration);

      now = 1200;
      expect(tracker.recordVaultActivity(["Tasks/Work/Other.md"])).toBe(true);
    });

    expect(tracker.generation()).toBe(initialGeneration + 1);
    expect(tracker.remainingQuietMs()).toBe(500);
  });

  it("treats a partially unexpected rename as external activity", async () => {
    const tracker = new ProjectSyncActivityTracker(() => 1000, 500);

    await tracker.runInternalMutation(["Tasks/Work/Old.md"], async () => {
      expect(tracker.recordVaultActivity(["Tasks/Work/Old.md", "Tasks/Work/New.md"])).toBe(true);
    });
  });

  it("supports nested internal mutations of the same path", async () => {
    const tracker = new ProjectSyncActivityTracker(() => 1000, 500);

    await tracker.runInternalMutation(["Tasks/Work/Task.md"], async () => {
      await tracker.runInternalMutation(["Tasks/Work/Task.md"], async () => {
        expect(tracker.recordVaultActivity(["Tasks/Work/Task.md"])).toBe(false);
      });
      expect(tracker.recordVaultActivity(["Tasks/Work/Task.md"])).toBe(false);
    });

    expect(tracker.recordVaultActivity(["Tasks/Work/Task.md"])).toBe(true);
  });
});

describe("isProjectSyncPath", () => {
  const mapping: ProjectSyncMapping = {
    id: "mapping-work",
    project: { projectId: "work", projectName: "Work" },
    folder: "Tasks/Work",
    includeSubprojects: true,
    previousFolders: ["Tasks/Old Work"],
  };

  it.each([
    "Tasks",
    "Tasks/Work",
    "Tasks/Work/Task.md",
    "Tasks/Old Work/Archived.md",
  ])("recognizes projection roots, their ancestors, and their descendants: %s", (path) => {
    expect(isProjectSyncPath(path, [mapping])).toBe(true);
  });

  it.each([
    "Tasks/Workshop/Task.md",
    "Notes/Task.md",
  ])("ignores paths outside projection roots: %s", (path) => {
    expect(isProjectSyncPath(path, [mapping])).toBe(false);
  });
});

describe("isAutomaticProjectSyncWriter", () => {
  it("requires an explicit exact device assignment", () => {
    expect(isAutomaticProjectSyncWriter(null, "device-a")).toBe(false);
    expect(isAutomaticProjectSyncWriter("device-b", "device-a")).toBe(false);
    expect(isAutomaticProjectSyncWriter("device-a", "device-a")).toBe(true);
  });
});
