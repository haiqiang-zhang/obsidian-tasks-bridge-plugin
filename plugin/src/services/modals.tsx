import { Modal, Platform } from "obsidian";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalContext, type ModalInfo, PluginContext } from "@/ui/context";

import type TodoistPlugin from "..";
import { CreateTaskModal } from "../ui/createTaskModal";
import { EditTaskModal } from "../ui/editTaskModal";
import { OnboardingModal } from "../ui/onboardingModal";

type ModalOptions = {
  title?: string;
  dontCloseOnExternalClick?: boolean;
};

class ReactModal<T extends object> extends Modal {
  private reactRoot: Root | null = null;
  private readonly content: React.ReactNode;

  constructor(plugin: TodoistPlugin, Component: React.FC<T>, props: T, opts: ModalOptions) {
    super(plugin.app);
    if (opts.title) {
      this.titleEl.textContent = opts.title;
    }

    const modal: ModalInfo = {
      close: () => this.close(),
    };

    if (opts.dontCloseOnExternalClick ?? false) {
      // HACK: In order to suppress the click event, we just re-create the element. This works okay because its simple.
      const modalBg = this.containerEl.firstElementChild;
      if (modalBg?.classList.contains("modal-bg")) {
        this.containerEl.removeChild(modalBg);
        createDiv({
          prepend: true,
          parent: this.containerEl,
          cls: ["modal-bg", "tasks-bridge-modal-bg-strong"],
        });
      }
    }

    this.content = (
      <PluginContext.Provider value={plugin}>
        <ModalContext.Provider value={modal}>
          <Component {...props} />
        </ModalContext.Provider>
      </PluginContext.Provider>
    );
  }

  onOpen(): void {
    // Preact renders synchronously. Inputs must measure after the native modal joins the DOM.
    this.reactRoot = createRoot(this.contentEl);
    this.reactRoot.render(this.content);
  }

  onClose(): void {
    this.reactRoot?.unmount();
    this.reactRoot = null;
    this.contentEl.empty();
  }
}

export class ModalHandler {
  private readonly plugin: TodoistPlugin;

  constructor(plugin: TodoistPlugin) {
    this.plugin = plugin;
  }

  public onboarding(props: React.ComponentProps<typeof OnboardingModal>) {
    new ReactModal(this.plugin, OnboardingModal, props, {
      title: "Tasks Bridge Setup",
    }).open();
  }

  public taskCreation(props: React.ComponentProps<typeof CreateTaskModal>) {
    new ReactModal(this.plugin, CreateTaskModal, props, {
      dontCloseOnExternalClick: Platform.isMobileApp,
    }).open();
  }

  public taskEdit(props: React.ComponentProps<typeof EditTaskModal>) {
    new ReactModal(this.plugin, EditTaskModal, props, {
      title: "Edit Todoist task",
      dontCloseOnExternalClick: Platform.isMobileApp,
    }).open();
  }
}
