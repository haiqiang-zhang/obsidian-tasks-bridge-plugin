import { act, fireEvent, render, screen } from "@testing-library/react";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeSettings } from "@/factories/settings";
import type TodoistPlugin from "@/index";
import { useSettingsStore } from "@/settings";

vi.mock("./AutoRefreshIntervalControl", () => ({
  AutoRefreshIntervalControl: () => null,
}));
vi.mock("./LabelsControl", () => ({ LabelsControl: () => null }));
vi.mock("./ProjectDropdownControl", () => ({ ProjectDropdownControl: () => null }));
vi.mock("./ProjectSyncMappingsControl", () => ({ ProjectSyncMappingsControl: () => null }));
vi.mock("./ProjectSyncNowControl", () => ({ ProjectSyncNowControl: () => null }));
vi.mock("./TokenChecker", () => ({ TokenChecker: () => null }));

import { SETTINGS_LINKS, SettingsLinks, SettingsTab } from "./index";

describe("SettingsTab", () => {
  let containerEl: HTMLElement;

  beforeEach(() => {
    useSettingsStore.setState(makeSettings(), true);
    containerEl = document.createElement("div");
    containerEl.empty = () => containerEl.replaceChildren();
    document.body.append(containerEl);
  });

  it("opens the canonical Tasks Bridge documentation from the Docs button", () => {
    const navigate = vi.fn();
    render(<SettingsLinks navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      "https://haiqiang-zhang.github.io/obsidian-tasks-bridge-plugin/",
    );
    expect(navigate).toHaveBeenCalledWith(SETTINGS_LINKS.documentation);
  });

  afterEach(() => {
    containerEl.remove();
  });

  it("places Project sync before the shared Auto-refresh settings", async () => {
    const plugin = {
      services: {
        token: {
          migrateStorage: vi.fn(async () => undefined),
        },
      },
      writeOptions: vi.fn(async () => undefined),
    } as unknown as TodoistPlugin;
    const tab = new SettingsTab({} as App, plugin);
    Object.assign(tab, { containerEl });

    await act(async () => tab.display());

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "General",
      "Project sync",
      "Auto-refresh",
      "Rendering",
      "Task creation",
      "Advanced",
    ]);
    expect(screen.queryByText("Automatic Project sync device")).not.toBeInTheDocument();

    await act(async () => tab.hide());
  });
});
