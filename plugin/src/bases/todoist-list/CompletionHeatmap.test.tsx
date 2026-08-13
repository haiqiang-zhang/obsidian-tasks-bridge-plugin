import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionHeatmap } from "./CompletionHeatmap";
import type { CompletionHeatmapEvent } from "./completionHeatmapModel";

const { menuItems, setTooltipMock, showAtPositionMock } = vi.hoisted(() => ({
  menuItems: [] as Array<{
    checked: boolean | null;
    click: (() => void) | null;
    section: string | null;
    title: string;
  }>,
  setTooltipMock: vi.fn(),
  showAtPositionMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
  Menu: class {
    setParentElement(): this {
      return this;
    }
    addItem(callback: (item: unknown) => void): this {
      const record: (typeof menuItems)[number] = {
        checked: null,
        click: null,
        section: null,
        title: "",
      };
      const item = {
        setChecked: (checked: boolean | null) => {
          record.checked = checked;
          return item;
        },
        setSection: (section: string) => {
          record.section = section;
          return item;
        },
        setTitle: (title: string) => {
          record.title = title;
          return item;
        },
        onClick: (click: () => void) => {
          record.click = click;
          return item;
        },
      };
      callback(item);
      menuItems.push(record);
      return this;
    }
    showAtPosition(...args: unknown[]): this {
      showAtPositionMock(...args);
      return this;
    }
  },
  setIcon: (parent: HTMLElement, iconId: string) => {
    parent.dataset.icon = iconId;
  },
  setTooltip: setTooltipMock,
}));

const NOW = new Date("2026-08-12T12:00:00.000Z");

const event = (id: string, completedAt: string): CompletionHeatmapEvent => ({ id, completedAt });

beforeEach(() => {
  menuItems.length = 0;
  setTooltipMock.mockClear();
  showAtPositionMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompletionHeatmap", () => {
  it("renders a labeled GitHub-style grid, Obsidian range menu, legend, and exact tooltips", () => {
    const onRangeChange = vi.fn();
    render(
      <CompletionHeatmap
        events={[
          event("today", "2026-08-12T10:00:00Z"),
          event("historical", "2025-03-04T10:00:00Z"),
        ]}
        now={NOW}
        onRangeChange={onRangeChange}
        range="last-4-weeks"
        timeZone="UTC"
      />,
    );

    const heatmap = screen.getByRole("region", { name: "Completion activity" });
    expect(within(heatmap).getByText("1 completion")).toBeInTheDocument();
    expect(
      within(heatmap).getByText("Last 4 weeks", {
        selector: ".tasks-bridge-completion-heatmap-heading-group p > span:last-child",
      }),
    ).toBeInTheDocument();
    expect(
      within(heatmap).getByRole("region", {
        name: "Completion calendar for July 16 – August 12, 2026",
      }),
    ).toBeInTheDocument();

    const grid = within(heatmap).getByRole("grid", {
      name: "Daily task completions from July 16 – August 12, 2026",
    });
    expect(grid).toHaveAttribute("aria-readonly", "true");
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    expect(grid.getAttribute("aria-describedby")).toContain("instructions");
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(28);
    expect(within(grid).getByText("Mon")).toHaveAttribute("data-visible", "true");
    expect(within(grid).getByText("Tue")).not.toHaveAttribute("data-visible");
    expect(within(grid).getByText("Jul")).toBeInTheDocument();
    expect(within(grid).getByText("Aug")).toBeInTheDocument();

    const today = within(grid).getByRole("gridcell", {
      name: "1 task completion on August 12, 2026.",
    });
    expect(today).toHaveAttribute("data-level", "4");
    expect(today.getAttribute("aria-describedby")).toContain("legend-4");
    expect(today.getAttribute("aria-describedby")).not.toContain("instructions");
    expect(setTooltipMock).toHaveBeenCalledWith(today, "1 task completion on August 12, 2026.", {
      placement: "top",
    });

    const picker = within(heatmap).getByRole("button", {
      name: "Activity range: Last 4 weeks",
    });
    expect(picker).toHaveClass("tasks-bridge-completion-heatmap-range-button");
    expect(picker).not.toHaveClass("dropdown");
    expect(picker.querySelectorAll('[data-icon="chevron-down"]')).toHaveLength(1);
    fireEvent.click(picker);
    expect(menuItems.map(({ title }) => title)).toEqual([
      "Last 4 weeks",
      "Last 3 months",
      "Last 6 months",
      "Last year",
      "2026",
      "2025",
    ]);
    expect(menuItems.find(({ title }) => title === "Last 4 weeks")).toMatchObject({
      checked: true,
      section: "recent-ranges",
    });
    expect(menuItems.find(({ title }) => title === "2026")).toMatchObject({
      checked: false,
      section: "calendar-years",
    });
    expect(showAtPositionMock).toHaveBeenCalledOnce();

    menuItems.find(({ title }) => title === "Last 3 months")?.click?.();
    expect(onRangeChange).toHaveBeenCalledWith("last-3-months");
    expect(within(heatmap).getByText("Less")).toBeInTheDocument();
    expect(within(heatmap).getByText("More")).toBeInTheDocument();
  });

  it("uses one roving tab stop and GitHub-style arrow, page, and edge navigation", () => {
    render(
      <CompletionHeatmap
        events={[]}
        now={NOW}
        onRangeChange={vi.fn()}
        range="last-4-weeks"
        timeZone="UTC"
      />,
    );

    const cells = screen.getAllByRole("gridcell");
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(cells.find((cell) => cell.tabIndex === 0)).toHaveAttribute("data-date", "2026-08-12");

    const augustThird = screen.getByRole("gridcell", {
      name: "No task completions on August 3, 2026.",
    });
    const augustTenth = screen.getByRole("gridcell", {
      name: "No task completions on August 10, 2026.",
    });
    const augustNinth = screen.getByRole("gridcell", {
      name: "No task completions on August 9, 2026.",
    });
    const augustFifteenth = screen.queryByRole("gridcell", {
      name: "No task completions on August 15, 2026.",
    });

    act(() => augustThird.focus());
    fireEvent.keyDown(augustThird, { key: "ArrowRight" });
    expect(augustTenth).toHaveFocus();

    fireEvent.keyDown(augustTenth, { key: "PageUp" });
    expect(augustNinth).toHaveFocus();

    fireEvent.keyDown(augustNinth, { key: "PageDown" });
    expect(augustFifteenth).toBeNull();
    expect(
      screen.getByRole("gridcell", { name: "No task completions on August 12, 2026." }),
    ).toHaveFocus();

    fireEvent.keyDown(document.activeElement ?? document.body, { ctrlKey: true, key: "Home" });
    expect(
      screen.getByRole("gridcell", { name: "No task completions on July 16, 2026." }),
    ).toHaveFocus();
  });

  it("selects complete pointer or keyboard ranges and resets a repeated day", () => {
    render(
      <CompletionHeatmap
        events={[event("first", "2026-01-01T10:00:00Z"), event("last", "2026-01-31T10:00:00Z")]}
        now={NOW}
        onRangeChange={vi.fn()}
        range="year:2026"
        timeZone="UTC"
      />,
    );

    const start = screen.getByRole("gridcell", {
      name: "1 task completion on January 1, 2026.",
    });
    const farEnd = screen.getByRole("gridcell", {
      name: "No task completions on March 15, 2026.",
    });

    fireEvent.click(start);
    expect(start).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("January 1, 2026 · 1 completion.");

    fireEvent.click(farEnd, { shiftKey: true });
    const selectedCells = screen
      .getAllByRole("gridcell")
      .filter((cell) => cell.getAttribute("aria-selected") === "true");
    expect(selectedCells).toHaveLength(74);
    expect(selectedCells.some((cell) => cell.getAttribute("data-date") === "2026-01-01")).toBe(
      true,
    );
    expect(selectedCells.some((cell) => cell.getAttribute("data-date") === "2026-01-31")).toBe(
      true,
    );
    expect(selectedCells.some((cell) => cell.getAttribute("data-date") === "2026-03-15")).toBe(
      true,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "January 1 – March 15, 2026 · 2 completions.",
    );

    fireEvent.keyDown(farEnd, { key: "Enter" });
    expect(farEnd).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(farEnd, { key: " " });
    expect(farEnd).toHaveAttribute("aria-selected", "false");
  });

  it("keeps the complete zero grid and shows a quiet empty state", () => {
    render(
      <CompletionHeatmap
        events={[]}
        now={NOW}
        onRangeChange={vi.fn()}
        range="last-4-weeks"
        timeZone="UTC"
      />,
    );

    expect(screen.getByText("0 completions")).toBeInTheDocument();
    expect(screen.getByText("No task completions in this period.")).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")).toHaveLength(28);
  });

  it("advances the rolling calendar at the requested time-zone midnight without a data refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59.500Z"));
    render(
      <CompletionHeatmap events={[]} onRangeChange={vi.fn()} range="last-4-weeks" timeZone="UTC" />,
    );

    expect(
      screen.getByRole("gridcell", { name: "No task completions on August 12, 2026." }),
    ).toHaveAttribute("tabindex", "0");

    act(() => vi.advanceTimersByTime(2000));

    expect(
      screen.getByRole("gridcell", { name: "No task completions on August 13, 2026." }),
    ).toHaveAttribute("tabindex", "0");
  });

  it("pins responsive overflow to recent dates without overriding manual history scrolling", () => {
    let viewportWidth = 800;
    const resizeCallbacks: Array<() => void> = [];
    class MockResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeCallbacks.push(() => this.callback([], this as unknown as ResizeObserver));
      }

      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("tasks-bridge-completion-heatmap-viewport") ? 777 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("tasks-bridge-completion-heatmap-viewport")
        ? viewportWidth
        : 0;
    });

    render(
      <CompletionHeatmap
        events={[]}
        now={NOW}
        onRangeChange={vi.fn()}
        range="last-year"
        timeZone="UTC"
      />,
    );
    const viewport = screen.getByRole("region", { name: /Completion calendar/ });
    expect(viewport.scrollLeft).toBe(0);

    viewportWidth = 400;
    act(() => resizeCallbacks[0]?.());
    expect(viewport.scrollLeft).toBe(377);

    viewportWidth = 350;
    fireEvent(window, new Event("resize"));
    expect(viewport.scrollLeft).toBe(427);

    viewport.scrollLeft = 100;
    fireEvent.scroll(viewport);
    viewportWidth = 300;
    act(() => resizeCallbacks[0]?.());
    expect(viewport.scrollLeft).toBe(100);

    viewportWidth = 800;
    act(() => resizeCallbacks[0]?.());
    expect(viewport.scrollLeft).toBe(0);
    viewportWidth = 400;
    act(() => resizeCallbacks[0]?.());
    expect(viewport.scrollLeft).toBe(377);
  });
});
