import { describe, expect, it } from "vitest";

import { makeProject, makeTask } from "@/factories/data";

import {
  applyManagedFrontmatter,
  applyManagedTaskRelationships,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  ManagedBodyConflictError,
  makeManagedBody,
  makeManagedTaskIdentityMarker,
  makeProjectTaskBlock,
  makeTaskFrontmatter,
  readManagedNoteIdentity,
  readManagedTaskIdentityMarker,
  readProjectTaskBlockIdentity,
  readRecoverableManagedNoteIdentity,
  readUserOwnedTaskDocument,
  replaceManagedBody,
  replaceManagedTaskDocument,
  requireManagedTaskBody,
} from "./document";
import { TaskPropertyConflictError } from "./properties";

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
      "task id": "task-1",
      content: "Read RFC",
      description: "Read the transport requirements",
      status: "completed",
      completed: true,
      project: "Networking",
      "project path": ["Networking"],
      labels: ["study"],
      priority: "P1",
      "updated at": "2026-08-10T01:30:00.000Z",
      "due date": "2026-08-12",
      "due datetime": "2026-08-12T09:30:00.000Z",
      "due timezone": "Asia/Shanghai",
      recurring: false,
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
    expect(
      Object.keys(frontmatter).every((key) => key === key.toLowerCase() && !key.includes("_")),
    ).toBe(true);
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
    ).toMatchObject({ "created at": "2026-08-17T06:32:05.000Z" });
    expect(
      makeTaskFrontmatter(
        { task: fallbackOnly, completed: false },
        project.id,
        path,
        "2026-08-17T08:00:00.000Z",
      ),
    ).not.toHaveProperty("created at");
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
      "due date": "2026-08-12",
      "due datetime": "2026-08-12T09:30:00.000Z",
    });
  });

  it("updates only the explicit managed key allowlist", () => {
    const frontmatter = {
      user_property: "keep me",
      "task id": "task-1",
      description: "old description",
      todoist_project_id_path: ["old-project"],
      "completed at": "old date",
      todoist_custom_user_property: "also keep me",
    };

    expect(applyManagedFrontmatter(frontmatter, { "task id": "task-1" })).toBe(true);
    expect(frontmatter).toEqual({
      user_property: "keep me",
      "task id": "task-1",
      todoist_custom_user_property: "also keep me",
    });
  });

  it("projects parent and ordered subtask links without touching user properties", () => {
    const frontmatter = {
      "parent task": "[[Old parent]]",
      subtasks: ["[[Old child]]"],
      user_property: "keep me",
    };

    expect(
      applyManagedTaskRelationships(frontmatter, {
        parentTask: "[[Tasks/Parent|Parent]]",
        subtasks: ["[[Tasks/First|First]]", "[[Tasks/Second|Second]]"],
      }),
    ).toBe(true);
    expect(frontmatter).toEqual({
      "parent task": "[[Tasks/Parent|Parent]]",
      subtasks: ["[[Tasks/First|First]]", "[[Tasks/Second|Second]]"],
      user_property: "keep me",
    });

    expect(
      applyManagedTaskRelationships(frontmatter, { parentTask: undefined, subtasks: [] }),
    ).toBe(true);
    expect(frontmatter).toEqual({ user_property: "keep me" });
  });

  it("migrates legacy fields and relationship links while retaining user properties", () => {
    const frontmatter = {
      todoist_task_id: "task-1",
      todoist_status: "active",
      todoist_due_date: "2026-10-24",
      todoist_parent_task: "[[Parent]]",
      todoist_subtasks: ["[[First child]]", "[[Second child]]"],
      todoist_synced_at: "old local clock",
      tags: ["study"],
      aliases: ["Task alias"],
      cssclasses: ["task-style"],
      user_property: "keep me",
    };

    expect(applyManagedFrontmatter(frontmatter, { "task id": "task-1", status: "active" })).toBe(
      true,
    );
    expect(frontmatter).toEqual({
      "task id": "task-1",
      status: "active",
      "parent task": "[[Parent]]",
      subtasks: ["[[First child]]", "[[Second child]]"],
      tags: ["study"],
      aliases: ["Task alias"],
      cssclasses: ["task-style"],
      user_property: "keep me",
    });
    expect(applyManagedFrontmatter(frontmatter, { "task id": "task-1", status: "active" })).toBe(
      false,
    );
  });

  it("rejects user property collisions before changing a legacy document", () => {
    const frontmatter = {
      todoist_task_id: "task-1",
      todoist_status: "active",
      status: "my workflow",
      todoist_parent_task: "[[Parent]]",
    };
    const before = { ...frontmatter };

    expect(() =>
      applyManagedFrontmatter(frontmatter, { "task id": "task-1", status: "completed" }),
    ).toThrow(TaskPropertyConflictError);
    expect(() => applyManagedTaskRelationships(frontmatter, { subtasks: [] })).toThrow(
      TaskPropertyConflictError,
    );
    const content = `---\n---\n${MANAGED_BODY_START}\ncard\n${MANAGED_BODY_END}\nUser notes`;
    expect(() => readUserOwnedTaskDocument(content, frontmatter, 8)).toThrow(
      TaskPropertyConflictError,
    );
    expect(frontmatter).toEqual(before);
    expect(readManagedNoteIdentity(frontmatter)).toBeNull();
  });

  it("rejects a changed task identity before altering any managed properties", () => {
    const frontmatter = { todoist_task_id: "task-1", todoist_content: "Original" };

    expect(() =>
      applyManagedFrontmatter(frontmatter, { "task id": "task-2", content: "Replacement" }),
    ).toThrow(TaskPropertyConflictError);
    expect(frontmatter).toEqual({ todoist_task_id: "task-1", todoist_content: "Original" });
  });

  it("replaces only the generated body region", () => {
    const before = `---\nuser: value\n---\n${MANAGED_BODY_START}\nold\n${MANAGED_BODY_END}\n\nUser notes`;
    const replacement = `${MANAGED_BODY_START}\nnew\n${MANAGED_BODY_END}`;

    expect(replaceManagedBody(before, replacement).content).toBe(
      `---\nuser: value\n---\n${replacement}\n\nUser notes`,
    );
  });

  it("updates frontmatter and the managed body as one document value", () => {
    const content = `---\ntodoist_task_id: task-1\ntodoist_content: Old\nuser_property: keep me\n---\n${MANAGED_BODY_START}\n${makeProjectTaskBlock("task-1")}\n${MANAGED_BODY_END}\n\nUser notes`;
    const contentStart = content.indexOf("\n---\n", 4) + 5;
    const replacement = makeManagedBody(makeTask("task-1"));

    const result = replaceManagedTaskDocument(
      content,
      {
        "task id": "task-1",
        content: "Old",
        user_property: "keep me",
      },
      { todoist_task_id: "task-1", todoist_content: "New" },
      replacement,
      contentStart,
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("content: New");
    expect(result.content).toContain("user_property: keep me");
    expect(result.content).toContain(`\n---\n${replacement}`);
    expect(result.content).toContain(replacement);
    expect(result.content).toContain("User notes");
    expect(result.content).not.toContain("todoist_task_id:");
    expect(result.content).not.toContain("todoist_content:");
  });

  it("inserts missing markers without discarding existing body content", () => {
    const content = "---\nuser: value\n---\nExisting user notes";
    const body = makeManagedBody(makeTask("task-1", { content: "Task" }));
    const result = replaceManagedBody(content, body, content.indexOf("Existing"));

    expect(result.content).toContain(body);
    expect(result.content).toContain("Existing user notes");
  });

  it("renders managed tasks with a source-only identity comment", () => {
    const body = makeManagedBody(
      makeTask("task-1", { content: "A title with todoist-sync-plus:managed:start" }),
    );

    expect(body).toBe(
      `${MANAGED_BODY_START}\n<!-- tasks-bridge:task-id "task-1" -->\n${MANAGED_BODY_END}`,
    );
    expect(body).not.toContain("A title with");
  });

  it("quotes numeric-looking task IDs in the identity comment", () => {
    const body = makeManagedBody(makeTask("9007199254740993"));

    expect(body).toContain('<!-- tasks-bridge:task-id "9007199254740993" -->');
    expect(readProjectTaskBlockIdentity('task_id: "9007199254740993"')).toEqual({
      taskId: "9007199254740993",
    });
  });

  it.each([
    ['task_id: "6hGr78cXw24jQC7W"', { taskId: "6hGr78cXw24jQC7W" }],
    ["task_id: task-1", { taskId: "task-1" }],
    ["task_id: 9007199254740993", null],
    ["task_id: true", null],
    ['task_id: ""', null],
    ["task_id: task.1", null],
    ['task_id: " task-1"', null],
    ['task_id: "task-1"\ntask_id: "task-2"', null],
    ['task_id: "task-1"\nextra: value', null],
    ["task: task-1", null],
    ["task_id: [task-1]", null],
    ["task_id: { value: task-1 }", null],
    ["task_id: [", null],
    ["", null],
  ])("parses a project task block identity from %j", (source, expected) => {
    expect(readProjectTaskBlockIdentity(source)).toEqual(expected);
  });

  it.each([
    ['<!-- tasks-bridge:task-id "task-1" -->', { taskId: "task-1" }],
    ['<!-- tasks-bridge:task-id "9007199254740993" -->', { taskId: "9007199254740993" }],
    ["<!-- tasks-bridge:task-id task-1 -->", null],
    ["<!-- tasks-bridge:task-id 'task-1' -->", null],
    ['<!-- tasks-bridge:task-id "" -->', null],
    ['<!-- tasks-bridge:task-id "task.1" -->', null],
    ['<!-- tasks-bridge:task-id " task-1" -->', null],
    ['<!-- tasks-bridge:task-id "task-1" --> extra', null],
    ['<!-- tasks-bridge:task-id "task-1" -->\n<!-- tasks-bridge:task-id "task-1" -->', null],
  ])("strictly parses a source-only task identity from %j", (source, expected) => {
    expect(readManagedTaskIdentityMarker(source)).toEqual(expected);
  });

  it.each([
    makeManagedTaskIdentityMarker("task-1"),
    makeProjectTaskBlock("task-1"),
    "```tasks-bridge-task\n```",
  ])("accepts supported managed identity regions without changing embedded user cards: %j", (region) => {
    const content = `${MANAGED_BODY_START}\n${region}\n${MANAGED_BODY_END}\n\n${makeProjectTaskBlock("other-task")}`;
    expect(() => requireManagedTaskBody(content, 0, "task-1")).not.toThrow();
  });

  it.each([
    makeManagedTaskIdentityMarker("different-task"),
    `${makeManagedTaskIdentityMarker("task-1")}\n${makeManagedTaskIdentityMarker("task-1")}`,
    `${makeManagedTaskIdentityMarker("task-1")}\n${makeProjectTaskBlock("task-1")}`,
    makeProjectTaskBlock("different-task"),
    '<!-- tasks-bridge:task-id "task-1" --> trailing data',
  ])("rejects ambiguous or mismatching managed identity regions: %j", (region) => {
    const content = `${MANAGED_BODY_START}\n${region}\n${MANAGED_BODY_END}`;
    expect(() => requireManagedTaskBody(content, 0, "task-1")).toThrow(ManagedBodyConflictError);
    expect(
      readRecoverableManagedNoteIdentity(
        `---\ntask id: task-1\n---\n${content}`,
        "task id: task-1",
      ),
    ).toBeNull();
  });

  it("rejects repeated boundaries and identity markers outside the managed region", () => {
    const body = makeManagedBody(makeTask("task-1"));
    expect(() => requireManagedTaskBody(`${body}\n${MANAGED_BODY_START}`, 0, "task-1")).toThrow(
      ManagedBodyConflictError,
    );
    expect(() =>
      requireManagedTaskBody(`${body}\n${makeManagedTaskIdentityMarker("task-1")}`, 0, "task-1"),
    ).toThrow(ManagedBodyConflictError);
    expect(() => requireManagedTaskBody(body, body.length, "task-1")).toThrow(
      ManagedBodyConflictError,
    );
  });

  it("rejects malformed or duplicate marker regions", () => {
    expect(() => replaceManagedBody(`${MANAGED_BODY_START}\nmissing end`, "new")).toThrow(
      ManagedBodyConflictError,
    );
  });

  it.each([
    "description",
    "status",
    "content",
  ])("preserves user prose beginning with %s and a horizontal rule", (key) => {
    const body = makeManagedBody(makeTask("task-1"));
    const prefix = `${key}: My personal summary\n---\n`;
    const content = `---\ntask id: task-1\n---\n${prefix}${body}\n`;
    const start = content.indexOf(prefix);
    const user = readUserOwnedTaskDocument(content, { "task id": "task-1" }, start);
    expect(user.body).toBe(prefix.trim());
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
    ["task id: task-1", { taskId: "task-1" }],
    ['"task id": "task-1"', { taskId: "task-1" }],
    ["'task id': 'task-1'", { taskId: "task-1" }],
    ["task id: task-1\ntodoist_task_id: task-1", { taskId: "task-1" }],
    ["task id: task-1\ntodoist_task_id: task-2", null],
    ['task id: task-1\n"task id": task-1', null],
  ])("recovers compatible schema identities from %j", (raw, expected) => {
    const body = makeManagedBody(makeTask("task-1"));
    expect(readRecoverableManagedNoteIdentity(`---\n${raw}\n---\n${body}`, raw)).toEqual(expected);
  });

  it("accepts canonical identity and declines conflicting schemas", () => {
    expect(readManagedNoteIdentity({ "task id": "task-1", status: "active" })).toEqual({
      taskId: "task-1",
    });
    expect(readManagedNoteIdentity({ "task id": "task-1", todoist_task_id: "task-2" })).toBeNull();
    expect(
      readManagedNoteIdentity({
        "task id": "task-1",
        status: "active",
        todoist_status: "completed",
      }),
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
