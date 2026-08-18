import * as sass from "sass";
import { describe, expect, it } from "vitest";

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
