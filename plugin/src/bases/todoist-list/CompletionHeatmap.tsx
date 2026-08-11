import type React from "react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useObsidianTooltip } from "@/ui/hooks";

import "./CompletionHeatmap.scss";

import {
  buildCompletionHeatmapModel,
  COMPLETION_HEATMAP_RELATIVE_RANGE_OPTIONS,
  type CompletionHeatmapDay,
  type CompletionHeatmapEvent,
  type CompletionHeatmapLevel,
  type CompletionHeatmapModel,
  type CompletionHeatmapRange,
  completionHeatmapCalendarYearRange,
  formatCompletionHeatmapDateRange,
  isCompletionHeatmapRange,
} from "./completionHeatmapModel";

export type CompletionHeatmapProps = Readonly<{
  events: readonly CompletionHeatmapEvent[];
  range: CompletionHeatmapRange;
  onRangeChange: (range: CompletionHeatmapRange) => void;
  now?: Date;
  timeZone?: string;
}>;

type SelectedDates = Readonly<{
  startKey: string;
  endKey: string;
}>;

type GridNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

const WEEKDAY_LABELS = [
  { full: "Sunday", short: "Sun", visible: false },
  { full: "Monday", short: "Mon", visible: true },
  { full: "Tuesday", short: "Tue", visible: false },
  { full: "Wednesday", short: "Wed", visible: true },
  { full: "Thursday", short: "Thu", visible: false },
  { full: "Friday", short: "Fri", visible: true },
  { full: "Saturday", short: "Sat", visible: false },
] as const;

const TOOLTIP_OPTIONS = { placement: "top" } as const;
const FIRST_INDEX = 0;
const LAST_WEEKDAY_INDEX = WEEKDAY_LABELS.length - 1;
const INDEX_STEP = 1;
const NO_TASKS = 0;
const LOW_ACTIVITY_LEVEL: CompletionHeatmapLevel = 1;
const MEDIUM_LOW_ACTIVITY_LEVEL: CompletionHeatmapLevel = 2;
const MEDIUM_HIGH_ACTIVITY_LEVEL: CompletionHeatmapLevel = 3;
const HIGH_ACTIVITY_LEVEL: CompletionHeatmapLevel = 4;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const TIME_ZONE_BOUNDARY_SEARCH_HOURS = 36;
const MINIMUM_CLOCK_DELAY_MS = MILLISECONDS_PER_SECOND;
const MIDNIGHT_SETTLE_DELAY_MS = 50;
const TIME_ZONE_BOUNDARY_SEARCH_MS =
  TIME_ZONE_BOUNDARY_SEARCH_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const TIME_ZONE_BOUNDARY_PRECISION_MS = MILLISECONDS_PER_SECOND;
const CLOCK_REFRESH_FALLBACK_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const END_SCROLL_TOLERANCE_PX = 2;
const HEATMAP_LEVELS = [
  NO_TASKS,
  LOW_ACTIVITY_LEVEL,
  MEDIUM_LOW_ACTIVITY_LEVEL,
  MEDIUM_HIGH_ACTIVITY_LEVEL,
  HIGH_ACTIVITY_LEVEL,
] as const;
const GRID_ROLE_PROPS = {
  "aria-multiselectable": true,
  "aria-readonly": true,
  role: "grid",
} as const;
const gridCellRoleProps = (selected: boolean) =>
  ({ "aria-selected": selected, role: "gridcell" }) as const;

export const CompletionHeatmap: React.FC<CompletionHeatmapProps> = ({
  events,
  range,
  onRangeChange,
  now,
  timeZone,
}) => {
  const instanceId = useId();
  const headingId = `${instanceId}-heading`;
  const instructionsId = `${instanceId}-instructions`;
  const legendId = (level: CompletionHeatmapLevel) => `${instanceId}-legend-${level}`;
  const controlledNowTimestamp = now?.getTime();
  const [liveNowTimestamp, setLiveNowTimestamp] = useState(() => Date.now());
  const nowTimestamp =
    controlledNowTimestamp !== undefined && Number.isFinite(controlledNowTimestamp)
      ? controlledNowTimestamp
      : liveNowTimestamp;

  useEffect(() => {
    if (controlledNowTimestamp !== undefined && Number.isFinite(controlledNowTimestamp)) {
      return;
    }

    let timerId: number | undefined;
    const scheduleNextCalendarDay = () => {
      const current = new Date();
      const delay = nextCalendarDayDelay(current, timeZone);
      timerId = window.setTimeout(() => {
        setLiveNowTimestamp(Date.now());
        scheduleNextCalendarDay();
      }, delay);
    };

    scheduleNextCalendarDay();
    return () => {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [controlledNowTimestamp, timeZone]);

  const model = useMemo(
    () =>
      buildCompletionHeatmapModel({
        events,
        range,
        now: new Date(nowTimestamp),
        timeZone,
      }),
    [events, nowTimestamp, range, timeZone],
  );
  const [focusedKey, setFocusedKey] = useState(model.endKey);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<SelectedDates | null>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const viewportRef = useRef<HTMLElement | null>(null);
  const viewportPinnedToEndRef = useRef(true);
  const visibleWeekCount = model.weeks.length;
  const rangeBoundsKey = `${model.startKey}\u0000${model.endKey}`;
  const previousRangeBoundsKeyRef = useRef(rangeBoundsKey);

  useEffect(() => {
    if (previousRangeBoundsKeyRef.current === rangeBoundsKey) {
      return;
    }

    previousRangeBoundsKeyRef.current = rangeBoundsKey;
    setFocusedKey(model.endKey);
    setSelectionAnchor(null);
    setSelectedDates(null);
  }, [model.endKey, rangeBoundsKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (
      viewport === null ||
      visibleWeekCount <= FIRST_INDEX ||
      model.endKey.length <= FIRST_INDEX
    ) {
      return;
    }

    const scrollToEnd = () => {
      viewport.scrollLeft = Math.max(FIRST_INDEX, viewport.scrollWidth - viewport.clientWidth);
    };
    const updatePinnedState = () => {
      const maximumScroll = Math.max(FIRST_INDEX, viewport.scrollWidth - viewport.clientWidth);
      viewportPinnedToEndRef.current =
        maximumScroll - viewport.scrollLeft <= END_SCROLL_TOLERANCE_PX;
    };
    const handleViewportResize = () => {
      const contentFits = viewport.scrollWidth <= viewport.clientWidth;
      if (viewportPinnedToEndRef.current || contentFits) {
        viewportPinnedToEndRef.current = true;
        scrollToEnd();
      }
    };

    viewportPinnedToEndRef.current = true;
    scrollToEnd();
    viewport.addEventListener("scroll", updatePinnedState, { passive: true });
    const viewWindow = viewport.ownerDocument.defaultView;
    viewWindow?.addEventListener("resize", handleViewportResize);

    const ResizeObserverConstructor = viewWindow?.ResizeObserver;
    const resizeObserver =
      ResizeObserverConstructor === undefined
        ? null
        : new ResizeObserverConstructor(handleViewportResize);
    resizeObserver?.observe(viewport);
    const grid = viewport.querySelector(".tasks-bridge-completion-heatmap-grid");
    if (grid !== null) {
      resizeObserver?.observe(grid);
    }

    return () => {
      viewport.removeEventListener("scroll", updatePinnedState);
      viewWindow?.removeEventListener("resize", handleViewportResize);
      resizeObserver?.disconnect();
    };
  }, [model.endKey, visibleWeekCount]);

  const registerCell = useCallback((key: string, element: HTMLTableCellElement | null) => {
    if (element === null) {
      cellRefs.current.delete(key);
      return;
    }

    cellRefs.current.set(key, element);
  }, []);

  const focusDay = (day: CompletionHeatmapDay | undefined) => {
    if (day === undefined || !day.inRange) {
      return;
    }

    setFocusedKey(day.key);
    cellRefs.current.get(day.key)?.focus();
  };

  const moveFocus = (day: CompletionHeatmapDay, key: GridNavigationKey, wholeGrid: boolean) => {
    const target = navigationTarget(model, day, key, wholeGrid);
    focusDay(target);
  };

  const activateDay = (day: CompletionHeatmapDay, extendSelection: boolean) => {
    setFocusedKey(day.key);

    if (extendSelection && selectionAnchor !== null) {
      setSelectedDates(orderedSelection(selectionAnchor, day.key));
      setSelectionAnchor(null);
      return;
    }

    if (
      selectedDates !== null &&
      selectedDates.startKey === day.key &&
      selectedDates.endKey === day.key
    ) {
      setSelectedDates(null);
      setSelectionAnchor(null);
      return;
    }

    setSelectedDates({ startKey: day.key, endKey: day.key });
    setSelectionAnchor(day.key);
  };

  const selectedSummary = selectionSummary(model, selectedDates);
  const hasSelection = selectedDates !== null;

  return (
    <section aria-labelledby={headingId} className="tasks-bridge-completion-heatmap">
      <header className="tasks-bridge-completion-heatmap-header">
        <div className="tasks-bridge-completion-heatmap-heading-group">
          <h3 id={headingId}>Completion activity</h3>
          <p>
            {completionCountLabel(model.totalCount)} <span aria-hidden="true">·</span>{" "}
            <span>{model.rangeLabel}</span>
          </p>
        </div>
        <label className="tasks-bridge-completion-heatmap-range">
          <span className="tasks-bridge-completion-heatmap-sr-only">Activity range</span>
          <select
            aria-label="Activity range"
            className="dropdown"
            onChange={(event) => {
              if (isCompletionHeatmapRange(event.currentTarget.value)) {
                onRangeChange(event.currentTarget.value);
              }
            }}
            value={range}
          >
            <optgroup label="Recent ranges">
              {COMPLETION_HEATMAP_RELATIVE_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Calendar years">
              {model.availableYears.map((year) => {
                const value = completionHeatmapCalendarYearRange(year);
                return (
                  <option key={value} value={value}>
                    {year}
                  </option>
                );
              })}
            </optgroup>
          </select>
        </label>
      </header>

      <p className="tasks-bridge-completion-heatmap-sr-only" id={instructionsId}>
        Use arrow keys to move between days. Press Enter or Space to select a day. Hold Shift while
        selecting a second day to select a date range.
      </p>

      <section
        aria-label={`Completion calendar for ${model.periodLabel}`}
        className="tasks-bridge-completion-heatmap-viewport"
        ref={viewportRef}
      >
        <table
          {...GRID_ROLE_PROPS}
          aria-describedby={instructionsId}
          className="tasks-bridge-completion-heatmap-grid"
          data-has-selection={hasSelection || undefined}
        >
          <caption className="tasks-bridge-completion-heatmap-sr-only">
            Daily task completions from {model.periodLabel}
          </caption>
          <thead>
            <tr>
              <th className="tasks-bridge-completion-heatmap-corner" scope="col">
                <span className="tasks-bridge-completion-heatmap-sr-only">Day of week</span>
              </th>
              {model.monthLabels.map((label) => (
                <th
                  className="tasks-bridge-completion-heatmap-month"
                  colSpan={label.weekSpan}
                  key={`${label.fullLabel}-${label.startWeek}`}
                  scope="colgroup"
                >
                  <span aria-hidden="true">{label.weekSpan >= 2 ? label.shortLabel : ""}</span>
                  <span className="tasks-bridge-completion-heatmap-sr-only">{label.fullLabel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAY_LABELS.map((weekday, weekdayIndex) => (
              <tr key={weekday.full}>
                <th className="tasks-bridge-completion-heatmap-weekday" scope="row">
                  <span className="tasks-bridge-completion-heatmap-sr-only">{weekday.full}</span>
                  <span aria-hidden="true" data-visible={weekday.visible || undefined}>
                    {weekday.short}
                  </span>
                </th>
                {model.weeks.map((week) => {
                  const day = week.days[weekdayIndex];
                  if (day === undefined || !day.inRange) {
                    return (
                      <td
                        aria-hidden="true"
                        className="tasks-bridge-completion-heatmap-outside"
                        key={day?.key ?? `${week.index}-${weekdayIndex}`}
                      />
                    );
                  }

                  const selected = dateIsSelected(day.key, selectedDates);
                  return (
                    <HeatmapDayCell
                      day={day}
                      describedBy={legendId(day.level)}
                      focused={focusedKey === day.key}
                      key={day.key}
                      onActivate={activateDay}
                      onFocusDay={(focusedDay) => setFocusedKey(focusedDay.key)}
                      onMove={moveFocus}
                      registerCell={registerCell}
                      selected={selected}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="tasks-bridge-completion-heatmap-footer">
        <output
          aria-atomic="true"
          aria-live="polite"
          className="tasks-bridge-completion-heatmap-selection"
        >
          {selectedSummary}
        </output>
        <div className="tasks-bridge-completion-heatmap-legend">
          <span className="tasks-bridge-completion-heatmap-sr-only">Completion intensity: </span>
          <span>Less</span>
          {HEATMAP_LEVELS.map((level) => (
            <span
              className="tasks-bridge-completion-heatmap-legend-cell"
              data-level={level}
              id={legendId(level)}
              key={level}
            >
              <span className="tasks-bridge-completion-heatmap-sr-only">
                {legendLevelLabel(level)}
              </span>
            </span>
          ))}
          <span>More</span>
        </div>
      </footer>

      {model.totalCount === NO_TASKS && (
        <p className="tasks-bridge-completion-heatmap-empty">No task completions in this period.</p>
      )}
    </section>
  );
};

type HeatmapDayCellProps = Readonly<{
  day: CompletionHeatmapDay;
  describedBy: string;
  focused: boolean;
  selected: boolean;
  onActivate: (day: CompletionHeatmapDay, extendSelection: boolean) => void;
  onFocusDay: (day: CompletionHeatmapDay) => void;
  onMove: (day: CompletionHeatmapDay, key: GridNavigationKey, wholeGrid: boolean) => void;
  registerCell: (key: string, element: HTMLTableCellElement | null) => void;
}>;

const HeatmapDayCell: React.FC<HeatmapDayCellProps> = ({
  day,
  describedBy,
  focused,
  selected,
  onActivate,
  onFocusDay,
  onMove,
  registerCell,
}) => {
  const [cellElement, setCellElement] = useState<HTMLTableCellElement | null>(null);
  const tooltip = completionTooltip(day);
  useObsidianTooltip(cellElement, tooltip, TOOLTIP_OPTIONS);

  const setCellRef = useCallback(
    (element: HTMLTableCellElement | null) => {
      setCellElement(element);
      registerCell(day.key, element);
    },
    [day.key, registerCell],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTableCellElement>) => {
    if (isGridNavigationKey(event.key)) {
      event.preventDefault();
      onMove(day, event.key, event.ctrlKey || event.metaKey);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(day, event.shiftKey);
    }
  };

  const handleClick = (event: ReactMouseEvent<HTMLTableCellElement>) => {
    onActivate(day, event.shiftKey);
  };

  return (
    <td
      {...gridCellRoleProps(selected)}
      aria-describedby={describedBy}
      aria-label={tooltip}
      className="tasks-bridge-completion-heatmap-day"
      data-date={day.key}
      data-level={day.level}
      onClick={handleClick}
      onFocus={() => onFocusDay(day)}
      onKeyDown={handleKeyDown}
      ref={setCellRef}
      tabIndex={focused ? FIRST_INDEX : -INDEX_STEP}
    >
      <span aria-hidden="true" className="tasks-bridge-completion-heatmap-day-square" />
    </td>
  );
};

const nextCalendarDayDelay = (current: Date, timeZone: string | undefined): number => {
  if (timeZone === undefined) {
    return nextLocalCalendarDayDelay(current);
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
    const currentKey = formatter.format(current);
    const currentTime = current.getTime();
    let lowerBound = currentTime;
    let upperBound = currentTime + TIME_ZONE_BOUNDARY_SEARCH_MS;

    if (formatter.format(new Date(upperBound)) === currentKey) {
      return CLOCK_REFRESH_FALLBACK_MS;
    }

    while (upperBound - lowerBound > TIME_ZONE_BOUNDARY_PRECISION_MS) {
      const midpoint = Math.floor((lowerBound + upperBound) / 2);
      if (formatter.format(new Date(midpoint)) === currentKey) {
        lowerBound = midpoint + 1;
      } else {
        upperBound = midpoint;
      }
    }

    return Math.max(MINIMUM_CLOCK_DELAY_MS, upperBound - currentTime + MIDNIGHT_SETTLE_DELAY_MS);
  } catch {
    return nextLocalCalendarDayDelay(current);
  }
};

const nextLocalCalendarDayDelay = (current: Date): number => {
  const nextMidnight = new Date(current);
  nextMidnight.setHours(24, 0, 0, MIDNIGHT_SETTLE_DELAY_MS);
  return Math.max(MINIMUM_CLOCK_DELAY_MS, nextMidnight.getTime() - current.getTime());
};

const completionCountLabel = (count: number): string => {
  if (count === 1) {
    return "1 completion";
  }

  return `${count} completions`;
};

const completionTooltip = (day: CompletionHeatmapDay): string => {
  if (day.count === NO_TASKS) {
    return `No task completions on ${day.fullDateLabel}.`;
  }

  if (day.count === 1) {
    return `1 task completion on ${day.fullDateLabel}.`;
  }

  return `${day.count} task completions on ${day.fullDateLabel}.`;
};

const legendLevelLabel = (level: CompletionHeatmapLevel): string => {
  switch (level) {
    case NO_TASKS:
      return "No task completions";
    case LOW_ACTIVITY_LEVEL:
      return "Low completion activity";
    case MEDIUM_LOW_ACTIVITY_LEVEL:
      return "Medium-low completion activity";
    case MEDIUM_HIGH_ACTIVITY_LEVEL:
      return "Medium-high completion activity";
    case HIGH_ACTIVITY_LEVEL:
      return "High completion activity";
    default: {
      const exhaustiveLevel: never = level;
      return exhaustiveLevel;
    }
  }
};

const isGridNavigationKey = (key: string): key is GridNavigationKey =>
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "ArrowUp" ||
  key === "ArrowDown" ||
  key === "Home" ||
  key === "End" ||
  key === "PageUp" ||
  key === "PageDown";

const navigationTarget = (
  model: CompletionHeatmapModel,
  day: CompletionHeatmapDay,
  key: GridNavigationKey,
  wholeGrid: boolean,
): CompletionHeatmapDay | undefined => {
  switch (key) {
    case "ArrowLeft":
      return dayAt(model, day.weekIndex - INDEX_STEP, day.weekdayIndex);
    case "ArrowRight":
      return dayAt(model, day.weekIndex + INDEX_STEP, day.weekdayIndex);
    case "ArrowUp":
      return dayAt(model, day.weekIndex, day.weekdayIndex - INDEX_STEP);
    case "ArrowDown":
      return dayAt(model, day.weekIndex, day.weekdayIndex + INDEX_STEP);
    case "Home":
      return wholeGrid
        ? model.daysByKey.get(model.startKey)
        : edgeDayInWeekdayRow(model, day, true);
    case "End":
      return wholeGrid ? model.daysByKey.get(model.endKey) : edgeDayInWeekdayRow(model, day, false);
    case "PageUp":
      return edgeDayInWeek(model, day.weekIndex, true);
    case "PageDown":
      return edgeDayInWeek(model, day.weekIndex, false);
    default: {
      const exhaustiveKey: never = key;
      return exhaustiveKey;
    }
  }
};

const dayAt = (
  model: CompletionHeatmapModel,
  weekIndex: number,
  weekdayIndex: number,
): CompletionHeatmapDay | undefined => {
  if (weekIndex < FIRST_INDEX || weekdayIndex < FIRST_INDEX || weekdayIndex > LAST_WEEKDAY_INDEX) {
    return undefined;
  }

  const day = model.weeks[weekIndex]?.days[weekdayIndex];
  return day?.inRange ? day : undefined;
};

const edgeDayInWeekdayRow = (
  model: CompletionHeatmapModel,
  day: CompletionHeatmapDay,
  first: boolean,
): CompletionHeatmapDay | undefined => {
  const weeks = first ? model.weeks : [...model.weeks].reverse();
  return weeks.map((week) => week.days[day.weekdayIndex]).find((candidate) => candidate?.inRange);
};

const edgeDayInWeek = (
  model: CompletionHeatmapModel,
  weekIndex: number,
  first: boolean,
): CompletionHeatmapDay | undefined => {
  const days = model.weeks[weekIndex]?.days;
  if (days === undefined) {
    return undefined;
  }

  const orderedDays = first ? days : [...days].reverse();
  return orderedDays.find((candidate) => candidate.inRange);
};

const orderedSelection = (first: string, second: string): SelectedDates => {
  if (first <= second) {
    return { startKey: first, endKey: second };
  }

  return { startKey: second, endKey: first };
};

const dateIsSelected = (key: string, selection: SelectedDates | null): boolean =>
  selection !== null && key >= selection.startKey && key <= selection.endKey;

const selectionSummary = (
  model: CompletionHeatmapModel,
  selection: SelectedDates | null,
): string => {
  if (selection === null) {
    return `${completionCountLabel(model.totalCount)} from ${model.periodLabel}.`;
  }

  let count = 0;
  for (const [key, day] of model.daysByKey) {
    if (key >= selection.startKey && key <= selection.endKey) {
      count += day.count;
    }
  }

  return `${formatCompletionHeatmapDateRange(
    selection.startKey,
    selection.endKey,
  )} · ${completionCountLabel(count)}.`;
};
