import {
  type CalendarDate,
  endOfWeek,
  Time,
  toCalendarDateTime,
  today,
  toZoned,
} from "@internationalized/date";
import type React from "react";
import { useMemo, useState } from "react";
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DateSegment,
  Heading,
  Label,
  TimeField,
} from "react-aria-components";

import type { DueDate as ApiDueDate } from "@/api/domain/dueDate";
import type { Duration as ApiDuration } from "@/api/domain/task";
import { DueDate as DataDueDate } from "@/data/dueDate";
import { t } from "@/i18n";
import { now, timezone } from "@/infra/time";
import { openObsidianReactModal } from "@/ui/components/ObsidianReactModal";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";
import { useObsidianMenu } from "@/ui/obsidianMenu";

export type DueDate = {
  date: CalendarDate;
  timeInfo:
    | {
        time: Time;
        duration: ApiDuration | undefined;
      }
    | undefined;
};

type Props = {
  selected: DueDate | undefined;
  setSelected: (selected: DueDate | undefined) => void;
  allowPastDates?: boolean;
};

export const DueDateSelector: React.FC<Props> = ({
  selected,
  setSelected,
  allowPastDates = false,
}) => {
  const plugin = PluginContext.use();
  const i18n = t().createTaskModal.dateSelector;
  const suggestions = getSuggestions();

  const openDateEditor = () => {
    openObsidianReactModal(plugin.app, {
      className: "tasks-bridge-date-modal",
      title: i18n.dialogLabel,
      render: (close) => (
        <DueDateEditor
          allowPastDates={allowPastDates}
          close={close}
          initial={selected}
          onSave={(next) => {
            setSelected(next);
            close();
          }}
        />
      ),
    });
  };

  const { anchorRef, isOpen, openMenu } = useObsidianMenu((menu) => {
    for (const suggestion of suggestions) {
      menu.addItem((item) =>
        item
          .setTitle(suggestion.label)
          .setIcon(suggestion.icon)
          .setSection("quick-dates")
          .onClick(() => {
            setSelected(
              suggestion.target === undefined
                ? undefined
                : { date: suggestion.target, timeInfo: selected?.timeInfo },
            );
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(i18n.chooseDateTimeLabel)
        .setIcon("calendar-days")
        .setSection("custom-date")
        .onClick(openDateEditor),
    );
  });

  return (
    <Button
      ref={anchorRef}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      aria-label={i18n.buttonLabel}
      className="due-date-selector"
      onPress={openMenu}
    >
      <ObsidianIcon size="s" id="calendar" />
      <span>{getLabel(selected)}</span>
    </Button>
  );
};

type DueDateEditorProps = {
  allowPastDates: boolean;
  close: () => void;
  initial: DueDate | undefined;
  onSave: (value: DueDate | undefined) => void;
};

const DueDateEditor: React.FC<DueDateEditorProps> = ({
  allowPastDates,
  close,
  initial,
  onSave,
}) => {
  const i18n = t().createTaskModal.dateSelector;
  const [draft, setDraft] = useState(initial);
  const durationOptions = useMemo(() => buildDurationOptions(), []);
  const durationIndex = Math.max(
    0,
    durationOptions.findIndex(({ value }) => value?.amount === draft?.timeInfo?.duration?.amount),
  );

  const setDuration = (duration: ApiDuration | undefined) => {
    setDraft((current) => {
      const currentTime = current?.timeInfo?.time;
      const localNow = now();
      return {
        date: current?.date ?? today(timezone()),
        timeInfo: {
          duration,
          time: currentTime ?? new Time(localNow.hour, localNow.minute, 0),
        },
      };
    });
  };

  const {
    anchorRef: durationAnchorRef,
    isOpen: durationMenuOpen,
    openMenu: openDurationMenu,
  } = useObsidianMenu((menu) => {
    for (const [index, option] of durationOptions.entries()) {
      menu.addItem((item) =>
        item
          .setTitle(option.label)
          .setChecked(index === durationIndex)
          .onClick(() => setDuration(option.value)),
      );
    }
  });

  return (
    <div className="task-date-editor">
      <Calendar
        aria-label={i18n.datePickerLabel}
        className="date-picker"
        minValue={allowPastDates ? undefined : today(timezone())}
        onChange={(date) => setDraft((current) => ({ date, timeInfo: current?.timeInfo }))}
        value={draft?.date ?? null}
      >
        <header>
          <Heading level={4} />
          <div className="date-picker-controls">
            <Button aria-label="Previous month" slot="previous">
              <ObsidianIcon id="chevron-left" size="s" />
            </Button>
            <Button aria-label="Next month" slot="next">
              <ObsidianIcon id="chevron-right" size="s" />
            </Button>
          </div>
        </header>
        <CalendarGrid>{(date) => <CalendarCell date={date} />}</CalendarGrid>
      </Calendar>

      <div className="task-date-editor-time">
        <TimeField
          className="task-time-picker"
          onChange={(time) => {
            if (time === null) {
              return;
            }
            setDraft((current) => ({
              date: current?.date ?? today(timezone()),
              timeInfo: { duration: current?.timeInfo?.duration, time },
            }));
          }}
          value={draft?.timeInfo?.time ?? null}
        >
          <Label className="task-time-picker-label">{i18n.timeDialog.timeLabel}</Label>
          <DateInput className="task-time-picker-input">
            {(segment) => (
              <DateSegment className="task-time-picker-input-segment" segment={segment} />
            )}
          </DateInput>
        </TimeField>

        <div className="task-duration-picker">
          <span className="task-duration-picker-label">{i18n.timeDialog.durationLabel}</span>
          <Button
            ref={durationAnchorRef}
            aria-expanded={durationMenuOpen}
            aria-haspopup="menu"
            className="task-duration-button"
            onPress={openDurationMenu}
          >
            <span>{durationOptions[durationIndex]?.label}</span>
            <ObsidianIcon id="chevron-down" size="xs" />
          </Button>
        </div>

        {draft?.timeInfo !== undefined && (
          <Button
            className="task-time-clear-button"
            onPress={() =>
              setDraft((current) =>
                current === undefined ? undefined : { ...current, timeInfo: undefined },
              )
            }
          >
            {i18n.timeDialog.clearTimeLabel}
          </Button>
        )}
      </div>

      <div className="task-date-editor-controls">
        <Button className="task-date-clear-button" onPress={() => onSave(undefined)}>
          {i18n.noDate}
        </Button>
        <span className="task-date-editor-controls-spacer" />
        <Button onPress={close}>{i18n.timeDialog.cancelButtonLabel}</Button>
        <Button className="mod-cta" onPress={() => onSave(draft)}>
          {i18n.timeDialog.saveButtonLabel}
        </Button>
      </div>
    </div>
  );
};

const getLabel = (selected: DueDate | undefined): string => {
  if (selected === undefined) {
    return t().createTaskModal.dateSelector.emptyDate;
  }

  const date =
    selected.timeInfo === undefined
      ? selected.date.toString()
      : toZoned(
          toCalendarDateTime(selected.date, selected.timeInfo.time),
          timezone(),
        ).toAbsoluteString();
  const apiDueDate: ApiDueDate = { date, isRecurring: false };
  return DataDueDate.format(DataDueDate.parse(apiDueDate, selected.timeInfo?.duration));
};

type DateSuggestion = {
  icon: string;
  label: string;
  target: CalendarDate | undefined;
};

const getSuggestions = (): DateSuggestion[] => {
  const dateI18n = t().dates;
  const selectorI18n = t().createTaskModal.dateSelector;
  const startOfNextWeek = endOfWeek(today(timezone()), "en-US").add({ days: 1 });

  return [
    { icon: "calendar", label: dateI18n.today, target: today(timezone()) },
    { icon: "sun", label: dateI18n.tomorrow, target: today(timezone()).add({ days: 1 }) },
    { icon: "calendar-clock", label: dateI18n.nextWeek, target: startOfNextWeek },
    { icon: "ban", label: selectorI18n.noDate, target: undefined },
  ];
};

const durationSegmentMinutes = 15;
const durationSegmentCount = (24 * 60 - durationSegmentMinutes) / durationSegmentMinutes;

const buildDurationOptions = (): Array<{ label: string; value: ApiDuration | undefined }> => {
  const i18n = t().createTaskModal.dateSelector.timeDialog;
  return [
    { label: i18n.noDuration, value: undefined },
    ...Array.from({ length: durationSegmentCount }, (_, index) => {
      const amount = (index + 1) * durationSegmentMinutes;
      return {
        label: i18n.duration(amount),
        value: { amount, unit: "minute" as const },
      };
    }),
  ];
};
