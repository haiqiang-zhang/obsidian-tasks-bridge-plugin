import { type CalendarDate, parseDate } from "@internationalized/date";

import type { Deadline as ApiDeadline } from "@/api/domain/task";
import { locale } from "@/infra/locale";
import { timezone, today } from "@/infra/time";
import { uiText } from "@/uiText";

export type DeadlineInfo = {
  raw: Date;
  isOverdue: boolean;
  isCurrentYear: boolean;
  flag: "today" | "tomorrow" | "nextWeek" | "yesterday" | "lastWeek" | undefined;
};

const parseDeadline = (deadline: ApiDeadline): DeadlineInfo => {
  const date = parseDate(deadline.date);
  return calculateDeadlineInfo(date);
};

const calculateDeadlineInfo = (date: CalendarDate): DeadlineInfo => {
  let flag: DeadlineInfo["flag"];
  if (date.compare(today()) === 0) {
    flag = "today";
  } else if (date.compare(today().add({ days: 1 })) === 0) {
    flag = "tomorrow";
  } else if (date.compare(today().add({ days: -1 })) === 0) {
    flag = "yesterday";
  } else if (date.compare(today().add({ days: -7 })) >= 0 && date.compare(today()) < 0) {
    flag = "lastWeek";
  } else if (date.compare(today().add({ days: 7 })) <= 0 && date.compare(today()) > 0) {
    flag = "nextWeek";
  }

  return {
    raw: date.toDate(timezone()),
    isOverdue: date.compare(today()) < 0,
    isCurrentYear: date.year === today().year,
    flag,
  };
};

const getFormatter: (style: string) => Intl.DateTimeFormat = (() => {
  const styles: Record<string, Intl.DateTimeFormatOptions> = {
    weekday: {
      weekday: "long",
    },
    date: {
      month: "short",
      day: "numeric",
    },
    dateWithYear: {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
  };

  const cache: Record<string, Intl.DateTimeFormat> = {};

  return (style: string): Intl.DateTimeFormat => {
    if (cache[style]) {
      return cache[style];
    }

    cache[style] = new Intl.DateTimeFormat(locale(), {
      timeZone: timezone(),
      ...styles[style],
    });
    return cache[style];
  };
})();

const formatDeadline = (info: DeadlineInfo): string => {
  const text = uiText.dates;

  switch (info.flag) {
    case "today":
      return text.today;
    case "tomorrow":
      return text.tomorrow;
    case "yesterday":
      return text.yesterday;
    case "lastWeek":
      return text.lastWeekday(getFormatter("weekday").format(info.raw));
    case "nextWeek":
      return getFormatter("weekday").format(info.raw);
    default:
      break;
  }

  if (!info.isCurrentYear) {
    return getFormatter("dateWithYear").format(info.raw);
  }

  return getFormatter("date").format(info.raw);
};

export const Deadline = {
  parse: parseDeadline,
  format: formatDeadline,
};
