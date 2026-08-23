import * as sass from "sass";
import { describe, expect, it } from "vitest";

import { resolve } from "node:path";

const compileStyles = (): string =>
  sass.compile(resolve(process.cwd(), "src/bases/todoist-list/CompletionHeatmap.scss")).css;

const ruleBody = (css: string, selector: string): string => {
  const normalizedCss = css.replace(/\s+/g, " ");
  const normalizedSelector = selector.replace(/\s+/g, " ");
  const start = normalizedCss.indexOf(`${normalizedSelector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = normalizedCss.indexOf("{", start) + 1;
  const bodyEnd = normalizedCss.indexOf("}", bodyStart);
  return normalizedCss.slice(bodyStart, bodyEnd);
};

describe("Completion heatmap styles", () => {
  it("owns horizontal overflow and responds to the component width", () => {
    const css = compileStyles();
    const heatmap = ruleBody(css, ".tasks-bridge-completion-heatmap");
    const viewport = ruleBody(css, ".tasks-bridge-completion-heatmap-viewport");

    expect(heatmap).toContain("container: tasks-bridge-completion-heatmap/inline-size");
    expect(heatmap).toContain("min-width: 0");
    expect(viewport).toContain("max-width: 100%");
    expect(viewport).toContain("overflow-x: auto");
    expect(viewport).toContain("overscroll-behavior-inline: contain");
    expect(css).toContain("@container tasks-bridge-completion-heatmap (max-width: 30rem)");
    expect(css).toContain("@container tasks-bridge-completion-heatmap (max-width: 22rem)");
  });

  it("neutralizes host Markdown table rules inside the component only", () => {
    const css = compileStyles();
    const grid = ruleBody(
      css,
      ".tasks-bridge-completion-heatmap .tasks-bridge-completion-heatmap-grid",
    );
    const cells = ruleBody(
      css,
      ".tasks-bridge-completion-heatmap .tasks-bridge-completion-heatmap-grid :is(.tasks-bridge-completion-heatmap-corner, .tasks-bridge-completion-heatmap-month, .tasks-bridge-completion-heatmap-weekday, .tasks-bridge-completion-heatmap-day, .tasks-bridge-completion-heatmap-outside)",
    );
    const stickyLabels = ruleBody(
      css,
      ".tasks-bridge-completion-heatmap .tasks-bridge-completion-heatmap-grid :is(.tasks-bridge-completion-heatmap-corner, .tasks-bridge-completion-heatmap-weekday)",
    );
    const days = ruleBody(
      css,
      ".tasks-bridge-completion-heatmap .tasks-bridge-completion-heatmap-grid :is(.tasks-bridge-completion-heatmap-day, .tasks-bridge-completion-heatmap-outside)",
    );

    expect(grid).toContain("display: table");
    expect(grid).toContain("width: max-content");
    expect(grid).toContain("max-width: none");
    expect(grid).toContain("margin: 0");
    expect(grid).toContain("border-collapse: separate");
    expect(grid).toContain("table-layout: fixed");
    expect(cells).toContain("min-width: 0");
    expect(cells).toContain("max-width: none");
    expect(cells).toContain("padding: 0");
    expect(cells).toContain("border: 0");
    expect(cells).toContain("background: transparent");
    expect(cells).toContain("overflow: visible");
    expect(cells).toContain("text-overflow: clip");
    expect(stickyLabels).toContain("background: var(--tasks-bridge-heatmap-surface)");
    expect(days).toContain("width: var(--tasks-bridge-heatmap-hit-size)");
    expect(days).toContain("min-width: var(--tasks-bridge-heatmap-hit-size)");
    expect(css).not.toContain(".markdown-rendered");
    expect(css).not.toContain(".cm-html-embed");
    expect(css).not.toContain("!important");
  });
});
