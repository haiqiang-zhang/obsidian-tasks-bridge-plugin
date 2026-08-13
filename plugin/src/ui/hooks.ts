import { setTooltip, type TooltipOptions } from "obsidian";
import { useEffect, useState } from "react";

import { RenderChildContext } from "@/ui/context";

export const useObsidianTooltip = (
  ref: HTMLElement | null,
  text: string,
  options?: TooltipOptions,
) => {
  useEffect(() => {
    if (ref !== null && text.length > 0) {
      setTooltip(ref, text, options);
    }
  }, [ref, text, options]);
};

/** Finds Obsidian's native action rail for the current rendered code block. */
export const useEmbedActions = (): HTMLElement | null => {
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
