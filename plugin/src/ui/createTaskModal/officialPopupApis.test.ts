import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const createTaskSourceRoot = dirname(fileURLToPath(import.meta.url));
const uiSourceRoot = join(createTaskSourceRoot, "..");
const pluginSourceRoot = join(uiSourceRoot, "..");

const readRuntimeSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readRuntimeSources(path);
    }
    if (
      ![".ts", ".tsx"].includes(extname(entry.name)) ||
      entry.name.includes(".test.") ||
      path.includes(`${join("src", "mocks")}/`)
    ) {
      return [];
    }
    return [readFileSync(path, "utf8")];
  });

const runtimeSources = readRuntimeSources(pluginSourceRoot);

const deadlineSource = readFileSync(join(createTaskSourceRoot, "DeadlineSelector.tsx"), "utf8");
const dueDateSource = readFileSync(join(createTaskSourceRoot, "DueDateSelector.tsx"), "utf8");
const menuHookSource = readFileSync(join(uiSourceRoot, "obsidianMenu.ts"), "utf8");

describe("official Obsidian popup API guard", () => {
  it("does not reintroduce custom or browser-native popup menus anywhere in the plugin", () => {
    const forbidden = [
      /\bMenuTrigger\b/,
      /\bDialogTrigger\b/,
      /\bAriaPopover\b/,
      /<Popover\b/,
      /<ListBox\b/,
      /<Select\b/,
      /<select\b/,
      /import\s*\{[^}]*\b(?:DialogTrigger|ListBox|Menu|MenuTrigger|Popover|Select)\b[^}]*\}\s*from\s*["']react-aria-components["']/s,
    ];

    for (const source of runtimeSources) {
      for (const pattern of forbidden) {
        expect(source).not.toMatch(pattern);
      }
      expect(source).not.toContain(".setUseNativeMenu(");
    }
  });

  it("uses official Obsidian popup primitives for every selector family", () => {
    const allSources = runtimeSources.join("\n");
    expect(allSources).toContain("useObsidianMenu");
    expect(allSources).toContain("FuzzySuggestModal");
    expect(allSources).toContain("extends Modal");
    expect(allSources).toContain("openObsidianReactModal");
  });

  it("routes both date shortcut menus through the anchored Obsidian Menu helper", () => {
    for (const source of [deadlineSource, dueDateSource]) {
      expect(source).toContain("useObsidianMenu");
      expect(source).toContain('.setSection("quick-dates")');
      expect(source).toContain('.setSection("custom-date")');
      expect(source).toContain('aria-haspopup="menu"');
    }

    expect(menuHookSource).toContain("new Menu()");
    expect(menuHookSource).toContain(".setParentElement(anchor)");
    expect(menuHookSource).toContain("anchor.ownerDocument");
  });
});
