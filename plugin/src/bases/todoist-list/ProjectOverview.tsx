import type React from "react";
import { type CSSProperties, useId } from "react";

import type { ProjectSyncStatus } from "@/project-sync";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";

import type { ProjectOverviewModel, ProjectOverviewNode } from "./projectOverviewModel";

export type ProjectOverviewProps = {
  model: ProjectOverviewModel | null;
  scopeLabel: string;
  status: ProjectSyncStatus;
  configured: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

type ProgressStyle = CSSProperties & {
  "--todoist-bases-project-overview-rate": number;
};

const percentageScale = 100;

export const ProjectOverview: React.FC<ProjectOverviewProps> = ({
  model,
  scopeLabel,
  status,
  configured,
  collapsed,
  onCollapsedChange,
}) => {
  const instanceId = useId();
  const headingId = `${instanceId}-heading`;
  const bodyId = `${instanceId}-body`;
  const loading = model === null && configured && isWaitingForInitialSync(status);
  const available = model?.rootAvailable ?? true;
  const summary = projectSummaryLabel(model, status, configured);

  return (
    <section
      aria-busy={loading || undefined}
      aria-labelledby={headingId}
      className="todoist-bases-project-overview"
      data-collapsed={collapsed || undefined}
      data-loading={loading || undefined}
    >
      <button
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        className="todoist-bases-project-overview-toggle"
        onClick={() => onCollapsedChange(!collapsed)}
        type="button"
      >
        <span className="todoist-bases-project-overview-header-leading">
          <span aria-hidden="true" className="todoist-bases-project-overview-disclosure">
            <ObsidianIcon
              id={collapsed ? "lucide-chevron-right" : "lucide-chevron-down"}
              size="xs"
            />
          </span>
          <span className="todoist-bases-project-overview-title-group">
            <span className="todoist-bases-project-overview-title" id={headingId}>
              Project overview
            </span>
            <span className="todoist-bases-project-overview-scope" title={scopeLabel}>
              {scopeLabel}
            </span>
          </span>
        </span>
        <span className="todoist-bases-project-overview-header-meta">
          <span className="todoist-bases-project-overview-header-summary">{summary}</span>
          <LastSynced syncedAt={model?.syncedAt ?? null} />
        </span>
      </button>

      <div className="todoist-bases-project-overview-content" hidden={collapsed} id={bodyId}>
        {model === null && <ProjectOverviewState configured={configured} status={status} />}
        {model !== null && !available && <UnavailableRoot />}
        {model !== null && available && <ProjectOverviewBody model={model} />}
      </div>
    </section>
  );
};

const LastSynced: React.FC<{ syncedAt: string | null }> = ({ syncedAt }) => {
  if (syncedAt === null) {
    return (
      <span className="todoist-bases-project-overview-last-synced">
        <ObsidianIcon aria-hidden="true" id="lucide-refresh-cw" size="xs" />
        <span className="todoist-bases-project-overview-last-synced-label">Not synced yet</span>
      </span>
    );
  }

  return (
    <time
      className="todoist-bases-project-overview-last-synced"
      dateTime={syncedAt}
      title={syncedAt}
    >
      <ObsidianIcon aria-hidden="true" id="lucide-refresh-cw" size="xs" />
      <span className="todoist-bases-project-overview-last-synced-label">
        Last synced {formatSyncedAt(syncedAt)}
      </span>
    </time>
  );
};

const ProjectOverviewState: React.FC<{
  configured: boolean;
  status: ProjectSyncStatus;
}> = ({ configured, status }) => {
  if (!configured) {
    return (
      <output className="todoist-bases-project-overview-state">
        <ObsidianIcon id="lucide-settings" size="l" />
        <span className="todoist-bases-project-overview-state-copy">
          <strong>Project Sync is not configured.</strong>
          <span>Add a project mapping in Tasks Bridge settings to enable complete statistics.</span>
        </span>
      </output>
    );
  }

  if (status.state === "disabled") {
    return (
      <output className="todoist-bases-project-overview-state">
        <ObsidianIcon id="lucide-circle-pause" size="l" />
        <span className="todoist-bases-project-overview-state-copy">
          <strong>Project Sync is disabled.</strong>
          <span>Enable and configure Project Sync to see complete project statistics.</span>
        </span>
      </output>
    );
  }

  if (status.state === "error") {
    return (
      <output className="todoist-bases-project-overview-state">
        <ObsidianIcon id="lucide-circle-alert" size="l" />
        <span className="todoist-bases-project-overview-state-copy">
          <strong>Project overview is unavailable.</strong>
          <span>{status.message}</span>
        </span>
      </output>
    );
  }

  if (status.state === "disposed") {
    return (
      <output className="todoist-bases-project-overview-state">
        <ObsidianIcon id="lucide-circle-alert" size="l" />
        <span className="todoist-bases-project-overview-state-copy">
          <strong>Project overview is unavailable.</strong>
          <span>Reload Tasks Bridge to reconnect Project Sync.</span>
        </span>
      </output>
    );
  }

  return (
    <output
      aria-live="polite"
      className="todoist-bases-project-overview-state todoist-bases-project-overview-loading"
    >
      <ObsidianIcon className="is-loading" id="lucide-loader-circle" size="l" />
      <span className="todoist-bases-project-overview-state-copy">
        <strong>Preparing project overview</strong>
        <span>
          {status.state === "syncing"
            ? "Loading the complete Project Sync snapshot."
            : "Waiting for the initial Project Sync."}
        </span>
      </span>
    </output>
  );
};

const UnavailableRoot: React.FC = () => (
  <output className="todoist-bases-project-overview-state">
    <ObsidianIcon id="lucide-circle-alert" size="l" />
    <span className="todoist-bases-project-overview-state-copy">
      <strong>The selected root project is unavailable.</strong>
      <span>
        It is not part of the synchronized project hierarchy. Choose another root project to see its
        statistics.
      </span>
    </span>
  </output>
);

const ProjectOverviewBody: React.FC<{ model: ProjectOverviewModel }> = ({ model }) => (
  <div className="todoist-bases-project-overview-body">
    <div className="todoist-bases-project-overview-summary-panel">
      <CompletionRing
        completed={model.counts.completed}
        rate={model.completionRate}
        total={model.taskCount}
      />
      <OverviewMetrics model={model} />
      <TaskLegend active={model.counts.active} completed={model.counts.completed} />
    </div>

    <div className="todoist-bases-project-overview-breakdown">
      <div className="todoist-bases-project-overview-breakdown-heading">
        <span>Project breakdown</span>
        <span>Each project includes its descendants.</span>
      </div>
      {model.roots.length === 0 ? (
        <div className="todoist-bases-project-overview-no-projects">No projects to display.</div>
      ) : (
        <ul aria-label="Project statistics" className="todoist-bases-project-overview-projects">
          {model.roots.map((project) => (
            <ProjectStatistics key={project.id} project={project} />
          ))}
        </ul>
      )}
    </div>
  </div>
);

const CompletionRing: React.FC<{
  completed: number;
  rate: number | null;
  total: number;
}> = ({ completed, rate, total }) => {
  const rateLabel = formatCompletionRate(rate);
  const accessibleLabel =
    rate === null
      ? "No tasks to calculate completion"
      : `${rateLabel} complete, ${completed} completed of ${total} tasks`;

  return (
    <div
      aria-label={accessibleLabel}
      className="todoist-bases-project-overview-ring"
      data-empty={rate === null ? true : undefined}
      role="img"
      style={progressStyle(rate)}
    >
      <svg aria-hidden="true" viewBox="0 0 36 36">
        <circle
          className="todoist-bases-project-overview-ring-track"
          cx="18"
          cy="18"
          pathLength="1"
          r="16"
        />
        {rate !== null && (
          <circle
            className="todoist-bases-project-overview-ring-value"
            cx="18"
            cy="18"
            pathLength="1"
            r="16"
          />
        )}
      </svg>
      <span className="todoist-bases-project-overview-ring-label">{rateLabel}</span>
      <span className="todoist-bases-project-overview-ring-caption">Complete</span>
    </div>
  );
};

const OverviewMetrics: React.FC<{ model: ProjectOverviewModel }> = ({ model }) => (
  <dl className="todoist-bases-project-overview-metrics">
    <Metric label="Total" value={model.taskCount} />
    <Metric label="Active" value={model.counts.active} />
    <Metric label="Completed" value={model.counts.completed} />
    <Metric label="Projects" value={model.projectCount} />
  </dl>
);

const Metric: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="todoist-bases-project-overview-metric">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const TaskLegend: React.FC<{ active: number; completed: number }> = ({ active, completed }) => (
  <ul aria-label="Task status legend" className="todoist-bases-project-overview-legend">
    <li>
      <span
        aria-hidden="true"
        className="todoist-bases-project-overview-legend-marker"
        data-status="completed"
      />
      <span>Completed</span>
      <strong>{completed}</strong>
    </li>
    <li>
      <span
        aria-hidden="true"
        className="todoist-bases-project-overview-legend-marker"
        data-status="active"
      />
      <span>Active</span>
      <strong>{active}</strong>
    </li>
  </ul>
);

const ProjectStatistics: React.FC<{ project: ProjectOverviewNode }> = ({ project }) => {
  const rateLabel = formatCompletionRate(project.completionRate);
  const projectLabel =
    project.taskCount === 0
      ? `${project.name}: No tasks, including child projects`
      : `${project.name}: ${project.counts.completed} of ${project.taskCount} tasks completed, ${rateLabel}, including child projects`;

  return (
    <li
      aria-label={projectLabel}
      className="todoist-bases-project-overview-project"
      data-project-id={project.id}
    >
      <div className="todoist-bases-project-overview-project-row">
        <ObsidianIcon
          aria-hidden="true"
          className="todoist-bases-project-overview-project-icon"
          id="lucide-folder"
          size="s"
        />
        <span className="todoist-bases-project-overview-project-main">
          <span
            className="todoist-bases-project-overview-project-name"
            title={project.pathNames.join(" / ")}
          >
            {project.name}
          </span>
          {project.taskCount === 0 ? (
            <span className="todoist-bases-project-overview-project-empty">No tasks</span>
          ) : (
            <span className="todoist-bases-project-overview-project-counts">
              {project.counts.completed} / {project.taskCount} completed
              <span aria-hidden="true"> · </span>
              {rateLabel}
            </span>
          )}
        </span>
        <ProjectProgress project={project} />
      </div>
      {project.children.length > 0 && (
        <ul className="todoist-bases-project-overview-project-children">
          {project.children.map((child) => (
            <ProjectStatistics key={child.id} project={child} />
          ))}
        </ul>
      )}
    </li>
  );
};

const ProjectProgress: React.FC<{ project: ProjectOverviewNode }> = ({ project }) => {
  if (project.taskCount === 0 || project.completionRate === null) {
    return (
      <span
        aria-hidden="true"
        className="todoist-bases-project-overview-progress"
        data-empty="true"
      />
    );
  }

  return (
    <span
      aria-label={`${project.name} completion`}
      aria-valuemax={project.taskCount}
      aria-valuemin={0}
      aria-valuenow={project.counts.completed}
      className="todoist-bases-project-overview-progress"
      role="progressbar"
      style={progressStyle(project.completionRate)}
    >
      <span aria-hidden="true" className="todoist-bases-project-overview-progress-value" />
    </span>
  );
};

const projectSummaryLabel = (
  model: ProjectOverviewModel | null,
  status: ProjectSyncStatus,
  configured: boolean,
): string => {
  if (model === null) {
    if (!configured) {
      return "Project Sync not configured";
    }
    if (status.state === "disabled") {
      return "Project Sync disabled";
    }
    if (status.state === "error" || status.state === "disposed") {
      return "Project statistics unavailable";
    }
    return status.state === "syncing" ? "Syncing projects" : "Waiting for Project Sync";
  }
  if (!model.rootAvailable) {
    return "Project statistics unavailable";
  }
  if (model.taskCount === 0) {
    return `${pluralize(model.projectCount, "project")} · No tasks`;
  }
  return `${pluralize(model.projectCount, "project")} · ${pluralize(model.taskCount, "task")} · ${formatCompletionRate(model.completionRate)} complete`;
};

const isWaitingForInitialSync = (status: ProjectSyncStatus): boolean =>
  status.state === "idle" || status.state === "syncing" || status.state === "success";

const formatCompletionRate = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(clampRate(rate) * percentageScale)}%`;

const progressStyle = (rate: number | null): ProgressStyle => ({
  "--todoist-bases-project-overview-rate": rate === null ? 0 : clampRate(rate),
});

const clampRate = (rate: number): number => Math.max(0, Math.min(1, rate));

const pluralize = (count: number, noun: string): string =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

const formatSyncedAt = (syncedAt: string): string => {
  const date = new Date(syncedAt);
  if (Number.isNaN(date.valueOf())) {
    return syncedAt;
  }
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};
