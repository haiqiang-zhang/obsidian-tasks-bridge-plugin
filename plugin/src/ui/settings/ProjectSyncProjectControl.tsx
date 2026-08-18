import type React from "react";
import { useMemo } from "react";

import type { Project } from "@/api/domain/project";
import type { ProjectDefaultSetting } from "@/settings";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { uiText } from "@/uiText";

import { ObsidianDropdown } from "./ObsidianDropdown";

const projectIndentWidth = 2;

type Props = {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  id?: string;
  invalid?: boolean;
  metadata: ProjectMetadata;
  value: ProjectDefaultSetting;
  onChange: (value: ProjectDefaultSetting) => Promise<void>;
};

export type ProjectMetadata = {
  ready: boolean;
  projects: Project[];
};

type ProjectOption = {
  project: Project;
  label: string;
};

export const ProjectSyncProjectControl: React.FC<Props> = ({
  ariaDescribedBy,
  ariaLabel,
  id,
  invalid = false,
  metadata,
  value,
  onChange,
}) => {
  const text = uiText.settings.projectSync.project;

  const options = useMemo(() => buildProjectOptions(metadata.projects), [metadata.projects]);
  const selectedProject =
    value === null
      ? undefined
      : metadata.projects.find((project) => project.id === value.projectId);
  const isProjectDeleted = metadata.ready && value !== null && selectedProject === undefined;

  const handleChange = async (projectId: string) => {
    if (projectId.length === 0) {
      await onChange(null);
      return;
    }

    const project = metadata.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return;
    }

    await onChange({
      projectId: project.id,
      projectName: project.name,
    });
  };

  return (
    <div className="project-dropdown-container">
      {isProjectDeleted && (
        <div className="project-dropdown-warning-icon" title={text.deletedWarning}>
          <ObsidianIcon size="s" id="lucide-alert-triangle" />
        </div>
      )}
      <ObsidianDropdown
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={invalid}
        ariaLabel={ariaLabel ?? text.label}
        className="project-sync-project-dropdown"
        disabled={!metadata.ready && value === null}
        id={id}
        onChange={handleChange}
        options={[
          {
            label: metadata.ready ? text.noProject : text.loading,
            value: "",
          },
          ...options.map(({ project, label }) => ({ label, value: project.id })),
          ...(value !== null && selectedProject === undefined
            ? [
                {
                  disabled: isProjectDeleted,
                  label: `${value.projectName}${isProjectDeleted ? ` (${text.deleted})` : ""}`,
                  value: value.projectId,
                },
              ]
            : []),
        ]}
        value={value?.projectId ?? ""}
      />
    </div>
  );
};

export const buildProjectOptions = (projects: Project[]): ProjectOption[] => {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const childrenByParent = new Map<string | null, Project[]>();

  for (const project of projects) {
    const parentId =
      project.parentId !== null && projectsById.has(project.parentId) ? project.parentId : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(project);
    childrenByParent.set(parentId, siblings);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareProjects);
  }

  const displayNames = new Map<string, string>();
  for (const children of childrenByParent.values()) {
    const counts = new Map<string, number>();
    for (const project of children) {
      const key = project.name.toLocaleLowerCase("en-US");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const project of children) {
      const isDuplicate = (counts.get(project.name.toLocaleLowerCase("en-US")) ?? 0) > 1;
      displayNames.set(project.id, isDuplicate ? `${project.name} (${project.id})` : project.name);
    }
  }

  const options: ProjectOption[] = [];
  const visited = new Set<string>();
  const visit = (project: Project, depth: number) => {
    if (visited.has(project.id)) {
      return;
    }

    visited.add(project.id);
    const breadcrumb = getProjectBreadcrumb(project, projectsById, displayNames);
    const indentation = "\u00a0".repeat(depth * projectIndentWidth);
    options.push({
      project,
      label: `${indentation}${breadcrumb.join(" / ")}`,
    });

    for (const child of childrenByParent.get(project.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    visit(root, 0);
  }

  for (const project of [...projects].sort(compareProjects)) {
    visit(project, 0);
  }

  return options;
};

const getProjectBreadcrumb = (
  project: Project,
  projectsById: ReadonlyMap<string, Project>,
  displayNames: ReadonlyMap<string, string>,
): string[] => {
  const breadcrumb: string[] = [];
  const seen = new Set<string>();
  let current: Project | undefined = project;

  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    breadcrumb.push(displayNames.get(current.id) ?? current.name);
    current = current.parentId === null ? undefined : projectsById.get(current.parentId);
  }

  return breadcrumb.reverse();
};

const compareProjects = (left: Project, right: Project): number =>
  left.childOrder - right.childOrder ||
  left.name.localeCompare(right.name) ||
  left.id.localeCompare(right.id);
