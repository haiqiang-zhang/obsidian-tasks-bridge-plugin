import type { Translations } from "@/i18n/translation";

export const en: Translations = {
  notices: {
    migrationFailed: "Failed to apply migrations. Check the console for details.",
    querySyncFailed: (message) => `Query sync failed: ${message}`,
    projectSyncInterrupted:
      "Project sync paused because the mapped Vault folders changed. Wait for Obsidian Sync to settle, then try again.",
    projectSyncComplete: (created, updated, moved, deleted, conflicts) =>
      `Project sync complete: ${created} created, ${updated} updated, ${moved} moved, ${deleted} deleted, ${conflicts} conflicts.`,
    projectSyncFailed: (message) => `Project sync failed: ${message}`,
  },
  settings: {
    general: {
      header: "General",
      links: {
        label: "Links",
        docsButtonLabel: "Docs",
        feedbackButtonLabel: "Feedback",
        donateButtonLabel: "Donate",
      },
      apiToken: {
        label: "API token",
        description: "The Todoist API token to use when fetching tasks",
        buttonLabel: "Setup",
      },
      tokenStorage: {
        label: "Token storage",
        description: "Where the plugin should store your Todoist API token",
        options: {
          secrets: "Obsidian secrets",
          file: "File-based",
        },
      },
    },
    autoRefresh: {
      header: "Auto-refresh",
      toggle: {
        label: "Enable auto-refresh",
        description:
          "Automatically refresh query blocks and Project sync on every device at a shared interval; incoming Obsidian Sync changes delay Project sync until they settle",
      },
      interval: {
        label: "Auto-refresh interval",
        description:
          "The interval, in seconds, used for query blocks and Project sync on this device",
      },
    },
    projectSync: {
      header: "Project sync",
      enabled: {
        label: "Enable project sync",
        description: "Synchronize one or more Todoist projects into independent Vault folder trees",
      },
      preserveUnmanagedItems: {
        label: "Preserve unmanaged Vault content",
        description:
          "Leave files without a managed Todoist task ID and folders not recorded as Tasks Bridge-created untouched.",
      },
      mappings: {
        label: "Project mappings",
        description:
          "Map each Todoist project to the existing Vault folder that will act as its root",
        empty: "No project mappings yet.",
        add: "Add project mapping",
        remove: "Remove mapping",
        mappingLabel: (number) => `Project mapping ${number}`,
        removeLabel: (number) => `Remove project mapping ${number}`,
        pendingMoveLabel: "Historical Sync roots",
        pendingMoveDescription: (folders) =>
          `Monitoring for late Obsidian Sync files and migrating managed notes from: ${folders}`,
      },
      folder: {
        label: "Vault folder",
        description: "The existing Vault folder used as this Todoist project's exact root folder",
        placeholder: "Choose an existing folder",
        exactRootHint: "This is the selected project's root folder, not its parent.",
      },
      project: {
        label: "Todoist project",
        description: "The Todoist project synchronized into this folder",
        noProject: "Select a project",
        loading: "Loading projects…",
        deletedWarning: "This project no longer exists",
        deleted: "deleted",
      },
      includeSubprojects: {
        label: "Include child projects",
        description:
          "Create the selected project's complete descendant hierarchy as nested folders",
      },
      validation: {
        projectRequired: "Select a Todoist project.",
        folderRequired: "Choose a Vault folder.",
        projectUnavailable:
          "This project is unavailable in the current Todoist account. This mapping is paused; reselect a project to use this account.",
        folderMissing: "This Vault folder does not exist.",
        duplicateProject: "This Todoist project is already mapped.",
        folderOverlap: "This Vault folder overlaps another project mapping.",
        hierarchyOverlap:
          "This project is already covered by another mapping that includes child projects.",
      },
      syncNow: {
        label: "Synchronize projects now",
        description: "Fetch every valid project mapping and update its Markdown files now",
        buttonLabel: "Sync now",
        syncingLabel: "Syncing…",
      },
    },
    rendering: {
      header: "Rendering",
      taskFadeAnimation: {
        label: "Enable task fade animation",
        description: "Whether tasks should fade in and out when created or completed",
      },
      dateIcon: {
        label: "Enable dates icon",
        description: "Whether rendered dates should include an icon",
      },
      projectIcon: {
        label: "Enable project & section icon",
        description: "Whether rendered projects & sections should include an icon",
      },
      labelsIcon: {
        label: "Enable label icon",
        description: "Whether rendered labels should include an icon",
      },
    },
    taskCreation: {
      header: "Task creation",
      wrapLinksInParens: {
        label: "Add parenthesis to page links",
        description:
          "When enabled, wraps Obsidian page links in Todoist tasks created from the command",
      },
      addTaskButtonAddsPageLink: {
        label: "Add task button adds page link",
        description:
          "When enabled, the embedded add task button in queries will add a link to the page to the task in the specified place",
        options: {
          off: "Disabled",
          description: "Task description",
          content: "Task name",
        },
      },
      defaultDueDate: {
        label: "Default due date",
        description: "The default due date to set when creating new tasks",
        options: {
          none: "No default",
        },
      },
      defaultProject: {
        label: "Default project",
        description: "The default project to set when creating new tasks",
        placeholder: "Select a project",
        noDefault: "Inbox",
        deletedWarning: "This project no longer exists",
        deleted: "deleted",
      },
      defaultLabels: {
        label: "Default labels",
        description: "The default labels to apply when creating new tasks",
        buttonAddLabel: "Add label",
        buttonNoAvailableLabels: "No labels available",
        noLabels: "No labels configured",
        deletedWarning: "This label no longer exists",
        deleted: "deleted",
      },
      defaultAddTaskAction: {
        label: "Default add task action",
        description: "The default action when clicking the Add task button",
        options: {
          add: "Add task",
          addCopyApp: "Add task and copy link (app)",
          addCopyWeb: "Add task and copy link (web)",
        },
      },
    },
    advanced: {
      header: "Advanced",
      debugLogging: {
        label: "Enable debug logging",
        description: "Whether debug logging should be enabled",
      },
      buildStamp: {
        label: "Build stamp",
        description: "Stamp for the build of this plugin",
      },
    },
    deprecation: {
      warningMessage: "This setting is deprecated and will be removed in a future release.",
    },
  },
  createTaskModal: {
    loadingMessage: "Loading Todoist data...",
    successNotice: "Task created successfully",
    errorNotice: "Failed to create task",
    taskNamePlaceholder: "Task name",
    descriptionPlaceholder: "Description",
    appendedLinkToContentMessage: "A link to this page will be appended to the task name",
    appendedLinkToDescriptionMessage:
      "A link to this page will be appended to the task description",
    cancelButtonLabel: "Cancel",
    addTaskButtonLabel: "Add task",
    addTaskAndCopyAppLabel: "Add task and copy link (app)",
    addTaskAndCopyWebLabel: "Add task and copy link (web)",
    actionMenuLabel: "Add task action menu",
    linkCopiedNotice: "Task created and link copied to clipboard",
    linkCopyFailedNotice: "Task created, but failed to copy link to clipboard",
    failedToFindInboxNotice: "Error: could not find inbox project",
    defaultProjectDeletedNotice: (projectName: string) =>
      `Default project "${projectName}" no longer exists. Using Inbox instead.`,
    defaultLabelsDeletedNotice: (labelNames: string) =>
      `Default labels no longer exist: ${labelNames}. Skipping deleted labels.`,
    dateSelector: {
      buttonLabel: "Set due date",
      dialogLabel: "Due date selector",
      suggestionsLabel: "Due date suggestions",
      datePickerLabel: "Task date",
      emptyDate: "Due date",
      noDate: "No date",
      chooseDateTimeLabel: "Choose date and time…",
      timeDialog: {
        timeLabel: "Time",
        saveButtonLabel: "Save",
        cancelButtonLabel: "Cancel",
        durationLabel: "Duration",
        noDuration: "No duration",
        clearTimeLabel: "Clear time",
        duration: (minutes: number) => {
          const hours = Math.floor(minutes / 60);
          const mins = minutes % 60;

          if (hours === 0) {
            return `${mins}m`;
          }

          return `${hours}h ${mins}m`;
        },
      },
    },
    deadlineSelector: {
      buttonLabel: "Set deadline",
      dialogLabel: "Deadline selector",
      suggestionsLabel: "Deadline suggestions",
      datePickerLabel: "Deadline date",
      placeholder: "Deadline",
      noDeadline: "No deadline",
      chooseDateLabel: "Choose date…",
    },
    labelSelector: {
      buttonLabel: "Set labels",
      buttonText: (num: number) => {
        return `Labels (${num})`;
      },
      labelOptionsLabel: "Label options",
      doneButtonLabel: "Done",
      emptyState: "No labels found",
      search: {
        label: "Filter labels",
        placeholder: "Type a label name",
      },
    },
    prioritySelector: {
      buttonLabel: "Set priority",
      optionsLabel: "Task priority options",
      p1: "Priority 1",
      p2: "Priority 2",
      p3: "Priority 3",
      p4: "Priority 4",
    },
    projectSelector: {
      buttonLabel: "Set project",
      selectorLabel: "Project selector",
      optionsLabel: "Project options",
      emptyState: "No projects or sections found",
      search: {
        label: "Filter projects",
        placeholder: "Type a project name",
      },
    },
    optionsSelector: {
      buttonLabel: "Set options",
      optionsLabel: "Task options",
      addLinkToContent: "Add link to content",
      addLinkToDescription: "Add link to description",
      doNotAddLink: "Do not add link",
    },
  },
  editTaskModal: {
    taskNamePlaceholder: "Task name",
    descriptionPlaceholder: "Description",
    recurringDueHint:
      "The recurring schedule will stay unchanged unless you choose a new due date.",
    cancelButtonLabel: "Cancel",
    saveButtonLabel: "Save changes",
    savingButtonLabel: "Saving…",
    successNotice: "Todoist task updated",
    errorNotice: "Could not update the Todoist task",
    projectionErrorNotice:
      "Todoist was updated, but the Vault projection could not be refreshed. Run Project sync again.",
  },
  onboardingModal: {
    failureNoticeMessage: "Failed to save API token",
    explainer:
      "In order to use this plugin, you must provide your Todoist API token. This allows us to read and write data to or from your Todoist account.",
    todoistGuideHint: {
      before: "You can follow ",
      linkText: "Todoist's guide",
      after: " on finding your API token.",
    },
    tokenInputLabel: "API Token",
    submitButtonLabel: "Save",
    pasteButtonLabel: "Paste from clipboard",
  },
  query: {
    displays: {
      loading: {
        label: "Loading Todoist tasks",
      },
      empty: {
        label: "The query returned no tasks",
      },
      error: {
        header: "Error",
        badRequest:
          "The Todoist API has rejected the request. Please check the filter to ensure it is valid.",
        unauthorized:
          "The Todoist API request is missing or has the incorrect credentials. Please check the API token in the settings.",
        serverError:
          "The Todoist API has returned an error. Please check Todoist's status page: https://status.todoist.net/ and try again later.",
        unknown:
          "Unknown error occurred. Please check the Console in the Developer Tools window for more information",
      },
      parsingError: {
        header: "Error: Query parsing failed",
        unknownErrorMessage:
          "Unknown error occurred. Please check the Console in the Developer Tools window for more information",
      },
    },
    contextMenu: {
      completeTaskLabel: "Complete task",
      openTaskInAppLabel: "Open task in Todoist (app)",
      openTaskInBrowserLabel: "Open task in Todoist (web)",
    },
    failedCloseMessage: "Failed to close task",
    completedHistory: {
      loadEarlier: (months: number) => `Load ${months} months`,
      loadingEarlier: (months: number) => `Loading ${months} months…`,
      loadError: "Could not load earlier completed tasks. Try again.",
    },
    header: {
      errorPostfix: "(Error)",
      refreshTooltip: {
        label: "Refresh tasks",
        lastRefreshed: (datetime: string) => `Last refreshed at: ${datetime}`,
        notRefreshed: "Not queried yet",
      },
    },
    warning: {
      header: "Warnings",
      jsonQuery:
        "This query is written using JSON. This is deprecated and will be removed in a future version. Please use YAML instead.",
      unknownKey: (key: string) => `Found unexpected query key '${key}'. Is this a typo?`,
      dueAndTime:
        "Both 'due' and 'time' show options are set. The 'time' option will be ignored when 'due' is present.",
      projectAndSection:
        "Both 'project' and 'section' show options are set. The 'section' option will be ignored when 'project' is present.",
    },
    groupedHeaders: {
      noDueDate: "No due date",
      overdue: "Overdue",
    },
  },
  commands: {
    sync: "Sync",
    insertQueryBlock: "Insert query block",
    insertProjectTaskBlock: "Insert project task block",
    addTask: "Add task",
    addTaskPageContent: "Add task with current page in task content",
    addTaskPageDescription: "Add task with current page in task description",
  },
  projectTaskPicker: {
    title: "Insert project task",
    search: {
      label: "Search synced project tasks",
      placeholder: "Search by task, project, or section",
    },
    emptyState: "No matching project tasks",
    currentLabel: "Current",
    activeLabel: "Active",
    completedLabel: "Completed",
    notices: {
      noTasks: "No synced project tasks are available. Configure Project sync and run Sync first.",
      contextChanged: "The synchronized task is no longer available. Run the command again.",
    },
  },
  tokenValidation: {
    emptyTokenError: "API token must not be empty",
    invalidTokenError:
      "Oops! Todoist does not recognize this token. Please double check and try again!",
  },
  dates: {
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
    nextWeek: "Next week",
    lastWeekday: (weekday: string) => {
      return `Last ${weekday}`;
    },
    dateTime: (date: string, time: string) => {
      return `${date} at ${time}`;
    },
    dateTimeDuration: (date: string, startTime: string, endTime: string) => {
      return `${date} at ${startTime} - ${endTime}`;
    },
    dateTimeDurationDifferentDays: (
      startDate: string,
      startTime: string,
      endDate: string,
      endTime: string,
    ): string => {
      return `${startDate} at ${startTime} - ${endDate} at ${endTime}`;
    },
    timeDuration: (startTime: string, endTime: string) => {
      return `${startTime} - ${endTime}`;
    },
    timeDurationDifferentDays: (startTime: string, endDate: string, endTime: string) => {
      return `${startTime} - ${endDate} at ${endTime}`;
    },
  },
};
