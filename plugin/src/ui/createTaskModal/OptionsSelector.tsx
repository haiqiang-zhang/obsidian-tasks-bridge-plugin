import type React from "react";
import { Button } from "react-aria-components";

import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import type { TaskCreationOptions } from "@/ui/createTaskModal";
import { useObsidianMenu } from "@/ui/obsidianMenu";
import { uiText } from "@/uiText";

type Props = {
  selected: TaskCreationOptions;
  setSelected: (selected: TaskCreationOptions) => void;
};

export const OptionsSelector: React.FC<Props> = ({ selected, setSelected }) => {
  const text = uiText.createTaskModal.optionsSelector;

  const items: Array<{
    label: string;
    isSelected: boolean;
    onSelect: () => void;
  }> = [
    {
      label: text.addLinkToContent,
      isSelected: selected.appendLinkTo === "content",
      onSelect: () => setSelected({ ...selected, appendLinkTo: "content" }),
    },
    {
      label: text.addLinkToDescription,
      isSelected: selected.appendLinkTo === "description",
      onSelect: () => setSelected({ ...selected, appendLinkTo: "description" }),
    },
    {
      label: text.doNotAddLink,
      isSelected: selected.appendLinkTo === undefined,
      onSelect: () => setSelected({ ...selected, appendLinkTo: undefined }),
    },
  ];
  const { anchorRef, isOpen, toggleMenu } = useObsidianMenu((menu) => {
    for (const item of items) {
      menu.addItem((menuItem) =>
        menuItem.setTitle(item.label).setChecked(item.isSelected).onClick(item.onSelect),
      );
    }
  });

  return (
    <Button
      ref={anchorRef}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      aria-label={text.buttonLabel}
      className="options-selector"
      onPress={toggleMenu}
    >
      <ObsidianIcon size="m" id="ellipsis-vertical" />
    </Button>
  );
};
