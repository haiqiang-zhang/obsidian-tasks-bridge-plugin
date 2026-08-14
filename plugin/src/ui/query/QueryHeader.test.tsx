import { render, screen, within } from "@testing-library/react";
import { MarkdownRenderChild } from "obsidian";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { PluginContext, RenderChildContext } from "@/ui/context";

import { QueryHeader } from "./QueryHeader";

const mockPlugin = {
  services: {
    todoist: {
      actions: {
        closeTask: vi.fn(),
      },
    },
  },
} as unknown as ReturnType<typeof PluginContext.use>;

const makeWrapper = (embedActions?: HTMLElement): React.FC<{ children: React.ReactNode }> => {
  const host = document.createElement("div");
  const renderContainer = document.createElement("div");
  host.append(renderContainer);
  if (embedActions !== undefined) {
    host.append(embedActions);
  }
  const renderChild = new MarkdownRenderChild(renderContainer);

  return ({ children }) => (
    <PluginContext.Provider value={mockPlugin}>
      <RenderChildContext.Provider value={renderChild}>{children}</RenderChildContext.Provider>
    </PluginContext.Provider>
  );
};

describe("QueryHeader", () => {
  it("should render query title", () => {
    render(
      <QueryHeader
        title="My Tasks"
        isFetching={false}
        refresh={vi.fn()}
        refreshedTimestamp={undefined}
      />,
      { wrapper: makeWrapper() },
    );

    expect(screen.getByRole("heading", { level: 4, name: "My Tasks" })).toBeInTheDocument();
  });

  it("should render two plugin control buttons", () => {
    const { container } = render(
      <QueryHeader
        title="Tasks"
        isFetching={false}
        refresh={vi.fn()}
        refreshedTimestamp={undefined}
      />,
      { wrapper: makeWrapper() },
    );

    expect(container.querySelector(".add-task")).toBeInTheDocument();
    expect(container.querySelector(".refresh-query")).toBeInTheDocument();
    expect(container.querySelector(".edit-query")).not.toBeInTheDocument();
    expect(container.querySelector(".todoist-query-controls")).toHaveClass("interactive-child");
    expect(screen.getByRole("button", { name: "Add task" })).toHaveClass("clickable-icon");
    expect(screen.getByRole("button", { name: "Refresh tasks" })).toHaveClass("clickable-icon");
    expect(
      screen.getByRole("button", { name: "Add task" }).querySelector(".obsidian-icon"),
    ).toHaveAttribute("data-icon-size", "m");
    expect(
      screen.getByRole("button", { name: "Refresh tasks" }).querySelector(".obsidian-icon"),
    ).toHaveAttribute("data-icon-size", "m");
  });

  it("should not render an empty title header when native block actions are available", () => {
    const embedActions = document.createElement("div");
    embedActions.className = "embed-actions";
    const nativeEdit = document.createElement("button");
    nativeEdit.className = "embed-action clickable-icon edit-block-button";
    nativeEdit.setAttribute("aria-label", "Edit this block");
    embedActions.append(nativeEdit);
    const { container } = render(
      <QueryHeader title="" isFetching={false} refresh={vi.fn()} refreshedTimestamp={undefined} />,
      { wrapper: makeWrapper(embedActions) },
    );

    expect(container.querySelector(".todoist-query-header")).not.toBeInTheDocument();
    expect(within(embedActions).getByRole("button", { name: "Add task" })).toHaveClass(
      "todoist-query-control-button",
    );
    expect(within(embedActions).getByRole("button", { name: "Refresh tasks" })).toHaveClass(
      "todoist-query-control-button",
    );
    expect(within(embedActions).getByRole("button", { name: "Edit this block" })).toBe(nativeEdit);
    expect(embedActions.querySelectorAll(":scope > .todoist-query-controls")).toHaveLength(1);
    expect(embedActions.children).toHaveLength(2);
  });

  it("should use an out-of-flow fallback toolbar without an empty title header", () => {
    const { container } = render(
      <QueryHeader title="" isFetching={false} refresh={vi.fn()} refreshedTimestamp={undefined} />,
      { wrapper: makeWrapper() },
    );

    expect(container.querySelector(".todoist-query-header")).not.toBeInTheDocument();
    expect(container.querySelector(".todoist-query-fallback-actions")).toContainElement(
      screen.getByRole("button", { name: "Add task" }),
    );
  });

  it("should show 'is-refreshing' class during fetch", () => {
    const { container } = render(
      <QueryHeader
        title="Tasks"
        isFetching={true}
        refresh={vi.fn()}
        refreshedTimestamp={undefined}
      />,
      { wrapper: makeWrapper() },
    );

    expect(container.querySelector(".refresh-query.is-refreshing")).toBeInTheDocument();
  });

  it("should not show 'is-refreshing' class when not fetching", () => {
    const { container } = render(
      <QueryHeader
        title="Tasks"
        isFetching={false}
        refresh={vi.fn()}
        refreshedTimestamp={undefined}
      />,
      { wrapper: makeWrapper() },
    );

    expect(container.querySelector(".refresh-query.is-refreshing")).not.toBeInTheDocument();
  });
});
