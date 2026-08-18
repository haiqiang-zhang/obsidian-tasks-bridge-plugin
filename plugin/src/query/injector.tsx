import type { MarkdownPostProcessorContext } from "obsidian";
import { MarkdownRenderChild } from "obsidian";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

import type TodoistPlugin from "@/index";
import { debug } from "@/log";
import { parseQuery } from "@/query/parser";
import { applyReplacements } from "@/query/replacements";
import { taskQueryDefinition } from "@/query/schema/tasks";
import { PluginContext, RenderChildContext } from "@/ui/context";
import { QueryError } from "@/ui/query/QueryError";
import { QueryRoot } from "@/ui/query/QueryRoot";

export const QUERY_CODE_BLOCK = "tasks-bridge-query";
export const LEGACY_QUERY_CODE_BLOCK = "todoist";

export class QueryInjector {
  private readonly plugin: TodoistPlugin;
  constructor(plugin: TodoistPlugin) {
    this.plugin = plugin;
  }

  onNewBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let child: MarkdownRenderChild;

    try {
      const [query, warnings] = parseQuery(source, taskQueryDefinition);
      applyReplacements(query, ctx);

      debug({
        msg: "Parsed query",
        context: query,
      });

      child = new ReactRenderer(el, this.plugin, QueryRoot, {
        query,
        warnings,
      });
    } catch (e) {
      console.error(e);
      child = new ReactRenderer(el, this.plugin, QueryError, {
        error: e,
      });
    }

    ctx.addChild(child);
  }
}

class ReactRenderer<T extends {}> extends MarkdownRenderChild {
  private readonly plugin: TodoistPlugin;
  private readonly props: T;
  private readonly component: React.FC<T>;
  private readonly reactRoot: Root;

  constructor(container: HTMLElement, plugin: TodoistPlugin, component: React.FC<T>, props: T) {
    super(container);
    this.plugin = plugin;
    this.component = component;
    this.props = props;
    this.reactRoot = createRoot(this.containerEl);
  }

  onload(): void {
    const Component = this.component;
    this.reactRoot.render(
      <RenderChildContext.Provider value={this}>
        <PluginContext.Provider value={this.plugin}>
          <Component {...this.props} />
        </PluginContext.Provider>
      </RenderChildContext.Provider>,
    );
  }

  onunload(): void {
    this.reactRoot.unmount();
  }
}
