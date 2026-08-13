import { fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Label } from "@/api/domain/label";
import type { Project } from "@/api/domain/project";
import type { Section } from "@/api/domain/section";
import type TodoistPlugin from "@/index";
import { PluginContext } from "@/ui/context";

import { LabelSelector } from "./LabelSelector";
import { ProjectSelector } from "./ProjectSelector";

afterEach(() => {
  document.querySelectorAll(".modal-container").forEach((modal) => {
    modal.remove();
  });
});

const project = (overrides: Partial<Project> & Pick<Project, "id" | "name">): Project => ({
  childOrder: 0,
  color: "charcoal",
  inboxProject: false,
  isArchived: false,
  isDeleted: false,
  parentId: null,
  ...overrides,
});

const section = (overrides: Partial<Section> & Pick<Section, "id" | "name">): Section => ({
  isArchived: false,
  isDeleted: false,
  projectId: "root",
  sectionOrder: 0,
  ...overrides,
});

const label = (id: string, name: string): Label => ({
  color: "charcoal",
  id,
  isDeleted: false,
  name,
});

const makePlugin = ({
  labels = [],
  projects = [],
  sections = [],
}: {
  labels?: Label[];
  projects?: Project[];
  sections?: Section[];
}): TodoistPlugin =>
  ({
    app: new App(),
    services: {
      todoist: {
        data: () => ({
          labels: {
            iterActive: () => labels.values(),
          },
          projects: {
            byId: (id: string) => projects.find((candidate) => candidate.id === id),
            iterActive: () => projects.values(),
          },
          sections: {
            byId: (id: string) => sections.find((candidate) => candidate.id === id),
            iterActive: () => sections.values(),
          },
        }),
      },
    },
  }) as unknown as TodoistPlugin;

const renderWithPlugin = (plugin: TodoistPlugin, node: React.ReactNode) =>
  render(<PluginContext.Provider value={plugin}>{node}</PluginContext.Provider>);

describe("official create-task selectors", () => {
  it("uses Obsidian fuzzy suggestions with complete project and section breadcrumbs", () => {
    const projects = [
      project({ id: "child", name: "Child", parentId: "root", childOrder: 2 }),
      project({ id: "inbox", name: "Inbox", inboxProject: true, childOrder: 4 }),
      project({ id: "root", name: "Root", childOrder: 1 }),
    ];
    const sections = [
      section({ id: "planning", name: "Planning", projectId: "root" }),
      section({ id: "sprint", name: "Sprint", projectId: "child" }),
    ];
    const plugin = makePlugin({ projects, sections });
    const setSelected = vi.fn();
    renderWithPlugin(
      plugin,
      <ProjectSelector
        selected={{ projectId: "child", sectionId: "sprint" }}
        setSelected={setSelected}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set project" }));

    expect(screen.getByRole("button", { name: "Set project" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );

    const dialog = screen.getByRole("dialog", { name: "Project selector" });
    expect(within(dialog).getByRole("searchbox", { name: "Filter projects" })).toHaveAttribute(
      "placeholder",
      "Type a project name",
    );
    expect(
      within(dialog).getByRole("button", { name: "Root / Child / Sprint, current selection" }),
    ).toHaveTextContent("Current");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual([
      "Inbox",
      "Root",
      "Root / Planning",
      "Root / Child",
      "Root / Child / Sprint, current selection",
    ]);

    const search = within(dialog).getByRole("searchbox", { name: "Filter projects" });
    fireEvent.change(search, { target: { value: "sprint" } });
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Root / Child / Sprint, current selection" }),
    );
    expect(setSelected).toHaveBeenCalledWith({ projectId: "child", sectionId: "sprint" });
    expect(screen.queryByRole("dialog", { name: "Project selector" })).not.toBeInTheDocument();
  });

  it("uses an Obsidian Modal with searchable Setting toggles for label multi-selection", () => {
    const labels = [label("alpha", "Alpha"), label("beta", "Beta"), label("gamma", "Gamma")];
    const plugin = makePlugin({ labels });
    const setSelected = vi.fn();
    renderWithPlugin(
      plugin,
      <LabelSelector selected={[labels[0] as Label]} setSelected={setSelected} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set labels" }));

    expect(screen.getByRole("button", { name: "Set labels" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );

    const dialog = screen.getByRole("dialog", { name: "Label options" });
    const search = within(dialog).getByRole("searchbox", { name: "Filter labels" });
    expect(search).toHaveAttribute("placeholder", "Type a label name");
    expect(within(dialog).getByRole("checkbox", { name: "Alpha" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Beta" })).not.toBeChecked();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Beta" }));
    expect(setSelected).toHaveBeenLastCalledWith([labels[0], labels[1]]);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Alpha" }));
    expect(setSelected).toHaveBeenLastCalledWith([labels[1]]);

    fireEvent.change(search, { target: { value: "gam" } });
    expect(within(dialog).queryByRole("checkbox", { name: "Alpha" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Gamma" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Label options" })).not.toBeInTheDocument();
  });
});
