import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Priorities } from "@/api/domain/task";

import { OptionsSelector } from "./OptionsSelector";
import { PrioritySelector } from "./PrioritySelector";

const { menuInstances } = vi.hoisted(() => ({
  menuInstances: [] as MenuRecord[],
}));

type MenuItemRecord = {
  checked: boolean | null;
  click: (() => void) | null;
  title: string;
};

type MenuRecord = {
  closed: boolean;
  document: Document | null;
  hide: (() => void) | null;
  items: MenuItemRecord[];
  native: boolean | null;
  parent: HTMLElement | null;
  position: { x: number; y: number; width?: number; overlap?: boolean } | null;
};

vi.mock("obsidian", () => ({
  Menu: class {
    private readonly record: MenuRecord = {
      closed: false,
      document: null,
      hide: null,
      items: [],
      native: null,
      parent: null,
      position: null,
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

    onHide(hide: () => void): void {
      this.record.hide = hide;
    }

    showAtPosition(
      position: { x: number; y: number; width?: number; overlap?: boolean },
      document: Document,
    ): this {
      this.record.position = position;
      this.record.document = document;
      return this;
    }

    close(): void {
      this.record.closed = true;
      this.record.hide?.();
    }
  },
  setIcon: vi.fn(),
}));

beforeEach(() => {
  menuInstances.length = 0;
});

describe("official create-task menus", () => {
  it("anchors priority choices without overriding Obsidian's native-menu preference", () => {
    const setSelected = vi.fn();
    const view = render(<PrioritySelector selected={Priorities.P2} setSelected={setSelected} />);
    const trigger = screen.getByRole("button", { name: "Set priority" });
    Object.defineProperty(trigger, "getBoundingClientRect", {
      value: () => ({ bottom: 48, left: 12, width: 120 }),
    });

    fireEvent.click(trigger);

    const menu = menuInstances[0];
    expect(menu.document).toBe(trigger.ownerDocument);
    expect(menu.native).toBeNull();
    expect(menu.parent).toBe(trigger);
    expect(menu.position).toEqual({ overlap: true, width: 120, x: 12, y: 48 });
    expect(menu.items.map(({ checked, title }) => ({ checked, title }))).toEqual([
      { checked: false, title: "Priority 1" },
      { checked: true, title: "Priority 2" },
      { checked: false, title: "Priority 3" },
      { checked: false, title: "Priority 4" },
    ]);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    menu.items.find(({ title }) => title === "Priority 4")?.click?.();
    expect(setSelected).toHaveBeenCalledWith(Priorities.P4);

    view.unmount();
    expect(menu.closed).toBe(true);
  });

  it("uses checked Obsidian menu items for page-link options", () => {
    const setSelected = vi.fn();
    render(
      <OptionsSelector selected={{ appendLinkTo: "description" }} setSelected={setSelected} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set options" }));

    const menu = menuInstances[0];
    expect(menu.items.map(({ checked, title }) => ({ checked, title }))).toEqual([
      { checked: false, title: "Add link to content" },
      { checked: true, title: "Add link to description" },
      { checked: false, title: "Do not add link" },
    ]);

    menu.items.find(({ title }) => title === "Do not add link")?.click?.();
    expect(setSelected).toHaveBeenCalledWith({ appendLinkTo: undefined });
  });

  it("closes an open menu when its trigger unmounts", () => {
    const view = render(<PrioritySelector selected={Priorities.P4} setSelected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set priority" }));

    const menu = menuInstances[0];
    view.unmount();

    expect(menu.closed).toBe(true);
  });

  it("toggles the same anchored menu closed without opening a replacement", () => {
    render(<PrioritySelector selected={Priorities.P4} setSelected={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Set priority" });

    fireEvent.click(trigger);
    const menu = menuInstances[0];
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger);
    expect(menu.closed).toBe(true);
    expect(menuInstances).toHaveLength(1);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(menuInstances).toHaveLength(2);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
