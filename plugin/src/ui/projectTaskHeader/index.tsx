import { Notice } from "obsidian";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";

import { ObsidianIcon, ObsidianLoadingIcon } from "@/ui/components/obsidian-icon";
import { useObsidianTooltip } from "@/ui/hooks";
import {
  type ProjectTaskCardActions,
  type ProjectTaskCardModel,
  useTaskCompletionAction,
} from "@/ui/projectTaskCard";

import "./styles.scss";

/** The task file's own header. It never joins a Markdown embed's action rail. */
export const ProjectTaskHeader: React.FC<{
  actions: ProjectTaskCardActions;
  task: ProjectTaskCardModel;
}> = ({ actions, task }) => {
  const completion = useTaskCompletionAction(actions, task, "Todoist task header");
  const [editPending, setEditPending] = useState(false);
  const [editButton, setEditButton] = useState<HTMLButtonElement | null>(null);
  const [openLink, setOpenLink] = useState<HTMLAnchorElement | null>(null);
  const [subtasksExpanded, setSubtasksExpanded] = useState(false);
  const subtasksId = useId();
  const headingId = useId();
  const location = [...task.projectPath, ...(task.section ? [task.section] : [])];
  const progress = countSubtasks(task.subtasks);
  const editTooltip = task.status === "completed" ? "Reopen before editing" : "Edit task";

  useObsidianTooltip(editButton, editTooltip);
  useObsidianTooltip(openLink, "Open in Todoist");

  const edit = async (): Promise<void> => {
    if (task.status !== "active" || completion.busy || editPending) {
      return;
    }
    setEditPending(true);
    completion.clearError();
    try {
      await actions.edit({ id: task.taskId, filePath: task.filePath });
    } catch (caught: unknown) {
      completion.setError("Could not open this task for editing.");
      new Notice("Could not open this Todoist task for editing.");
      console.error("Failed to edit the Todoist task header", caught);
    } finally {
      setEditPending(false);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="tasks-bridge-task-header"
      data-priority={task.priority}
      data-status={task.status}
    >
      <div className="tasks-bridge-task-header-topline">
        <nav
          aria-label="Task location"
          className="tasks-bridge-task-header-location"
          title={location.join(" / ")}
        >
          <ObsidianIcon aria-hidden="true" id="folder-tree" size="xs" />
          <span>{location.join(" / ") || "Todoist"}</span>
        </nav>
        <div aria-label="Task actions" className="tasks-bridge-task-header-actions" role="toolbar">
          <button
            aria-label="Edit Todoist task"
            className="clickable-icon"
            disabled={task.status !== "active" || completion.busy || editPending}
            onClick={() => void edit()}
            ref={setEditButton}
            type="button"
          >
            {editPending ? <ObsidianLoadingIcon size="s" /> : <ObsidianIcon id="pencil" size="s" />}
          </button>
          <a
            aria-label="Open task in Todoist"
            className="clickable-icon"
            href={task.url}
            ref={setOpenLink}
            rel="noreferrer"
            target="_blank"
          >
            <ObsidianIcon id="external-link" size="s" />
          </a>
        </div>
      </div>
      <div className="tasks-bridge-task-header-heading">
        <CompletionControl completion={completion} disabled={editPending} task={task} />
        <h1 id={headingId}>{task.content}</h1>
      </div>
      <div className="tasks-bridge-task-header-details">
        <TaskMetadata task={task} />
        {task.description.trim() !== "" && <TaskDescription description={task.description} />}
        {completion.error !== null && <TaskError message={completion.error} />}
        {task.subtasks.length > 0 && (
          <div className="tasks-bridge-task-header-subtask-region">
            <button
              aria-controls={subtasksId}
              aria-expanded={subtasksExpanded}
              aria-label={`Subtasks, ${progress.completed} of ${progress.total} completed`}
              className="clickable-icon tasks-bridge-task-header-subtask-toggle"
              onClick={() => setSubtasksExpanded((expanded) => !expanded)}
              type="button"
            >
              <ObsidianIcon id={subtasksExpanded ? "chevron-down" : "chevron-right"} size="xs" />
              <span>Subtasks</span>
              <span className="tasks-bridge-task-header-subtask-progress">
                {progress.completed}/{progress.total}
              </span>
            </button>
            {/* Keep completion locks alive while the hierarchy is collapsed. */}
            <div
              className="tasks-bridge-task-header-subtask-scroll"
              hidden={!subtasksExpanded}
              id={subtasksId}
            >
              <SubtaskList actions={actions} depth={0} subtasks={task.subtasks} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

const CompletionControl: React.FC<{
  completion: ReturnType<typeof useTaskCompletionAction>;
  disabled?: boolean;
  task: ProjectTaskCardModel;
  subtask?: boolean;
}> = ({ completion, disabled = false, task, subtask = false }) => {
  const [control, setControl] = useState<HTMLSpanElement | null>(null);
  const converged = task.completed === (task.status === "completed");
  const mutable = task.status === "active" || task.status === "completed";
  let tooltip = completion.completed ? "Reopen task" : "Complete task";
  if (completion.awaitingProjection) {
    tooltip = "Todoist was updated. Waiting for Project sync.";
  } else if (!converged) {
    tooltip = "Waiting for Todoist status to match this note.";
  } else if (!mutable) {
    tooltip = "This task is not currently available for updates.";
  }
  useObsidianTooltip(control, tooltip);
  const label = subtask ? task.content : "Todoist task";

  return (
    <span
      aria-busy={completion.remotePending}
      className="tasks-bridge-task-header-completion"
      data-priority={task.priority}
      ref={setControl}
    >
      {completion.remotePending ? (
        <ObsidianLoadingIcon aria-label={`Updating ${label}`} role="status" size="s" />
      ) : (
        <input
          aria-label={`${completion.completed ? "Reopen" : "Complete"} ${label}`}
          checked={completion.completed}
          disabled={disabled || !mutable || !converged || completion.busy}
          onChange={() => void completion.toggle()}
          type="checkbox"
        />
      )}
    </span>
  );
};

const TaskMetadata: React.FC<{ task: ProjectTaskCardModel }> = ({ task }) => {
  const due = task.dueDatetime || task.dueDate;
  const duration = formatDuration(task.duration, task.durationUnit);

  return (
    <section aria-label="Task details" className="tasks-bridge-task-header-meta">
      {due && (
        <MetadataPill
          icon="calendar-days"
          label="Due"
          title={[due, task.dueTimezone].filter(Boolean).join(" · ")}
        >
          <time dateTime={due}>{formatDate(due, task.dueTimezone)}</time>
          {task.dueDatetime && task.dueTimezone && (
            <span className="tasks-bridge-task-header-timezone">{task.dueTimezone}</span>
          )}
        </MetadataPill>
      )}
      {task.deadline && (
        <MetadataPill icon="calendar-clock" label="Deadline" title={task.deadline}>
          <span>Deadline</span>
          <time dateTime={task.deadline}>{formatDate(task.deadline)}</time>
        </MetadataPill>
      )}
      {task.recurring && (
        <MetadataPill icon="repeat-2" label="Recurring">
          Recurring
        </MetadataPill>
      )}
      {duration && (
        <MetadataPill icon="timer" label="Duration">
          {duration}
        </MetadataPill>
      )}
      <MetadataPill icon="flag" label="Priority" priority={task.priority}>
        {task.priority}
      </MetadataPill>
      {task.labels.map((label) => (
        <MetadataPill icon="tag" key={label} label="Label">
          {label}
        </MetadataPill>
      ))}
      {task.status !== "active" && (
        <MetadataPill icon={task.status === "completed" ? "check" : "info"} label="Status">
          {statusLabel(task.status)}
        </MetadataPill>
      )}
    </section>
  );
};

const MetadataPill: React.FC<{
  children: React.ReactNode;
  icon: string;
  label: string;
  priority?: string;
  title?: string;
}> = ({ children, icon, label, priority, title }) => (
  <span className="tasks-bridge-task-header-pill" data-priority={priority} title={title}>
    <ObsidianIcon aria-hidden="true" id={icon} size="xs" />
    <span className="tasks-bridge-task-header-sr-label">{label}: </span>
    <span className="tasks-bridge-task-header-pill-value">{children}</span>
  </span>
);

const descriptionPreviewCharacters = 260;
const descriptionPreviewLines = 3;

const TaskDescription: React.FC<{ description: string }> = ({ description }) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const descriptionId = useId();
  const potentiallyLong =
    description.length > descriptionPreviewCharacters ||
    description.split("\n").length > descriptionPreviewLines;

  useEffect(() => {
    const element = paragraph.current;
    if (element === null || expanded || description === "") {
      return;
    }
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    const viewWindow = element.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    const ResizeObserverConstructor = viewWindow?.ResizeObserver;
    if (ResizeObserverConstructor === undefined) {
      return;
    }
    const observer = new ResizeObserverConstructor(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description, expanded]);

  return (
    <div className="tasks-bridge-task-header-description" data-expanded={expanded}>
      <p id={descriptionId} ref={paragraph}>
        {description}
      </p>
      {(potentiallyLong || overflows || expanded) && (
        <button
          aria-controls={descriptionId}
          aria-expanded={expanded}
          className="clickable-icon tasks-bridge-task-header-description-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "Show less" : "Show description"}
          <ObsidianIcon id={expanded ? "chevron-up" : "chevron-down"} size="xs" />
        </button>
      )}
    </div>
  );
};

const SubtaskList: React.FC<{
  actions: ProjectTaskCardActions;
  depth: number;
  subtasks: ProjectTaskCardModel[];
}> = ({ actions, depth, subtasks }) => (
  <ul className="tasks-bridge-task-header-subtasks" data-depth={depth}>
    {subtasks.map((task) => (
      <SubtaskRow actions={actions} depth={depth} key={task.taskId} task={task} />
    ))}
  </ul>
);

const SubtaskRow: React.FC<{
  actions: ProjectTaskCardActions;
  depth: number;
  task: ProjectTaskCardModel;
}> = ({ actions, depth, task }) => {
  const completion = useTaskCompletionAction(actions, task, "Todoist header subtask");
  const [expanded, setExpanded] = useState(false);
  const childrenId = useId();
  const progress = countSubtasks(task.subtasks);

  return (
    <li className="tasks-bridge-task-header-subtask" data-status={task.status}>
      <div className="tasks-bridge-task-header-subtask-row">
        <CompletionControl completion={completion} subtask task={task} />
        <a
          className="internal-link tasks-bridge-task-header-subtask-link"
          data-href={task.filePath}
          href={task.filePath}
          onClick={(event) => {
            event.preventDefault();
            void Promise.resolve()
              .then(() => actions.open(task.filePath))
              .catch((caught: unknown) => {
                completion.setError("Could not open this subtask note.");
                console.error("Failed to open a Todoist subtask note", caught);
              });
          }}
        >
          {task.content}
        </a>
        {task.subtasks.length > 0 && (
          <button
            aria-controls={childrenId}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} subtasks for ${task.content}`}
            className="clickable-icon tasks-bridge-task-header-subtask-disclosure"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            <span>
              {progress.completed}/{progress.total}
            </span>
            <ObsidianIcon id={expanded ? "chevron-down" : "chevron-right"} size="xs" />
          </button>
        )}
      </div>
      {completion.error !== null && <TaskError message={completion.error} />}
      {task.subtasks.length > 0 && (
        <div hidden={!expanded} id={childrenId}>
          <SubtaskList actions={actions} depth={depth + 1} subtasks={task.subtasks} />
        </div>
      )}
    </li>
  );
};

const TaskError: React.FC<{ message: string }> = ({ message }) => (
  <output aria-live="polite" className="tasks-bridge-task-header-error">
    {message}
  </output>
);

const countSubtasks = (tasks: readonly ProjectTaskCardModel[]) => {
  let completed = 0;
  let total = 0;
  const visit = (children: readonly ProjectTaskCardModel[]): void => {
    for (const child of children) {
      total++;
      completed += Number(child.completed);
      visit(child.subtasks);
    }
  };
  visit(tasks);
  return { completed, total };
};

const statusLabel = (status: ProjectTaskCardModel["status"]): string => {
  switch (status) {
    case "completed":
      return "Completed";
    case "out_of_scope":
      return "Outside sync scope";
    case "stale":
      return "Unavailable";
    default:
      return "Active";
  }
};

const formatDate = (value: string, timezone?: string): string => {
  const hasTime = value.includes("T");
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date = new Date(hasTime ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(hasTime ? { hour: "numeric", minute: "2-digit" } : {}),
    ...(hasTime && hasOffset && timezone ? { timeZone: timezone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    return value;
  }
};

const formatDuration = (amount?: number, unit?: string): string | null => {
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (unit === "minute") {
    return `${amount} min`;
  }
  if (unit === "day") {
    return `${amount} ${amount === 1 ? "day" : "days"}`;
  }
  return unit ? `${amount} ${unit}` : String(amount);
};
