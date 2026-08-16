import type React from "react";
import { Button } from "react-aria-components";

import { t } from "@/i18n";
import type { Translations } from "@/i18n/translation";
import { useObsidianMenu } from "@/ui/obsidianMenu";
import { assertNever } from "@/utils/types";

import { Priorities, type Priority } from "../../api/domain/task";
import { ObsidianIcon } from "../components/obsidian-icon";

type Props = {
  selected: Priority;
  setSelected: (selected: Priority) => void;
};

const options: Priority[] = [Priorities.P1, Priorities.P2, Priorities.P3, Priorities.P4];

export const PrioritySelector: React.FC<Props> = ({ selected, setSelected }) => {
  const i18n = t().createTaskModal.prioritySelector;
  const { anchorRef, isOpen, toggleMenu } = useObsidianMenu((menu) => {
    for (const priority of options) {
      menu.addItem((item) =>
        item
          .setTitle(getLabel(priority, i18n))
          .setChecked(priority === selected)
          .onClick(() => setSelected(priority)),
      );
    }
  });

  const label = getLabel(selected, i18n);
  return (
    <Button
      ref={anchorRef}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      aria-label={i18n.buttonLabel}
      className="priority-selector"
      onPress={toggleMenu}
    >
      <ObsidianIcon size="m" id="flag" />
      <span>{label}</span>
    </Button>
  );
};

const getLabel = (
  priority: Priority,
  i18n: Translations["createTaskModal"]["prioritySelector"],
): string => {
  switch (priority) {
    case Priorities.P4:
      return i18n.p4;
    case Priorities.P3:
      return i18n.p3;
    case Priorities.P2:
      return i18n.p2;
    case Priorities.P1:
      return i18n.p1;
    default:
      return assertNever(priority, "Unknown priority");
  }
};
