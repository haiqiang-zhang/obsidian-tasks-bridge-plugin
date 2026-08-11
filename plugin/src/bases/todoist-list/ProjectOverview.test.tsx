import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSyncStatus } from "@/project-sync";

import { ProjectOverview } from "./ProjectOverview";
import type { ProjectOverviewModel, ProjectOverviewNode } from "./projectOverviewModel";

afterEach(cleanup);

const idleStatus: ProjectSyncStatus = { state: "idle" };

const makeNode = (
  id: string,
  name: string,
  active: number,
  completed: number,
  children: ProjectOverviewNode[] = [],
  pathNames: string[] = [name],
): ProjectOverviewNode => {
  const taskCount = active + completed;
  const childCounts = children.reduce(
    (counts, child) => ({
      active: counts.active + child.counts.active,
      completed: counts.completed + child.counts.completed,
    }),
    { active: 0, completed: 0 },
  );
  return {
    id,
    name,
    pathIds: pathNames.map((_, index) => `${id}-${index}`),
    pathNames,
    directCounts: {
      active: active - childCounts.active,
      completed: completed - childCounts.completed,
    },
    directCompletionEvents: [],
    counts: { active, completed },
    children,
    taskCount,
    projectCount: 1 + children.reduce((count, child) => count + child.projectCount, 0),
    completionRate: taskCount === 0 ? null : completed / taskCount,
  };
};

const makeModel = (overrides: Partial<ProjectOverviewModel> = {}): ProjectOverviewModel => {
  const grandchild = makeNode(
    "grandchild",
    "Grandchild",
    0,
    1,
    [],
    ["Root", "Child", "Grandchild"],
  );
  const child = makeNode("child", "Child", 1, 1, [grandchild], ["Root", "Child"]);
  const root = makeNode("root", "Root", 1, 2, [child], ["Root"]);
  return {
    syncedAt: "2026-08-10T06:00:00.000Z",
    rootProjectId: "root",
    rootAvailable: true,
    projectOptions: [
      { id: "root", name: "Root", pathIds: ["root"], pathNames: ["Root"] },
      {
        id: "child",
        name: "Child",
        pathIds: ["root", "child"],
        pathNames: ["Root", "Child"],
      },
      {
        id: "grandchild",
        name: "Grandchild",
        pathIds: ["root", "child", "grandchild"],
        pathNames: ["Root", "Child", "Grandchild"],
      },
    ],
    roots: [root],
    counts: { active: 1, completed: 2 },
    taskCount: 3,
    projectCount: 3,
    completionRate: 2 / 3,
    completionEvents: [],
    ...overrides,
  };
};

describe("ProjectOverview", () => {
  it("exposes an accessible controlled disclosure and native progress semantics", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel()}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Root"
        status={idleStatus}
      />,
    );

    const region = screen.getByRole("region", { name: "Project overview" });
    const toggle = within(region).getByRole("button", { name: /Project overview/ });
    const leading = toggle.querySelector(".todoist-bases-project-overview-header-leading");
    const metadata = toggle.querySelector(".todoist-bases-project-overview-header-meta");
    const bodyId = toggle.getAttribute("aria-controls");
    expect(toggle.children).toHaveLength(2);
    expect(toggle.children[0]).toBe(leading);
    expect(toggle.children[1]).toBe(metadata);
    expect(leading).toContainElement(
      toggle.querySelector(".todoist-bases-project-overview-disclosure"),
    );
    expect(leading).toContainElement(
      toggle.querySelector(".todoist-bases-project-overview-title-group"),
    );
    expect(metadata).toContainElement(
      toggle.querySelector(".todoist-bases-project-overview-header-summary"),
    );
    expect(metadata).toContainElement(toggle.querySelector("time"));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(bodyId).not.toBeNull();
    expect(document.getElementById(bodyId ?? "")).toBeVisible();
    expect(
      within(region).getByRole("img", {
        name: "67% complete, 2 completed of 3 tasks",
      }),
    ).toBeInTheDocument();
    expect(within(region).getByRole("progressbar", { name: "Root completion" })).toHaveAttribute(
      "aria-valuenow",
      "2",
    );
    expect(within(region).queryByRole("tree")).not.toBeInTheDocument();
  });

  it("requests a collapsed-state change and follows the controlled prop", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel()}
        onCollapsedChange={onCollapsedChange}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Root"
        status={idleStatus}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Project overview/ });
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenCalledOnce();
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(
      <ProjectOverview
        collapsed={true}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel()}
        onCollapsedChange={onCollapsedChange}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Root"
        status={idleStatus}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).not.toBeVisible();
    expect(screen.getByText("3 projects · 3 tasks · 67% complete")).toBeVisible();
  });

  it("renders the complete selected root and descendant hierarchy", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel()}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Root"
        status={idleStatus}
      />,
    );

    expect(
      screen.getByText("Root", { selector: ".todoist-bases-project-overview-project-name" }),
    ).toHaveAttribute("title", "Root");
    expect(
      screen.getByText("Child", { selector: ".todoist-bases-project-overview-project-name" }),
    ).toHaveAttribute("title", "Root / Child");
    expect(
      screen.getByText("Grandchild", {
        selector: ".todoist-bases-project-overview-project-name",
      }),
    ).toHaveAttribute("title", "Root / Child / Grandchild");

    const rootItem = screen
      .getByText("Root", { selector: ".todoist-bases-project-overview-project-name" })
      .closest("li");
    const childItem = screen
      .getByText("Child", { selector: ".todoist-bases-project-overview-project-name" })
      .closest("li");
    const grandchildItem = screen
      .getByText("Grandchild", { selector: ".todoist-bases-project-overview-project-name" })
      .closest("li");
    expect(rootItem).toContainElement(childItem);
    expect(childItem).toContainElement(grandchildItem);
    expect(
      rootItem?.querySelector(".todoist-bases-project-overview-project-counts"),
    ).toHaveTextContent("2 / 3 completed · 67%");
    expect(screen.getByText(/^Last synced /)).toBeInTheDocument();
  });

  it("shows a unified loading state before the initial Project Sync", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={null}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="All synchronized projects"
        status={idleStatus}
      />,
    );

    expect(screen.getByRole("region", { name: "Project overview" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText("All synchronized projects")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Project Sync")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing project overviewWaiting for the initial Project Sync.",
    );
    expect(screen.queryByRole("list", { name: "Project statistics" })).not.toBeInTheDocument();
  });

  it("explains when Project Sync has no mapping instead of showing an indefinite spinner", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={false}
        model={null}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="All synchronized projects"
        status={{ state: "disabled" }}
      />,
    );

    expect(screen.getByText("Project Sync not configured")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Project Sync is not configured.");
    expect(screen.queryByText("Preparing project overview")).not.toBeInTheDocument();
  });

  it("explains when Project Sync is disabled instead of showing an indefinite spinner", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={null}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="All synchronized projects"
        status={{ state: "disabled" }}
      />,
    );

    expect(screen.getByRole("region", { name: "Project overview" })).not.toHaveAttribute(
      "aria-busy",
    );
    expect(screen.getByText("Project Sync disabled")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Project Sync is disabled.");
    expect(screen.queryByText("Preparing project overview")).not.toBeInTheDocument();
  });

  it("shows the initial Project Sync error when no last-good snapshot exists", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={null}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="All synchronized projects"
        status={{
          state: "error",
          completedAt: "2026-08-10T06:00:00.000Z",
          message: "Todoist request failed",
        }}
      />,
    );

    expect(screen.getByText("Project statistics unavailable")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Project overview is unavailable.Todoist request failed",
    );
  });

  it("explains when the selected root is no longer synchronized", () => {
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel({
          rootProjectId: "removed-root",
          rootAvailable: false,
          projectOptions: [],
          roots: [],
          counts: { active: 0, completed: 0 },
          taskCount: 0,
          projectCount: 0,
          completionRate: null,
        })}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Selected root project"
        status={idleStatus}
      />,
    );

    expect(screen.getByText("Selected root project")).toBeInTheDocument();
    expect(screen.getByText("Project statistics unavailable")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The selected root project is unavailable.",
    );
    expect(screen.queryByRole("img", { name: /complete/ })).not.toBeInTheDocument();
  });

  it("renders zero-task projects without an invalid progressbar", () => {
    const emptyRoot = makeNode("empty", "Empty project", 0, 0, [], ["Empty project"]);
    render(
      <ProjectOverview
        collapsed={false}
        completionHeatmapRange="last-year"
        configured={true}
        model={makeModel({
          rootProjectId: "empty",
          projectOptions: [
            {
              id: "empty",
              name: "Empty project",
              pathIds: ["empty"],
              pathNames: ["Empty project"],
            },
          ],
          roots: [emptyRoot],
          counts: { active: 0, completed: 0 },
          taskCount: 0,
          projectCount: 1,
          completionRate: null,
        })}
        onCollapsedChange={vi.fn()}
        onCompletionHeatmapRangeChange={vi.fn()}
        scopeLabel="Empty project"
        status={idleStatus}
      />,
    );

    expect(screen.getByText("1 project · No tasks")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "No tasks to calculate completion" })).toHaveTextContent(
      "—Complete",
    );
    const projectRow = screen.getByLabelText("Empty project: No tasks, including child projects");
    expect(within(projectRow).getByText("No tasks")).toBeInTheDocument();
    expect(within(projectRow).queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
