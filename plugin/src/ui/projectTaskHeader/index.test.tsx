import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectTaskMutationResult } from "@/services/projectTaskCommands";
import type { ProjectTaskCardModel } from "@/ui/projectTaskCard";

import { ProjectTaskHeader } from ".";

const task: ProjectTaskCardModel = {
  completed: false,
  content: "Write the report",
  description: "Draft the first section",
  dueDate: "2026-10-26",
  dueDatetime: "2026-10-26T07:30:00Z",
  dueTimezone: "Asia/Shanghai",
  recurring: true,
  deadline: "2026-10-30",
  duration: 45,
  durationUnit: "minute",
  filePath: "Tasks/Work/Write the report.task.md",
  labels: ["writing", "next"],
  priority: "P2",
  projectPath: ["Work", "Planning"],
  section: "Next",
  status: "active",
  subtasks: [],
  taskId: "task-1",
  url: "https://todoist.com/app/task/task-1",
};

const makeActions = () => ({
  edit: vi.fn(async () => undefined),
  open: vi.fn(async () => undefined),
  setCompleted: vi.fn(
    async (): Promise<ProjectTaskMutationResult> => ({
      projection: Promise.resolve(),
      targetedProjection: Promise.resolve(),
    }),
  ),
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe("ProjectTaskHeader", () => {
  it("renders its own controls and full task details without a Markdown embed context", () => {
    const { container } = render(<ProjectTaskHeader actions={makeActions()} task={task} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(task.content);
    expect(screen.getByRole("navigation", { name: "Task location" })).toHaveTextContent(
      "Work / Planning / Next",
    );
    expect(screen.getByRole("toolbar", { name: "Task actions" })).toContainElement(
      screen.getByRole("button", { name: "Edit Todoist task" }),
    );
    expect(screen.getByRole("link", { name: "Open task in Todoist" })).toHaveAttribute(
      "href",
      task.url,
    );
    const details = screen.getByRole("region", { name: "Task details" });
    for (const text of ["Asia/Shanghai", "Recurring", "45 min", "P2", "writing", "next"]) {
      expect(within(details).getByText(text)).toBeVisible();
    }
    expect(details.querySelector('time[datetime="2026-10-26T07:30:00Z"]')).toBeVisible();
    expect(details.querySelector('time[datetime="2026-10-30"]')).toBeVisible();
    expect(container.querySelector(".embed-action, .tasks-bridge-note-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show description" })).not.toBeInTheDocument();
  });

  it("expands a long description without replacing its source text", () => {
    const description = "A long description with useful task context. ".repeat(12);
    render(<ProjectTaskHeader actions={makeActions()} task={{ ...task, description }} />);

    const expand = screen.getByRole("button", { name: "Show description" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText(description.trim())).toHaveTextContent(description.trim());
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "Show description" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps subtasks collapsed initially and opens native task notes from the hierarchy", async () => {
    const actions = makeActions();
    const grandchild = { ...task, content: "Gather sources", taskId: "grandchild", subtasks: [] };
    const child = {
      ...task,
      content: "Prepare outline",
      taskId: "child",
      filePath: "Tasks/Work/Prepare outline.task.md",
      subtasks: [grandchild],
    };
    render(<ProjectTaskHeader actions={actions} task={{ ...task, subtasks: [child] }} />);

    expect(screen.queryByRole("link", { name: child.content })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Subtasks, 0 of 2 completed" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("link", { name: grandchild.content })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `Expand subtasks for ${child.content}` }));
    expect(screen.getByRole("link", { name: grandchild.content })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: child.content }));
    await waitFor(() => expect(actions.open).toHaveBeenCalledWith(child.filePath));
  });

  it("locks completion until projected metadata has converged", async () => {
    const actions = makeActions();
    const remote = deferred<ProjectTaskMutationResult>();
    const projection = deferred<void>();
    actions.setCompleted.mockReturnValue(remote.promise);
    const { rerender } = render(<ProjectTaskHeader actions={actions} task={task} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Complete Todoist task" }));
    expect(screen.getByRole("status", { name: "Updating Todoist task" })).toBeVisible();
    expect(actions.setCompleted).toHaveBeenCalledWith(
      { id: task.taskId, filePath: task.filePath },
      true,
    );
    await act(async () => {
      remote.resolve({ projection: projection.promise, targetedProjection: projection.promise });
    });
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Edit Todoist task" })).toBeDisabled();
    await act(async () => projection.resolve());
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeDisabled();
    rerender(
      <ProjectTaskHeader
        actions={actions}
        task={{ ...task, completed: true, status: "completed" }}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeEnabled();
    expect(actions.setCompleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("activates the whole completion label once and respects its disabled state (subtask: %s)", async (subtask) => {
    const actions = makeActions();
    const target = subtask ? { ...task, content: "Child task", taskId: "child" } : task;
    render(
      <ProjectTaskHeader
        actions={actions}
        task={subtask ? { ...task, subtasks: [target] } : task}
      />,
    );
    if (subtask) {
      fireEvent.click(screen.getByRole("button", { name: "Subtasks, 0 of 1 completed" }));
    }
    const name = subtask ? target.content : "Todoist task";
    const label = screen.getByRole("checkbox", { name: `Complete ${name}` }).closest("label");
    if (label === null) {
      throw new Error("The checkbox must have a native label for its full touch target");
    }

    fireEvent.click(label);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: `Reopen ${name}` })).toBeDisabled(),
    );
    fireEvent.click(label);

    expect(actions.setCompleted).toHaveBeenCalledExactlyOnceWith(
      { id: target.taskId, filePath: target.filePath },
      true,
    );
  });

  it("keeps the remote result locked when projection fails", async () => {
    const actions = makeActions();
    const projection = deferred<void>();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    actions.setCompleted.mockResolvedValue({
      projection: projection.promise,
      targetedProjection: Promise.resolve(),
    });
    render(<ProjectTaskHeader actions={actions} task={task} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete Todoist task" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeDisabled(),
    );
    await act(async () => projection.reject(new Error("projection failed")));
    expect(
      screen.getByText("Todoist was updated, but this note still needs Project sync."),
    ).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeDisabled();
    log.mockRestore();
  });

  it("keeps completion activation local to independently mounted task headers", async () => {
    const firstActions = makeActions();
    const secondActions = makeActions();
    const first = render(<ProjectTaskHeader actions={firstActions} task={task} />);
    const secondTask = { ...task, taskId: "task-2", filePath: "Tasks/Second.task.md" };
    const second = render(<ProjectTaskHeader actions={secondActions} task={secondTask} />);
    const firstCheckbox = within(first.container).getByRole("checkbox");
    const secondCheckbox = within(second.container).getByRole("checkbox");
    const label = secondCheckbox.closest("label");
    if (label === null) {
      throw new Error("The checkbox must have a native label");
    }
    // Production Preact IDs can repeat between independently mounted roots. A label must
    // associate with its descendant rather than resolving a document-global ID.
    expect(label).not.toHaveAttribute("for");
    firstCheckbox.id = "root-local-id";
    secondCheckbox.id = "root-local-id";
    expect(label.control).toBe(secondCheckbox);

    fireEvent.click(label);

    await waitFor(() =>
      expect(secondActions.setCompleted).toHaveBeenCalledExactlyOnceWith(
        { id: secondTask.taskId, filePath: secondTask.filePath },
        true,
      ),
    );
    expect(firstActions.setCompleted).not.toHaveBeenCalled();
  });

  it("uses the same safe completion action for a subtask", async () => {
    const actions = makeActions();
    const child = { ...task, content: "Prepare outline", taskId: "child" };
    render(<ProjectTaskHeader actions={actions} task={{ ...task, subtasks: [child] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Subtasks, 0 of 1 completed" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete Prepare outline" }));
    await waitFor(() =>
      expect(actions.setCompleted).toHaveBeenCalledWith(
        { id: child.taskId, filePath: child.filePath },
        true,
      ),
    );
    expect(screen.getByRole("checkbox", { name: "Reopen Prepare outline" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Subtasks, 0 of 1 completed" }));
    fireEvent.click(screen.getByRole("button", { name: "Subtasks, 0 of 1 completed" }));
    expect(screen.getByRole("checkbox", { name: "Reopen Prepare outline" })).toBeDisabled();
    expect(actions.setCompleted).toHaveBeenCalledTimes(1);
  });

  it("locks stale and inconsistent tasks while leaving the Todoist link available", () => {
    const actions = makeActions();
    const { rerender } = render(
      <ProjectTaskHeader actions={actions} task={{ ...task, status: "stale" }} />,
    );
    expect(screen.getByRole("checkbox", { name: "Complete Todoist task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Todoist task" })).toBeDisabled();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open task in Todoist" })).toHaveAttribute(
      "href",
      task.url,
    );
    rerender(<ProjectTaskHeader actions={actions} task={{ ...task, completed: true }} />);
    expect(screen.getByRole("checkbox", { name: "Reopen Todoist task" })).toBeDisabled();
  });

  it("edits the exact task file and prevents duplicate modal requests", async () => {
    const actions = makeActions();
    const pending = deferred<undefined>();
    actions.edit.mockReturnValue(pending.promise);
    render(<ProjectTaskHeader actions={actions} task={task} />);

    const button = screen.getByRole("button", { name: "Edit Todoist task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Complete Todoist task" })).toBeDisabled();
    expect(actions.edit).toHaveBeenCalledExactlyOnceWith({
      id: task.taskId,
      filePath: task.filePath,
    });
    await act(async () => pending.resolve(undefined));
    expect(button).toBeEnabled();
  });

  it("preserves invalid dates for inspection and omits invalid durations", () => {
    render(
      <ProjectTaskHeader
        actions={makeActions()}
        task={{ ...task, dueDatetime: "unknown date", deadline: "invalid", duration: -10 }}
      />,
    );
    expect(screen.getByText("unknown date")).toBeVisible();
    expect(screen.getByText("invalid")).toBeVisible();
    expect(screen.queryByText("-10 min")).not.toBeInTheDocument();
  });
});
