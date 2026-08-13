import { Notice } from "obsidian";
import type React from "react";
import { useState } from "react";
import { createPortal } from "react-dom";

import type { ManagedProjectTaskReference } from "@/services/projectTaskCommands";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";
import { ObsidianIcon, ObsidianLoadingIcon } from "@/ui/components/obsidian-icon";
import { useEmbedActions, useObsidianTooltip } from "@/ui/hooks";

import "./styles.scss";

export type ProjectTaskCardModel = {
  completed: boolean;
  content: string;
  description: string;
  filePath: string;
  labels: string[];
  priority: string;
  projectPath: string[];
  section?: string;
  status: "active" | "completed" | "stale" | "out_of_scope";
  subtasks: ProjectTaskCardModel[];
  taskId: string;
  url: string;
};

export type ProjectTaskCardActions = {
  setCompleted(reference: ManagedProjectTaskReference, completed: boolean): Promise<void>;
  edit(reference: ManagedProjectTaskReference): Promise<void> | void;
  open(filePath: string): Promise<void> | void;
};

export const ProjectTaskCard: React.FC<{
  actions: ProjectTaskCardActions;
  task: ProjectTaskCardModel;
}> = ({ actions, task }) => {
  const [pending, setPending] = useState<"completion" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editButton, setEditButton] = useState<HTMLButtonElement | null>(null);
  const [openLink, setOpenLink] = useState<HTMLAnchorElement | null>(null);
  const [subtasksCollapsed, setSubtasksCollapsed] = useState(false);
  const embedActions = useEmbedActions();
  const reference = { id: task.taskId, filePath: task.filePath };
  const mutable = task.status === "active" || task.status === "completed";
  const location = [...task.projectPath, ...(task.section === undefined ? [] : [task.section])];
  const editTooltip = task.status === "completed" ? "Reopen before editing" : "Edit task";
  const subtaskProgress = countSubtaskProgress(task.subtasks);

  useObsidianTooltip(editButton, editTooltip);
  useObsidianTooltip(openLink, "Open in Todoist");

  const toggleCompleted = async (): Promise<void> => {
    if (!mutable || pending !== null) {
      return;
    }
    setPending("completion");
    setError(null);
    try {
      await actions.setCompleted(reference, !task.completed);
    } catch (caught: unknown) {
      if (caught instanceof ProjectTaskProjectionError) {
        setError("Todoist was updated, but this note still needs Project sync.");
      } else {
        setError("Todoist could not be updated. Your previous task state was restored.");
      }
      console.error("Failed to update this projected Todoist task", caught);
    } finally {
      setPending(null);
    }
  };

  const edit = async (): Promise<void> => {
    if (task.status !== "active" || pending !== null) {
      return;
    }
    setPending("edit");
    setError(null);
    try {
      await actions.edit(reference);
    } catch (caught: unknown) {
      setError("Could not open this task for editing.");
      new Notice("Could not open this Todoist task for editing.");
      console.error("Failed to edit this projected Todoist task", caught);
    } finally {
      setPending(null);
    }
  };

  const controls = (
    <div
      aria-label="Todoist task"
      className="tasks-bridge-note-card-actions interactive-child"
      role="toolbar"
    >
      <button
        aria-label="Edit Todoist task"
        className="embed-action clickable-icon tasks-bridge-note-card-action"
        disabled={task.status !== "active" || pending !== null}
        onClick={() => void edit()}
        ref={setEditButton}
        type="button"
      >
        {pending === "edit" ? (
          <ObsidianLoadingIcon size="m" />
        ) : (
          <ObsidianIcon id="pencil" size="m" />
        )}
      </button>
      <a
        aria-label="Open task in Todoist"
        className="embed-action clickable-icon tasks-bridge-note-card-action"
        href={task.url}
        rel="noreferrer"
        ref={setOpenLink}
        target="_blank"
      >
        <ObsidianIcon id="external-link" size="m" />
      </a>
    </div>
  );

  return (
    <>
      <section className="tasks-bridge-note-card" data-status={task.status}>
        <div className="tasks-bridge-note-card-main">
          <span
            className="tasks-bridge-note-card-completion"
            data-loading={pending === "completion" || undefined}
          >
            <input
              aria-label={task.completed ? "Reopen Todoist task" : "Complete Todoist task"}
              checked={task.completed}
              disabled={!mutable || pending !== null}
              onChange={() => void toggleCompleted()}
              type="checkbox"
            />
            {pending === "completion" && <ObsidianLoadingIcon size="s" />}
          </span>
          <div className="tasks-bridge-note-card-content">
            <div className="tasks-bridge-note-card-heading">
              <h1>{task.content}</h1>
              {task.status !== "active" && task.status !== "completed" && (
                <span className="tasks-bridge-note-card-status">
                  {task.status.replace("_", " ")}
                </span>
              )}
            </div>
            {task.description !== "" && (
              <p className="tasks-bridge-note-card-description">{task.description}</p>
            )}
            <div className="tasks-bridge-note-card-meta">
              <span title={location.join(" / ")}>
                <ObsidianIcon id="folder-tree" size="xs" />
                {location.join(" / ")}
              </span>
              <span>
                <ObsidianIcon id="flag" size="xs" />
                {task.priority}
              </span>
              {task.labels.map((label) => (
                <span key={label}>
                  <ObsidianIcon id="tag" size="xs" />
                  {label}
                </span>
              ))}
            </div>
            {error !== null && (
              <output className="tasks-bridge-note-card-error" aria-live="polite">
                {error}
              </output>
            )}
          </div>
        </div>
        {task.subtasks.length > 0 && (
          <div className="tasks-bridge-note-card-subtask-region">
            <div className="tasks-bridge-note-card-subtask-header">
              <button
                aria-expanded={!subtasksCollapsed}
                className="tasks-bridge-note-card-subtask-heading"
                onClick={() => setSubtasksCollapsed((collapsed) => !collapsed)}
                type="button"
              >
                <ObsidianIcon id="git-branch" size="xs" />
                Subtasks
              </button>
              <output
                aria-label={`${subtaskProgress.completed} of ${subtaskProgress.total} subtasks completed`}
                className="tasks-bridge-note-card-subtask-progress"
              >
                {subtaskProgress.completed} of {subtaskProgress.total} completed
              </output>
            </div>
            {!subtasksCollapsed && (
              <SubtaskList actions={actions} depth={0} subtasks={task.subtasks} />
            )}
          </div>
        )}
        {embedActions === null && (
          <div className="tasks-bridge-note-card-fallback-actions">{controls}</div>
        )}
      </section>
      {embedActions !== null && createPortal(controls, embedActions)}
    </>
  );
};

const SubtaskList: React.FC<{
  actions: ProjectTaskCardActions;
  depth: number;
  subtasks: ProjectTaskCardModel[];
}> = ({ actions, depth, subtasks }) => {
  return (
    <ul className="tasks-bridge-note-card-subtasks" data-depth={depth}>
      {subtasks.map((subtask) => (
        <SubtaskRow actions={actions} depth={depth} key={subtask.taskId} task={subtask} />
      ))}
    </ul>
  );
};

const SubtaskRow: React.FC<{
  actions: ProjectTaskCardActions;
  depth: number;
  task: ProjectTaskCardModel;
}> = ({ actions, depth, task }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutable = task.status === "active" || task.status === "completed";
  const reference = { id: task.taskId, filePath: task.filePath };
  const subtaskProgress = countSubtaskProgress(task.subtasks);

  const toggleCompleted = async (): Promise<void> => {
    if (!mutable || pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await actions.setCompleted(reference, !task.completed);
    } catch (caught: unknown) {
      setError(
        caught instanceof ProjectTaskProjectionError
          ? "Todoist was updated, but this note still needs Project sync."
          : "Todoist could not be updated. Your previous task state was restored.",
      );
      console.error("Failed to update this projected Todoist subtask", caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="tasks-bridge-note-card-subtask" data-status={task.status}>
      <div className="tasks-bridge-note-card-subtask-row">
        <span
          className="tasks-bridge-note-card-subtask-completion"
          data-loading={pending || undefined}
        >
          <input
            aria-label={task.completed ? `Reopen ${task.content}` : `Complete ${task.content}`}
            checked={task.completed}
            disabled={!mutable || pending}
            onChange={() => void toggleCompleted()}
            type="checkbox"
          />
          {pending && <ObsidianLoadingIcon size="s" />}
        </span>
        <a
          className="tasks-bridge-note-card-subtask-link"
          data-href={task.filePath}
          href={task.filePath}
          onClick={(event) => {
            event.preventDefault();
            void actions.open(task.filePath);
          }}
        >
          {task.content}
        </a>
        {task.subtasks.length > 0 && (
          <>
            <output
              aria-label={`${subtaskProgress.completed} of ${subtaskProgress.total} subtasks completed`}
              className="tasks-bridge-note-card-subtask-count"
            >
              {subtaskProgress.completed}/{subtaskProgress.total}
            </output>
            <SubtaskDisclosure
              collapsed={collapsed}
              onCollapse={() => setCollapsed((current) => !current)}
              taskName={task.content}
            />
          </>
        )}
      </div>
      {error !== null && (
        <output className="tasks-bridge-note-card-error" aria-live="polite">
          {error}
        </output>
      )}
      {task.subtasks.length > 0 && !collapsed && (
        <SubtaskList actions={actions} depth={depth + 1} subtasks={task.subtasks} />
      )}
    </li>
  );
};

const SubtaskDisclosure: React.FC<{
  collapsed: boolean;
  onCollapse(): void;
  taskName: string;
}> = ({ collapsed, onCollapse, taskName }) => (
  <button
    aria-expanded={!collapsed}
    aria-label={`${collapsed ? "Expand" : "Collapse"} subtasks for ${taskName}`}
    className="clickable-icon nav-collapse-icon tasks-bridge-note-card-subtask-disclosure"
    onClick={onCollapse}
    type="button"
  >
    <ObsidianIcon id={collapsed ? "chevron-right" : "chevron-down"} size="xs" />
  </button>
);

const countSubtaskProgress = (
  subtasks: readonly ProjectTaskCardModel[],
): { completed: number; total: number } => {
  let completed = 0;
  let total = 0;
  const visit = (tasks: readonly ProjectTaskCardModel[]): void => {
    for (const task of tasks) {
      total++;
      if (task.completed) {
        completed++;
      }
      visit(task.subtasks);
    }
  };
  visit(subtasks);
  return { completed, total };
};
