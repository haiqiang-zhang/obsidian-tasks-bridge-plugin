import { type App, Modal, Setting, setIcon } from "obsidian";
import type React from "react";
import { useMemo } from "react";
import { Button } from "react-aria-components";

import type { Label } from "@/api/domain/label";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";
import type { UiText } from "@/uiText";
import { uiText } from "@/uiText";

type Props = {
  selected: Label[];
  setSelected: (labels: Label[]) => void;
};

type LabelSelectorText = UiText["createTaskModal"]["labelSelector"];

export const LabelSelector: React.FC<Props> = ({ selected, setSelected }) => {
  const plugin = PluginContext.use();
  const options = useMemo(
    () => Array.from(plugin.services.todoist.data().labels.iterActive()),
    [plugin],
  );
  const text = uiText.createTaskModal.labelSelector;

  const openSelector = () => {
    new LabelSelectionModal(plugin.app, options, selected, setSelected, text).open();
  };

  return (
    <Button
      aria-haspopup="dialog"
      aria-label={text.buttonLabel}
      className="label-selector"
      onPress={openSelector}
    >
      <ObsidianIcon id="tag" size="m" />
      <span>{text.buttonText(selected.length)}</span>
    </Button>
  );
};

class LabelSelectionModal extends Modal {
  private readonly labels: Label[];
  private readonly selectedIds: Set<string>;
  private readonly onSelectionChange: (labels: Label[]) => void;
  private readonly text: LabelSelectorText;
  private resultsEl: HTMLElement | null = null;

  public constructor(
    app: App,
    labels: Label[],
    selected: Label[],
    onSelectionChange: (labels: Label[]) => void,
    text: LabelSelectorText,
  ) {
    super(app);
    this.labels = labels;
    this.selectedIds = new Set(selected.map((label) => label.id));
    this.onSelectionChange = onSelectionChange;
    this.text = text;
  }

  public override onOpen(): void {
    this.setTitle(this.text.labelOptionsLabel);
    this.modalEl.classList.add("tasks-bridge-label-selector-modal");
    this.contentEl.replaceChildren();

    new Setting(this.contentEl)
      .setName(this.text.search.label)
      .setClass("tasks-bridge-label-selector-search")
      .addSearch((search) => {
        search.setPlaceholder(this.text.search.placeholder);
        search.inputEl.setAttribute("aria-label", this.text.search.label);
        search.onChange((query) => this.renderOptions(query));
      });

    this.resultsEl = this.contentEl.createDiv("tasks-bridge-label-selector-results");
    this.renderOptions("");

    new Setting(this.contentEl)
      .setClass("tasks-bridge-label-selector-actions")
      .addButton((button) => {
        button
          .setButtonText(this.text.doneButtonLabel)
          .setCta()
          .onClick(() => this.close());
        button.buttonEl.setAttribute("aria-label", this.text.doneButtonLabel);
      });
  }

  public override onClose(): void {
    this.resultsEl = null;
    this.contentEl.replaceChildren();
  }

  private renderOptions(query: string): void {
    if (this.resultsEl === null) {
      return;
    }
    this.resultsEl.replaceChildren();
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    const visibleLabels = this.labels.filter(
      (label) =>
        normalizedQuery === "" || label.name.toLocaleLowerCase("en-US").includes(normalizedQuery),
    );

    if (visibleLabels.length === 0) {
      new Setting(this.resultsEl)
        .setName(this.text.emptyState)
        .setClass("tasks-bridge-label-selector-empty");
      return;
    }

    for (const label of visibleLabels) {
      const name = this.makeLabelName(label);
      new Setting(this.resultsEl)
        .setName(name)
        .setClass("tasks-bridge-label-selector-option")
        .addToggle((toggle) => {
          toggle.setValue(this.selectedIds.has(label.id));
          toggle.toggleEl.setAttribute("aria-label", label.name);
          toggle.onChange((selected) => {
            if (selected) {
              this.selectedIds.add(label.id);
            } else {
              this.selectedIds.delete(label.id);
            }
            this.onSelectionChange(
              this.labels.filter((candidate) => this.selectedIds.has(candidate.id)),
            );
          });
        });
    }
  }

  private makeLabelName(label: Label): DocumentFragment {
    const fragment = createFragment();
    const iconEl = fragment.createSpan({ cls: "tasks-bridge-label-selector-icon" });
    iconEl.dataset.labelColor = label.color;
    iconEl.setAttribute("aria-hidden", "true");
    setIcon(iconEl, "tag");
    fragment.append(label.name);
    return fragment;
  }
}
