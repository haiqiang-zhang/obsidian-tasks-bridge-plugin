import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectOverview } from "./ProjectOverview";
import type { ProjectOverviewModel } from "./projectOverviewModel";

afterEach(cleanup);

const makeModel = (overrides: Partial<ProjectOverviewModel> = {}): ProjectOverviewModel => ({
  counts: { active: 1, completed: 2, unavailable: 0 },
  taskCount: 3,
  projectCount: 2,
  completionRate: 2 / 3,
  completionEvents: [],
  ...overrides,
});

const renderOverview = (
  model: ProjectOverviewModel = makeModel(),
  overrides: Partial<ComponentProps<typeof ProjectOverview>> = {},
) =>
  render(
    <ProjectOverview
      collapsed={false}
      completionHeatmapRange="last-year"
      model={model}
      onCollapsedChange={vi.fn()}
      onCompletionHeatmapRangeChange={vi.fn()}
      scopeLabel="Root"
      {...overrides}
    />,
  );

describe("ProjectOverview", () => {
  it("renders percentage, activity, and metrics from the current Base result", () => {
    renderOverview();

    const region = screen.getByRole("region", { name: "Project overview" });
    const toggle = within(region).getByRole("button", { name: /Project overview/ });
    const leading = toggle.querySelector(".todoist-bases-project-overview-header-leading");
    const summary = toggle.querySelector(".todoist-bases-project-overview-header-summary");
    const bodyId = toggle.getAttribute("aria-controls");
    expect(toggle.children).toHaveLength(2);
    expect(toggle.children[0]).toBe(leading);
    expect(toggle.children[1]).toBe(summary);
    expect(leading).toContainElement(
      toggle.querySelector(".todoist-bases-project-overview-disclosure"),
    );
    expect(leading).toContainElement(
      toggle.querySelector(".todoist-bases-project-overview-title-group"),
    );
    expect(toggle.querySelector("time")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(bodyId).not.toBeNull();
    expect(document.getElementById(bodyId ?? "")).toBeVisible();
    expect(
      within(region).getByRole("img", {
        name: "67% complete, 2 completed of 3 tasks",
      }),
    ).toBeInTheDocument();
    expect(within(region).getByRole("region", { name: "Completion activity" })).toBeInTheDocument();

    const metrics = within(region).getByRole("group", { name: "Project completion totals" });
    expect(within(metrics).getByText("Total").nextElementSibling).toHaveTextContent("3");
    expect(within(metrics).getByText("Active").nextElementSibling).toHaveTextContent("1");
    expect(within(metrics).getByText("Completed").nextElementSibling).toHaveTextContent("2");
    expect(within(metrics).getByText("Unavailable").nextElementSibling).toHaveTextContent("0");
    expect(within(metrics).getByText("Projects").nextElementSibling).toHaveTextContent("2");
  });

  it("requests a collapsed-state change and follows the controlled prop", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = renderOverview(makeModel(), { onCollapsedChange });

    const toggle = screen.getByRole("button", { name: /Project overview/ });
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenCalledOnce();
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(
      <ProjectOverview
        collapsed={true}
        completionHeatmapRange="last-year"
        model={makeModel()}
        onCollapsedChange={onCollapsedChange}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Root"
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).not.toBeVisible();
    expect(screen.getByText("2 projects · 3 tasks · 67% complete")).toBeVisible();
  });

  it("does not expose a separate Project Sync status or hierarchy source", () => {
    renderOverview();

    expect(screen.queryByText(/^Last synced /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for Project Sync/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project Sync disabled/)).not.toBeInTheDocument();
    expect(screen.queryByText("Project breakdown")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Project statistics" })).not.toBeInTheDocument();
  });

  it("renders a zero-result model instead of an initial-sync loading state", () => {
    renderOverview(
      makeModel({
        counts: { active: 0, completed: 0, unavailable: 0 },
        taskCount: 0,
        projectCount: 0,
        completionRate: null,
        completionEvents: [],
      }),
      { scopeLabel: "Root" },
    );

    expect(screen.getByText("0 projects · No tasks")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "No tasks to calculate completion" })).toHaveTextContent(
      "—Complete",
    );
    expect(
      screen
        .getByRole("region", { name: "Project overview" })
        .querySelector(".todoist-bases-project-overview-state"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing project overview")).not.toBeInTheDocument();
  });

  it("shows exactly the filtered Base totals supplied by its model", () => {
    renderOverview(
      makeModel({
        counts: { active: 1, completed: 0, unavailable: 0 },
        taskCount: 1,
        projectCount: 1,
        completionRate: 0,
      }),
    );

    expect(screen.getByText("1 project · 1 task · 0% complete")).toBeInTheDocument();
    const metrics = screen.getByRole("group", { name: "Project completion totals" });
    expect(within(metrics).getByText("Total").nextElementSibling).toHaveTextContent("1");
    expect(within(metrics).getByText("Active").nextElementSibling).toHaveTextContent("1");
    expect(within(metrics).getByText("Completed").nextElementSibling).toHaveTextContent("0");
    expect(within(metrics).getByText("Unavailable").nextElementSibling).toHaveTextContent("0");
  });

  it("counts unavailable Base rows in Total while excluding them from completion progress", () => {
    renderOverview(
      makeModel({
        counts: { active: 1, completed: 2, unavailable: 3 },
        taskCount: 6,
        projectCount: 2,
        completionRate: 2 / 3,
      }),
    );

    expect(screen.getByText("2 projects · 6 tasks · 67% complete")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "67% complete, 2 completed of 3 available tasks",
      }),
    ).toBeInTheDocument();
    const metrics = screen.getByRole("group", { name: "Project completion totals" });
    expect(within(metrics).getByText("Total").nextElementSibling).toHaveTextContent("6");
    expect(within(metrics).getByText("Unavailable").nextElementSibling).toHaveTextContent("3");
  });

  it("reports unavailable-only results without treating them as no Base tasks", () => {
    renderOverview(
      makeModel({
        counts: { active: 0, completed: 0, unavailable: 2 },
        taskCount: 2,
        projectCount: 1,
        completionRate: null,
      }),
    );

    expect(screen.getByText("1 project · 2 tasks · 2 unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "No available tasks to calculate completion" }),
    ).toBeInTheDocument();
    const metrics = screen.getByRole("group", { name: "Project completion totals" });
    expect(within(metrics).getByText("Total").nextElementSibling).toHaveTextContent("2");
    expect(within(metrics).getByText("Unavailable").nextElementSibling).toHaveTextContent("2");
  });
});
