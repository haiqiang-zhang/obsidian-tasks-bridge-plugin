import { describe, expect, it } from "vitest";

import type { Label } from "@/api/domain/label";
import type { Project } from "@/api/domain/project";
import type { Section } from "@/api/domain/section";
import {
  type DataAccessor,
  hydrate,
  rebindTaskMetadata,
  rebindTaskMetadataList,
} from "@/data/hydrate";
import { Repository } from "@/data/repository";
import { isTaskCompleted } from "@/data/task";
import { makeApiTask, makeLabel, makeProject, makeSection, makeTask } from "@/factories/data";

const makeDataAccessor = (opts?: {
  projects?: Project[];
  sections?: Section[];
  labels?: Label[];
}): DataAccessor => {
  const projects = new Repository<string, Project>();
  const sections = new Repository<string, Section>();
  const labels = new Repository<string, Label>();
  if (opts?.projects) {
    projects.applyDiff(opts.projects);
  }
  if (opts?.sections) {
    sections.applyDiff(opts.sections);
  }
  if (opts?.labels) {
    labels.applyDiff(opts.labels);
  }
  return { projects, sections, labels };
};

describe("hydrate", () => {
  it("should map API task fields correctly to internal Task", () => {
    const apiTask = makeApiTask({
      id: "task-42",
      addedAt: "2024-06-15T10:30:00Z",
      updatedAt: "2024-06-16T12:00:00Z",
      content: "Buy groceries",
      description: "Milk, eggs, bread",
      priority: 3,
      childOrder: 7,
      due: { isRecurring: false, date: "2024-06-20" },
      duration: { amount: 30, unit: "minute" },
      deadline: { date: "2024-06-25" },
    });

    const task = hydrate(apiTask, makeDataAccessor());

    expect(task.id).toBe("task-42");
    expect(task.createdAt).toBe("2024-06-15T10:30:00Z");
    expect(task.authoritativeCreatedAt).toBe("2024-06-15T10:30:00Z");
    expect(task.updatedAt).toBe("2024-06-16T12:00:00Z");
    expect(task.content).toBe("Buy groceries");
    expect(task.description).toBe("Milk, eggs, bread");
    expect(task.priority).toBe(3);
    expect(task.order).toBe(7);
    expect(task.due).toEqual({ isRecurring: false, date: "2024-06-20" });
    expect(task.duration).toEqual({ amount: 30, unit: "minute" });
    expect(task.deadline).toEqual({ date: "2024-06-25" });
  });

  it("does not expose a completedAt fallback as an authoritative creation time", () => {
    const completedAt = "2026-08-09T12:34:56.000Z";
    const task = hydrate(
      makeApiTask({
        addedAt: "1970-01-01T00:00:00.000Z",
        addedAtIsAuthoritative: false,
        completedAt,
      }),
      makeDataAccessor(),
    );

    expect(task.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(task.createdAt).not.toBe(completedAt);
    expect(task.completedAt).toBe(completedAt);
    expect(task).not.toHaveProperty("authoritativeCreatedAt");
  });

  it("should preserve completed task identity", () => {
    const task = hydrate(makeApiTask({ completedAt: "2024-06-16T11:45:00Z" }), makeDataAccessor());

    expect(task.completedAt).toBe("2024-06-16T11:45:00Z");
    expect(isTaskCompleted(task)).toBe(true);
  });

  it.each([
    null,
    undefined,
  ])("should omit a non-completion timestamp represented as %s", (completedAt) => {
    const task = hydrate(makeApiTask({ completedAt }), makeDataAccessor());

    expect(task).not.toHaveProperty("completedAt");
    expect(isTaskCompleted(task)).toBe(false);
  });

  it("should treat a legacy null completion timestamp as active", () => {
    expect(isTaskCompleted({ completedAt: null })).toBe(false);
  });

  it("should resolve project from repository by projectId", () => {
    const project = makeProject("project-1", { name: "My Project" });
    const data = makeDataAccessor({ projects: [project] });

    const task = hydrate(makeApiTask({ projectId: "project-1" }), data);

    expect(task.project).toEqual(project);
  });

  it("should fall back to Unknown Project when project not found", () => {
    const task = hydrate(makeApiTask({ projectId: "missing-project" }), makeDataAccessor());

    expect(task.project.name).toBe("Unknown Project");
    expect(task.project.id).toBe("missing-project");
  });

  it("should resolve section from repository by sectionId", () => {
    const section = makeSection("section-1", { name: "My Section" });
    const data = makeDataAccessor({ sections: [section] });

    const task = hydrate(makeApiTask({ sectionId: "section-1" }), data);

    expect(task.section).toEqual(section);
  });

  it("should fall back to Unknown Section when section not found", () => {
    const task = hydrate(makeApiTask({ sectionId: "missing-section" }), makeDataAccessor());

    expect(task.section?.name).toBe("Unknown Section");
    expect(task.section?.id).toBe("missing-section");
  });

  it("should set section to undefined when sectionId is null", () => {
    const task = hydrate(makeApiTask({ sectionId: null }), makeDataAccessor());

    expect(task.section).toBeUndefined();
  });

  it("should resolve labels by name from repository", () => {
    const label = makeLabel("label-1", { name: "urgent" });
    const data = makeDataAccessor({ labels: [label] });

    const task = hydrate(makeApiTask({ labels: ["urgent"] }), data);

    expect(task.labels).toEqual([label]);
  });

  it("preserves the API label name when current metadata is unavailable", () => {
    const task = hydrate(makeApiTask({ labels: ["nonexistent"] }), makeDataAccessor());

    expect(task.labels).toEqual([
      {
        id: "tasks-bridge:unresolved-label:nonexistent",
        name: "nonexistent",
        color: "grey",
        isDeleted: false,
      },
    ]);
  });

  it("should resolve mixed labels (some found, some not)", () => {
    const label = makeLabel("label-1", { name: "urgent" });
    const data = makeDataAccessor({ labels: [label] });

    const task = hydrate(makeApiTask({ labels: ["urgent", "nonexistent"] }), data);

    expect(task.labels).toEqual([
      label,
      {
        id: "tasks-bridge:unresolved-label:nonexistent",
        name: "nonexistent",
        color: "grey",
        isDeleted: false,
      },
    ]);
  });

  it("encodes an unresolved API label name into a stable cache identity", () => {
    const task = hydrate(makeApiTask({ labels: ["research & review/中文"] }), makeDataAccessor());

    expect(task.labels).toEqual([
      {
        id: "tasks-bridge:unresolved-label:research%20%26%20review%2F%E4%B8%AD%E6%96%87",
        name: "research & review/中文",
        color: "grey",
        isDeleted: false,
      },
    ]);
  });

  it("rebinds an unresolved label by the API name after metadata recovers", () => {
    const offlineTask = hydrate(makeApiTask({ labels: ["urgent"] }), makeDataAccessor());
    const currentLabel = makeLabel("label-1", { name: "urgent", color: "red" });

    const rebound = rebindTaskMetadata(offlineTask, makeDataAccessor({ labels: [currentLabel] }));

    expect(rebound.labels).toEqual([currentLabel]);
  });

  it("does not replace a resolved label with a different same-name label", () => {
    const cachedLabel = makeLabel("original-label", { name: "urgent" });
    const differentLabel = makeLabel("replacement-label", { name: "urgent" });
    const cached = makeTask("cached", { labels: [cachedLabel] });

    expect(
      rebindTaskMetadata(cached, makeDataAccessor({ labels: [differentLabel] })).labels,
    ).toEqual([cachedLabel]);
  });

  it("should map parentId correctly", () => {
    const task = hydrate(makeApiTask({ parentId: "parent-1" }), makeDataAccessor());

    expect(task.parentId).toBe("parent-1");
  });

  it("should map null parentId to undefined", () => {
    const task = hydrate(makeApiTask({ parentId: null }), makeDataAccessor());

    expect(task.parentId).toBeUndefined();
  });

  it("rebinds cached project, section, and label metadata by stable ID", () => {
    const oldProject = makeProject("project-1", { name: "Old project" });
    const oldSection = makeSection("section-1", { name: "Old section" });
    const oldLabel = makeLabel("label-1", { name: "Old label" });
    const currentProject = makeProject("project-1", { name: "Renamed project" });
    const currentSection = makeSection("section-1", { name: "Renamed section" });
    const currentLabel = makeLabel("label-1", { name: "Renamed label" });
    const cached = makeTask("cached", {
      project: oldProject,
      section: oldSection,
      labels: [oldLabel],
    });

    const rebound = rebindTaskMetadata(
      cached,
      makeDataAccessor({
        projects: [currentProject],
        sections: [currentSection],
        labels: [currentLabel],
      }),
    );

    expect(rebound).toEqual({
      ...cached,
      project: currentProject,
      section: currentSection,
      labels: [currentLabel],
    });
  });

  it("keeps cached fallbacks when current metadata is unavailable", () => {
    const cached = makeTask("cached", {
      project: makeProject("missing-project", { name: "Cached project" }),
      section: makeSection("missing-section", { name: "Cached section" }),
      labels: [makeLabel("missing-label", { name: "Cached label" })],
    });
    const tasks = [cached];

    expect(rebindTaskMetadataList(tasks, makeDataAccessor())).toBe(tasks);
    expect(rebindTaskMetadata(cached, makeDataAccessor())).toBe(cached);
  });
});
