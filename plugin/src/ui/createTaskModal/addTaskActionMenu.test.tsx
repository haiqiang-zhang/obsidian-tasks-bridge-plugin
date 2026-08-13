import { act, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSettings } from "@/factories/settings";
import type TodoistPlugin from "@/index";
import { useSettingsStore } from "@/settings";
import { ModalContext, PluginContext } from "@/ui/context";

import { CreateTaskModal } from ".";

type MenuItemRecord = {
  checked: boolean | null;
  click: (() => void) | null;
  title: string;
};

type MenuRecord = {
  document: Document | null;
  items: MenuItemRecord[];
  native: boolean | null;
  parent: HTMLElement | null;
};

const { menuInstances } = vi.hoisted(() => ({
  menuInstances: [] as MenuRecord[],
}));

vi.mock("obsidian", () => ({
  Menu: class {
    private readonly record: MenuRecord = {
      document: null,
      items: [],
      native: null,
      parent: null,
    };

    constructor() {
      menuInstances.push(this.record);
    }

    setUseNativeMenu(native: boolean): this {
      this.record.native = native;
      return this;
    }

    setParentElement(parent: HTMLElement): this {
      this.record.parent = parent;
      return this;
    }

    addItem(configure: (item: unknown) => void): this {
      const record: MenuItemRecord = { checked: null, click: null, title: "" };
      const item = {
        onClick: (click: () => void) => {
          record.click = click;
          return item;
        },
        setChecked: (checked: boolean | null) => {
          record.checked = checked;
          return item;
        },
        setTitle: (title: string) => {
          record.title = title;
          return item;
        },
      };
      configure(item);
      this.record.items.push(record);
      return this;
    }

    onHide(): void {}

    showAtPosition(_position: unknown, document: Document): this {
      this.record.document = document;
      return this;
    }

    close(): void {}
  },
  Notice: vi.fn(),
  setIcon: vi.fn(),
}));

vi.mock("./DeadlineSelector", () => ({ DeadlineSelector: () => null }));
vi.mock("./DueDateSelector", () => ({ DueDateSelector: () => null }));
vi.mock("./LabelSelector", () => ({ LabelSelector: () => null }));
vi.mock("./OptionsSelector", () => ({ OptionsSelector: () => null }));
vi.mock("./PrioritySelector", () => ({ PrioritySelector: () => null }));
vi.mock("./ProjectSelector", () => ({ ProjectSelector: () => null }));

const renderModal = (initialContent: string) => {
  const plugin = {
    services: {
      todoist: {
        data: () => ({
          projects: {
            iterActive: () => [
              {
                childOrder: 1,
                color: "grey",
                id: "inbox",
                inboxProject: true,
                isArchived: false,
                isDeleted: false,
                name: "Inbox",
                parentId: null,
              },
            ],
          },
        }),
        isPremium: () => false,
        isReady: () => true,
      },
    },
  } as unknown as TodoistPlugin;
  const modal = {
    close: vi.fn(),
    popoverContainerEl: document.createElement("div"),
  };
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <PluginContext.Provider value={plugin}>
      <ModalContext.Provider value={modal}>{children}</ModalContext.Provider>
    </PluginContext.Provider>
  );

  return render(
    <CreateTaskModal initialContent={initialContent} fileContext={undefined} options={{}} />,
    { wrapper: Wrapper },
  );
};

beforeEach(() => {
  menuInstances.length = 0;
  useSettingsStore.setState(makeSettings(), true);
});

describe("CreateTaskModal add-task action menu", () => {
  it("uses a checked Obsidian menu without overriding the native-menu preference", () => {
    renderModal("Write report");
    const trigger = screen.getByRole("button", { name: "Add task action menu" });

    fireEvent.click(trigger);

    const menu = menuInstances[0];
    expect(menu.native).toBeNull();
    expect(menu.parent).toBe(trigger);
    expect(menu.document).toBe(trigger.ownerDocument);
    expect(menu.items.map(({ checked, title }) => ({ checked, title }))).toEqual([
      { checked: true, title: "Add task" },
      { checked: false, title: "Add task and copy link (app)" },
      { checked: false, title: "Add task and copy link (web)" },
    ]);

    act(() => {
      menu.items.find(({ title }) => title === "Add task and copy link (web)")?.click?.();
    });
    expect(
      screen.getByRole("button", { name: "Add task and copy link (web)" }),
    ).toBeInTheDocument();
  });

  it("keeps the action menu disabled when the task cannot be submitted", () => {
    renderModal("");

    const trigger = screen.getByRole("button", { name: "Add task action menu" });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(menuInstances).toHaveLength(0);
  });
});
