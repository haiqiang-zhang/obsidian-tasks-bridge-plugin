import * as sass from "sass";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolve } from "node:path";

type Mode = "source" | "preview";

const addNativeSurface = (parent: HTMLElement, mode: Mode) => {
  const classes =
    mode === "source"
      ? ["markdown-source-view is-live-preview", "cm-editor", "cm-scroller", "cm-sizer"]
      : ["markdown-reading-view", "markdown-preview-view", "markdown-preview-sizer", "mod-header"];
  let header = parent;
  for (const className of classes) {
    const element = document.createElement("div");
    element.className = className;
    header.append(element);
    header = element;
  }
  const title = document.createElement("div");
  title.className = "inline-title";
  title.textContent = "Task title";
  const properties = document.createElement("div");
  properties.className = "metadata-container";
  properties.textContent = "Native Properties";
  header.append(title, properties);
  return { header, properties, title };
};

describe("native task document first-paint styles", () => {
  let css: string;
  let stylesheet: HTMLStyleElement;

  beforeAll(() => {
    css = sass.compile(resolve(process.cwd(), "src/styles/main.scss")).css;
  });

  beforeEach(() => {
    stylesheet = document.createElement("style");
    stylesheet.textContent = css;
    document.head.append(stylesheet);
  });

  afterEach(() => {
    stylesheet.remove();
    document.body.replaceChildren();
  });

  const makeView = (mode: Mode) => {
    const leaf = document.createElement("div");
    leaf.className = "workspace-leaf-content";
    const content = document.createElement("div");
    content.className = "view-content";
    leaf.append(content);
    document.body.append(leaf);
    return { leaf, content, ...addNativeSurface(content, mode) };
  };

  it.each([
    "source",
    "preview",
  ] as const)("hides only the validated %s file header before filename decoration or React content exists", (mode) => {
    const { content, header, leaf, properties, title } = makeView(mode);
    const embed = document.createElement("div");
    embed.className = "markdown-embed";
    header.append(embed);
    const embedded = addNativeSurface(embed, mode);

    content.classList.add("tasks-bridge-task-content");

    expect(leaf).not.toHaveClass("tasks-bridge-task-document");
    expect(content.querySelector(".tasks-bridge-task-header-host")).toBeNull();
    expect(getComputedStyle(properties).display).toBe("none");
    expect(getComputedStyle(title).display).toBe("none");
    expect(getComputedStyle(embedded.properties).display).toBe("block");
    expect(getComputedStyle(embedded.title).display).toBe("block");

    // Disposal, invalid metadata, and reused ordinary views must restore native presentation.
    content.classList.remove("tasks-bridge-task-content");
    expect(getComputedStyle(properties).display).toBe("block");
    expect(getComputedStyle(title).display).toBe("block");
  });

  it.each([
    "source",
    "preview",
  ] as const)("keeps ordinary and unvalidated %s files visible even when the filename has a task suffix", (mode) => {
    const { leaf, properties, title } = makeView(mode);

    expect(getComputedStyle(properties).display).toBe("block");
    expect(getComputedStyle(title).display).toBe("block");
    leaf.classList.add("tasks-bridge-task-document");
    expect(getComputedStyle(properties).display).toBe("block");
    expect(getComputedStyle(title).display).toBe("block");
  });

  it("hides a validated editor's own Properties before its workspace leaf or task header is ready", () => {
    const { content, header, properties, title } = makeView("source");
    const editor = content.querySelector(".cm-editor");
    const embed = document.createElement("div");
    embed.className = "markdown-embed";
    header.append(embed);
    const embedded = addNativeSurface(embed, "source");
    embed.querySelector(".cm-editor")?.classList.add("tasks-bridge-task-editor");

    expect(content).not.toHaveClass("tasks-bridge-task-content");
    expect(content.querySelector(".tasks-bridge-task-header-host")).toBeNull();
    editor?.classList.add("tasks-bridge-task-editor");
    expect(getComputedStyle(properties).display).toBe("none");
    expect(getComputedStyle(title).display).toBe("none");
    expect(getComputedStyle(embedded.properties).display).toBe("block");
    expect(getComputedStyle(embedded.title).display).toBe("block");

    // Invalid source, mode changes, ordinary-file reuse and plugin unload all remove the facet.
    editor?.classList.remove("tasks-bridge-task-editor");
    expect(getComputedStyle(properties).display).toBe("block");
    expect(getComputedStyle(title).display).toBe("block");
  });
});
