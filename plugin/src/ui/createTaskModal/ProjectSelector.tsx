import { type FuzzyMatch, FuzzySuggestModal, renderResults, setIcon } from "obsidian";
import type React from "react";
import { useMemo } from "react";
import { Button } from "react-aria-components";

import { PluginContext } from "@/ui/context";
import type { UiText } from "@/uiText";
import { uiText } from "@/uiText";

import type TodoistPlugin from "../..";
import type { Project, ProjectId } from "../../api/domain/project";
import type { Section, SectionId } from "../../api/domain/section";
import { ObsidianIcon } from "../components/obsidian-icon";

export type ProjectIdentifier = {
  projectId: ProjectId;
  sectionId?: SectionId;
};

type Props = {
  selected: ProjectIdentifier;
  setSelected: (selected: ProjectIdentifier) => void;
};

type ProjectSelectorText = UiText["createTaskModal"]["projectSelector"];

type ProjectSelectionOption = {
  identifier: ProjectIdentifier;
  project: Project;
  section?: Section;
  pathNames: string[];
};

export const ProjectSelector: React.FC<Props> = ({ selected, setSelected }) => {
  const plugin = PluginContext.use();
  const options = useMemo(() => buildProjectOptions(plugin), [plugin]);
  const text = uiText.createTaskModal.projectSelector;

  const openSelector = () => {
    new ProjectSuggestModal(plugin, options, selected, setSelected, text).open();
  };

  return (
    <Button
      aria-haspopup="dialog"
      aria-label={text.buttonLabel}
      className="project-selector"
      onPress={openSelector}
    >
      <ButtonLabel {...selected} />
      <ObsidianIcon id="chevron-down" size="s" />
    </Button>
  );
};

class ProjectSuggestModal extends FuzzySuggestModal<ProjectSelectionOption> {
  private readonly options: ProjectSelectionOption[];
  private readonly selected: ProjectIdentifier;
  private readonly onSelect: (selected: ProjectIdentifier) => void;

  public constructor(
    plugin: TodoistPlugin,
    options: ProjectSelectionOption[],
    selected: ProjectIdentifier,
    onSelect: (selected: ProjectIdentifier) => void,
    text: ProjectSelectorText,
  ) {
    super(plugin.app);
    this.options = options;
    this.selected = selected;
    this.onSelect = onSelect;
    this.limit = Math.max(this.limit, options.length);
    this.emptyStateText = text.emptyState;
    this.setTitle(text.selectorLabel);
    this.setPlaceholder(text.search.placeholder);
    this.inputEl.setAttribute("aria-label", text.search.label);
    this.modalEl.classList.add("tasks-bridge-project-suggest-modal");
  }

  public getItems(): ProjectSelectionOption[] {
    return this.options;
  }

  public getItemText(option: ProjectSelectionOption): string {
    return option.pathNames.join(" / ");
  }

  public onChooseItem(option: ProjectSelectionOption): void {
    this.onSelect(option.identifier);
  }

  public override renderSuggestion(
    match: FuzzyMatch<ProjectSelectionOption>,
    el: HTMLElement,
  ): void {
    const { item } = match;
    const current = identifiersEqual(item.identifier, this.selected);
    el.classList.add("tasks-bridge-project-suggestion");
    el.dataset.kind = item.section === undefined ? "project" : "section";
    el.setAttribute(
      "aria-label",
      `${this.getItemText(item)}${current ? ", current selection" : ""}`,
    );

    const iconEl = el.createSpan({ cls: "tasks-bridge-project-suggestion-icon" });
    iconEl.setAttribute("aria-hidden", "true");
    if (item.section === undefined) {
      iconEl.dataset.projectColor = item.project.color;
      setIcon(iconEl, item.project.inboxProject ? "inbox" : "hash");
    } else {
      setIcon(iconEl, "gallery-vertical");
    }

    const copyEl = el.createSpan({ cls: "tasks-bridge-project-suggestion-copy" });
    const pathEl = copyEl.createSpan({ cls: "tasks-bridge-project-suggestion-path" });
    renderResults(pathEl, this.getItemText(item), match.match);
    copyEl.createSpan({
      cls: "tasks-bridge-project-suggestion-kind",
      text: item.section === undefined ? "Project" : "Section",
    });

    if (current) {
      el.createSpan({ cls: "tasks-bridge-project-suggestion-current", text: "Current" });
    }
  }
}

const identifiersEqual = (left: ProjectIdentifier, right: ProjectIdentifier): boolean =>
  left.projectId === right.projectId && left.sectionId === right.sectionId;

const SectionLabel: React.FC<{ section: Section }> = ({ section }) => (
  <>
    <ObsidianIcon id="gallery-vertical" size="s" />
    <div>{section.name}</div>
  </>
);

const ProjectLabel: React.FC<{ project: Project }> = ({ project }) => (
  <>
    <ObsidianIcon
      className="todoist-project-icon"
      data-project-color={project.color}
      id={project.inboxProject ? "inbox" : "hash"}
      size="s"
    />
    <div>{project.name}</div>
  </>
);

const ButtonLabel: React.FC<ProjectIdentifier> = ({ projectId, sectionId }) => {
  const { projects, sections } = PluginContext.use().services.todoist.data();
  const selectedProject = projects.byId(projectId);
  if (selectedProject === undefined) {
    throw new Error("Could not find selected project");
  }

  const selectedSection = sectionId === undefined ? undefined : sections.byId(sectionId);
  return (
    <>
      <ProjectLabel project={selectedProject} />
      {selectedSection !== undefined && (
        <>
          <div>/</div>
          <SectionLabel section={selectedSection} />
        </>
      )}
    </>
  );
};

type NestedProject = {
  project: Project;
  sections: Section[];
  children: NestedProject[];
};

type ProjectHierarchy = NestedProject[];

const buildProjectOptions = (plugin: TodoistPlugin): ProjectSelectionOption[] => {
  const options: ProjectSelectionOption[] = [];
  const visit = (nested: NestedProject, parentNames: readonly string[]) => {
    const projectPath = [...parentNames, nested.project.name];
    options.push({
      identifier: { projectId: nested.project.id },
      project: nested.project,
      pathNames: projectPath,
    });
    for (const section of nested.sections) {
      options.push({
        identifier: { projectId: nested.project.id, sectionId: section.id },
        project: nested.project,
        section,
        pathNames: [...projectPath, section.name],
      });
    }
    for (const child of nested.children) {
      visit(child, projectPath);
    }
  };

  for (const root of buildProjectHierarchy(plugin)) {
    visit(root, []);
  }
  return options;
};

const buildProjectHierarchy = (plugin: TodoistPlugin): ProjectHierarchy => {
  const data = plugin.services.todoist.data();
  const mapped = new Map<ProjectId, NestedProject>();
  for (const project of data.projects.iterActive()) {
    mapped.set(project.id, { project, sections: [], children: [] });
  }

  for (const project of data.projects.iterActive()) {
    if (project.parentId === null) {
      continue;
    }
    const child = mapped.get(project.id);
    if (child === undefined) {
      throw new Error("Failed to find project in map");
    }
    mapped.get(project.parentId)?.children.push(child);
  }

  for (const section of data.sections.iterActive()) {
    mapped.get(section.projectId)?.sections.push(section);
  }

  for (const nested of mapped.values()) {
    nested.sections.sort((left, right) => left.sectionOrder - right.sectionOrder);
    nested.children.sort((left, right) => left.project.childOrder - right.project.childOrder);
  }

  const roots = Array.from(data.projects.iterActive())
    .filter((project) => project.parentId === null)
    .map((project) => {
      const root = mapped.get(project.id);
      if (root === undefined) {
        throw new Error("Failed to find root project in map");
      }
      return root;
    });
  roots.sort((left, right) => {
    if (left.project.inboxProject !== right.project.inboxProject) {
      return left.project.inboxProject ? -1 : 1;
    }
    return left.project.childOrder - right.project.childOrder;
  });
  return roots;
};
