import { describe, expect, it } from "vitest";

import {
  normalizeAutoRefreshInterval,
  normalizeSettings,
  updateProjectSyncMappingFolder,
  updateProjectSyncMappingProject,
} from "@/settings";

describe("normalizeSettings auto-refresh", () => {
  it.each([
    [45.9, 45],
    [0, 0],
    [-1, 60],
    [Number.NaN, 60],
    [Number.POSITIVE_INFINITY, 60],
    ["30", 60],
  ])("normalizes interval %j to %i seconds", (stored, expected) => {
    expect(normalizeAutoRefreshInterval(stored)).toBe(expected);
    expect(normalizeSettings({ autoRefreshInterval: stored }).autoRefreshInterval).toBe(expected);
  });

  it("accepts only a boolean true auto-refresh toggle", () => {
    expect(normalizeSettings({ autoRefreshToggle: true }).autoRefreshToggle).toBe(true);
    expect(normalizeSettings({ autoRefreshToggle: "true" }).autoRefreshToggle).toBe(false);
  });
});

describe("normalizeSettings project sync", () => {
  it("accepts only a non-empty automatic writer device ID", () => {
    expect(normalizeSettings({ projectSyncWriterId: " device-a " }).projectSyncWriterId).toBe(
      "device-a",
    );
    expect(normalizeSettings({ projectSyncWriterId: " " }).projectSyncWriterId).toBeNull();
    expect(normalizeSettings({ projectSyncWriterId: 42 }).projectSyncWriterId).toBeNull();
  });

  it("preserves an enabled, structurally complete multi-project configuration", () => {
    const settings = normalizeSettings({
      projectSyncEnabled: true,
      projectSyncMappings: [
        {
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: true,
        },
        {
          project: { projectId: "personal", projectName: "Personal" },
          folder: "Todoist/Personal",
          includeSubprojects: false,
        },
      ],
    });

    expect(settings.projectSyncEnabled).toBe(true);
    expect(settings.projectSyncMappings).toHaveLength(2);
    expect(settings.projectSyncMappings.every((mapping) => mapping.id.length > 0)).toBe(true);
    expect(
      settings.projectSyncMappings.every((mapping) => mapping.previousFolders.length === 0),
    ).toBe(true);
  });

  it.each([
    ["empty mappings", true, []],
    [
      "an incomplete mapping",
      true,
      [{ project: null, folder: "Todoist/Work", includeSubprojects: false }],
    ],
    [
      "a non-boolean enabled value",
      "true",
      [
        {
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: false,
        },
      ],
    ],
    [
      "duplicate project mappings",
      true,
      [
        {
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: false,
        },
        {
          project: { projectId: "work", projectName: "Work again" },
          folder: "Todoist/Work again",
          includeSubprojects: false,
        },
      ],
    ],
    [
      "overlapping folder mappings",
      true,
      [
        {
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: false,
        },
        {
          project: { projectId: "archive", projectName: "Archive" },
          folder: "todoist/work/Archive",
          includeSubprojects: false,
        },
      ],
    ],
  ])("disables project sync for %s", (_label, projectSyncEnabled, projectSyncMappings) => {
    const settings = normalizeSettings({ projectSyncEnabled, projectSyncMappings });

    expect(settings.projectSyncEnabled).toBe(false);
  });

  it("persists valid prior roots across incremental folder edits and removes an undone target", () => {
    const mapping = normalizeSettings({
      projectSyncMappings: [
        {
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: false,
        },
      ],
    }).projectSyncMappings[0];

    const editing = updateProjectSyncMappingFolder(mapping, "Todoist/Wor", ["Todoist/Work"]);
    expect(editing.previousFolders).toEqual(["Todoist/Work"]);

    const moved = updateProjectSyncMappingFolder(editing, "Todoist/Archive", [
      "Todoist/Work",
      "Todoist/Archive",
    ]);
    expect(moved.previousFolders).toEqual(["Todoist/Work"]);

    const undone = updateProjectSyncMappingFolder(moved, "Todoist/Work", [
      "Todoist/Work",
      "Todoist/Archive",
    ]);
    expect(undone.previousFolders).toEqual(["Todoist/Archive"]);
  });

  it("assigns a new stable mapping identity and clears prior roots when the project changes", () => {
    const mapping = normalizeSettings({
      projectSyncMappings: [
        {
          id: "mapping-a",
          project: { projectId: "work", projectName: "Work" },
          folder: "Todoist/Work",
          includeSubprojects: false,
          previousFolders: ["Todoist/Old Work"],
        },
      ],
    }).projectSyncMappings[0];

    const changed = updateProjectSyncMappingProject(mapping, {
      projectId: "personal",
      projectName: "Personal",
    });

    expect(changed.id).not.toBe(mapping.id);
    expect(changed.previousFolders).toEqual([]);
  });
});
