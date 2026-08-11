import { act, screen } from "@testing-library/react";
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

import { SettingsTab } from "./index";

describe("SettingsTab", () => {
  let containerEl: HTMLElement;

  beforeEach(() => {
    useSettingsStore.setState(makeSettings(), true);
    containerEl = document.createElement("div");
    containerEl.empty = () => containerEl.replaceChildren();
    document.body.append(containerEl);
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
      getProjectSyncWriterState: vi.fn(() => "unassigned"),
      setThisDeviceAsAutomaticProjectSyncWriter: vi.fn(async () => undefined),
      stopAutomaticProjectSyncOnThisDevice: vi.fn(async () => undefined),
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

    await act(async () => tab.hide());
  });
});
