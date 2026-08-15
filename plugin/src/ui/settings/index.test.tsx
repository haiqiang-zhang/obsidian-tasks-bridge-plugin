import { act, fireEvent, render, screen } from "@testing-library/react";
import type { App, Setting as ObsidianSetting, SettingGroup } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeSettings } from "@/factories/settings";
import type TodoistPlugin from "@/index";
import { useSettingsStore } from "@/settings";

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

  it("uses only the declarative settings API", () => {
    const plugin = {
      services: {
        token: {
          migrateStorage: vi.fn(async () => undefined),
        },
      },
      writeOptions: vi.fn(async () => undefined),
    } as unknown as TodoistPlugin;
    const tab = new SettingsTab({} as App, plugin);

    expect(Object.getOwnPropertyDescriptor(SettingsTab.prototype, "display")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(SettingsTab.prototype, "hide")).toBeUndefined();
    expect(tab.getSettingDefinitions()).toMatchObject([
      { type: "group", heading: "General" },
      { type: "group", heading: "Project sync" },
      { type: "group", heading: "Auto-refresh" },
      { type: "group", heading: "Rendering" },
      { type: "group", heading: "Task creation" },
      { type: "group", heading: "Advanced" },
    ]);
    expect(plugin.writeOptions).not.toHaveBeenCalled();
    expect(plugin.services.token.migrateStorage).not.toHaveBeenCalled();
  });

  it("cleans up React controls through the declarative render callback", async () => {
    const plugin = {
      services: {
        token: {
          migrateStorage: vi.fn(async () => undefined),
        },
      },
      writeOptions: vi.fn(async () => undefined),
    } as unknown as TodoistPlugin;
    const tab = new SettingsTab({} as App, plugin);
    const general = tab.getSettingDefinitions()[0];
    if (!general || !("type" in general) || general.type !== "group") {
      throw new TypeError("Expected the General settings group");
    }
    const links = general.items?.[0];
    if (!links || !("render" in links) || typeof links.render !== "function") {
      throw new TypeError("Expected the links render definition");
    }
    const renderLinks = links.render;

    let cleanup: (() => void) | undefined;
    await act(async () => {
      cleanup = renderLinks(
        { controlEl: containerEl } as ObsidianSetting,
        {} as SettingGroup,
      ) as () => void;
    });
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    await act(async () => cleanup?.());
    expect(screen.queryByRole("button", { name: "Docs" })).not.toBeInTheDocument();
  });
});
