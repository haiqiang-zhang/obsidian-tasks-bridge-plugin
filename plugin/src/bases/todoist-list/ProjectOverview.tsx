import type React from "react";
import { type CSSProperties, useId } from "react";

import { ObsidianIcon } from "@/ui/components/obsidian-icon";

import { CompletionHeatmap } from "./CompletionHeatmap";
import type { CompletionHeatmapRange } from "./completionHeatmapModel";
import type { ProjectOverviewModel } from "./projectOverviewModel";

export type ProjectOverviewProps = {
  model: ProjectOverviewModel;
  scopeLabel: string;
  collapsed: boolean;
  collapsible?: boolean;
  completionHeatmapRange: CompletionHeatmapRange;
  onCollapsedChange: (collapsed: boolean) => void;
  onCompletionHeatmapRangeChange: (range: CompletionHeatmapRange) => void;
};

type ProgressStyle = CSSProperties & {
  "--todoist-bases-project-overview-rate": number;
};

const percentageScale = 100;

export const ProjectOverview: React.FC<ProjectOverviewProps> = ({
  model,
  scopeLabel,
  collapsed,
  collapsible = true,
  completionHeatmapRange,
  onCollapsedChange,
  onCompletionHeatmapRangeChange,
}) => {
  const instanceId = useId();
  const headingId = `${instanceId}-heading`;
  const bodyId = `${instanceId}-body`;
  const isCollapsed = collapsible && collapsed;
  const headerContent = (
    <>
      <span className="todoist-bases-project-overview-header-leading">
        {collapsible && (
          <span aria-hidden="true" className="todoist-bases-project-overview-disclosure">
            <ObsidianIcon
              id={isCollapsed ? "lucide-chevron-right" : "lucide-chevron-down"}
              size="xs"
            />
          </span>
        )}
        <span className="todoist-bases-project-overview-title-group">
          <span className="todoist-bases-project-overview-title" id={headingId}>
            Project overview
          </span>
          <span className="todoist-bases-project-overview-scope" title={scopeLabel}>
            {scopeLabel}
          </span>
        </span>
      </span>
      <span className="todoist-bases-project-overview-header-summary">
        {projectSummaryLabel(model)}
      </span>
    </>
  );

  return (
    <section
      aria-labelledby={headingId}
      className="todoist-bases-project-overview"
      data-collapsed={isCollapsed || undefined}
      data-collapsible={collapsible}
    >
      {collapsible ? (
        <button
          aria-controls={bodyId}
          aria-expanded={!isCollapsed}
          className="todoist-bases-project-overview-toggle"
          onClick={() => onCollapsedChange(!isCollapsed)}
          type="button"
        >
          {headerContent}
        </button>
      ) : (
        <header className="todoist-bases-project-overview-header">{headerContent}</header>
      )}

      <div className="todoist-bases-project-overview-content" hidden={isCollapsed} id={bodyId}>
        <ProjectOverviewBody
          completionHeatmapRange={completionHeatmapRange}
          model={model}
          onCompletionHeatmapRangeChange={onCompletionHeatmapRangeChange}
        />
      </div>
    </section>
  );
};

const ProjectOverviewBody: React.FC<{
  model: ProjectOverviewModel;
  completionHeatmapRange: CompletionHeatmapRange;
  onCompletionHeatmapRangeChange: (range: CompletionHeatmapRange) => void;
}> = ({ model, completionHeatmapRange, onCompletionHeatmapRangeChange }) => (
  <div className="todoist-bases-project-overview-body">
    <div className="todoist-bases-project-overview-percentage">
      <CompletionRing
        completed={model.counts.completed}
        rate={model.completionRate}
        total={model.counts.active + model.counts.completed}
        unavailable={model.counts.unavailable}
      />
      <OverviewMetrics model={model} />
    </div>
    <CompletionHeatmap
      events={model.completionEvents}
      onRangeChange={onCompletionHeatmapRangeChange}
      range={completionHeatmapRange}
    />
  </div>
);

const CompletionRing: React.FC<{
  completed: number;
  rate: number | null;
  total: number;
  unavailable: number;
}> = ({ completed, rate, total, unavailable }) => {
  const rateLabel = formatCompletionRate(rate);
  let accessibleLabel: string;
  if (rate === null) {
    accessibleLabel =
      unavailable > 0
        ? "No available tasks to calculate completion"
        : "No tasks to calculate completion";
  } else {
    const availabilityLabel = unavailable > 0 ? "available " : "";
    accessibleLabel = `${rateLabel} complete, ${completed} completed of ${total} ${availabilityLabel}tasks`;
  }

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
  <fieldset aria-label="Project completion totals">
    <dl className="todoist-bases-project-overview-metrics">
      <Metric label="Total" value={model.taskCount} />
      <Metric label="Active" value={model.counts.active} />
      <Metric label="Completed" value={model.counts.completed} />
      <Metric label="Unavailable" value={model.counts.unavailable} />
      <Metric label="Projects" value={model.projectCount} />
    </dl>
  </fieldset>
);

const Metric: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="todoist-bases-project-overview-metric">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const projectSummaryLabel = (model: ProjectOverviewModel): string => {
  if (model.taskCount === 0) {
    return `${pluralize(model.projectCount, "project")} · No tasks`;
  }
  if (model.completionRate === null) {
    return `${pluralize(model.projectCount, "project")} · ${pluralize(model.taskCount, "task")} · ${model.counts.unavailable} unavailable`;
  }
  return `${pluralize(model.projectCount, "project")} · ${pluralize(model.taskCount, "task")} · ${formatCompletionRate(model.completionRate)} complete`;
};

const formatCompletionRate = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(clampRate(rate) * percentageScale)}%`;

const progressStyle = (rate: number | null): ProgressStyle => ({
  "--todoist-bases-project-overview-rate": rate === null ? 0 : clampRate(rate),
});

const clampRate = (rate: number): number => Math.max(0, Math.min(1, rate));

const pluralize = (count: number, noun: string): string =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;
