import type React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Project } from "@/api/domain/project";
import { t } from "@/i18n";
import { isPathInside, selectProjectHierarchy } from "@/project-sync";
import {
  createProjectSyncMapping,
  type ProjectSyncMapping,
  updateProjectSyncMappingFolder,
  updateProjectSyncMappingProject,
} from "@/settings";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";

import { ProjectSyncFolderControl } from "./ProjectSyncFolderControl";
import { type ProjectMetadata, ProjectSyncProjectControl } from "./ProjectSyncProjectControl";
import { Setting } from "./SettingItem";

const metadataRefreshIntervalMs = 1000;

export type ProjectSyncMappingValue = ProjectSyncMapping;

export type ProjectSyncMappingIssueCode =
  | "projectRequired"
  | "folderRequired"
  | "projectUnavailable"
  | "folderMissing"
  | "duplicateProject"
  | "folderOverlap"
  | "hierarchyOverlap";

export type ProjectSyncMappingsValidation = {
  issues: ProjectSyncMappingIssueCode[][];
  valid: boolean;
};

type Props = {
  mappings: ProjectSyncMappingValue[];
  onChange: (mappings: ProjectSyncMappingValue[], valid: boolean) => Promise<void>;
  onValidityChange: (valid: boolean, ready: boolean) => void;
};

type SyncMetadata = ProjectMetadata & {
  folders: string[];
};

export const ProjectSyncMappingsControl: React.FC<Props> = ({
  mappings,
  onChange,
  onValidityChange,
}) => {
  const plugin = PluginContext.use();
  const i18n = t().settings.projectSync.mappings;
  const [metadata, setMetadata] = useState<SyncMetadata>(() => readSyncMetadata(plugin));
  const mappingsRef = useRef(mappings);

  useEffect(() => {
    mappingsRef.current = mappings;
  }, [mappings]);

  useEffect(() => {
    let signature = "";
    const refresh = () => {
      const next = readSyncMetadata(plugin);
      const nextSignature = makeSyncMetadataSignature(next);
      if (nextSignature === signature) {
        return;
      }

      signature = nextSignature;
      setMetadata(next);
    };

    refresh();
    const interval = window.setInterval(refresh, metadataRefreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [plugin]);

  const validation = useMemo(
    () =>
      validateProjectSyncMappings(mappings, metadata.projects, metadata.folders, metadata.ready),
    [mappings, metadata],
  );

  useLayoutEffect(() => {
    onValidityChange(validation.valid, metadata.ready);
  }, [metadata.ready, onValidityChange, validation.valid]);

  const commitMappings = async (next: ProjectSyncMappingValue[]) => {
    const nextValidation = validateProjectSyncMappings(
      next,
      metadata.projects,
      metadata.folders,
      metadata.ready,
    );
    const previous = mappingsRef.current;
    mappingsRef.current = next;
    try {
      await onChange(next, nextValidation.valid);
    } catch (error: unknown) {
      mappingsRef.current = previous;
      throw error;
    }
  };

  const updateMapping = async (index: number, mapping: ProjectSyncMappingValue) => {
    const next = [...mappingsRef.current];
    next[index] = mapping;
    await commitMappings(next);
  };

  const removeMapping = async (index: number) => {
    await commitMappings(
      mappingsRef.current.filter((_, candidateIndex) => candidateIndex !== index),
    );
  };

  const addMapping = async () => {
    await commitMappings([...mappingsRef.current, createProjectSyncMapping()]);
  };

  return (
    <div className="project-sync-mappings-control">
      {mappings.length === 0 ? (
        <output className="project-sync-mappings-empty">
          <ObsidianIcon id="lucide-folder-sync" size="l" />
          <span>{i18n.empty}</span>
        </output>
      ) : (
        <div className="project-sync-mappings-list">
          {mappings.map((mapping, index) => (
            <ProjectSyncMappingCard
              folders={metadata.folders}
              index={index}
              issues={validation.issues[index] ?? []}
              key={mapping.id}
              mapping={mapping}
              metadata={metadata}
              onChange={async (next) => await updateMapping(index, next)}
              onRemove={async () => await removeMapping(index)}
            />
          ))}
        </div>
      )}
      <Setting.ButtonControl icon="plus" label={i18n.add} onClick={addMapping} />
    </div>
  );
};

type CardProps = {
  folders: string[];
  index: number;
  issues: ProjectSyncMappingIssueCode[];
  mapping: ProjectSyncMappingValue;
  metadata: ProjectMetadata;
  onChange: (mapping: ProjectSyncMappingValue) => Promise<void>;
  onRemove: () => Promise<void>;
};

const ProjectSyncMappingCard: React.FC<CardProps> = ({
  folders,
  index,
  issues,
  mapping,
  metadata,
  onChange,
  onRemove,
}) => {
  const i18n = t().settings.projectSync;
  const titleId = useId();
  const projectControlId = `${titleId}-project`;
  const projectErrorsId = `${titleId}-project-errors`;
  const folderControlId = `${titleId}-folder`;
  const folderHintId = `${titleId}-folder-hint`;
  const folderErrorsId = `${titleId}-folder-errors`;
  const projectIssues = issues.filter(isProjectIssue);
  const folderIssues = issues.filter(isFolderIssue);
  const mappingNumber = index + 1;

  const toggleSubprojects = async () => {
    await onChange({ ...mapping, includeSubprojects: !mapping.includeSubprojects });
  };

  const handleToggleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void toggleSubprojects();
  };

  return (
    <section aria-labelledby={titleId} className="project-sync-mapping-card">
      <div className="project-sync-mapping-header">
        <div className="project-sync-mapping-title" id={titleId}>
          <ObsidianIcon id="lucide-folder-kanban" size="m" />
          <span>{i18n.mappings.mappingLabel(mappingNumber)}</span>
        </div>
        <button
          aria-label={i18n.mappings.removeLabel(mappingNumber)}
          className="clickable-icon project-sync-mapping-remove"
          onClick={() => void onRemove()}
          title={i18n.mappings.remove}
          type="button"
        >
          <ObsidianIcon id="lucide-trash-2" size="m" />
        </button>
      </div>

      <div className="project-sync-mapping-fields">
        <div className="project-sync-mapping-field">
          <label className="project-sync-mapping-field-label" htmlFor={projectControlId}>
            {i18n.project.label}
          </label>
          <ProjectSyncProjectControl
            ariaDescribedBy={projectIssues.length > 0 ? projectErrorsId : undefined}
            ariaLabel={`${i18n.project.label}, ${i18n.mappings.mappingLabel(mappingNumber)}`}
            id={projectControlId}
            invalid={projectIssues.length > 0}
            metadata={metadata}
            onChange={async (project) =>
              await onChange(updateProjectSyncMappingProject(mapping, project))
            }
            value={mapping.project}
          />
          <MappingIssues id={projectErrorsId} issues={projectIssues} />
        </div>

        <div className="project-sync-mapping-field">
          <label className="project-sync-mapping-field-label" htmlFor={folderControlId}>
            {i18n.folder.label}
          </label>
          <ProjectSyncFolderControl
            ariaDescribedBy={
              folderIssues.length > 0 ? `${folderHintId} ${folderErrorsId}` : folderHintId
            }
            ariaLabel={`${i18n.folder.label}, ${i18n.mappings.mappingLabel(mappingNumber)}`}
            folders={folders}
            id={folderControlId}
            invalid={folderIssues.length > 0}
            onChange={async (folder) =>
              await onChange(updateProjectSyncMappingFolder(mapping, folder, folders))
            }
            value={mapping.folder}
          />
          <div className="project-sync-mapping-field-hint" id={folderHintId}>
            {i18n.folder.exactRootHint}
          </div>
          <MappingIssues id={folderErrorsId} issues={folderIssues} />
        </div>
      </div>

      {mapping.previousFolders.length > 0 && (
        <output className="project-sync-mapping-migration">
          <ObsidianIcon id="lucide-folder-input" size="s" />
          <div>
            <div className="project-sync-mapping-migration-label">
              {i18n.mappings.pendingMoveLabel}
            </div>
            <div className="project-sync-mapping-migration-description">
              {i18n.mappings.pendingMoveDescription(mapping.previousFolders.join(", "))}
            </div>
          </div>
        </output>
      )}

      <div className="project-sync-mapping-toggle-row">
        <div>
          <div className="project-sync-mapping-toggle-label">{i18n.includeSubprojects.label}</div>
          <div className="project-sync-mapping-toggle-description">
            {i18n.includeSubprojects.description}
          </div>
        </div>
        <div
          aria-checked={mapping.includeSubprojects}
          aria-label={`${i18n.includeSubprojects.label}, ${i18n.mappings.mappingLabel(mappingNumber)}`}
          className={`checkbox-container${mapping.includeSubprojects ? " is-enabled" : ""}`}
          onClick={() => void toggleSubprojects()}
          onKeyDown={handleToggleKeyDown}
          role="switch"
          tabIndex={0}
        />
      </div>
    </section>
  );
};

const MappingIssues: React.FC<{ id: string; issues: ProjectSyncMappingIssueCode[] }> = ({
  id,
  issues,
}) => {
  if (issues.length === 0) {
    return null;
  }

  const messages = t().settings.projectSync.validation;
  return (
    <div aria-live="polite" className="project-sync-mapping-errors" id={id}>
      {issues.map((issue) => (
        <div className="project-sync-mapping-error" key={issue}>
          <ObsidianIcon id="lucide-circle-alert" size="s" />
          <span>{messages[issue]}</span>
        </div>
      ))}
    </div>
  );
};

const isProjectIssue = (issue: ProjectSyncMappingIssueCode): boolean =>
  issue === "projectRequired" ||
  issue === "projectUnavailable" ||
  issue === "duplicateProject" ||
  issue === "hierarchyOverlap";

const isFolderIssue = (issue: ProjectSyncMappingIssueCode): boolean =>
  issue === "folderRequired" || issue === "folderMissing" || issue === "folderOverlap";

const readSyncMetadata = (plugin: ReturnType<typeof PluginContext.use>): SyncMetadata => ({
  ready: plugin.services.todoist.isReady(),
  projects: plugin.services.todoist.listActiveProjects(),
  folders: plugin.app.vault
    .getAllFolders(false)
    .map((folder) => folder.path)
    .sort((left, right) => left.localeCompare(right)),
});

const makeSyncMetadataSignature = ({ ready, projects, folders }: SyncMetadata): string =>
  JSON.stringify({
    ready,
    folders,
    projects: projects
      .map(({ id, parentId, name, childOrder }) => ({ id, parentId, name, childOrder }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });

export const validateProjectSyncMappings = (
  mappings: ProjectSyncMappingValue[],
  projects: Project[],
  folders: string[],
  projectMetadataReady = true,
): ProjectSyncMappingsValidation => {
  const issueSets = mappings.map(() => new Set<ProjectSyncMappingIssueCode>());
  const addIssue = (index: number, issue: ProjectSyncMappingIssueCode) => {
    issueSets[index]?.add(issue);
  };
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const existingFolders = new Set(folders.map(normalizeFolder));

  for (const [index, mapping] of mappings.entries()) {
    if (mapping.project === null) {
      addIssue(index, "projectRequired");
    } else if (projectMetadataReady && !projectsById.has(mapping.project.projectId)) {
      addIssue(index, "projectUnavailable");
    }

    const folder = normalizeFolder(mapping.folder);
    if (folder.length === 0) {
      addIssue(index, "folderRequired");
    } else if (!existingFolders.has(folder)) {
      addIssue(index, "folderMissing");
    }
  }

  for (let leftIndex = 0; leftIndex < mappings.length; leftIndex++) {
    const left = mappings[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < mappings.length; rightIndex++) {
      const right = mappings[rightIndex];
      if (
        left.project !== null &&
        right.project !== null &&
        left.project.projectId === right.project.projectId
      ) {
        addIssue(leftIndex, "duplicateProject");
        addIssue(rightIndex, "duplicateProject");
      }

      const leftFolders = mappingFolderKeys(left, existingFolders);
      const rightFolders = mappingFolderKeys(right, existingFolders);
      if (
        leftFolders.some((leftFolder) =>
          rightFolders.some(
            (rightFolder) =>
              isPathInside(leftFolder, rightFolder) || isPathInside(rightFolder, leftFolder),
          ),
        )
      ) {
        addIssue(leftIndex, "folderOverlap");
        addIssue(rightIndex, "folderOverlap");
      }
    }
  }

  for (const [rootIndex, rootMapping] of mappings.entries()) {
    if (rootMapping.project === null || !rootMapping.includeSubprojects) {
      continue;
    }

    let coveredProjectIds: Set<string>;
    try {
      coveredProjectIds = new Set(
        selectProjectHierarchy(projects, rootMapping.project.projectId, true).map(
          (project) => project.id,
        ),
      );
    } catch {
      continue;
    }

    for (const [candidateIndex, candidateMapping] of mappings.entries()) {
      if (
        candidateIndex === rootIndex ||
        candidateMapping.project === null ||
        candidateMapping.project.projectId === rootMapping.project.projectId ||
        !coveredProjectIds.has(candidateMapping.project.projectId)
      ) {
        continue;
      }

      addIssue(rootIndex, "hierarchyOverlap");
      addIssue(candidateIndex, "hierarchyOverlap");
    }
  }

  const issues = issueSets.map((mappingIssues) => Array.from(mappingIssues));
  return {
    issues,
    valid:
      projectMetadataReady &&
      mappings.length > 0 &&
      issues.every((mappingIssues) => mappingIssues.length === 0),
  };
};

const normalizeFolder = (folder: string): string =>
  folder
    .trim()
    .split("\\")
    .join("/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");

const portableFolderKey = (folder: string): string =>
  normalizeFolder(folder).normalize("NFC").toLocaleLowerCase("en-US");

const mappingFolderKeys = (
  mapping: ProjectSyncMappingValue,
  existingFolders: ReadonlySet<string>,
): string[] =>
  [
    mapping.folder,
    ...mapping.previousFolders.filter((folder) => existingFolders.has(normalizeFolder(folder))),
  ]
    .map(portableFolderKey)
    .filter((folder) => folder.length > 0);
