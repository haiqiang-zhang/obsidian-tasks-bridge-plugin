import type React from "react";
import { Button } from "react-aria-components";

import { t } from "@/i18n";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import type { TaskCreationOptions } from "@/ui/createTaskModal";
import { useObsidianMenu } from "@/ui/obsidianMenu";

type Props = {
  selected: TaskCreationOptions;
  setSelected: (selected: TaskCreationOptions) => void;
};

export const OptionsSelector: React.FC<Props> = ({ selected, setSelected }) => {
  const i18n = t().createTaskModal.optionsSelector;

  const items: Array<{
    label: string;
    isSelected: boolean;
    onSelect: () => void;
  }> = [
    {
      label: i18n.addLinkToContent,
      isSelected: selected.appendLinkTo === "content",
      onSelect: () => setSelected({ ...selected, appendLinkTo: "content" }),
    },
    {
      label: i18n.addLinkToDescription,
      isSelected: selected.appendLinkTo === "description",
      onSelect: () => setSelected({ ...selected, appendLinkTo: "description" }),
    },
    {
      label: i18n.doNotAddLink,
      isSelected: selected.appendLinkTo === undefined,
      onSelect: () => setSelected({ ...selected, appendLinkTo: undefined }),
    },
  ];
  const { anchorRef, isOpen, openMenu } = useObsidianMenu((menu) => {
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
      aria-label={i18n.buttonLabel}
      className="options-selector"
      onPress={openMenu}
    >
      <ObsidianIcon size="m" id="ellipsis-vertical" />
    </Button>
  );
};
