import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Notice } from "obsidian";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Priorities, type Task, type UpdateTaskParams } from "@/api/domain/task";
import type TodoistPlugin from "@/index";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";
import { ModalContext, PluginContext } from "@/ui/context";

import { EditTaskModal } from ".";

vi.mock("obsidian", () => ({
  Notice: vi.fn(),
  normalizePath: (path: string) => path,
}));

// These selectors have their own interaction contracts. The edit-modal tests keep them inert so
// they can focus on save orchestration while state.test.ts covers their Todoist payload semantics.
vi.mock("@/ui/components/obsidian-icon", () => ({ ObsidianIcon: () => null }));
vi.mock("@/ui/createTaskModal/DeadlineSelector", () => ({ DeadlineSelector: () => null }));
vi.mock("@/ui/createTaskModal/DueDateSelector", () => ({ DueDateSelector: () => null }));
vi.mock("@/ui/createTaskModal/LabelSelector", () => ({ LabelSelector: () => null }));
vi.mock("@/ui/createTaskModal/PrioritySelector", () => ({ PrioritySelector: () => null }));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  addedAt: "2026-08-01T00:00:00.000Z",
  content: "Write the report",
  description: "Draft the first section",
  projectId: "project-1",
  sectionId: null,
  parentId: null,
  labels: [],
  priority: Priorities.P3,
  due: null,
  duration: null,
  deadline: null,
  childOrder: 1,
  ...overrides,
});

const renderEditor = (task: Task, onSubmit: (params: UpdateTaskParams) => Promise<void>) => {
  const close = vi.fn();
  const plugin = {
    services: {
      todoist: {
        data: () => ({ labels: { iterActive: () => [] } }),
        isPremium: () => false,
      },
    },
  } as unknown as TodoistPlugin;
  const modal = {
    close,
    popoverContainerEl: document.createElement("div"),
  };
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <PluginContext.Provider value={plugin}>
      <ModalContext.Provider value={modal}>{children}</ModalContext.Provider>
    </PluginContext.Provider>
  );

  return {
    close,
    ...render(
      <EditTaskModal
        task={task}
        projectPath="Work / Planning"
        sectionName="Next"
        onSubmit={onSubmit}
      />,
      { wrapper: Wrapper },
    ),
  };
};

describe("EditTaskModal", () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an untouched recurring schedule out of the submitted update", async () => {
    const task = makeTask({
      due: {
        date: "2026-08-12",
        datetime: "2026-08-12T09:30:00",
        isRecurring: true,
      },
    });
    const onSubmit = vi.fn(async (_params: UpdateTaskParams) => undefined);
    const { close } = renderEditor(task, onSubmit);

    expect(
      screen.getByText(
        "The recurring schedule will stay unchanged unless you choose a new due date.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Draft the final section" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ description: "Draft the final section" }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledWith("Todoist task updated");
  });

  it("stays open and becomes retryable when the Todoist update fails", async () => {
    const remoteError = new Error("Todoist request failed");
    const onSubmit = vi.fn(async (_params: UpdateTaskParams) => {
      throw remoteError;
    });
    const { close } = renderEditor(makeTask(), onSubmit);

    fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
      target: { value: "Write the final report" },
    });
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(close).not.toHaveBeenCalled();
    expect(saveButton).toHaveTextContent("Save changes");
    expect(Notice).toHaveBeenCalledWith("Could not update the Todoist task");
    expect(console.error).toHaveBeenCalledWith("Failed to update Todoist task", remoteError);
  });

  it("closes after a remote success whose Vault projection fails and prevents a duplicate retry", async () => {
    const projectionCause = new Error("Vault is read-only");
    const projectionError = new ProjectTaskProjectionError(projectionCause);
    const onSubmit = vi.fn(async (_params: UpdateTaskParams) => {
      throw projectionError;
    });
    const { close } = renderEditor(makeTask(), onSubmit);

    fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
      target: { value: "Write the final report" },
    });
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(projectionError.remoteMutationSucceeded).toBe(true);
    expect(Notice).toHaveBeenCalledWith(
      "Todoist was updated, but the Vault projection could not be refreshed. Run Project sync again.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "Todoist task updated, but Project sync failed",
      projectionCause,
    );
    expect(saveButton).toBeDisabled();

    fireEvent.click(saveButton);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
