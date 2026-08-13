import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MarkdownRenderChild } from "obsidian";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { RenderChildContext } from "@/ui/context";

import { ProjectTaskCard, type ProjectTaskCardModel } from ".";

const task: ProjectTaskCardModel = {
  completed: false,
  content: "Write the report",
  description: "Draft the first section",
  filePath: "Task Projects/Work/Write the report.md",
  labels: ["writing"],
  priority: "P2",
  projectPath: ["Work", "Planning"],
  section: "Next",
  status: "active",
  subtasks: [],
  taskId: "task-1",
  url: "https://todoist.com/app/task/task-1",
};

const makeRenderContext = (withEmbedActions: boolean) => {
  const host = document.createElement("div");
  const renderContainer = document.createElement("div");
  host.append(renderContainer);
  const embedActions = document.createElement("div");
  embedActions.className = "embed-actions";
  if (withEmbedActions) {
    host.append(embedActions);
  }
  const renderChild = new MarkdownRenderChild(renderContainer);
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <RenderChildContext.Provider value={renderChild}>{children}</RenderChildContext.Provider>
  );

  return { embedActions, host, Wrapper };
};

const makeActions = () => ({
  edit: vi.fn(async () => undefined),
  open: vi.fn(async () => undefined),
  setCompleted: vi.fn(async () => undefined),
});

describe("ProjectTaskCard", () => {
  it("joins Obsidian's native code-block action rail without replacing its edit control", () => {
    const { embedActions, Wrapper } = makeRenderContext(true);
    const nativeEdit = document.createElement("div");
    nativeEdit.className = "embed-action edit-block-button";
    nativeEdit.setAttribute("aria-label", "Edit this block");
    embedActions.append(nativeEdit);

    render(<ProjectTaskCard actions={makeActions()} task={task} />, { wrapper: Wrapper });

    const toolbar = within(embedActions).getByRole("toolbar", { name: "Todoist task" });
    expect(toolbar).toHaveClass("tasks-bridge-note-card-actions", "interactive-child");
    expect(within(toolbar).getByRole("button", { name: "Edit Todoist task" })).toHaveClass(
      "embed-action",
      "clickable-icon",
    );
    expect(within(toolbar).getByRole("link", { name: "Open task in Todoist" })).toHaveClass(
      "embed-action",
      "clickable-icon",
    );
    expect(within(embedActions).getByLabelText("Edit this block")).toBe(nativeEdit);
  });

  it("uses an in-card fallback when Obsidian does not expose an action rail", () => {
    const { Wrapper } = makeRenderContext(false);
    const { container } = render(<ProjectTaskCard actions={makeActions()} task={task} />, {
      wrapper: Wrapper,
    });

    expect(container.querySelector(".tasks-bridge-note-card-fallback-actions")).toContainElement(
      screen.getByRole("toolbar", { name: "Todoist task" }),
    );
  });

  it("moves the controls into an action rail that Obsidian inserts after rendering", async () => {
    const { embedActions, host, Wrapper } = makeRenderContext(false);
    const { container } = render(<ProjectTaskCard actions={makeActions()} task={task} />, {
      wrapper: Wrapper,
    });

    host.append(embedActions);

    await waitFor(() => {
      expect(embedActions).toContainElement(
        within(embedActions).getByRole("toolbar", { name: "Todoist task" }),
      );
    });
    expect(
      container.querySelector(".tasks-bridge-note-card-fallback-actions"),
    ).not.toBeInTheDocument();
  });

  it("keeps task editing wired after moving the button into Obsidian's action rail", async () => {
    const actions = makeActions();
    const { embedActions, Wrapper } = makeRenderContext(true);
    render(<ProjectTaskCard actions={actions} task={task} />, { wrapper: Wrapper });

    fireEvent.click(within(embedActions).getByRole("button", { name: "Edit Todoist task" }));

    await waitFor(() => {
      expect(actions.edit).toHaveBeenCalledWith({
        id: "task-1",
        filePath: "Task Projects/Work/Write the report.md",
      });
    });
  });

  it("keeps editing disabled for a completed task", () => {
    const { embedActions, Wrapper } = makeRenderContext(true);
    render(
      <ProjectTaskCard
        actions={makeActions()}
        task={{ ...task, completed: true, status: "completed" }}
      />,
      { wrapper: Wrapper },
    );

    expect(within(embedActions).getByRole("button", { name: "Edit Todoist task" })).toBeDisabled();
  });

  it("renders and collapses a recursive subtask list with aggregate progress", () => {
    const actions = makeActions();
    const child = {
      ...task,
      completed: true,
      content: "Chapter one",
      filePath: "Task Projects/Work/Report/Chapter one.md",
      status: "completed" as const,
      taskId: "child-1",
      subtasks: [
        {
          ...task,
          content: "Exercise one",
          filePath: "Task Projects/Work/Report/Chapter one/Exercise one.md",
          taskId: "grandchild-1",
          subtasks: [],
        },
      ],
    };
    const { Wrapper } = makeRenderContext(false);
    render(<ProjectTaskCard actions={actions} task={{ ...task, subtasks: [child] }} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByLabelText("1 of 2 subtasks completed")).toHaveTextContent(
      "1 of 2 completed",
    );
    expect(screen.getByText("Subtasks")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chapter one" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exercise one" })).toBeInTheDocument();

    const subtasksButton = screen.getByRole("button", { name: "Subtasks" });
    expect(subtasksButton).toHaveAttribute("aria-expanded", "true");
    expect(subtasksButton.querySelector(".obsidian-icon")).toHaveAttribute("data-icon-size", "xs");

    fireEvent.click(subtasksButton);
    expect(subtasksButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Chapter one" })).not.toBeInTheDocument();
  });

  it("opens and completes a projected subtask through the same task actions", async () => {
    const actions = makeActions();
    const child = {
      ...task,
      content: "Chapter one",
      filePath: "Task Projects/Work/Report/Chapter one.md",
      taskId: "child-1",
      subtasks: [],
    };
    const { Wrapper } = makeRenderContext(false);
    render(<ProjectTaskCard actions={actions} task={{ ...task, subtasks: [child] }} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByRole("link", { name: "Chapter one" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete Chapter one" }));

    expect(actions.open).toHaveBeenCalledWith(child.filePath);
    await waitFor(() => {
      expect(actions.setCompleted).toHaveBeenCalledWith(
        { id: child.taskId, filePath: child.filePath },
        true,
      );
    });
  });

  it("renders sibling tasks with checkboxes first and no decorative graph nodes", () => {
    const child = (id: string, content: string): ProjectTaskCardModel => ({
      ...task,
      content,
      filePath: `Task Projects/Work/Report/${content}.md`,
      taskId: id,
      subtasks: [],
    });
    const { Wrapper } = makeRenderContext(false);
    const { container } = render(
      <ProjectTaskCard
        actions={makeActions()}
        task={{
          ...task,
          subtasks: [child("child-1", "Chapter one"), child("child-2", "Chapter two")],
        }}
      />,
      { wrapper: Wrapper },
    );

    const rows = container.querySelectorAll(".tasks-bridge-note-card-subtask-row");
    expect(rows[0]?.firstElementChild).toHaveClass("tasks-bridge-note-card-subtask-completion");
    expect(
      container.querySelector(".tasks-bridge-note-card-subtask-disclosure-spacer"),
    ).not.toBeInTheDocument();
    expect(container.querySelector("[data-branch]")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("uses Obsidian-style indentation for nested task levels", () => {
    const grandchild: ProjectTaskCardModel = {
      ...task,
      content: "Exercise one",
      filePath: "Task Projects/Work/Report/Chapter one/Exercise one.md",
      taskId: "grandchild-1",
      subtasks: [],
    };
    const child: ProjectTaskCardModel = {
      ...task,
      content: "Chapter one",
      filePath: "Task Projects/Work/Report/Chapter one.md",
      taskId: "child-1",
      subtasks: [grandchild],
    };
    const { Wrapper } = makeRenderContext(false);
    const { container } = render(
      <ProjectTaskCard actions={makeActions()} task={{ ...task, subtasks: [child] }} />,
      { wrapper: Wrapper },
    );

    expect(container.querySelectorAll(".tasks-bridge-note-card-subtasks")).toHaveLength(2);
    expect(container.querySelector('[data-depth="0"]')).toBeInTheDocument();
    expect(container.querySelector('[data-depth="1"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-depth="1"] .tasks-bridge-note-card-subtask-row')
        ?.firstElementChild,
    ).toHaveClass("tasks-bridge-note-card-subtask-completion");
    expect(screen.getByRole("link", { name: "Exercise one" })).toHaveAttribute(
      "href",
      grandchild.filePath,
    );
  });

  it("uses an Obsidian disclosure control to collapse nested tasks", () => {
    const actions = makeActions();
    const grandchild = {
      ...task,
      content: "Exercise one",
      filePath: "Task Projects/Work/Report/Chapter one/Exercise one.md",
      taskId: "grandchild-1",
      subtasks: [],
    };
    const child = {
      ...task,
      content: "Chapter one",
      filePath: "Task Projects/Work/Report/Chapter one.md",
      taskId: "child-1",
      subtasks: [grandchild],
    };
    const { Wrapper } = makeRenderContext(false);
    render(<ProjectTaskCard actions={actions} task={{ ...task, subtasks: [child] }} />, {
      wrapper: Wrapper,
    });

    const disclosure = screen.getByRole("button", {
      name: "Collapse subtasks for Chapter one",
    });
    fireEvent.click(disclosure);
    expect(screen.queryByRole("link", { name: "Exercise one" })).not.toBeInTheDocument();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("does not draw decorative branch paths when a row is hovered", () => {
    const child = (id: string, content: string): ProjectTaskCardModel => ({
      ...task,
      content,
      filePath: `Task Projects/Work/Report/${content}.md`,
      taskId: id,
      subtasks: [],
    });
    const { Wrapper } = makeRenderContext(false);
    const { container } = render(
      <ProjectTaskCard
        actions={makeActions()}
        task={{
          ...task,
          subtasks: [
            child("child-1", "Chapter one"),
            child("child-2", "Chapter two"),
            child("child-3", "Chapter three"),
          ],
        }}
      />,
      { wrapper: Wrapper },
    );
    const rows = container.querySelectorAll(".tasks-bridge-note-card-subtask-row");

    expect(container.querySelector("[data-branch-path]")).not.toBeInTheDocument();
    fireEvent.pointerEnter(rows[1]);

    expect(container.querySelector("[data-branch-path]")).not.toBeInTheDocument();
    expect(container.querySelector("[data-branch]")).not.toBeInTheDocument();

    fireEvent.pointerLeave(rows[1]);
    expect(container.querySelector("[data-branch-path]")).not.toBeInTheDocument();
  });
});
