export type CompletionHeatmapEvent = Readonly<{
  id: string;
  completedAt: string | number | Date;
}>;

export type CompletionHeatmapRelativeRange =
  | "last-4-weeks"
  | "last-3-months"
  | "last-6-months"
  | "last-year";

export type CompletionHeatmapCalendarYearRange = `year:${number}`;

export type CompletionHeatmapRange =
  | CompletionHeatmapRelativeRange
  | CompletionHeatmapCalendarYearRange;

export type CompletionHeatmapLevel = 0 | 1 | 2 | 3 | 4;

export type CompletionHeatmapDay = Readonly<{
  key: string;
  year: number;
  month: number;
  day: number;
  weekdayIndex: number;
  weekIndex: number;
  count: number;
  level: CompletionHeatmapLevel;
  inRange: boolean;
  fullDateLabel: string;
}>;

export type CompletionHeatmapWeek = Readonly<{
  index: number;
  days: readonly CompletionHeatmapDay[];
}>;

export type CompletionHeatmapMonthLabel = Readonly<{
  fullLabel: string;
  shortLabel: string;
  startWeek: number;
  weekSpan: number;
}>;

export type CompletionHeatmapRangeOption = Readonly<{
  value: CompletionHeatmapRelativeRange;
  label: string;
}>;

export type CompletionHeatmapModel = Readonly<{
  range: CompletionHeatmapRange;
  rangeLabel: string;
  startKey: string;
  endKey: string;
  periodLabel: string;
  totalCount: number;
  availableYears: readonly number[];
  weeks: readonly CompletionHeatmapWeek[];
  monthLabels: readonly CompletionHeatmapMonthLabel[];
  daysByKey: ReadonlyMap<string, CompletionHeatmapDay>;
}>;

export type BuildCompletionHeatmapModelInput = Readonly<{
  events: readonly CompletionHeatmapEvent[];
  range: CompletionHeatmapRange;
  now?: Date;
  timeZone?: string;
}>;

export const COMPLETION_HEATMAP_RELATIVE_RANGE_OPTIONS = [
  { value: "last-4-weeks", label: "Last 4 weeks" },
  { value: "last-3-months", label: "Last 3 months" },
  { value: "last-6-months", label: "Last 6 months" },
  { value: "last-year", label: "Last year" },
] as const satisfies readonly CompletionHeatmapRangeOption[];

const DAY_IN_MILLISECONDS = 86_400_000;
const DAYS_IN_WEEK = 7;
const FOUR_WEEKS_IN_DAYS = 28;
const THREE_MONTHS = 3;
const SIX_MONTHS = 6;
const MONTHS_IN_YEAR = 12;
const FIRST_MONTH = 1;
const FIRST_DAY = 1;
const MINIMUM_YEAR = 1;
const MAXIMUM_YEAR = 9999;
const YEAR_KEY_WIDTH = 4;
const MONTH_DAY_KEY_WIDTH = 2;
const LEVEL_ONE: CompletionHeatmapLevel = 1;
const LEVEL_TWO: CompletionHeatmapLevel = 2;
const LEVEL_THREE: CompletionHeatmapLevel = 3;
const LEVEL_FOUR: CompletionHeatmapLevel = 4;
const FIRST_QUARTILE = 0.25;
const SECOND_QUARTILE = 0.5;
const THIRD_QUARTILE = 0.75;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CALENDAR_YEAR_RANGE_PATTERN = /^year:([1-9]\d{0,3})$/;

type CivilDate = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

type RangeBounds = Readonly<{
  start: CivilDate;
  end: CivilDate;
  label: string;
}>;

type QuartileThresholds = readonly [number, number, number, number] | null;

export const completionHeatmapCalendarYearRange = (
  year: number,
): CompletionHeatmapCalendarYearRange => {
  if (!Number.isInteger(year) || year < MINIMUM_YEAR || year > MAXIMUM_YEAR) {
    throw new Error(`Invalid completion heatmap calendar year: ${year}`);
  }

  return `year:${year}`;
};

export const isCompletionHeatmapRange = (value: unknown): value is CompletionHeatmapRange => {
  if (typeof value !== "string") {
    return false;
  }

  if (COMPLETION_HEATMAP_RELATIVE_RANGE_OPTIONS.some((option) => option.value === value)) {
    return true;
  }

  return parseCalendarYearRange(value) !== null;
};

export const buildCompletionHeatmapModel = (
  input: BuildCompletionHeatmapModelInput,
): CompletionHeatmapModel => {
  const now = validDateOrNow(input.now);
  const dateFormatter = createCivilDateFormatter(input.timeZone);
  const today = instantToCivilDate(now, dateFormatter);
  const bounds = resolveRangeBounds(input.range, today);
  const displayStart = addDays(bounds.start, -weekdayIndex(bounds.start));
  const displayEnd = addDays(bounds.end, DAYS_IN_WEEK - FIRST_DAY - weekdayIndex(bounds.end));
  const weekCount = Math.floor(daysBetween(displayStart, displayEnd) / DAYS_IN_WEEK) + FIRST_DAY;
  const eventDates = validEventCivilDates(input.events, dateFormatter);
  const countsByKey = countEventsInRange(eventDates, bounds.start, bounds.end);
  const thresholds = quartileThresholds([...countsByKey.values()]);
  const weeks = buildWeeks(displayStart, weekCount, bounds, countsByKey, thresholds);
  const daysByKey = new Map<string, CompletionHeatmapDay>();

  for (const week of weeks) {
    for (const day of week.days) {
      if (day.inRange) {
        daysByKey.set(day.key, day);
      }
    }
  }

  return {
    range: input.range,
    rangeLabel: bounds.label,
    startKey: civilDateKey(bounds.start),
    endKey: civilDateKey(bounds.end),
    periodLabel: formatCompletionHeatmapDateRange(
      civilDateKey(bounds.start),
      civilDateKey(bounds.end),
    ),
    totalCount: [...countsByKey.values()].reduce((total, count) => total + count, 0),
    availableYears: availableCalendarYears(eventDates, today.year, input.range),
    weeks,
    monthLabels: buildMonthLabels(bounds.start, bounds.end, displayStart, weekCount),
    daysByKey,
  };
};

export const formatCompletionHeatmapDate = (key: string): string => {
  const date = civilDateFromKey(key);
  if (date === null) {
    return key;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(civilDateToDate(date));
};

export const formatCompletionHeatmapDateRange = (startKey: string, endKey: string): string => {
  if (startKey === endKey) {
    return formatCompletionHeatmapDate(startKey);
  }

  const start = civilDateFromKey(startKey);
  const end = civilDateFromKey(endKey);
  if (start === null || end === null) {
    return `${startKey} – ${endKey}`;
  }

  const startDate = civilDateToDate(start);
  const endDate = civilDateToDate(end);
  const sameYear = start.year === end.year;
  const sameMonth = sameYear && start.month === end.month;
  const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

  if (sameMonth) {
    return `${monthFormatter.format(startDate)} ${start.day} – ${end.day}, ${end.year}`;
  }

  if (sameYear) {
    return `${monthFormatter.format(startDate)} ${start.day} – ${monthFormatter.format(endDate)} ${
      end.day
    }, ${end.year}`;
  }

  return `${formatCompletionHeatmapDate(startKey)} – ${formatCompletionHeatmapDate(endKey)}`;
};

const validDateOrNow = (value: Date | undefined): Date => {
  if (value !== undefined && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }

  return new Date();
};

const createCivilDateFormatter = (timeZone: string | undefined): Intl.DateTimeFormat => {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  };

  if (timeZone !== undefined) {
    options.timeZone = timeZone;
  }

  try {
    return new Intl.DateTimeFormat("en-US", options);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }
};

const instantToCivilDate = (instant: Date, formatter: Intl.DateTimeFormat): CivilDate => {
  const values = new Map(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number.parseInt(part.value, 10)]),
  );

  return {
    year: values.get("year") ?? instant.getFullYear(),
    month: values.get("month") ?? instant.getMonth() + FIRST_MONTH,
    day: values.get("day") ?? instant.getDate(),
  };
};

const resolveRangeBounds = (range: CompletionHeatmapRange, today: CivilDate): RangeBounds => {
  const calendarYear = parseCalendarYearRange(range);
  if (calendarYear !== null) {
    const end = calendarYear === today.year ? today : endOfYear(calendarYear);
    return {
      start: { year: calendarYear, month: FIRST_MONTH, day: FIRST_DAY },
      end,
      label: `${calendarYear}`,
    };
  }

  switch (range) {
    case "last-4-weeks":
      return {
        start: addDays(today, -(FOUR_WEEKS_IN_DAYS - FIRST_DAY)),
        end: today,
        label: "Last 4 weeks",
      };
    case "last-3-months":
      return {
        start: subtractCalendarMonths(today, THREE_MONTHS),
        end: today,
        label: "Last 3 months",
      };
    case "last-6-months":
      return {
        start: subtractCalendarMonths(today, SIX_MONTHS),
        end: today,
        label: "Last 6 months",
      };
    case "last-year":
      return {
        start: subtractCalendarMonths(today, MONTHS_IN_YEAR),
        end: today,
        label: "Last year",
      };
    default:
      throw new Error(`Unsupported completion heatmap range: ${range}`);
  }
};

const parseCalendarYearRange = (value: string): number | null => {
  const match = value.match(CALENDAR_YEAR_RANGE_PATTERN);
  if (match === null) {
    return null;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(year) || year < MINIMUM_YEAR || year > MAXIMUM_YEAR) {
    return null;
  }

  return year;
};

const subtractCalendarMonths = (date: CivilDate, months: number): CivilDate => {
  const zeroBasedMonth = date.year * MONTHS_IN_YEAR + date.month - FIRST_MONTH - months;
  const year = Math.floor(zeroBasedMonth / MONTHS_IN_YEAR);
  const month = positiveModulo(zeroBasedMonth, MONTHS_IN_YEAR) + FIRST_MONTH;
  return {
    year,
    month,
    day: Math.min(date.day, daysInMonth(year, month)),
  };
};

const positiveModulo = (value: number, divisor: number): number =>
  ((value % divisor) + divisor) % divisor;

const endOfYear = (year: number): CivilDate => ({
  year,
  month: MONTHS_IN_YEAR,
  day: daysInMonth(year, MONTHS_IN_YEAR),
});

const daysInMonth = (year: number, month: number): number => {
  const firstOfNextMonth = civilDateToDate({ year, month: month + FIRST_MONTH, day: FIRST_DAY });
  firstOfNextMonth.setUTCDate(0);
  return firstOfNextMonth.getUTCDate();
};

const civilDateToDate = (date: CivilDate): Date => {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(date.year, date.month - FIRST_MONTH, date.day);
  return value;
};

const addDays = (date: CivilDate, amount: number): CivilDate => {
  const result = civilDateToDate(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + FIRST_MONTH,
    day: result.getUTCDate(),
  };
};

const daysBetween = (start: CivilDate, end: CivilDate): number =>
  Math.round(
    (civilDateToDate(end).getTime() - civilDateToDate(start).getTime()) / DAY_IN_MILLISECONDS,
  );

const compareCivilDates = (left: CivilDate, right: CivilDate): number =>
  civilDateToDate(left).getTime() - civilDateToDate(right).getTime();

const weekdayIndex = (date: CivilDate): number => civilDateToDate(date).getUTCDay();

const civilDateKey = (date: CivilDate): string =>
  `${date.year.toString().padStart(YEAR_KEY_WIDTH, "0")}-${date.month
    .toString()
    .padStart(MONTH_DAY_KEY_WIDTH, "0")}-${date.day.toString().padStart(MONTH_DAY_KEY_WIDTH, "0")}`;

const civilDateFromKey = (key: string): CivilDate | null => {
  const match = key.match(DATE_KEY_PATTERN);
  if (match === null) {
    return null;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const candidate = { year, month, day };
  if (civilDateKey(candidate) !== key) {
    return null;
  }

  const normalized = civilDateToDate(candidate);
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + FIRST_MONTH !== month ||
    normalized.getUTCDate() !== day
  ) {
    return null;
  }

  return candidate;
};

const validEventCivilDates = (
  events: readonly CompletionHeatmapEvent[],
  formatter: Intl.DateTimeFormat,
): CivilDate[] => {
  const datesByEventId = new Map<string, CivilDate>();
  for (const event of events) {
    const instant =
      event.completedAt instanceof Date
        ? new Date(event.completedAt.getTime())
        : new Date(event.completedAt);
    if (Number.isFinite(instant.getTime()) && !datesByEventId.has(event.id)) {
      datesByEventId.set(event.id, instantToCivilDate(instant, formatter));
    }
  }

  return [...datesByEventId.values()];
};

const countEventsInRange = (
  eventDates: readonly CivilDate[],
  start: CivilDate,
  end: CivilDate,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const date of eventDates) {
    if (compareCivilDates(date, start) < 0 || compareCivilDates(date, end) > 0) {
      continue;
    }

    const key = civilDateKey(date);
    counts.set(key, (counts.get(key) ?? 0) + FIRST_DAY);
  }

  return counts;
};

const quartileThresholds = (counts: readonly number[]): QuartileThresholds => {
  const positiveCounts = counts.filter((count) => count > 0).sort((left, right) => left - right);
  if (positiveCounts.length === 0) {
    return null;
  }

  return [
    nearestRank(positiveCounts, FIRST_QUARTILE),
    nearestRank(positiveCounts, SECOND_QUARTILE),
    nearestRank(positiveCounts, THIRD_QUARTILE),
    positiveCounts[positiveCounts.length - FIRST_DAY] ?? 0,
  ];
};

const nearestRank = (values: readonly number[], percentile: number): number => {
  const rank = Math.max(FIRST_DAY, Math.ceil(values.length * percentile));
  return values[rank - FIRST_DAY] ?? values[values.length - FIRST_DAY] ?? 0;
};

const levelForCount = (count: number, thresholds: QuartileThresholds): CompletionHeatmapLevel => {
  if (count === 0 || thresholds === null) {
    return 0;
  }

  // The busiest visible day should always match the "More" end of the legend, including sparse
  // periods with only one to three active days. The other thresholds retain quartile bins for
  // denser ranges.
  if (count >= thresholds[3]) {
    return LEVEL_FOUR;
  }

  if (count <= thresholds[0]) {
    return LEVEL_ONE;
  }

  if (count <= thresholds[1]) {
    return LEVEL_TWO;
  }

  if (count <= thresholds[2]) {
    return LEVEL_THREE;
  }

  return LEVEL_FOUR;
};

const buildWeeks = (
  displayStart: CivilDate,
  weekCount: number,
  bounds: RangeBounds,
  countsByKey: ReadonlyMap<string, number>,
  thresholds: QuartileThresholds,
): CompletionHeatmapWeek[] => {
  const weeks: CompletionHeatmapWeek[] = [];
  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += FIRST_DAY) {
    const days: CompletionHeatmapDay[] = [];
    for (let dayIndex = 0; dayIndex < DAYS_IN_WEEK; dayIndex += FIRST_DAY) {
      const date = addDays(displayStart, weekIndex * DAYS_IN_WEEK + dayIndex);
      const inRange =
        compareCivilDates(date, bounds.start) >= 0 && compareCivilDates(date, bounds.end) <= 0;
      const key = civilDateKey(date);
      const count = inRange ? (countsByKey.get(key) ?? 0) : 0;
      days.push({
        key,
        year: date.year,
        month: date.month,
        day: date.day,
        weekdayIndex: dayIndex,
        weekIndex,
        count,
        level: levelForCount(count, thresholds),
        inRange,
        fullDateLabel: formatCompletionHeatmapDate(key),
      });
    }

    weeks.push({ index: weekIndex, days });
  }

  return weeks;
};

const buildMonthLabels = (
  start: CivilDate,
  end: CivilDate,
  displayStart: CivilDate,
  weekCount: number,
): CompletionHeatmapMonthLabel[] => {
  const starts: { date: CivilDate; weekIndex: number }[] = [{ date: start, weekIndex: 0 }];
  let month = nextMonth(start);

  while (compareCivilDates(month, end) <= 0) {
    const weekIndex = Math.floor(daysBetween(displayStart, month) / DAYS_IN_WEEK);
    const previous = starts[starts.length - FIRST_DAY];
    if (previous === undefined || weekIndex > previous.weekIndex) {
      starts.push({ date: month, weekIndex });
    } else if (weekIndex === previous.weekIndex) {
      // When a range begins on the last day of a month, prefer the new month label for the shared
      // week instead of labeling the entire graph with the nearly absent previous month.
      starts[starts.length - FIRST_DAY] = { date: month, weekIndex };
    }
    month = nextMonth(month);
  }

  return starts.map((item, index) => {
    const next = starts[index + FIRST_DAY];
    const weekSpan = (next?.weekIndex ?? weekCount) - item.weekIndex;
    const date = civilDateToDate(item.date);
    return {
      fullLabel: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date),
      shortLabel: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
        date,
      ),
      startWeek: item.weekIndex,
      weekSpan,
    };
  });
};

const nextMonth = (date: CivilDate): CivilDate => {
  if (date.month === MONTHS_IN_YEAR) {
    return { year: date.year + FIRST_DAY, month: FIRST_MONTH, day: FIRST_DAY };
  }

  return { year: date.year, month: date.month + FIRST_MONTH, day: FIRST_DAY };
};

const availableCalendarYears = (
  eventDates: readonly CivilDate[],
  currentYear: number,
  range: CompletionHeatmapRange,
): number[] => {
  const selectedYear = parseCalendarYearRange(range);
  const historicalYears = eventDates.map((date) => date.year).filter((year) => year <= currentYear);
  const earliestYear = Math.min(currentYear, ...historicalYears);
  const years: number[] = [];

  for (let year = currentYear; year >= earliestYear; year -= FIRST_DAY) {
    years.push(year);
  }

  if (selectedYear !== null && !years.includes(selectedYear)) {
    years.push(selectedYear);
    years.sort((left, right) => right - left);
  }

  return years;
};
