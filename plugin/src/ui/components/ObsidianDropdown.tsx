import { DropdownComponent } from "obsidian";
import type React from "react";
import { useLayoutEffect, useRef } from "react";

export type ObsidianDropdownOption<T extends string> = {
  disabled?: boolean;
  label: string;
  value: T;
};

type Props<T extends string> = {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: T) => void | Promise<void>;
  options: readonly ObsidianDropdownOption<T>[];
  value: T;
};

/**
 * Lets React own the host while Obsidian owns the actual dropdown control.
 */
export const ObsidianDropdown = <T extends string>({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  className,
  disabled = false,
  id,
  onChange,
  options,
  value,
}: Props<T>): React.ReactNode => {
  const hostRef = useRef<HTMLDivElement>(null);
  const componentRef = useRef<DropdownComponent | null>(null);
  const onChangeRef = useRef(onChange);
  const customClassesRef = useRef<string[]>([]);
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const component = new DropdownComponent(host);
    component.onChange((next) => void onChangeRef.current(next as T));
    componentRef.current = component;

    return () => {
      component.selectEl.remove();
      componentRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const component = componentRef.current;
    if (component === null) {
      return;
    }

    component.selectEl.replaceChildren();
    for (const option of options) {
      component.addOption(option.value, option.label);
      const optionEl = component.selectEl.options.item(component.selectEl.options.length - 1);
      if (optionEl !== null) {
        optionEl.disabled = option.disabled === true;
      }
    }

    component.setValue(value).setDisabled(disabled);

    component.selectEl.classList.remove(...customClassesRef.current);
    const customClasses = className?.split(/\s+/).filter(Boolean) ?? [];
    component.selectEl.classList.add(...customClasses);
    customClassesRef.current = customClasses;

    setOptionalAttribute(component.selectEl, "aria-describedby", ariaDescribedBy);
    setOptionalAttribute(component.selectEl, "aria-label", ariaLabel);
    setOptionalAttribute(
      component.selectEl,
      "aria-invalid",
      ariaInvalid === undefined ? undefined : String(ariaInvalid),
    );
    setOptionalAttribute(component.selectEl, "id", id);
  }, [ariaDescribedBy, ariaInvalid, ariaLabel, className, disabled, id, options, value]);

  return <div className="tasks-bridge-dropdown-host" ref={hostRef} />;
};

const setOptionalAttribute = (
  element: HTMLElement,
  name: string,
  value: string | undefined,
): void => {
  if (value === undefined) {
    element.removeAttribute(name);
    return;
  }

  element.setAttribute(name, value);
};
