import classNames from "classnames";
import type React from "react";

import { ObsidianIcon } from "@/ui/components/obsidian-icon";

export type Contents = string | { msg: string; children: Contents[] };

export type CalloutVariant = "error" | "info" | "success" | "warning";

type Props = {
  title: string;
  className: string;
  iconId: string;
  variant: CalloutVariant;
  contents?: Contents[];
};

const renderContents = (content: Contents): React.ReactNode => {
  if (typeof content === "string") {
    return <li key={content}>{content}</li>;
  }

  return (
    <li key={content.msg}>
      {content.msg}
      {content.children && content.children.length > 0 && (
        <ul>{content.children.map((child) => renderContents(child))}</ul>
      )}
    </li>
  );
};

export const Callout: React.FC<Props> = ({ title, contents, iconId, className, variant }) => {
  return (
    <div
      className={classNames("callout", "todoist-callout", className)}
      data-callout={variant}
      role={variant === "error" ? "alert" : "status"}
    >
      <div className="callout-title">
        <div className="callout-icon">
          <ObsidianIcon id={iconId} size="m" />
        </div>
        <div className="callout-title-inner">{title}</div>
      </div>
      {contents !== undefined && contents.length > 0 && (
        <div className="callout-content">
          <ul className="todoist-callout-contents">
            {contents.map((content) => renderContents(content))}
          </ul>
        </div>
      )}
    </div>
  );
};
