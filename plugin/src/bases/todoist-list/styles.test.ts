import * as sass from "sass";
import { describe, expect, it } from "vitest";

import { resolve } from "node:path";

const compileStyles = (): string =>
  sass.compile(resolve(process.cwd(), "src/bases/todoist-list/styles.scss")).css;

const ruleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  const bodyEnd = css.indexOf("}", bodyStart);
  return css.slice(bodyStart, bodyEnd);
};

describe("Tasks List styles", () => {
  it("lays out the percentage and heatmap as the only overview modules", () => {
    const css = compileStyles();
    const body = ruleBody(css, ".todoist-bases-project-overview-body");
    const percentage = ruleBody(css, ".todoist-bases-project-overview-percentage");

    expect(body).toContain("display: grid");
    const metrics = ruleBody(css, ".todoist-bases-project-overview-metrics");
    const metric = ruleBody(css, ".todoist-bases-project-overview-metric");

    expect(body).toContain("grid-template-columns: minmax(24rem, 0.75fr) minmax(28rem, 1.25fr)");
    expect(percentage).toContain("border: 1px solid var(--background-modifier-border)");
    expect(percentage).toContain("border-radius: var(--radius-m)");
    expect(percentage).toContain("background: var(--background-primary)");
    expect(percentage).not.toContain("box-shadow");
    expect(percentage).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(metrics).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(metric).toContain("border: 1px solid var(--background-modifier-border)");
    expect(metric).toContain("background: var(--background-secondary)");
    expect(css).not.toContain(".todoist-bases-project-overview-legend");
    expect(css).not.toContain(".todoist-bases-project-overview-breakdown");
  });

  it("gives project disclosures a 44px coarse-pointer target without custom button styling", () => {
    const css = compileStyles();
    const list = ruleBody(css, ".todoist-bases-list");
    const disclosure = ruleBody(css, ".todoist-bases-disclosure");

    expect(list).toContain("--todoist-bases-disclosure-size: var(--size-4-6)");
    expect(disclosure).toContain("width: var(--todoist-bases-disclosure-size)");
    expect(disclosure).toContain("min-height: var(--todoist-bases-disclosure-size)");
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("--todoist-bases-disclosure-size: 44px");
    expect(disclosure).not.toContain("background");
    expect(disclosure).not.toContain("box-shadow");
  });

  it("keeps the checkbox and mutually exclusive loader centered on the title's first line", () => {
    const css = compileStyles();
    const wrapper = ruleBody(css, ".todoist-bases-task-action-wrap");
    const checkbox = ruleBody(
      css,
      ".todoist-bases-task-action-wrap > input.todoist-bases-task-checkbox",
    );

    expect(wrapper).toContain("display: grid");
    expect(wrapper).toContain("height: var(--size-4-6)");
    expect(wrapper).toContain("align-items: center");
    expect(wrapper).toContain("justify-items: center");
    expect(wrapper).toContain("padding-block-start: 1px");
    expect(wrapper).toContain("grid-template-rows: var(--checkbox-size)");
    expect(wrapper).toContain("line-height: 0");
    expect(wrapper).not.toContain("position: relative");
    expect(checkbox).toContain("box-sizing: border-box");
    expect(checkbox).toContain("width: var(--checkbox-size)");
    expect(checkbox).toContain("height: var(--checkbox-size)");
    expect(checkbox).toContain("min-width: var(--checkbox-size)");
    expect(checkbox).toContain("min-height: var(--checkbox-size)");
    expect(checkbox).toContain("max-width: var(--checkbox-size)");
    expect(checkbox).toContain("max-height: var(--checkbox-size)");
    expect(checkbox).toContain("aspect-ratio: 1");
    expect(checkbox).toContain("margin: 0");
    expect(checkbox).toContain("border-radius: var(--checkbox-radius)");
    expect(checkbox).not.toContain("border-radius: 50%");
    expect(css).not.toContain('content: "\u2713"');
    expect(css).not.toContain('[data-loading="true"] .todoist-bases-task-checkbox');
  });

  it("lays out project statistics responsively with native progress styling", () => {
    const css = compileStyles();
    const row = ruleBody(css, ".todoist-bases-project-row");
    const statistics = ruleBody(css, ".todoist-bases-project-statistics");
    const progress = ruleBody(css, ".todoist-bases-project-progress");

    expect(row).toContain("minmax(15rem, 38%)");
    expect(statistics).toContain("grid-template-columns: minmax(9.5rem, auto) minmax(5rem, 1fr)");
    expect(statistics).not.toContain("font-family");
    expect(progress).toContain("appearance: none");
    expect(progress).toContain("background: var(--background-modifier-border)");
    expect(css).toContain("background: var(--interactive-accent)");
    expect(css).toContain("@container todoist-bases-list (max-width: 760px)");
    expect(statistics).not.toContain("box-shadow");
    expect(progress).not.toContain("box-shadow");
  });
});
