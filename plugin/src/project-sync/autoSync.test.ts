import { describe, expect, it } from "vitest";

import { isProjectSyncPath, ProjectSyncActivityTracker } from "./autoSync";
import type { ProjectSyncMapping } from "./types";

describe("ProjectSyncActivityTracker", () => {
  it("advances its generation for relevant external activity", () => {
    const tracker = new ProjectSyncActivityTracker();
    expect(tracker.generation()).toBe(0);

    tracker.recordActivity();
    expect(tracker.generation()).toBe(1);
    tracker.recordActivity();
    expect(tracker.generation()).toBe(2);
  });

  it("distinguishes plugin mutations from external Vault activity", async () => {
    const tracker = new ProjectSyncActivityTracker();
    tracker.recordActivity();
    const initialGeneration = tracker.generation();

    await tracker.runInternalMutation(["Tasks/Work/Task.md"], async () => {
      expect(tracker.recordVaultActivity(["Tasks/Work/Task.md"])).toBe(false);
      expect(tracker.generation()).toBe(initialGeneration);

      expect(tracker.recordVaultActivity(["Tasks/Work/Other.md"])).toBe(true);
    });

    expect(tracker.generation()).toBe(initialGeneration + 1);
  });

  it("treats a partially unexpected rename as external activity", async () => {
    const tracker = new ProjectSyncActivityTracker();

    await tracker.runInternalMutation(["Tasks/Work/Old.md"], async () => {
      expect(tracker.recordVaultActivity(["Tasks/Work/Old.md", "Tasks/Work/New.md"])).toBe(true);
    });
  });

  it("supports nested internal mutations of the same path", async () => {
    const tracker = new ProjectSyncActivityTracker();

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
