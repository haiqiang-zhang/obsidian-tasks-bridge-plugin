import { type App, Modal, Setting, setIcon } from "obsidian";
import type React from "react";
import { useMemo } from "react";
import { Button } from "react-aria-components";

import type { Label } from "@/api/domain/label";
import { t } from "@/i18n";
import type { Translations } from "@/i18n/translation";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";

type Props = {
  selected: Label[];
  setSelected: (labels: Label[]) => void;
};

type LabelSelectorTranslations = Translations["createTaskModal"]["labelSelector"];

export const LabelSelector: React.FC<Props> = ({ selected, setSelected }) => {
  const plugin = PluginContext.use();
  const options = useMemo(
    () => Array.from(plugin.services.todoist.data().labels.iterActive()),
    [plugin],
  );
  const i18n = t().createTaskModal.labelSelector;

  const openSelector = () => {
    new LabelSelectionModal(plugin.app, options, selected, setSelected, i18n).open();
  };

  return (
    <Button
      aria-haspopup="dialog"
      aria-label={i18n.buttonLabel}
      className="label-selector"
      onPress={openSelector}
    >
      <ObsidianIcon id="tag" size="m" />
      <span>{i18n.buttonText(selected.length)}</span>
    </Button>
  );
};

class LabelSelectionModal extends Modal {
  private readonly labels: Label[];
  private readonly selectedIds: Set<string>;
  private readonly onSelectionChange: (labels: Label[]) => void;
  private readonly i18n: LabelSelectorTranslations;
  private resultsEl: HTMLElement | null = null;

  public constructor(
    app: App,
    labels: Label[],
    selected: Label[],
    onSelectionChange: (labels: Label[]) => void,
    i18n: LabelSelectorTranslations,
  ) {
    super(app);
    this.labels = labels;
    this.selectedIds = new Set(selected.map((label) => label.id));
    this.onSelectionChange = onSelectionChange;
    this.i18n = i18n;
  }

  public override onOpen(): void {
    this.setTitle(this.i18n.labelOptionsLabel);
    this.modalEl.classList.add("tasks-bridge-label-selector-modal");
    this.contentEl.replaceChildren();

    new Setting(this.contentEl)
      .setName(this.i18n.search.label)
      .setClass("tasks-bridge-label-selector-search")
      .addSearch((search) => {
        search.setPlaceholder(this.i18n.search.placeholder);
        search.inputEl.setAttribute("aria-label", this.i18n.search.label);
        search.onChange((query) => this.renderOptions(query));
      });

    this.resultsEl = this.contentEl.ownerDocument.createElement("div");
    this.resultsEl.className = "tasks-bridge-label-selector-results";
    this.contentEl.append(this.resultsEl);
    this.renderOptions("");

    new Setting(this.contentEl)
      .setClass("tasks-bridge-label-selector-actions")
      .addButton((button) => {
        button
          .setButtonText(this.i18n.doneButtonLabel)
          .setCta()
          .onClick(() => this.close());
        button.buttonEl.setAttribute("aria-label", this.i18n.doneButtonLabel);
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
        .setName(this.i18n.emptyState)
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
    const ownerDocument = this.contentEl.ownerDocument;
    const fragment = ownerDocument.createDocumentFragment();
    const iconEl = ownerDocument.createElement("span");
    iconEl.className = "tasks-bridge-label-selector-icon";
    iconEl.dataset.labelColor = label.color;
    iconEl.setAttribute("aria-hidden", "true");
    setIcon(iconEl, "tag");
    fragment.append(iconEl, ownerDocument.createTextNode(label.name));
    return fragment;
  }
}
