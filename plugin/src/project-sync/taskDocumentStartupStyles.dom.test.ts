import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/taskDocumentStartup.css"), "utf8");

type Mode = "source" | "preview";

const makeSurface = (mode: Mode, parent: HTMLElement) => {
  let header = parent;
  const chain =
    mode === "source"
      ? ["markdown-source-view is-live-preview", "cm-editor", "cm-scroller", "cm-sizer"]
      : ["markdown-reading-view", "markdown-preview-view", "markdown-preview-sizer", "mod-header"];
  for (const className of chain) {
    const node = document.createElement("div");
    node.className = className;
    header.append(node);
    header = node;
  }
  const metadata = document.createElement("div");
  metadata.className = "metadata-container";
  metadata.innerHTML =
    '<div class="metadata-content"><div class="metadata-properties"></div></div>';
  header.append(metadata);
  const properties = metadata.querySelector(".metadata-properties");
  if (properties === null) {
    throw new Error("Missing fixture properties");
  }
  for (const key of ["task id", "content", "status", "url"]) {
    const property = document.createElement("div");
    property.className = "metadata-property";
    property.dataset.propertyKey = key;
    if (key === "url") {
      property.innerHTML =
        '<div class="metadata-property-value"><div class="metadata-link"><div class="metadata-link-inner external-link" data-href="https://todoist.com/app/project/project-id/task/task-id"></div></div></div>';
    }
    properties.append(property);
  }
  return { header, metadata };
};

const makeTemporaryView = (mode: Mode) => {
  const app = document.createElement("div");
  app.className = "app-container mod-loading";
  const leaf = document.createElement("div");
  leaf.className = "workspace-leaf-content";
  leaf.dataset.type = "markdown";
  leaf.dataset.mode = mode;
  const viewHeader = document.createElement("div");
  viewHeader.className = "view-header";
  const spinner = document.createElement("div");
  spinner.className = "mod-loading-icon";
  const title = document.createElement("div");
  title.className = "view-header-title-container";
  viewHeader.append(spinner, title);
  const content = document.createElement("div");
  content.className = "view-content";
  leaf.append(viewHeader, content);
  app.append(leaf);
  document.body.append(app);
  return { app, leaf, spinner, title, content, ...makeSurface(mode, content) };
};

describe("pre-plugin mobile task preview selectors", () => {
  let stylesheet: HTMLStyleElement;
  // jsdom does not resolve inherited CSS custom properties. Inspect the native selector's
  // assignment; real computed visibility and first paints are checked in the Obsidian fixture.
  const guarded = (leaf: HTMLElement) =>
    getComputedStyle(leaf).getPropertyValue("--tasks-bridge-mobile-preview-visibility") ===
    "hidden";

  beforeEach(() => {
    stylesheet = document.createElement("style");
    stylesheet.textContent = css;
    document.head.append(stylesheet);
  });

  afterEach(() => {
    stylesheet.remove();
    document.body.replaceChildren();
  });

  it.each(["source", "preview"] as const)("guards only the temporary %s task surface", (mode) => {
    const { app, leaf, spinner } = makeTemporaryView(mode);

    expect(guarded(leaf)).toBe(true);
    expect(getComputedStyle(spinner).visibility).toBe("visible");

    app.classList.remove("mod-loading");
    expect(guarded(leaf)).toBe(false);
    app.classList.add("mod-loading");
    spinner.classList.remove("mod-loading-icon");
    expect(guarded(leaf)).toBe(false);
  });

  it.each([
    "source",
    "preview",
  ] as const)("does not hide ordinary %s notes containing a task embed", (mode) => {
    const { content, leaf, metadata } = makeTemporaryView(mode);
    metadata.querySelector('[data-property-key="url"]')?.remove();
    const embed = document.createElement("div");
    embed.className = "markdown-embed";
    content.append(embed);
    makeSurface(mode, embed);

    expect(guarded(leaf)).toBe(false);
  });

  it.each(["task id", "content", "status", "url"])("requires the task's own %s property", (key) => {
    const { leaf, metadata } = makeTemporaryView("source");
    metadata.querySelector(`[data-property-key="${key}"]`)?.remove();

    expect(guarded(leaf)).toBe(false);
  });

  it("keeps intentional Source mode visible", () => {
    const { content, leaf } = makeTemporaryView("source");
    content.querySelector(".markdown-source-view")?.classList.remove("is-live-preview");

    expect(guarded(leaf)).toBe(false);
  });

  it.each([
    ["https://todoist.com/app/project/p/task/t", true],
    ["https://app.todoist.com/app/task/t", true],
    ["https://todoist.com/app/project/p", false],
    ["https://todoist.com.example.org/app/project/p/task/t", false],
    ["https://example.org/task/t", false],
  ] as const)("handles URL %s", (url, expected) => {
    const { leaf, metadata } = makeTemporaryView("preview");
    metadata.querySelector(".external-link")?.setAttribute("data-href", url);

    expect(guarded(leaf)).toBe(expected);
  });
});
