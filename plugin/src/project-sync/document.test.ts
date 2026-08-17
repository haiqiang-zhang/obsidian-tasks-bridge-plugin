import { describe, expect, it } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import {
  applyManagedFrontmatter,
  applyManagedTaskRelationships,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  ManagedBodyConflictError,
  makeManagedBody,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  readRecoverableManagedNoteIdentity,
  replaceManagedBody,
  replaceManagedTaskDocument,
} from "./document";

const completionEvent = (id: string, completedAt: string) => ({
  id,
  taskId: "task-1",
  projectId: "project-1",
  completedAt,
});

describe("project task documents", () => {
  it("emits flat Bases-friendly managed properties", () => {
    const project = makeProject("project-1", { name: "Networking" });
    const task = {
      ...makeTask("task-1", {
        content: "Read RFC",
        completedAt: "2026-08-10T01:00:00.000Z",
        due: {
          date: "2026-08-12",
          datetime: "2026-08-12T09:30:00.000Z",
          timezone: "Asia/Shanghai",
          isRecurring: false,
        },
        labels: [{ id: "study", name: "study", color: "blue", isDeleted: false }],
        priority: 4,
        project,
      }),
      description: "Read the transport requirements",
      updatedAt: "2026-08-10T01:30:00.000Z",
    };

    const frontmatter = makeTaskFrontmatter(
      { task, completed: true },
      project.id,
      { ids: [project.id], names: [project.name] },
      "2026-08-10T02:00:00.000Z",
      "mapping-1",
      [
        completionEvent("second", "2026-08-10T01:00:00.000Z"),
        completionEvent("first", "2026-08-09T01:00:00.000Z"),
        completionEvent("second", "2026-08-10T01:00:00.000Z"),
      ],
    );
    expect(frontmatter).toMatchObject({
      todoist_task_id: "task-1",
      todoist_content: "Read RFC",
      todoist_description: "Read the transport requirements",
      todoist_status: "completed",
      todoist_completed: true,
      todoist_project: "Networking",
      todoist_project_path: ["Networking"],
      todoist_labels: ["study"],
      todoist_priority: "P1",
      todoist_updated_at: "2026-08-10T01:30:00.000Z",
      todoist_due_date: "2026-08-12",
      todoist_due_datetime: "2026-08-12T09:30:00.000Z",
      todoist_due_timezone: "Asia/Shanghai",
      todoist_due_is_recurring: false,
    });
    expect(frontmatter).not.toHaveProperty("todoist_sync_managed");
    expect(frontmatter).not.toHaveProperty("todoist_sync_mapping_id");
    expect(frontmatter).not.toHaveProperty("todoist_sync_root_id");
    expect(frontmatter).not.toHaveProperty("todoist_project_id");
    expect(frontmatter).not.toHaveProperty("todoist_project_id_path");
    expect(frontmatter).not.toHaveProperty("todoist_parent_task_id");
    expect(frontmatter).not.toHaveProperty("todoist_section_id");
    expect(frontmatter).not.toHaveProperty("todoist_completion_events");
    expect(frontmatter).not.toHaveProperty("todoist_order");
    expect(frontmatter).not.toHaveProperty("todoist_synced_at");
  });

  it("emits identical managed frontmatter on devices with different local clocks", () => {
    const project = makeProject("project-1", { name: "Networking" });
    const task = makeTask("task-1", { content: "Read RFC", project });
    const path = { ids: [project.id], names: [project.name] };

    expect(
      makeTaskFrontmatter({ task, completed: false }, project.id, path, "2026-08-10T01:00:00.000Z"),
    ).toEqual(
      makeTaskFrontmatter({ task, completed: false }, project.id, path, "2026-08-10T09:00:00.000Z"),
    );
  });

  it("emits only an authoritative Todoist creation time", () => {
    const project = makeProject("project-1", { name: "Networking" });
    const authoritative = makeTask("authoritative", {
      content: "Read RFC",
      createdAt: "2026-08-17T06:32:05.000Z",
      project,
    });
    const fallbackOnly = {
      ...makeTask("fallback", { content: "Read RFC", project }),
      createdAt: "2026-08-17T07:00:00.000Z",
    };
    const path = { ids: [project.id], names: [project.name] };

    expect(
      makeTaskFrontmatter(
        { task: authoritative, completed: false },
        project.id,
        path,
        "2026-08-17T08:00:00.000Z",
      ),
    ).toMatchObject({ todoist_created_at: "2026-08-17T06:32:05.000Z" });
    expect(
      makeTaskFrontmatter(
        { task: fallbackOnly, completed: false },
        project.id,
        path,
        "2026-08-17T08:00:00.000Z",
      ),
    ).not.toHaveProperty("todoist_created_at");
  });

  it("retains legacy timed due dates encoded in the date field", () => {
    const project = makeProject("project-1");
    const task = makeTask("task-1", {
      project,
      due: {
        date: "2026-08-12T09:30:00.000Z",
        isRecurring: false,
      },
    });

    expect(
      makeTaskFrontmatter(
        { task, completed: false },
        project.id,
        { ids: [project.id], names: [project.name] },
        "2026-08-10T02:00:00.000Z",
      ),
    ).toMatchObject({
      todoist_due_date: "2026-08-12",
      todoist_due_datetime: "2026-08-12T09:30:00.000Z",
    });
  });

  it("updates only the explicit managed key allowlist", () => {
    const frontmatter = {
      user_property: "keep me",
      todoist_task_id: "old",
      todoist_description: "old description",
      todoist_project_id_path: ["old-project"],
      todoist_completed_at: "old date",
      todoist_custom_user_property: "also keep me",
    };

    expect(applyManagedFrontmatter(frontmatter, { todoist_task_id: "new" })).toBe(true);
    expect(frontmatter).toEqual({
      user_property: "keep me",
      todoist_task_id: "new",
      todoist_custom_user_property: "also keep me",
    });
  });

  it("projects parent and ordered subtask links without touching user properties", () => {
    const frontmatter = {
      todoist_parent_task: "[[Old parent]]",
      todoist_subtasks: ["[[Old child]]"],
      user_property: "keep me",
    };

    expect(
      applyManagedTaskRelationships(frontmatter, {
        parentTask: "[[Tasks/Parent|Parent]]",
        subtasks: ["[[Tasks/First|First]]", "[[Tasks/Second|Second]]"],
      }),
    ).toBe(true);
    expect(frontmatter).toEqual({
      todoist_parent_task: "[[Tasks/Parent|Parent]]",
      todoist_subtasks: ["[[Tasks/First|First]]", "[[Tasks/Second|Second]]"],
      user_property: "keep me",
    });

    expect(
      applyManagedTaskRelationships(frontmatter, { parentTask: undefined, subtasks: [] }),
    ).toBe(true);
    expect(frontmatter).toEqual({ user_property: "keep me" });
  });

  it("replaces only the generated body region", () => {
    const before = `---\nuser: value\n---\n${MANAGED_BODY_START}\nold\n${MANAGED_BODY_END}\n\nUser notes`;
    const replacement = `${MANAGED_BODY_START}\nnew\n${MANAGED_BODY_END}`;

    expect(replaceManagedBody(before, replacement).content).toBe(
      `---\nuser: value\n---\n${replacement}\n\nUser notes`,
    );
  });

  it("updates frontmatter and the managed body as one document value", () => {
    const content = `---\ntodoist_task_id: task-1\ntodoist_content: Old\nuser_property: keep me\n---\n${MANAGED_BODY_START}\nold\n${MANAGED_BODY_END}\n\nUser notes`;
    const contentStart = content.indexOf("\n---\n", 4) + 5;
    const replacement = `${MANAGED_BODY_START}\nnew\n${MANAGED_BODY_END}`;

    const result = replaceManagedTaskDocument(
      content,
      {
        todoist_task_id: "task-1",
        todoist_content: "Old",
        user_property: "keep me",
      },
      { todoist_task_id: "task-1", todoist_content: "New" },
      replacement,
      contentStart,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("todoist_content: New");
    expect(result.content).toContain("user_property: keep me");
    expect(result.content).toContain(`\n---\n${replacement}`);
    expect(result.content).toContain(replacement);
    expect(result.content).toContain("User notes");
  });

  it("inserts missing markers without discarding existing body content", () => {
    const content = "---\nuser: value\n---\nExisting user notes";
    const body = makeManagedBody(makeTask("task-1", { content: "Task" }));
    const result = replaceManagedBody(content, body, content.indexOf("Existing"));

    expect(result.content).toContain(body);
    expect(result.content).toContain("Existing user notes");
  });

  it("renders managed tasks as a compact Tasks Bridge card code block", () => {
    const body = makeManagedBody(
      makeTask("task-1", { content: "A title with todoist-sync-plus:managed:start" }),
    );

    expect(body).toBe(
      `${MANAGED_BODY_START}\n\`\`\`tasks-bridge-task\n\`\`\`\n${MANAGED_BODY_END}`,
    );
    expect(body).not.toContain("A title with");
  });

  it("rejects malformed or duplicate marker regions", () => {
    expect(() => replaceManagedBody(`${MANAGED_BODY_START}\nmissing end`, "new")).toThrow(
      ManagedBodyConflictError,
    );
  });

  it("recovers only one strict task ID from a malformed managed document", () => {
    const body = `${MANAGED_BODY_START}\n\`\`\`tasks-bridge-task\n\`\`\`\n${MANAGED_BODY_END}`;
    const malformedYaml = "todoist_task_id: 6hGr78cXw24jQC7W\ntodoist_created_at: ''broken'";

    expect(
      readRecoverableManagedNoteIdentity(`---\n${malformedYaml}\n---\n${body}\n`, malformedYaml),
    ).toEqual({ taskId: "6hGr78cXw24jQC7W" });
    expect(
      readRecoverableManagedNoteIdentity(
        `---\n${malformedYaml}\ntodoist_task_id: second\n---\n${body}\n`,
        `${malformedYaml}\ntodoist_task_id: second`,
      ),
    ).toBeNull();
    expect(
      readRecoverableManagedNoteIdentity(`---\n${malformedYaml}\n---\nUser notes\n`, malformedYaml),
    ).toBeNull();
  });

  it.each([
    ["alphanumeric", "6hGr78cXw24jQC7W"],
    ["hyphenated", "task-1"],
    ["underscored", "task_1"],
  ])("accepts an exact %s Todoist task ID", (_kind, taskId) => {
    expect(readManagedNoteIdentity({ todoist_task_id: taskId })).toEqual({ taskId });
  });

  it.each([
    ["whitespace-only", " \t "],
    ["leading-whitespace", " task-1"],
    ["trailing-whitespace", "task-1 "],
    ["embedded-space", "task 1"],
    ["punctuation", "task.1"],
  ])("rejects a %s Todoist task ID instead of claiming the note", (_kind, taskId) => {
    expect(readManagedNoteIdentity({ todoist_task_id: taskId })).toBeNull();
  });
});
