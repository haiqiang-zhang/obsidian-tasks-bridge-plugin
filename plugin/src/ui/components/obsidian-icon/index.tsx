import classNames from "classnames";
import { setIcon } from "obsidian";
import type React from "react";
import { useEffect, useRef } from "react";
import "./styles.scss";

type Props = {
  size: "xs" | "s" | "m" | "l" | "xl";
  id: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "size" | "id" | "className">;

type LoadingProps = Omit<Props, "id">;

export const ObsidianIcon: React.FC<Props> = ({ size, id, className, ...rest }) => {
  const div = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (div.current === null) {
      return;
    }

    setIcon(div.current, id);
  }, [id]);

  return (
    <div
      className={classNames("obsidian-icon", className)}
      data-icon-size={size}
      ref={div}
      {...rest}
    />
  );
};

/** Obsidian's native loader icon and animation contract. */
export const ObsidianLoadingIcon: React.FC<LoadingProps> = ({ className, ...rest }) => (
  <ObsidianIcon className={classNames("loader-spinner", className)} id="loader-2" {...rest} />
);
