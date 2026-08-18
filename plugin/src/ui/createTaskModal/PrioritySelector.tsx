import type React from "react";
import { Button } from "react-aria-components";

import { useObsidianMenu } from "@/ui/obsidianMenu";
import type { UiText } from "@/uiText";
import { uiText } from "@/uiText";
import { assertNever } from "@/utils/types";

import { Priorities, type Priority } from "../../api/domain/task";
import { ObsidianIcon } from "../components/obsidian-icon";

type Props = {
  selected: Priority;
  setSelected: (selected: Priority) => void;
};

const options: Priority[] = [Priorities.P1, Priorities.P2, Priorities.P3, Priorities.P4];

export const PrioritySelector: React.FC<Props> = ({ selected, setSelected }) => {
  const text = uiText.createTaskModal.prioritySelector;
  const { anchorRef, isOpen, toggleMenu } = useObsidianMenu((menu) => {
    for (const priority of options) {
      menu.addItem((item) =>
        item
          .setTitle(getLabel(priority, text))
          .setChecked(priority === selected)
          .onClick(() => setSelected(priority)),
      );
    }
  });

  const label = getLabel(selected, text);
  return (
    <Button
      ref={anchorRef}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      aria-label={text.buttonLabel}
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
  text: UiText["createTaskModal"]["prioritySelector"],
): string => {
  switch (priority) {
    case Priorities.P4:
      return text.p4;
    case Priorities.P3:
      return text.p3;
    case Priorities.P2:
      return text.p2;
    case Priorities.P1:
      return text.p1;
    default:
      return assertNever(priority, "Unknown priority");
  }
};
