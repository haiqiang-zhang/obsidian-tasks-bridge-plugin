import * as sass from "sass";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolve } from "node:path";

const compileStyles = (path: string): string => sass.compile(resolve(process.cwd(), path)).css;

const ruleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  const bodyEnd = css.indexOf("}", bodyStart);
  return css.slice(bodyStart, bodyEnd);
};

describe("Todoist query special-state styles", () => {
  it("reserves the native action rail only beside the first task content", () => {
    const css = compileStyles("src/ui/query/styles.scss");
    const firstTaskContent = ruleBody(
      css,
      ".todoist-query.is-untitled .todoist-query-content > .todoist-tasks-list:first-child > .todoist-task-container:first-child > .todoist-task > .todoist-task-content",
    );

    expect(firstTaskContent).toContain("padding-inline-end: var(--todoist-query-actions-width)");
    expect(css).not.toMatch(
      /\.todoist-query\.is-untitled[^{}]*> \.todoist-task-container:first-child\s*\{[^}]*padding-inline-end:/,
    );
  });

  it("keeps an untitled callout full width while reserving the native action rail", () => {
    const css = compileStyles("src/ui/query/styles.scss");
    const callout = ruleBody(
      css,
      ".todoist-query.is-untitled .todoist-query-content > .todoist-callout:first-child",
    );
    const title = ruleBody(
      css,
      ".todoist-query.is-untitled .todoist-query-content > .todoist-callout:first-child > .callout-title",
    );

    expect(callout).toContain("margin: var(--size-2-2)");
    expect(callout).not.toContain("padding-inline-end");
    expect(callout).not.toContain("margin-inline-end");
    expect(callout).not.toMatch(/(?:background|border|border-radius|box-shadow|font|--callout-):/);
    expect(title).toContain("padding-inline-end: var(--todoist-query-actions-width)");
  });

  it("centers only the single-line empty-state rail and preserves tall callout positioning", () => {
    const css = compileStyles("src/ui/query/styles.scss");
    const toolbar = ruleBody(css, ".embed-actions > .todoist-query-controls");
    const centeredRail = ruleBody(
      css,
      ":is(.cm-lang-tasks-bridge-query, .cm-lang-todoist):has(.todoist-query.is-untitled .todoist-no-tasks:first-child) > .embed-actions",
    );
    const action = ruleBody(css, ".todoist-query-control-button");

    expect(toolbar).toContain("order: -1");
    expect(centeredRail).toContain("inset-block-start: 50%");
    expect(centeredRail).toContain("transform: translateY(-50%)");
    expect(centeredRail).not.toMatch(/(?:background|border|box-shadow|color|padding):/);
    expect(css).not.toContain(":has(> .callout-content)");
    expect(css).not.toContain(
      ":is(.cm-lang-tasks-bridge-query, .cm-lang-todoist):has(.todoist-query.is-untitled .todoist-callout:first-child) > .embed-actions",
    );
    expect(css).not.toContain(
      ":is(.cm-lang-tasks-bridge-query, .cm-lang-todoist):has(.todoist-query.is-untitled .todoist-query-error:first-child) > .embed-actions",
    );
    expect(action).toContain("flex: none");
    expect(action).not.toMatch(/(?:border|box-shadow|color|--icon-size|--icon-stroke)\s*:/);
    expect(css).not.toContain(".edit-block-button");
    expect(css).not.toContain(".embed-actions > .embed-action {");
    expect(css).not.toContain(
      ":is(.cm-lang-tasks-bridge-query, .cm-lang-todoist) > .embed-actions .embed-action {",
    );
  });
});

describe("Todoist query task dividers", () => {
  let css: string;
  let stylesheet: HTMLStyleElement;
  const divider = "1px solid rgb(180, 180, 180)";

  beforeAll(() => {
    // jsdom does not resolve CSS variables. Supply native token values while retaining the
    // compiled selectors and declarations so these assertions exercise the actual cascade.
    css = compileStyles("src/ui/query/styles.scss")
      .replace(/var\(--todoist-task-separator-color\)/g, "rgb(180, 180, 180)")
      .replace(/var\(--size-4-1\)/g, "4px")
      .replace(/var\(--size-4-2\)/g, "8px");
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

  const appendList = (parent: HTMLElement): HTMLElement => {
    const list = document.createElement("div");
    list.className = "todoist-tasks-list";
    parent.append(list);
    return list;
  };

  const appendTask = (list: HTMLElement, label: string): HTMLElement => {
    const task = document.createElement("div");
    task.className = "todoist-task-container";
    task.textContent = label;
    list.append(task);
    return task;
  };

  const makeQuery = (hasName: boolean): HTMLElement => {
    const query = document.createElement("div");
    query.className = hasName ? "todoist-query" : "todoist-query is-untitled";
    if (hasName) {
      const header = document.createElement("div");
      header.className = "todoist-query-header has-actions";
      const title = document.createElement("h4");
      title.className = "todoist-query-title";
      title.textContent = "Learning Management";
      header.append(title);
      query.append(header);
    }
    const content = document.createElement("div");
    content.className = "todoist-query-content";
    query.append(content);
    document.body.append(query);
    return appendList(content);
  };

  const expectBorders = (task: HTMLElement, hasDivider: boolean): void => {
    const style = getComputedStyle(task);
    expect(style.borderBlockStart).toBe(hasDivider ? divider : "");
    expect(style.borderBlockEnd).toBe("");
    // Catch the former physical first-row top border and per-row bottom border as well.
    expect(style.borderTopWidth).toBe("");
    expect(style.borderBottomWidth).toBe("");
  };

  it.each([true, false])("places separators only between rows with name=%s", (hasName) => {
    const list = makeQuery(hasName);
    const first = appendTask(list, "First task");
    const middle = appendTask(list, "Middle task");
    const last = appendTask(list, "Last task");

    expectBorders(first, false);
    expectBorders(middle, true);
    expectBorders(last, true);

    // After a completed task's exit animation removes its DOM, the next row becomes first.
    first.remove();
    expectBorders(middle, false);
    expectBorders(last, true);
  });

  it.each([true, false])("leaves a single task open on both edges with name=%s", (hasName) => {
    const list = makeQuery(hasName);
    expectBorders(appendTask(list, "Only task"), false);
  });

  it.each([true, false])("separates peers across nested subtrees with name=%s", (hasName) => {
    const list = makeQuery(hasName);
    const parent = appendTask(list, "Parent task");
    const children = appendList(list);
    const child = appendTask(children, "First child");
    const grandchildren = appendList(children);
    const grandchild = appendTask(grandchildren, "Grandchild");
    const sibling = appendTask(children, "Second child");
    const nextParent = appendTask(list, "Next parent");

    expect(getComputedStyle(children).marginBlockStart).toBe("0");
    expect(getComputedStyle(grandchildren).marginBlockStart).toBe("0");
    expectBorders(parent, false);
    expectBorders(child, false);
    expectBorders(grandchild, false);
    expectBorders(sibling, true);
    expectBorders(nextParent, true);

    parent.remove();
    children.remove();
    expectBorders(nextParent, false);
  });
});
