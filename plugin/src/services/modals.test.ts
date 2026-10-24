import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Priorities, type Task } from "@/api/domain/task";
import type TodoistPlugin from "@/index";
import { CreateTaskModal } from "@/ui/createTaskModal";
import { EditTaskModal } from "@/ui/editTaskModal";
import { OnboardingModal } from "@/ui/onboardingModal";

import { ModalHandler } from "./modals";

type NativeModal = {
  containerEl: HTMLDivElement;
  contentEl: HTMLDivElement;
  open: () => void;
  close: () => void;
};

type RenderedRoot = {
  element: HTMLElement;
  connectedAtRender: boolean[];
  render: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
};

const state = vi.hoisted(() => ({
  modals: [] as NativeModal[],
  roots: [] as RenderedRoot[],
}));

vi.mock("obsidian", () => ({
  Platform: { isMobileApp: true },
  Modal: class {
    containerEl = document.createElement("div");
    modalEl = document.createElement("div");
    contentEl = document.createElement("div");
    titleEl = document.createElement("div");

    constructor() {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-bg";
      this.modalEl.append(this.titleEl, this.contentEl);
      this.containerEl.append(backdrop, this.modalEl);
      state.modals.push(this);
    }

    onOpen(): void {}
    onClose(): void {}

    open(): void {
      // Obsidian attaches the native shell before invoking the plugin's open hook.
      document.body.append(this.containerEl);
      this.onOpen();
    }

    close(): void {
      this.onClose();
      this.containerEl.remove();
    }
  },
}));

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn((element: HTMLElement) => {
    const connectedAtRender: boolean[] = [];
    const root = {
      element,
      connectedAtRender,
      render: vi.fn(() => {
        // Preact renders synchronously in the production bundle. Measuring an unattached
        // form here used to leave mobile auto-sizing textareas blank or incorrectly sized.
        connectedAtRender.push(element.isConnected);
        element.textContent = "Rendered form";
      }),
      unmount: vi.fn(),
    };
    state.roots.push(root);
    return root;
  }),
}));

vi.mock("@/ui/createTaskModal", () => ({ CreateTaskModal: () => null }));
vi.mock("@/ui/editTaskModal", () => ({ EditTaskModal: () => null }));
vi.mock("@/ui/onboardingModal", () => ({ OnboardingModal: () => null }));

const task: Task = {
  id: "mobile-task",
  addedAt: "2026-10-25T00:00:00.000Z",
  addedAtIsAuthoritative: true,
  content: "Mobile task",
  description: "Description",
  projectId: "project",
  sectionId: null,
  parentId: null,
  labels: [],
  priority: Priorities.P4,
  due: null,
  duration: null,
  deadline: null,
  childOrder: 1,
};

const cases = [
  {
    name: "onboarding",
    Component: OnboardingModal,
    open: (handler: ModalHandler) => handler.onboarding({ onTokenSubmit: vi.fn() }),
  },
  {
    name: "task creation",
    Component: CreateTaskModal,
    open: (handler: ModalHandler) =>
      handler.taskCreation({ initialContent: "New task", fileContext: undefined, options: {} }),
  },
  {
    name: "task editing",
    Component: EditTaskModal,
    open: (handler: ModalHandler) =>
      handler.taskEdit({ task, projectPath: "Project", onSubmit: vi.fn() }),
  },
];

beforeEach(() => {
  state.modals.length = 0;
  state.roots.length = 0;
  vi.stubGlobal(
    "createDiv",
    (options: { cls: string[]; parent: HTMLElement; prepend: boolean }) => {
      const element = document.createElement("div");
      element.classList.add(...options.cls);
      if (options.prepend) {
        options.parent.prepend(element);
      } else {
        options.parent.append(element);
      }
      return element;
    },
  );
});

afterEach(() => {
  for (const modal of state.modals) {
    modal.close();
  }
  vi.unstubAllGlobals();
});

describe("native modal mounting", () => {
  it.each(
    cases,
  )("mounts $name after attachment and cleans up through its close action", (entry) => {
    const plugin = { app: {} } as TodoistPlugin;
    const handler = new ModalHandler(plugin);

    entry.open(handler);

    const modal = state.modals[0];
    const root = state.roots[0];
    expect(state.roots).toHaveLength(1);
    expect(root.element).toBe(modal.contentEl);
    expect(root.connectedAtRender).toEqual([true]);

    const provider = root.render.mock.calls[0][0] as ReactElement<{
      value: TodoistPlugin;
      children: ReactElement<{
        value: { close: () => void };
        children: ReactElement;
      }>;
    }>;
    expect(provider.props.value).toBe(plugin);
    expect(provider.props.children.props.children.type).toBe(entry.Component);

    provider.props.children.props.value.close();

    expect(root.unmount).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.childNodes).toHaveLength(0);
    expect(modal.containerEl.isConnected).toBe(false);
    modal.close();
    expect(root.unmount).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh attached root when a closed native modal is reopened", () => {
    const handler = new ModalHandler({ app: {} } as TodoistPlugin);
    handler.taskCreation({ initialContent: "New task", fileContext: undefined, options: {} });
    const modal = state.modals[0];
    const originalRoot = state.roots[0];

    modal.close();
    modal.open();

    expect(state.roots).toHaveLength(2);
    expect(originalRoot.unmount).toHaveBeenCalledTimes(1);
    expect(originalRoot.render).toHaveBeenCalledTimes(1);
    expect(state.roots[1].connectedAtRender).toEqual([true]);
    modal.close();
    expect(state.roots[1].unmount).toHaveBeenCalledTimes(1);
  });
});
