import type React from "react";
import { useMemo } from "react";

import type { Project } from "@/api/domain/project";
import { t } from "@/i18n";
import type { ProjectDefaultSetting } from "@/settings";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";

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
  const i18n = t().settings.projectSync.project;

  const options = useMemo(() => buildProjectOptions(metadata.projects), [metadata.projects]);
  const selectedProject =
    value === null
      ? undefined
      : metadata.projects.find((project) => project.id === value.projectId);
  const isProjectDeleted = metadata.ready && value !== null && selectedProject === undefined;

  const handleChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const projectId = event.target.value;
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
        <div className="project-dropdown-warning-icon" title={i18n.deletedWarning}>
          <ObsidianIcon size="s" id="lucide-alert-triangle" />
        </div>
      )}
      <select
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        aria-label={ariaLabel ?? i18n.label}
        className="dropdown project-sync-project-dropdown"
        disabled={!metadata.ready && value === null}
        id={id}
        onChange={handleChange}
        value={value?.projectId ?? ""}
      >
        <option value="">{metadata.ready ? i18n.noProject : i18n.loading}</option>
        {options.map(({ project, label }) => (
          <option key={project.id} value={project.id}>
            {label}
          </option>
        ))}
        {value !== null && selectedProject === undefined && (
          <option value={value.projectId} disabled={isProjectDeleted}>
            {value.projectName}
            {isProjectDeleted ? ` (${i18n.deleted})` : ""}
          </option>
        )}
      </select>
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
