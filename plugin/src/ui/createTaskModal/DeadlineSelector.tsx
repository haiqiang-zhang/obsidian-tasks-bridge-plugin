import { type CalendarDate, endOfWeek, today } from "@internationalized/date";
import type React from "react";
import { useState } from "react";
import { Button, Calendar, CalendarCell, CalendarGrid, Heading } from "react-aria-components";

import type { Deadline as ApiDeadline } from "@/api/domain/task";
import { Deadline as DataDeadline } from "@/data/deadline";
import { t } from "@/i18n";
import { timezone } from "@/infra/time";
import { openObsidianReactModal } from "@/ui/components/ObsidianReactModal";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";
import { useObsidianMenu } from "@/ui/obsidianMenu";

export type Deadline = {
  date: CalendarDate;
};

type Props = {
  selected: Deadline | undefined;
  setSelected: (selected: Deadline | undefined) => void;
  allowPastDates?: boolean;
};

export const DeadlineSelector: React.FC<Props> = ({
  selected,
  setSelected,
  allowPastDates = false,
}) => {
  const plugin = PluginContext.use();
  const i18n = t().createTaskModal.deadlineSelector;
  const suggestions = getSuggestions();

  const openDateEditor = () => {
    openObsidianReactModal(plugin.app, {
      className: "tasks-bridge-date-modal",
      title: i18n.dialogLabel,
      render: (close) => (
        <DeadlineEditor
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
          .onClick(() =>
            setSelected(suggestion.target === undefined ? undefined : { date: suggestion.target }),
          ),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(i18n.chooseDateLabel)
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
      className="deadline-selector"
      onPress={openMenu}
    >
      <ObsidianIcon size="s" id="target" />
      <span>{getLabel(selected)}</span>
    </Button>
  );
};

type DeadlineEditorProps = {
  allowPastDates: boolean;
  close: () => void;
  initial: Deadline | undefined;
  onSave: (value: Deadline | undefined) => void;
};

const DeadlineEditor: React.FC<DeadlineEditorProps> = ({
  allowPastDates,
  close,
  initial,
  onSave,
}) => {
  const createTaskI18n = t().createTaskModal;
  const i18n = createTaskI18n.deadlineSelector;
  const [draft, setDraft] = useState(initial);

  return (
    <div className="task-date-editor">
      <Calendar
        aria-label={i18n.datePickerLabel}
        className="date-picker"
        minValue={allowPastDates ? undefined : today(timezone())}
        onChange={(date) => setDraft({ date })}
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

      <div className="task-date-editor-controls">
        <Button className="task-date-clear-button" onPress={() => onSave(undefined)}>
          {i18n.noDeadline}
        </Button>
        <span className="task-date-editor-controls-spacer" />
        <Button onPress={close}>{createTaskI18n.cancelButtonLabel}</Button>
        <Button className="mod-cta" onPress={() => onSave(draft)}>
          {createTaskI18n.dateSelector.timeDialog.saveButtonLabel}
        </Button>
      </div>
    </div>
  );
};

const getLabel = (selected: Deadline | undefined): string => {
  if (selected === undefined) {
    return t().createTaskModal.deadlineSelector.placeholder;
  }

  const apiDeadline: ApiDeadline = { date: selected.date.toString() };
  return DataDeadline.format(DataDeadline.parse(apiDeadline));
};

type DateSuggestion = {
  icon: string;
  label: string;
  target: CalendarDate | undefined;
};

const getSuggestions = (): DateSuggestion[] => {
  const dateI18n = t().dates;
  const selectorI18n = t().createTaskModal.deadlineSelector;
  const startOfNextWeek = endOfWeek(today(timezone()), "en-US").add({ days: 1 });

  return [
    { icon: "calendar", label: dateI18n.today, target: today(timezone()) },
    { icon: "sun", label: dateI18n.tomorrow, target: today(timezone()).add({ days: 1 }) },
    { icon: "calendar-clock", label: dateI18n.nextWeek, target: startOfNextWeek },
    { icon: "ban", label: selectorI18n.noDeadline, target: undefined },
  ];
};
