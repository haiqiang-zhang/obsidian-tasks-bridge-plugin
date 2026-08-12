import classNames from "classnames";
import type React from "react";
import type { OptionHTMLAttributes, PropsWithChildren } from "react";
import { useState } from "react";

import { t } from "@/i18n";

import { ObsidianIcon } from "../components/obsidian-icon";

type RootProps = {
  name: string;
  description: string;
  deprecationMessage?: string;
};

const Root: React.FC<PropsWithChildren<RootProps>> = ({
  children,
  name,
  description,
  deprecationMessage,
}) => {
  const renderDeprecationNotice = deprecationMessage !== undefined;
  return (
    <div className="setting-item">
      <div className="setting-item-info">
        <div className="setting-item-name">{name}</div>
        <div className="setting-item-description">
          {description}
          {renderDeprecationNotice && <DeprecationNotice message={deprecationMessage} />}
        </div>
      </div>
      <div className="setting-item-control">{children}</div>
    </div>
  );
};

type DeprecationNoticeProps = {
  message: string;
};

const DeprecationNotice: React.FC<DeprecationNoticeProps> = ({ message }) => {
  const prefix = t().settings.deprecation.warningMessage;
  return (
    <div className="setting-item-deprecation-notice">
      <ObsidianIcon size="l" id="lucide-alert-triangle" />
      <div className="setting-item-deprecation-notice-message">
        {prefix} {message}
      </div>
    </div>
  );
};

type ButtonProps = {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
};

const ButtonControl: React.FC<ButtonProps> = ({ label, icon, onClick, disabled }) => {
  return (
    <button className="mod-cta" onClick={() => void onClick()} type="button" disabled={disabled}>
      {icon !== undefined && <ObsidianIcon size="l" id={icon} className="setting-button-icon" />}
      {label}
    </button>
  );
};

type ToggleControl = {
  value: boolean;
  onClick: (val: boolean) => Promise<void>;
  disabled?: boolean;
  ariaLabel?: string;
};

const ToggleControl: React.FC<ToggleControl> = ({
  value,
  onClick,
  disabled = false,
  ariaLabel,
}) => {
  const onToggle = async () => {
    if (!disabled) {
      await onClick(!value);
    }
  };

  const className = classNames("checkbox-container", {
    "is-enabled": value,
    "is-disabled": disabled,
  });
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void onToggle();
  };
  return (
    <div
      aria-checked={value}
      aria-disabled={disabled}
      aria-label={ariaLabel}
      className={className}
      onClick={() => void onToggle()}
      onKeyDown={onKeyDown}
      role="switch"
      tabIndex={disabled ? -1 : 0}
    />
  );
};

type DropdownOptionValue = OptionHTMLAttributes<HTMLOptionElement>["value"];

type DropdownControlProps<T extends DropdownOptionValue> = {
  value: T;
  options: { label: string; value: T }[];
  onClick: (val: T) => Promise<void>;
};

const DropdownControl = <T extends DropdownOptionValue>({
  value,
  options,
  onClick,
}: DropdownControlProps<T>): React.ReactNode => {
  const [selected, setSelected] = useState(value);

  const onChange = async (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const val = ev.target.value as T;
    setSelected(val);
    await onClick(val);
  };

  return (
    <select className="dropdown" value={selected} onChange={(event) => void onChange(event)}>
      {options.map(({ label, value }) => (
        <option key={label} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
};

export const Setting = {
  Root,
  ButtonControl,
  ToggleControl,
  DropdownControl,
};
