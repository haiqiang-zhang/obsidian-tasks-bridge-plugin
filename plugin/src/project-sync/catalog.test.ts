import { describe, expect, it } from "vitest";

import {
  mergeProjectCatalogCollections,
  type ProjectCatalog,
  type ProjectCatalogCollection,
  projectCatalogCollectionsHaveSameContent,
} from "./catalog";

const catalog = (): ProjectCatalog => ({
  mappingId: "work",
  rootProjectId: "root",
  includeSubprojects: true,
  syncedAt: "2026-10-27T00:00:00.000Z",
  projects: [
    { id: "root", parentId: null, name: "Work", childOrder: 1 },
    { id: "child", parentId: "root", name: "Research", childOrder: 2 },
  ],
  tasks: [
    { id: "parent", projectId: "root", order: 1 },
    { id: "task", projectId: "child", parentId: "parent", sectionId: "section", order: 2 },
  ],
  completionEvents: [
    { id: "event-1", taskId: "task", projectId: "child", completedAt: "2026-10-25T10:00:00Z" },
    { id: "event-2", taskId: "task", projectId: "child", completedAt: "2026-10-26T10:00:00Z" },
  ],
});

const collection = (value: ProjectCatalog): ProjectCatalogCollection => ({
  [value.mappingId]: value,
});

describe("project catalog content changes", () => {
  it("does not turn a later successful poll or response ordering into a synchronized change", () => {
    const original = catalog();
    const other = { ...catalog(), mappingId: "personal" };
    const next = {
      ...original,
      syncedAt: "2026-10-27T01:00:00.000Z",
      projects: [...original.projects].reverse(),
      tasks: [...original.tasks].reverse(),
      completionEvents: [...original.completionEvents].reverse(),
    };
    const before = structuredClone(original);

    expect(
      projectCatalogCollectionsHaveSameContent(
        { work: original, personal: other },
        { personal: other, work: next },
      ),
    ).toBe(true);
    expect(original).toEqual(before);
  });

  it.each([
    [
      "mapping identity",
      (value: ProjectCatalog) => {
        value.mappingId = "new-mapping";
      },
    ],
    [
      "root project",
      (value: ProjectCatalog) => {
        value.rootProjectId = "child";
      },
    ],
    [
      "subproject scope",
      (value: ProjectCatalog) => {
        value.includeSubprojects = false;
      },
    ],
    [
      "project name",
      (value: ProjectCatalog) => {
        value.projects[1].name = "New research";
      },
    ],
    [
      "project hierarchy",
      (value: ProjectCatalog) => {
        value.projects[1].parentId = null;
      },
    ],
    [
      "project order",
      (value: ProjectCatalog) => {
        value.projects[1].childOrder = 3;
      },
    ],
    [
      "task project",
      (value: ProjectCatalog) => {
        value.tasks[1].projectId = "root";
      },
    ],
    [
      "subtask parent",
      (value: ProjectCatalog) => {
        delete value.tasks[1].parentId;
      },
    ],
    [
      "task section",
      (value: ProjectCatalog) => {
        delete value.tasks[1].sectionId;
      },
    ],
    [
      "task order",
      (value: ProjectCatalog) => {
        value.tasks[1].order = 3;
      },
    ],
    [
      "missing-task evidence",
      (value: ProjectCatalog) => {
        value.tasks[1].missingCount = 1;
      },
    ],
    [
      "completion task",
      (value: ProjectCatalog) => {
        value.completionEvents[1] = { ...value.completionEvents[1], taskId: "parent" };
      },
    ],
    [
      "completion project",
      (value: ProjectCatalog) => {
        value.completionEvents[1] = { ...value.completionEvents[1], projectId: "root" };
      },
    ],
    [
      "completion time",
      (value: ProjectCatalog) => {
        value.completionEvents[1] = {
          ...value.completionEvents[1],
          completedAt: "2026-10-26T11:00:00Z",
        };
      },
    ],
    [
      "completion identity",
      (value: ProjectCatalog) => {
        value.completionEvents[1] = { ...value.completionEvents[1], id: "event-3" };
      },
    ],
    [
      "removed project",
      (value: ProjectCatalog) => {
        value.projects.pop();
      },
    ],
    [
      "removed task",
      (value: ProjectCatalog) => {
        value.tasks.pop();
      },
    ],
    [
      "removed completion",
      (value: ProjectCatalog) => {
        value.completionEvents.pop();
      },
    ],
  ] as const)("still detects changed %s", (_name, change) => {
    const original = catalog();
    const changed = structuredClone(original);
    change(changed);

    expect(projectCatalogCollectionsHaveSameContent({ work: original }, { work: changed })).toBe(
      false,
    );
  });

  it("detects added or removed mappings", () => {
    const current = collection(catalog());
    expect(projectCatalogCollectionsHaveSameContent(current, {})).toBe(false);
    expect(projectCatalogCollectionsHaveSameContent({}, current)).toBe(false);
    expect(projectCatalogCollectionsHaveSameContent({}, {})).toBe(true);
  });

  it("keeps the latest observation in memory so the second catalog publication preserves retained tasks", () => {
    const original = catalog();
    const fresh = { ...catalog(), syncedAt: "2026-10-27T01:00:00.000Z" };
    const current = collection(original);
    const observed = mergeProjectCatalogCollections(current, collection(fresh));

    // Vault reconciliation retained the parent note, so an unchanged catalog needs no write.
    expect(projectCatalogCollectionsHaveSameContent(current, observed)).toBe(true);
    expect(observed.work.syncedAt).toBe(fresh.syncedAt);

    // Statistics subsequently publishes the same run's raw source snapshot. Matching timestamps
    // must still union these catalogs rather than dropping the retained task.
    const rawSnapshotCatalog = {
      ...fresh,
      tasks: fresh.tasks.filter((task) => task.id !== "parent"),
    };
    const final = mergeProjectCatalogCollections(observed, collection(rawSnapshotCatalog));
    expect(projectCatalogCollectionsHaveSameContent(current, final)).toBe(true);
    expect(final.work.tasks.map((task) => task.id)).toContain("parent");
  });

  it("retains timestamp ordering for a stale incoming snapshot with different content", () => {
    const current = collection({ ...catalog(), syncedAt: "2026-10-27T01:00:00.000Z" });
    const stale = catalog();
    stale.projects[0].name = "Old name";
    const merged = mergeProjectCatalogCollections(current, collection(stale));

    expect(projectCatalogCollectionsHaveSameContent(current, merged)).toBe(true);
    expect(merged.work.projects[0].name).toBe("Work");
  });
});
