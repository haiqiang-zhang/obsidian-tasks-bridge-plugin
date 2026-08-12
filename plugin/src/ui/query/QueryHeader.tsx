import classNames from "classnames";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { createPortal } from "react-dom";

import { type CommandId, fireCommand } from "@/commands";
import { t } from "@/i18n";
import { type Settings, useSettingsStore } from "@/settings";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext, RenderChildContext } from "@/ui/context";
import { useObsidianTooltip } from "@/ui/hooks";
import { assertNever } from "@/utils/types";

const getAddTaskCommandId = (settings: Settings): CommandId => {
  switch (settings.addTaskButtonAddsPageLink) {
    case "content":
      return "add-task-page-content";
    case "description":
      return "add-task-page-description";
    case "off":
      return "add-task";
    default:
      return assertNever(settings.addTaskButtonAddsPageLink, "Unknown add task button setting");
  }
};

type Props = {
  title: string;
  isFetching: boolean;
  refresh: () => Promise<void>;
  refreshedTimestamp: Date | undefined;
};

export const QueryHeader: React.FC<Props> = ({
  title,
  isFetching,
  refresh,
  refreshedTimestamp,
}) => {
  const plugin = PluginContext.use();
  const settings = useSettingsStore();
  const i18n = t().query.header.refreshTooltip;
  const embedActions = useEmbedActions();
  const hasTitle = title.trim().length > 0;

  const refreshedAtDisplay =
    refreshedTimestamp !== undefined
      ? i18n.lastRefreshed(refreshedTimestamp.toLocaleString())
      : i18n.notRefreshed;

  const controls = (
    <div className="todoist-query-controls interactive-child" role="toolbar" aria-label="Todoist">
      <HeaderButton
        className="add-task"
        iconId="plus"
        action={() => fireCommand(getAddTaskCommandId(settings), plugin)}
        label={t().commands.addTask}
      />
      <HeaderButton
        className={classNames("refresh-query", {
          "is-refreshing": isFetching,
        })}
        iconId="refresh-ccw"
        action={async () => {
          await refresh();
        }}
        label={i18n.label}
        tooltip={`${i18n.label}. ${refreshedAtDisplay}`}
      />
    </div>
  );

  return (
    <>
      {hasTitle && (
        <div className="todoist-query-header has-actions">
          <h4 className="todoist-query-title">{title}</h4>
        </div>
      )}
      {embedActions === null && <div className="todoist-query-fallback-actions">{controls}</div>}
      {embedActions !== null && createPortal(controls, embedActions)}
    </>
  );
};

const useEmbedActions = (): HTMLElement | null => {
  const renderChild = RenderChildContext.use();
  const findContainer = () =>
    renderChild.containerEl.parentElement?.querySelector<HTMLElement>(":scope > .embed-actions") ??
    null;
  const [container, setContainer] = useState<HTMLElement | null>(findContainer);

  useEffect(() => {
    const parent = renderChild.containerEl.parentElement;
    if (parent === null) {
      setContainer(null);
      return;
    }

    const updateContainer = () => {
      setContainer(parent.querySelector<HTMLElement>(":scope > .embed-actions"));
    };

    updateContainer();
    const observer = new MutationObserver(updateContainer);
    observer.observe(parent, { childList: true });
    return () => observer.disconnect();
  }, [renderChild]);

  return container;
};

type ButtonProps = {
  iconId: string;
  action: () => Promise<void> | void;
  className: string;
  label: string;
  tooltip?: string;
};

const HeaderButton: React.FC<ButtonProps> = ({ iconId, action, className, label, tooltip }) => {
  const [buttonEl, setButtonEl] = useState<HTMLButtonElement | null>(null);

  const handler = async () => {
    const result = action();

    if (result instanceof Promise) {
      await result;
    }
  };

  useObsidianTooltip(buttonEl, tooltip ?? label);

  return (
    <Button
      aria-label={label}
      className={classNames("embed-action clickable-icon todoist-query-control-button", className)}
      onPress={() => void handler()}
      ref={setButtonEl}
    >
      <ObsidianIcon id={iconId} size="s" />
    </Button>
  );
};
