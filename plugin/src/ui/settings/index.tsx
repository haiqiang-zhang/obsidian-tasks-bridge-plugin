import {
  type App,
  type Setting as ObsidianSetting,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import type React from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { t } from "@/i18n";
import { PluginContext } from "@/ui/context";

import type TodoistPlugin from "../..";
import { type Settings, type TokenStorageSetting, useSettingsStore } from "../../settings";
import { TokenValidation } from "../../token";
import { AutoRefreshIntervalControl } from "./AutoRefreshIntervalControl";
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
  private reactRoot: Root | undefined;

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

  display() {
    this.containerEl.empty();
    this.reactRoot = createRoot(this.containerEl);
    this.reactRoot.render(<SettingsRoot plugin={this.plugin} />);
  }

  hide() {
    this.reactRoot?.unmount();
  }
}

type Props = {
  plugin: TodoistPlugin;
};

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

const SettingsLinks: React.FC = () => {
  const i18n = t().settings.general.links;
  return (
    <>
      <Setting.ButtonControl
        label={i18n.docsButtonLabel}
        icon="book-open"
        onClick={() => {
          location.replace(
            "https://haiqiang-zhang.github.io/obsidian-tasks-bridge-plugin/docs/overview/",
          );
        }}
      />
      <Setting.ButtonControl
        label={i18n.feedbackButtonLabel}
        icon="github"
        onClick={() => {
          location.replace(
            "https://github.com/haiqiang-zhang/obsidian-tasks-bridge-plugin/issues/new/choose",
          );
        }}
      />
      <Setting.ButtonControl
        label={i18n.donateButtonLabel}
        icon="coffee"
        onClick={() => {
          location.replace("https://www.buymeacoffee.com/jamiebrynes");
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
      onValidityChange={(valid, ready) => setStatus({ valid, ready })}
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
  "fadeToggle",
  "renderDateIcon",
  "renderProjectIcon",
  "renderLabelsIcon",
  "shouldWrapLinksInParens",
  "debugLogging",
]);

type BooleanDeclarativeSettingKey =
  | "autoRefreshToggle"
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

type SettingsKeys<V> = {
  [K in keyof Settings]: Settings[K] extends V ? K : never;
}[keyof Settings];

const SettingsRoot: React.FC<Props> = ({ plugin }) => {
  const settings = useSettingsStore();
  const [projectSyncValidation, setProjectSyncValidation] = useState({
    ready: false,
    valid: false,
  });
  const onProjectSyncValidityChange = useCallback((valid: boolean, ready: boolean) => {
    setProjectSyncValidation((current) =>
      current.valid === valid && current.ready === ready ? current : { ready, valid },
    );
  }, []);

  useEffect(() => {
    if (
      projectSyncValidation.ready &&
      !projectSyncValidation.valid &&
      settings.projectSyncEnabled
    ) {
      void plugin.writeOptions({ projectSyncEnabled: false });
    }
  }, [plugin, projectSyncValidation, settings.projectSyncEnabled]);

  const mkOptionUpdate = <K extends keyof Settings>(key: K) => {
    return async (val: Settings[K]) => {
      await plugin.writeOptions({
        [key]: val,
      });
    };
  };

  const toggleProps = (key: SettingsKeys<boolean>) => {
    const onClick = mkOptionUpdate(key);
    const value = settings[key];

    return {
      value,
      onClick,
    };
  };

  const i18n = t().settings;

  return (
    <PluginContext.Provider value={plugin}>
      <h2>{i18n.general.header}</h2>
      <Setting.Root name={i18n.general.links.label} description="">
        <Setting.ButtonControl
          label={i18n.general.links.docsButtonLabel}
          icon="book-open"
          onClick={() => {
            location.replace(
              "https://haiqiang-zhang.github.io/obsidian-tasks-bridge-plugin/docs/overview/",
            );
          }}
        />
        <Setting.ButtonControl
          label={i18n.general.links.feedbackButtonLabel}
          icon="github"
          onClick={() => {
            location.replace(
              "https://github.com/haiqiang-zhang/obsidian-tasks-bridge-plugin/issues/new/choose",
            );
          }}
        />
        <Setting.ButtonControl
          label={i18n.general.links.donateButtonLabel}
          icon="coffee"
          onClick={() => {
            location.replace("https://www.buymeacoffee.com/jamiebrynes");
          }}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.general.apiToken.label}
        description={i18n.general.apiToken.description}
      >
        <TokenChecker tester={TokenValidation.DefaultTester} />
      </Setting.Root>
      <Setting.Root
        name={i18n.general.tokenStorage.label}
        description={i18n.general.tokenStorage.description}
      >
        <Setting.DropdownControl
          value={settings.tokenStorage}
          options={[
            {
              label: i18n.general.tokenStorage.options.secrets,
              value: "secrets",
            },
            {
              label: i18n.general.tokenStorage.options.file,
              value: "file",
            },
          ]}
          onClick={async (val: TokenStorageSetting) => {
            const oldStorage = settings.tokenStorage;
            await plugin.services.token.migrateStorage(oldStorage, val);
            await plugin.writeOptions({ tokenStorage: val });
          }}
        />
      </Setting.Root>

      <h2>{i18n.projectSync.header}</h2>
      <Setting.Root
        name={i18n.projectSync.enabled.label}
        description={i18n.projectSync.enabled.description}
      >
        <Setting.ToggleControl
          {...toggleProps("projectSyncEnabled")}
          ariaLabel={i18n.projectSync.enabled.label}
          disabled={!projectSyncValidation.valid && !settings.projectSyncEnabled}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.projectSync.mappings.label}
        description={i18n.projectSync.mappings.description}
      >
        <ProjectSyncMappingsControl
          mappings={settings.projectSyncMappings}
          onChange={async (mappings, valid) => {
            await plugin.writeOptions({
              projectSyncMappings: mappings,
              ...(settings.projectSyncEnabled && !valid ? { projectSyncEnabled: false } : {}),
            });
          }}
          onValidityChange={onProjectSyncValidityChange}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.projectSync.syncNow.label}
        description={i18n.projectSync.syncNow.description}
      >
        <ProjectSyncNowControl
          disabled={!settings.projectSyncEnabled || !projectSyncValidation.valid}
        />
      </Setting.Root>

      <h2>{i18n.autoRefresh.header}</h2>
      <Setting.Root
        name={i18n.autoRefresh.toggle.label}
        description={i18n.autoRefresh.toggle.description}
      >
        <Setting.ToggleControl {...toggleProps("autoRefreshToggle")} />
      </Setting.Root>
      <Setting.Root
        name={i18n.autoRefresh.interval.label}
        description={i18n.autoRefresh.interval.description}
      >
        <AutoRefreshIntervalControl
          initialValue={settings.autoRefreshInterval}
          onChange={mkOptionUpdate("autoRefreshInterval")}
        />
      </Setting.Root>

      <h2>{i18n.rendering.header}</h2>
      <Setting.Root
        name={i18n.rendering.taskFadeAnimation.label}
        description={i18n.rendering.taskFadeAnimation.description}
      >
        <Setting.ToggleControl {...toggleProps("fadeToggle")} />
      </Setting.Root>

      <Setting.Root
        name={i18n.rendering.dateIcon.label}
        description={i18n.rendering.dateIcon.description}
      >
        <Setting.ToggleControl {...toggleProps("renderDateIcon")} />
      </Setting.Root>
      <Setting.Root
        name={i18n.rendering.projectIcon.label}
        description={i18n.rendering.projectIcon.description}
      >
        <Setting.ToggleControl {...toggleProps("renderProjectIcon")} />
      </Setting.Root>
      <Setting.Root
        name={i18n.rendering.labelsIcon.label}
        description={i18n.rendering.labelsIcon.description}
      >
        <Setting.ToggleControl {...toggleProps("renderLabelsIcon")} />
      </Setting.Root>

      <h2>{i18n.taskCreation.header}</h2>
      <Setting.Root
        name={i18n.taskCreation.wrapLinksInParens.label}
        description={i18n.taskCreation.wrapLinksInParens.description}
      >
        <Setting.ToggleControl {...toggleProps("shouldWrapLinksInParens")} />
      </Setting.Root>
      <Setting.Root
        name={i18n.taskCreation.addTaskButtonAddsPageLink.label}
        description={i18n.taskCreation.addTaskButtonAddsPageLink.description}
      >
        <Setting.DropdownControl
          value={settings.addTaskButtonAddsPageLink}
          options={[
            {
              label: i18n.taskCreation.addTaskButtonAddsPageLink.options.off,
              value: "off",
            },
            {
              label: i18n.taskCreation.addTaskButtonAddsPageLink.options.description,
              value: "description",
            },
            {
              label: i18n.taskCreation.addTaskButtonAddsPageLink.options.content,
              value: "content",
            },
          ]}
          onClick={async (val) => {
            await plugin.writeOptions({
              addTaskButtonAddsPageLink: val,
            });
          }}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.taskCreation.defaultDueDate.label}
        description={i18n.taskCreation.defaultDueDate.description}
      >
        <Setting.DropdownControl
          value={settings.taskCreationDefaultDueDate}
          options={[
            {
              label: i18n.taskCreation.defaultDueDate.options.none,
              value: "none",
            },
            {
              label: t().dates.today,
              value: "today",
            },
            {
              label: t().dates.tomorrow,
              value: "tomorrow",
            },
          ]}
          onClick={async (val) => {
            await plugin.writeOptions({
              taskCreationDefaultDueDate: val,
            });
          }}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.taskCreation.defaultProject.label}
        description={i18n.taskCreation.defaultProject.description}
      >
        <ProjectDropdownControl
          value={settings.taskCreationDefaultProject}
          onChange={mkOptionUpdate("taskCreationDefaultProject")}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.taskCreation.defaultLabels.label}
        description={i18n.taskCreation.defaultLabels.description}
      >
        <LabelsControl
          value={settings.taskCreationDefaultLabels}
          onChange={mkOptionUpdate("taskCreationDefaultLabels")}
        />
      </Setting.Root>
      <Setting.Root
        name={i18n.taskCreation.defaultAddTaskAction.label}
        description={i18n.taskCreation.defaultAddTaskAction.description}
      >
        <Setting.DropdownControl
          value={settings.defaultAddTaskAction}
          options={[
            {
              label: i18n.taskCreation.defaultAddTaskAction.options.add,
              value: "add",
            },
            {
              label: i18n.taskCreation.defaultAddTaskAction.options.addCopyApp,
              value: "add-copy-app",
            },
            {
              label: i18n.taskCreation.defaultAddTaskAction.options.addCopyWeb,
              value: "add-copy-web",
            },
          ]}
          onClick={async (val) => {
            await plugin.writeOptions({
              defaultAddTaskAction: val,
            });
          }}
        />
      </Setting.Root>

      <h2>{i18n.advanced.header}</h2>
      <Setting.Root
        name={i18n.advanced.debugLogging.label}
        description={i18n.advanced.debugLogging.description}
      >
        <Setting.ToggleControl {...toggleProps("debugLogging")} />
      </Setting.Root>
      <Setting.Root
        name={i18n.advanced.buildStamp.label}
        description={i18n.advanced.buildStamp.description}
      >
        <span className="setting-item-build-stamp">{BuildStamp}</span>
      </Setting.Root>
    </PluginContext.Provider>
  );
};
