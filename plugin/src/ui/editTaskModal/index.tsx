import { Notice } from "obsidian";
import type React from "react";
import { useMemo, useState } from "react";
import { Button } from "react-aria-components";

import type { Label as TodoistLabel } from "@/api/domain/label";
import type { Task, UpdateTaskParams } from "@/api/domain/task";
import { t } from "@/i18n";
import { ProjectTaskProjectionError } from "@/services/projectTaskCommands";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { ModalContext, PluginContext } from "@/ui/context";
import { type Deadline, DeadlineSelector } from "@/ui/createTaskModal/DeadlineSelector";
import { type DueDate, DueDateSelector } from "@/ui/createTaskModal/DueDateSelector";
import { LabelSelector } from "@/ui/createTaskModal/LabelSelector";
import { PrioritySelector } from "@/ui/createTaskModal/PrioritySelector";
import { TaskContentInput } from "@/ui/createTaskModal/TaskContentInput";

import {
  buildUpdateTaskParams,
  hasTaskUpdate,
  taskDeadlineSelection,
  taskDueDateSelection,
} from "./state";
import "./styles.scss";

export type EditTaskModalProps = {
  task: Task;
  projectPath: string;
  sectionName?: string;
  onSubmit(params: UpdateTaskParams): Promise<void>;
};

export const EditTaskModal: React.FC<EditTaskModalProps> = ({
  task,
  projectPath,
  sectionName,
  onSubmit,
}) => {
  const plugin = PluginContext.use();
  const modal = ModalContext.use();
  const i18n = t().editTaskModal;

  const availableLabels = useMemo(
    () => Array.from(plugin.services.todoist.data().labels.iterActive()),
    [plugin],
  );
  const [selectedLabels, preservedLabelNames] = useMemo(() => {
    const byName = new Map(availableLabels.map((label) => [label.name, label]));
    const selected: TodoistLabel[] = [];
    const preserved: string[] = [];
    for (const name of task.labels) {
      const label = byName.get(name);
      if (label === undefined) {
        preserved.push(name);
      } else {
        selected.push(label);
      }
    }
    return [selected, preserved] as const;
  }, [availableLabels, task.labels]);

  const [content, setContent] = useState(task.content);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [labels, setLabels] = useState<TodoistLabel[]>(selectedLabels);
  const [dueDate, setDueDate] = useState<DueDate | undefined>(() => taskDueDateSelection(task));
  const [dueDateChanged, setDueDateChanged] = useState(false);
  const [deadline, setDeadline] = useState<Deadline | undefined>(() => taskDeadlineSelection(task));
  const [deadlineChanged, setDeadlineChanged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const params = buildUpdateTaskParams(task, {
    content,
    description,
    priority,
    labels,
    preservedLabelNames,
    dueDate,
    dueDateChanged,
    deadline,
    deadlineChanged,
  });
  const canSave = content.trim() !== "" && hasTaskUpdate(params) && !isSaving;

  const save = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setIsSaving(true);
    try {
      await onSubmit(params);
      modal.close();
      new Notice(i18n.successNotice);
    } catch (error: unknown) {
      if (error instanceof ProjectTaskProjectionError) {
        modal.close();
        new Notice(i18n.projectionErrorNotice);
        console.error("Todoist task updated, but Project sync failed", error.projectionCause);
        return;
      }
      new Notice(i18n.errorNotice);
      console.error("Failed to update Todoist task", error);
      setIsSaving(false);
    }
  };

  const location = sectionName === undefined ? projectPath : `${projectPath} / ${sectionName}`;

  return (
    <div className="task-creation-modal-root task-edit-modal-root">
      <TaskContentInput
        className="task-name"
        placeholder={i18n.taskNamePlaceholder}
        content={content}
        onChange={setContent}
        autofocus={true}
        onEnterKey={save}
      />
      <TaskContentInput
        className="task-description"
        placeholder={i18n.descriptionPlaceholder}
        content={description}
        onChange={setDescription}
      />

      <div className="task-edit-location" title={location}>
        <ObsidianIcon id="folder-tree" size="s" />
        <span>{location}</span>
      </div>

      <div className="task-creation-selectors">
        <div className="task-creation-selectors-group">
          <DueDateSelector
            selected={dueDate}
            setSelected={(value) => {
              setDueDate(value);
              setDueDateChanged(true);
            }}
            allowPastDates={true}
          />
          <PrioritySelector selected={priority} setSelected={setPriority} />
          <LabelSelector selected={labels} setSelected={setLabels} />
          {plugin.services.todoist.isPremium() && (
            <DeadlineSelector
              selected={deadline}
              setSelected={(value) => {
                setDeadline(value);
                setDeadlineChanged(true);
              }}
              allowPastDates={true}
            />
          )}
        </div>
      </div>

      {task.due?.isRecurring === true && !dueDateChanged && (
        <div className="task-edit-recurring-hint">
          <ObsidianIcon id="repeat-2" size="xs" />
          <span>{i18n.recurringDueHint}</span>
        </div>
      )}

      <div className="task-edit-actions">
        <Button className="mod-ghost" onPress={modal.close} isDisabled={isSaving}>
          {i18n.cancelButtonLabel}
        </Button>
        <Button className="mod-cta" onPress={() => void save()} isDisabled={!canSave}>
          {isSaving ? i18n.savingButtonLabel : i18n.saveButtonLabel}
        </Button>
      </div>
    </div>
  );
};
