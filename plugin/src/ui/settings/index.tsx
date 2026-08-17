import {
  type App,
  type Setting as ObsidianSetting,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import type React from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { t } from "@/i18n";
import { PluginContext } from "@/ui/context";

import type TodoistPlugin from "../..";
import { useSettingsStore } from "../../settings";
import { TokenValidation } from "../../token";
import { LabelsControl } from "./LabelsControl";
import { ProjectDropdownControl } from "./ProjectDropdownControl";
import { ProjectSyncMappingsControl } from "./ProjectSyncMappingsControl";
import { ProjectSyncNowControl } from "./ProjectSyncNowControl";
import { Setting } from "./SettingItem";
import { TokenChecker } from "./TokenChecker";
import "./styles.scss";

import { BuildStamp } from "@/stamp";

export class SettingsTab extends PluginSettingTab {
  private readonly plugin: TodoistPlugin;
  private readonly projectSyncValidation = new ProjectSyncValidationState();

  constructor(app: App, plugin: TodoistPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "list-todo";
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const i18n = t().settings;
    const render = (content: React.ReactNode) => (setting: ObsidianSetting) =>
      mountReactControl(setting, this.plugin, content);

    return [
      {
        type: "group",
        heading: i18n.general.header,
        items: [
          {
            name: i18n.general.links.label,
            render: render(<SettingsLinks />),
          },
          {
            name: i18n.general.apiToken.label,
            desc: i18n.general.apiToken.description,
            render: render(<TokenChecker tester={TokenValidation.DefaultTester} />),
          },
          {
            name: i18n.general.tokenStorage.label,
            desc: i18n.general.tokenStorage.description,
            render: render(<TokenStorageControl plugin={this.plugin} />),
          },
        ],
      },
      {
        type: "group",
        heading: i18n.projectSync.header,
        items: [
          {
            name: i18n.projectSync.enabled.label,
            desc: i18n.projectSync.enabled.description,
            render: render(
              <ProjectSyncEnabledControl
                plugin={this.plugin}
                validation={this.projectSyncValidation}
              />,
            ),
          },
          {
            name: i18n.projectSync.preserveUnmanagedItems.label,
            desc: i18n.projectSync.preserveUnmanagedItems.description,
            control: {
              type: "toggle",
              key: "projectSyncPreserveUnmanagedItems",
              defaultValue: true,
            },
          },
          {
            name: i18n.projectSync.mappings.label,
            desc: i18n.projectSync.mappings.description,
            aliases: [i18n.projectSync.project.label, i18n.projectSync.folder.label],
            render: render(
              <ProjectSyncMappingsSetting
                plugin={this.plugin}
                validation={this.projectSyncValidation}
              />,
            ),
          },
          {
            name: i18n.projectSync.syncNow.label,
            desc: i18n.projectSync.syncNow.description,
            render: render(<ProjectSyncNowSetting validation={this.projectSyncValidation} />),
          },
        ],
      },
      {
        type: "group",
        heading: i18n.autoRefresh.header,
        items: [
          {
            name: i18n.autoRefresh.toggle.label,
            desc: i18n.autoRefresh.toggle.description,
            control: { type: "toggle", key: "autoRefreshToggle" },
          },
          {
            name: i18n.autoRefresh.interval.label,
            desc: i18n.autoRefresh.interval.description,
            control: {
              type: "number",
              key: "autoRefreshInterval",
              min: 0,
              step: 1,
            },
          },
        ],
      },
      {
        type: "group",
        heading: i18n.rendering.header,
        items: [
          {
            name: i18n.rendering.taskFadeAnimation.label,
            desc: i18n.rendering.taskFadeAnimation.description,
            control: { type: "toggle", key: "fadeToggle" },
          },
          {
            name: i18n.rendering.dateIcon.label,
            desc: i18n.rendering.dateIcon.description,
            control: { type: "toggle", key: "renderDateIcon" },
          },
          {
            name: i18n.rendering.projectIcon.label,
            desc: i18n.rendering.projectIcon.description,
            control: { type: "toggle", key: "renderProjectIcon" },
          },
          {
            name: i18n.rendering.labelsIcon.label,
            desc: i18n.rendering.labelsIcon.description,
            control: { type: "toggle", key: "renderLabelsIcon" },
          },
        ],
      },
      {
        type: "group",
        heading: i18n.taskCreation.header,
        items: [
          {
            name: i18n.taskCreation.wrapLinksInParens.label,
            desc: i18n.taskCreation.wrapLinksInParens.description,
            control: { type: "toggle", key: "shouldWrapLinksInParens" },
          },
          {
            name: i18n.taskCreation.addTaskButtonAddsPageLink.label,
            desc: i18n.taskCreation.addTaskButtonAddsPageLink.description,
            control: {
              type: "dropdown",
              key: "addTaskButtonAddsPageLink",
              options: {
                off: i18n.taskCreation.addTaskButtonAddsPageLink.options.off,
                description: i18n.taskCreation.addTaskButtonAddsPageLink.options.description,
                content: i18n.taskCreation.addTaskButtonAddsPageLink.options.content,
              },
            },
          },
          {
            name: i18n.taskCreation.defaultDueDate.label,
            desc: i18n.taskCreation.defaultDueDate.description,
            control: {
              type: "dropdown",
              key: "taskCreationDefaultDueDate",
              options: {
                none: i18n.taskCreation.defaultDueDate.options.none,
                today: t().dates.today,
                tomorrow: t().dates.tomorrow,
              },
            },
          },
          {
            name: i18n.taskCreation.defaultProject.label,
            desc: i18n.taskCreation.defaultProject.description,
            render: render(<DefaultProjectControl plugin={this.plugin} />),
          },
          {
            name: i18n.taskCreation.defaultLabels.label,
            desc: i18n.taskCreation.defaultLabels.description,
            render: render(<DefaultLabelsControl plugin={this.plugin} />),
          },
          {
            name: i18n.taskCreation.defaultAddTaskAction.label,
            desc: i18n.taskCreation.defaultAddTaskAction.description,
            control: {
              type: "dropdown",
              key: "defaultAddTaskAction",
              options: {
                add: i18n.taskCreation.defaultAddTaskAction.options.add,
                "add-copy-app": i18n.taskCreation.defaultAddTaskAction.options.addCopyApp,
                "add-copy-web": i18n.taskCreation.defaultAddTaskAction.options.addCopyWeb,
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: i18n.advanced.header,
        items: [
          {
            name: i18n.advanced.debugLogging.label,
            desc: i18n.advanced.debugLogging.description,
            control: { type: "toggle", key: "debugLogging" },
          },
          {
            name: i18n.advanced.buildStamp.label,
            desc: i18n.advanced.buildStamp.description,
            render: render(<span className="setting-item-build-stamp">{BuildStamp}</span>),
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = useSettingsStore.getState();
    return isDeclarativeSettingKey(key) ? settings[key] : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (isBooleanDeclarativeSettingKey(key)) {
      if (typeof value !== "boolean") {
        throw new TypeError(`Expected a boolean value for ${key}`);
      }
      await this.plugin.writeOptions({ [key]: value });
      return;
    }

    if (key === "autoRefreshInterval") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError("Auto-refresh interval must be a non-negative number");
      }
      await this.plugin.writeOptions({ autoRefreshInterval: Math.floor(value) });
      return;
    }

    if (key === "addTaskButtonAddsPageLink") {
      if (value !== "off" && value !== "description" && value !== "content") {
        throw new TypeError("Unknown page-link setting");
      }
      await this.plugin.writeOptions({ addTaskButtonAddsPageLink: value });
      return;
    }

    if (key === "taskCreationDefaultDueDate") {
      if (value !== "none" && value !== "today" && value !== "tomorrow") {
        throw new TypeError("Unknown default due-date setting");
      }
      await this.plugin.writeOptions({ taskCreationDefaultDueDate: value });
      return;
    }

    if (key === "defaultAddTaskAction") {
      if (value !== "add" && value !== "add-copy-app" && value !== "add-copy-web") {
        throw new TypeError("Unknown default add-task action");
      }
      await this.plugin.writeOptions({ defaultAddTaskAction: value });
    }
  }
}

type ProjectSyncValidation = {
  ready: boolean;
  valid: boolean;
};

class ProjectSyncValidationState {
  private snapshot: ProjectSyncValidation = { ready: false, valid: false };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): ProjectSyncValidation => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(valid: boolean, ready: boolean): void {
    if (this.snapshot.valid === valid && this.snapshot.ready === ready) {
      return;
    }
    this.snapshot = { ready, valid };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const mountReactControl = (
  setting: ObsidianSetting,
  plugin: TodoistPlugin,
  content: React.ReactNode,
): (() => void) => {
  const root = createRoot(setting.controlEl);
  root.render(<PluginContext.Provider value={plugin}>{content}</PluginContext.Provider>);
  return () => root.unmount();
};

export const SETTINGS_LINKS = {
  documentation: "https://haiqiang-zhang.github.io/obsidian-tasks-bridge-plugin/",
  donate: "https://www.buymeacoffee.com/jamiebrynes",
  feedback: "https://github.com/haiqiang-zhang/obsidian-tasks-bridge-plugin/issues/new/choose",
} as const;

type SettingsLinksProps = {
  navigate?: (url: string) => void;
};

export const SettingsLinks: React.FC<SettingsLinksProps> = ({
  navigate = (url) => location.replace(url),
}) => {
  const i18n = t().settings.general.links;
  return (
    <>
      <Setting.ButtonControl
        label={i18n.docsButtonLabel}
        icon="book-open"
        onClick={() => {
          navigate(SETTINGS_LINKS.documentation);
        }}
      />
      <Setting.ButtonControl
        label={i18n.feedbackButtonLabel}
        icon="github"
        onClick={() => {
          navigate(SETTINGS_LINKS.feedback);
        }}
      />
      <Setting.ButtonControl
        label={i18n.donateButtonLabel}
        icon="coffee"
        onClick={() => {
          navigate(SETTINGS_LINKS.donate);
        }}
      />
    </>
  );
};

const TokenStorageControl: React.FC<{ plugin: TodoistPlugin }> = ({ plugin }) => {
  const tokenStorage = useSettingsStore((settings) => settings.tokenStorage);
  const i18n = t().settings.general.tokenStorage;
  return (
    <Setting.DropdownControl
      value={tokenStorage}
      options={[
        { label: i18n.options.secrets, value: "secrets" },
        { label: i18n.options.file, value: "file" },
      ]}
      onClick={async (next) => {
        await plugin.services.token.migrateStorage(tokenStorage, next);
        await plugin.writeOptions({ tokenStorage: next });
      }}
    />
  );
};

const ProjectSyncEnabledControl: React.FC<{
  plugin: TodoistPlugin;
  validation: ProjectSyncValidationState;
}> = ({ plugin, validation }) => {
  const enabled = useSettingsStore((settings) => settings.projectSyncEnabled);
  const status = useSyncExternalStore(
    validation.subscribe,
    validation.getSnapshot,
    validation.getSnapshot,
  );
  return (
    <Setting.ToggleControl
      ariaLabel={t().settings.projectSync.enabled.label}
      disabled={!status.valid && !enabled}
      onClick={async (value) => await plugin.writeOptions({ projectSyncEnabled: value })}
      value={enabled}
    />
  );
};

const ProjectSyncMappingsSetting: React.FC<{
  plugin: TodoistPlugin;
  validation: ProjectSyncValidationState;
}> = ({ plugin, validation }) => {
  const enabled = useSettingsStore((settings) => settings.projectSyncEnabled);
  const mappings = useSettingsStore((settings) => settings.projectSyncMappings);
  const [status, setStatus] = useState<ProjectSyncValidation>({ ready: false, valid: false });
  const handleValidityChange = useCallback((valid: boolean, ready: boolean) => {
    setStatus((current) =>
      current.valid === valid && current.ready === ready ? current : { valid, ready },
    );
  }, []);

  useEffect(() => {
    validation.set(status.valid, status.ready);
    if (status.ready && !status.valid && enabled) {
      void plugin.writeOptions({ projectSyncEnabled: false });
    }
  }, [enabled, plugin, status, validation]);

  return (
    <ProjectSyncMappingsControl
      mappings={mappings}
      onChange={async (next, valid) => {
        await plugin.writeOptions({
          projectSyncMappings: next,
          ...(enabled && !valid ? { projectSyncEnabled: false } : {}),
        });
      }}
      onValidityChange={handleValidityChange}
    />
  );
};

const ProjectSyncNowSetting: React.FC<{ validation: ProjectSyncValidationState }> = ({
  validation,
}) => {
  const enabled = useSettingsStore((settings) => settings.projectSyncEnabled);
  const status = useSyncExternalStore(
    validation.subscribe,
    validation.getSnapshot,
    validation.getSnapshot,
  );
  return <ProjectSyncNowControl disabled={!enabled || !status.valid} />;
};

const DefaultProjectControl: React.FC<{ plugin: TodoistPlugin }> = ({ plugin }) => {
  const value = useSettingsStore((settings) => settings.taskCreationDefaultProject);
  return (
    <ProjectDropdownControl
      value={value}
      onChange={async (next) => await plugin.writeOptions({ taskCreationDefaultProject: next })}
    />
  );
};

const DefaultLabelsControl: React.FC<{ plugin: TodoistPlugin }> = ({ plugin }) => {
  const value = useSettingsStore((settings) => settings.taskCreationDefaultLabels);
  return (
    <LabelsControl
      value={value}
      onChange={async (next) => await plugin.writeOptions({ taskCreationDefaultLabels: next })}
    />
  );
};

const booleanDeclarativeSettingKeys = new Set<string>([
  "autoRefreshToggle",
  "projectSyncPreserveUnmanagedItems",
  "fadeToggle",
  "renderDateIcon",
  "renderProjectIcon",
  "renderLabelsIcon",
  "shouldWrapLinksInParens",
  "debugLogging",
]);

type BooleanDeclarativeSettingKey =
  | "autoRefreshToggle"
  | "projectSyncPreserveUnmanagedItems"
  | "fadeToggle"
  | "renderDateIcon"
  | "renderProjectIcon"
  | "renderLabelsIcon"
  | "shouldWrapLinksInParens"
  | "debugLogging";

type DeclarativeSettingKey =
  | BooleanDeclarativeSettingKey
  | "autoRefreshInterval"
  | "addTaskButtonAddsPageLink"
  | "taskCreationDefaultDueDate"
  | "defaultAddTaskAction";

const isBooleanDeclarativeSettingKey = (key: string): key is BooleanDeclarativeSettingKey =>
  booleanDeclarativeSettingKeys.has(key);

const isDeclarativeSettingKey = (key: string): key is DeclarativeSettingKey =>
  isBooleanDeclarativeSettingKey(key) ||
  key === "autoRefreshInterval" ||
  key === "addTaskButtonAddsPageLink" ||
  key === "taskCreationDefaultDueDate" ||
  key === "defaultAddTaskAction";
