import { toCalendarDateTime, toZoned } from "@internationalized/date";
import { Notice, type TFile } from "obsidian";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "react-aria-components";

import { timezone, today } from "@/infra/time";
import {
  type AddTaskAction,
  type DueDateDefaultSetting,
  type LabelsDefaultSetting,
  type ProjectDefaultSetting,
  useSettingsStore,
} from "@/settings";
import { ModalContext, PluginContext } from "@/ui/context";
import { useObsidianMenu } from "@/ui/obsidianMenu";
import { uiText } from "@/uiText";
import { assertNever } from "@/utils/types";

import type TodoistPlugin from "../..";
import type { Label as TodoistLabel } from "../../api/domain/label";
import type { CreateTaskParams, Priority } from "../../api/domain/task";
import { ObsidianIcon } from "../components/obsidian-icon";
import { type Deadline, DeadlineSelector } from "./DeadlineSelector";
import { type DueDate, DueDateSelector } from "./DueDateSelector";
import { LabelSelector } from "./LabelSelector";
import { PrioritySelector } from "./PrioritySelector";
import { type ProjectIdentifier, ProjectSelector } from "./ProjectSelector";
import { TaskContentInput } from "./TaskContentInput";
import { buildClipboardMarkdown, buildTaskContent, type FileInfo } from "./taskContent";
import "./styles.scss";

import { OptionsSelector } from "@/ui/createTaskModal/OptionsSelector";
import type { UiText } from "@/uiText";

const toFileInfo = (file: TFile | undefined): FileInfo | undefined => {
  if (file === undefined) {
    return undefined;
  }

  return {
    name: file.name,
    path: file.path,
    vaultName: file.vault.getName(),
  };
};

const readyCheckIntervalMs = 500;

export type LinkDestination = "content" | "description";

export type TaskCreationOptions = {
  appendLinkTo?: LinkDestination;
};

type CreateTaskProps = {
  initialContent: string;
  fileContext: TFile | undefined;
  options: TaskCreationOptions;
};

const getLinkDestinationMessage = (
  destination: LinkDestination | undefined,
  text: UiText["createTaskModal"],
): string | undefined => {
  switch (destination) {
    case "content":
      return text.appendedLinkToContentMessage;
    case "description":
      return text.appendedLinkToDescriptionMessage;
    default:
      return undefined;
  }
};

const calculateDefaultDueDate = (setting: DueDateDefaultSetting): DueDate | undefined => {
  switch (setting) {
    case "none":
      return undefined;
    case "today":
      return {
        date: today(),
        timeInfo: undefined,
      };
    case "tomorrow":
      return {
        date: today().add({ days: 1 }),
        timeInfo: undefined,
      };
    default:
      return assertNever(setting, "Unknown due date default setting");
  }
};

const calculateDefaultProject = (
  plugin: TodoistPlugin,
  projectSetting: ProjectDefaultSetting,
): ProjectIdentifier => {
  if (projectSetting === null) {
    return getInboxProject(plugin);
  }

  const project = plugin.services.todoist.data().projects.byId(projectSetting.projectId);
  if (project === undefined) {
    const noticeMsg = uiText.createTaskModal.defaultProjectDeletedNotice(
      projectSetting.projectName,
    );
    new Notice(noticeMsg);
    return getInboxProject(plugin);
  }

  return {
    projectId: projectSetting.projectId,
  };
};

const calculateDefaultLabels = (
  plugin: TodoistPlugin,
  labelsSetting: LabelsDefaultSetting,
): TodoistLabel[] => {
  if (labelsSetting.length === 0) {
    return [];
  }

  const allLabels = Array.from(plugin.services.todoist.data().labels.iterActive());
  const validLabels: TodoistLabel[] = [];
  const deletedLabelNames: string[] = [];

  for (const defaultLabel of labelsSetting) {
    const label = allLabels.find((l) => l.id === defaultLabel.labelId);
    if (label !== undefined) {
      validLabels.push(label);
    } else {
      deletedLabelNames.push(defaultLabel.labelName);
    }
  }

  if (deletedLabelNames.length > 0) {
    const noticeMsg = uiText.createTaskModal.defaultLabelsDeletedNotice(
      deletedLabelNames.join(", "),
    );
    new Notice(noticeMsg);
  }

  return validLabels;
};

export const CreateTaskModal: React.FC<CreateTaskProps> = (props) => {
  const plugin = PluginContext.use();

  const [isReady, setIsReady] = useState(plugin.services.todoist.isReady());

  const refreshIsReady = () => {
    if (isReady) {
      return;
    }

    setIsReady(plugin.services.todoist.isReady());
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: we don't want to reset this when isReady changes.
  useEffect(() => {
    const id = window.setInterval(refreshIsReady, readyCheckIntervalMs);
    return () => window.clearInterval(id);
  }, []);

  const text = uiText.createTaskModal;

  if (!isReady) {
    return <div className="task-creation-modal-root">{text.loadingMessage}</div>;
  }

  return <CreateTaskModalContent {...props} />;
};

const CreateTaskModalContent: React.FC<CreateTaskProps> = ({
  initialContent,
  fileContext,
  options: initialOptions,
}) => {
  const plugin = PluginContext.use();
  const settings = useSettingsStore();
  const modal = ModalContext.use();

  const [content, setContent] = useState(initialContent);
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<DueDate | undefined>(() =>
    calculateDefaultDueDate(settings.taskCreationDefaultDueDate),
  );
  const [priority, setPriority] = useState<Priority>(1);
  const [labels, setLabels] = useState<TodoistLabel[]>(() =>
    calculateDefaultLabels(plugin, settings.taskCreationDefaultLabels),
  );
  const [deadline, setDeadline] = useState<Deadline | undefined>();
  const [project, setProject] = useState<ProjectIdentifier>(
    calculateDefaultProject(plugin, settings.taskCreationDefaultProject),
  );

  const [options, setOptions] = useState<TaskCreationOptions>(initialOptions);
  const [currentAction, setCurrentAction] = useState<AddTaskAction>(settings.defaultAddTaskAction);

  const isPremium = plugin.services.todoist.isPremium();
  const isSubmitButtonDisabled = content === "" && options.appendLinkTo !== "content";

  const text = uiText.createTaskModal;

  const createTask = async (action: AddTaskAction) => {
    if (isSubmitButtonDisabled) {
      return;
    }

    const fileInfo = toFileInfo(fileContext);

    modal.close();

    const params: CreateTaskParams = {
      description: buildTaskContent(description, toFileInfo(fileContext), {
        appendLink: options.appendLinkTo === "description",
        wrapInParens: settings.shouldWrapLinksInParens,
      }),
      priority,
      labels: labels.map((l) => l.name),
      projectId: project.projectId,
      sectionId: project.sectionId,
    };

    if (dueDate !== undefined) {
      if (dueDate.timeInfo !== undefined) {
        params.dueDatetime = toZoned(
          toCalendarDateTime(dueDate.date, dueDate.timeInfo.time),
          timezone(),
        ).toAbsoluteString();
      } else {
        params.dueDate = dueDate.date.toString();
      }
    }

    if (deadline !== undefined) {
      params.deadlineDate = deadline.date.toString();
    }

    try {
      const taskContent = buildTaskContent(content, toFileInfo(fileContext), {
        appendLink: options.appendLinkTo === "content",
        wrapInParens: settings.shouldWrapLinksInParens,
      });

      const task = await plugin.services.todoist.actions.createTask(taskContent, params);

      if (action === "add-copy-app" || action === "add-copy-web") {
        const taskRef = {
          id: task.id,
          projectId: task.projectId,
        };

        const markdownLink = buildClipboardMarkdown(
          content,
          taskRef,
          {
            appendLink: options.appendLinkTo === "content",
            variant: action,
          },
          fileInfo,
        );
        try {
          await navigator.clipboard.writeText(markdownLink);
          new Notice(text.linkCopiedNotice);
        } catch (clipboardErr) {
          new Notice(text.linkCopyFailedNotice);
          console.error("Failed to copy to clipboard", clipboardErr);
        }
      } else {
        new Notice(text.successNotice);
      }
    } catch (err) {
      new Notice(text.errorNotice);
      console.error("Failed to create task", err);
    }
  };

  const getActionLabel = (action: AddTaskAction): string => {
    switch (action) {
      case "add":
        return text.addTaskButtonLabel;
      case "add-copy-app":
        return text.addTaskAndCopyAppLabel;
      case "add-copy-web":
        return text.addTaskAndCopyWebLabel;
      default:
        return assertNever(action, "Unknown add task action");
    }
  };

  const linkDestinationMessage = getLinkDestinationMessage(options.appendLinkTo, text);
  const addTaskActions: Array<{ action: AddTaskAction; label: string }> = [
    { action: "add", label: text.addTaskButtonLabel },
    { action: "add-copy-app", label: text.addTaskAndCopyAppLabel },
    { action: "add-copy-web", label: text.addTaskAndCopyWebLabel },
  ];
  const {
    anchorRef: addTaskMenuAnchorRef,
    isOpen: isAddTaskMenuOpen,
    toggleMenu: toggleAddTaskMenu,
  } = useObsidianMenu((menu) => {
    for (const item of addTaskActions) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(item.label)
          .setChecked(item.action === currentAction)
          .onClick(() => setCurrentAction(item.action)),
      );
    }
  });

  return (
    <div className="task-creation-modal-root">
      <TaskContentInput
        className="task-name"
        placeholder={text.taskNamePlaceholder}
        content={content}
        onChange={setContent}
        autofocus={true}
        onEnterKey={() => createTask(currentAction)}
      />
      <TaskContentInput
        className="task-description"
        placeholder={text.descriptionPlaceholder}
        content={description}
        onChange={setDescription}
      />
      <div className="task-creation-selectors">
        <div className="task-creation-selectors-group">
          <DueDateSelector selected={dueDate} setSelected={setDueDate} />
          <PrioritySelector selected={priority} setSelected={setPriority} />
          <LabelSelector selected={labels} setSelected={setLabels} />
          {isPremium && <DeadlineSelector selected={deadline} setSelected={setDeadline} />}
        </div>
        <div className="task-creation-selectors-group">
          <OptionsSelector selected={options} setSelected={setOptions} />
        </div>
      </div>
      <div className="task-creation-notes">
        <ul>{linkDestinationMessage && <li>{linkDestinationMessage}</li>}</ul>
      </div>
      <hr />
      <div className="task-creation-controls">
        <div>
          <ProjectSelector selected={project} setSelected={setProject} />
        </div>
        <div className="task-creation-action">
          <Button onPress={() => modal.close()} aria-label={text.cancelButtonLabel}>
            {text.cancelButtonLabel}
          </Button>
          <div className="add-task-button-group">
            <Button
              className="mod-cta add-task-primary"
              isDisabled={isSubmitButtonDisabled}
              onPress={() => void createTask(currentAction)}
              aria-label={getActionLabel(currentAction)}
            >
              {getActionLabel(currentAction)}
            </Button>
            <Button
              ref={addTaskMenuAnchorRef}
              aria-expanded={isAddTaskMenuOpen}
              aria-haspopup="menu"
              aria-label={text.actionMenuLabel}
              className="mod-cta add-task-dropdown"
              isDisabled={isSubmitButtonDisabled}
              onPress={toggleAddTaskMenu}
            >
              <ObsidianIcon id="chevron-down" size="s" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const getInboxProject = (plugin: TodoistPlugin): ProjectIdentifier => {
  const { todoist } = plugin.services;
  const projects = Array.from(todoist.data().projects.iterActive());

  for (const project of projects) {
    if (project.inboxProject) {
      return {
        projectId: project.id,
      };
    }
  }

  const text = uiText.createTaskModal;

  new Notice(text.failedToFindInboxNotice);
  throw new Error("Could not find inbox project");
};
