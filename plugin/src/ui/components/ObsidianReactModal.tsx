import { type App, Modal } from "obsidian";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

type Options = {
  className?: string;
  render: (close: () => void) => React.ReactNode;
  title: string;
};

/**
 * Opens React content inside Obsidian's supported Modal shell.
 */
export const openObsidianReactModal = (app: App, options: Options): Modal => {
  const modal = new ObsidianReactModal(app, options);
  modal.open();
  return modal;
};

class ObsidianReactModal extends Modal {
  private readonly options: Options;
  private root: Root | null = null;

  constructor(app: App, options: Options) {
    super(app);
    this.options = options;
  }

  public override onOpen(): void {
    this.setTitle(this.options.title);
    if (this.options.className !== undefined) {
      this.modalEl.classList.add(this.options.className);
    }
    this.root = createRoot(this.contentEl);
    this.root.render(this.options.render(() => this.close()));
  }

  public override onClose(): void {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
