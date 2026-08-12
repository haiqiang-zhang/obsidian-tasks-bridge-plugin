import { MarkdownRenderer } from "obsidian";
import type React from "react";
import { useEffect, useRef } from "react";

import { PluginContext, RenderChildContext } from "@/ui/context";

interface MarkdownProps {
  content: string;
  className?: string;
}

export const Markdown: React.FC<MarkdownProps> = ({ content, className }) => {
  const plugin = PluginContext.use();
  const renderChild = RenderChildContext.use();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (container === null) {
      return;
    }

    let active = true;
    const renderMarkdown = async (): Promise<void> => {
      container.empty();
      await MarkdownRenderer.render(plugin.app, content, container, "", renderChild);
      if (!active) {
        container.empty();
        return;
      }

      if (container.childElementCount !== 1) {
        return;
      }

      const markdownContent = container.firstElementChild;

      if (markdownContent?.tagName === "P") {
        markdownContent.replaceWith(...markdownContent.childNodes);
      }
    };

    void renderMarkdown();
    return () => {
      active = false;
      container.empty();
    };
  }, [content, plugin, renderChild]);

  return <div ref={ref} className={className} />;
};
