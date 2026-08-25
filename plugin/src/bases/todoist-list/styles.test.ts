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
    const overviewDisclosure = ruleBody(css, "\n.todoist-bases-project-overview-disclosure");

    expect(list).toContain("--todoist-bases-disclosure-size: var(--size-4-6)");
    expect(disclosure).toContain("width: var(--todoist-bases-disclosure-size)");
    expect(disclosure).toContain("min-height: var(--todoist-bases-disclosure-size)");
    expect(overviewDisclosure).toContain("width: var(--todoist-bases-disclosure-size)");
    expect(overviewDisclosure).toContain("height: var(--todoist-bases-disclosure-size)");
    expect(overviewDisclosure).toContain("flex: 0 0 var(--todoist-bases-disclosure-size)");
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("--todoist-bases-disclosure-size: 44px");
    expect(css).toMatch(
      /padding-inline-start:\s*calc\(var\(--todoist-bases-disclosure-size\) \+ var\(--size-4-2\)\)/,
    );
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

  it("aligns the Overview and project tree within one shared content gutter", () => {
    const css = compileStyles();
    const container = ruleBody(css, ".todoist-bases-list-container");
    const list = ruleBody(css, ".todoist-bases-list");
    const content = ruleBody(css, ".todoist-bases-list-content");
    const tree = ruleBody(css, ".todoist-bases-list-tree");
    const leading = ruleBody(css, ".todoist-bases-project-leading");
    const projectIconWithoutDisclosure = ruleBody(
      css,
      ".todoist-bases-project-row:not([data-has-task-content]) .todoist-bases-project-icon",
    );
    const projectIcon = ruleBody(css, "\n.todoist-bases-project-icon");
    const rows = ruleBody(
      css,
      ".todoist-bases-project-row,\n.todoist-bases-section-row,\n.todoist-bases-task-row",
    );
    const rowDividers = ruleBody(
      css,
      ".todoist-bases-project-row::after,\n.todoist-bases-section-row::after,\n.todoist-bases-task-row::after",
    );

    expect(css).not.toContain("scrollbar-gutter");
    expect(container).toContain("container: todoist-bases-list/inline-size");
    expect(list).toContain("--todoist-bases-content-gutter: var(--size-4-4)");
    expect(list).toContain("padding: 0 0 var(--size-4-4)");
    expect(content).toContain("box-sizing: border-box");
    expect(content).toContain("inline-size: 100%");
    expect(content).toContain("padding-inline: var(--todoist-bases-content-gutter)");
    expect(content).not.toContain("padding-left");
    expect(content).not.toContain("padding-right");
    expect(content).toContain("overflow: visible");
    expect(content).toContain("border: 0");
    expect(content).toContain("border-radius: 0");
    expect(content).toContain("background: transparent");
    expect(content).not.toContain("max-inline-size");
    expect(content).not.toContain("margin-inline-start");
    expect(content).not.toContain("margin-inline-end");
    expect(content).not.toContain("box-shadow");
    expect(tree).not.toContain("margin-inline");
    expect(leading).toContain("min-height: var(--todoist-bases-disclosure-size)");
    expect(leading).toContain(
      "padding-inline-start: calc(var(--todoist-bases-depth) * var(--todoist-bases-indent))",
    );
    expect(projectIconWithoutDisclosure).toContain("width: var(--todoist-bases-disclosure-size)");
    expect(projectIconWithoutDisclosure).toContain("height: var(--todoist-bases-disclosure-size)");
    expect(projectIcon).toContain("justify-content: center");
    expect(rows).toContain("position: relative");
    expect(rows).not.toContain("border-block-end");
    expect(rowDividers).toContain('content: ""');
    expect(rowDividers).toContain("position: absolute");
    expect(rowDividers).toContain("inset-block-end: 0");
    expect(rowDividers).toContain("inset-inline: var(--size-4-2)");
    expect(rowDividers).toContain("block-size: var(--bases-table-row-border-width, 1px)");
    expect(rowDividers).toContain(
      "background: var(--bases-table-border-color, var(--background-modifier-border))",
    );
    expect(rowDividers).toContain("pointer-events: none");
    expect(rowDividers).not.toContain("border-radius");
    expect(css).toMatch(
      /@container todoist-bases-list \(max-width: 760px\)[\s\S]*?\.todoist-bases-project-statistics \{[\s\S]*?margin-inline-start: calc\(var\(--todoist-bases-depth\) \* var\(--todoist-bases-indent\) \+ var\(--todoist-bases-project-label-offset\)\)/,
    );
    expect(css).toMatch(
      /@container todoist-bases-list \(max-width: 760px\)[\s\S]*?\.todoist-bases-project-statistics \{[\s\S]*?justify-self: stretch/,
    );
    expect(css).toMatch(
      /@container todoist-bases-list \(max-width: 460px\)[\s\S]*?\.todoist-bases-project-statistics:not\(\[data-empty=true\]\) \{\s*grid-template-columns: minmax\(0, 1fr\) auto/,
    );
    expect(css).toMatch(
      /@container todoist-bases-list \(min-width: 1200px\)[\s\S]*?\.todoist-bases-list-content \{[\s\S]*?grid-template-columns: minmax\(20rem, 24rem\) minmax\(0, 1fr\)/,
    );
    expect(css).not.toContain("@media (max-width");
  });

  it("uses the shared content gutter around a shadowless Overview card", () => {
    const css = compileStyles();
    const content = ruleBody(css, ".todoist-bases-list-content");
    const main = ruleBody(css, ".todoist-bases-list-main");
    const overview = ruleBody(css, ".todoist-bases-project-overview");
    const overviewContent = ruleBody(css, ".todoist-bases-project-overview-content");
    const sharedHeader = ruleBody(
      css,
      ".todoist-bases-project-overview-toggle,\n.todoist-bases-project-overview-header",
    );
    const groups = ruleBody(css, ".todoist-bases-list-groups");
    const toggle = ruleBody(
      css,
      ".todoist-bases-project-overview > .todoist-bases-project-overview-toggle",
    );
    const hoverToggle = ruleBody(
      css,
      ".todoist-bases-project-overview > .todoist-bases-project-overview-toggle:hover",
    );
    const focusToggle = ruleBody(
      css,
      ".todoist-bases-project-overview > .todoist-bases-project-overview-toggle:focus-visible",
    );
    const hoverDisclosure = ruleBody(
      css,
      ".todoist-bases-project-overview > .todoist-bases-project-overview-toggle:hover .todoist-bases-project-overview-disclosure",
    );
    const wideStart = css.indexOf("@container todoist-bases-list (min-width: 1200px)");
    const wideEnd = css.indexOf("@container todoist-bases-list (max-width: 600px)", wideStart);
    expect(wideStart).toBeGreaterThanOrEqual(0);
    expect(wideEnd).toBeGreaterThan(wideStart);
    const wideCss = css.slice(wideStart, wideEnd);
    const wideContent = ruleBody(wideCss, ".todoist-bases-list-content");
    const wideOverview = ruleBody(wideCss, ".todoist-bases-project-overview");
    const wideOverviewContent = ruleBody(wideCss, ".todoist-bases-project-overview-content");
    const wideBody = ruleBody(wideCss, ".todoist-bases-project-overview-body");
    const widePercentage = ruleBody(wideCss, ".todoist-bases-project-overview-percentage");
    const wideMetric = ruleBody(wideCss, ".todoist-bases-project-overview-metric");
    const wideLastMetric = ruleBody(wideCss, ".todoist-bases-project-overview-metric:last-child");
    const wideHeatmap = ruleBody(
      wideCss,
      ".todoist-bases-project-overview .tasks-bridge-completion-heatmap",
    );

    expect(content).toContain("background: transparent");
    expect(content).toContain("overflow: visible");
    expect(content).toContain("border: 0");
    expect(content).toContain("border-radius: 0");
    expect(main).toContain("background: var(--background-primary)");
    expect(overview).toContain("background: var(--background-primary-alt)");
    expect(overview).toContain("margin-inline: 0");
    expect(overview).toContain("margin-block-end: var(--size-4-3)");
    expect(overview).toContain("border: 0");
    expect(overview).toContain("border-radius: var(--radius-l)");
    expect(overview).toContain("box-shadow: none");
    expect(overview).not.toContain("border-bottom");
    expect(main).not.toContain("border-block-start");
    expect(main).not.toContain("border-top");
    expect(overviewContent).toContain("border-top: 1px solid var(--background-modifier-border)");
    expect(overviewContent).toContain("background: transparent");
    expect(groups).toContain("padding-block: var(--size-2-2)");
    expect(sharedHeader).toContain("padding-inline: var(--size-4-2)");
    expect(toggle).toContain("background: inherit");
    expect(hoverToggle).toContain("background: inherit");
    expect(hoverToggle).toContain("box-shadow: none");
    expect(focusToggle).toContain("background: inherit");
    expect(focusToggle).toContain(
      "box-shadow: inset 0 0 0 2px var(--background-modifier-border-focus)",
    );
    expect(hoverDisclosure).toContain("color: var(--text-normal)");
    expect(css).not.toContain(".todoist-bases-project-overview-header:hover");
    expect(css).not.toContain(
      ".todoist-bases-project-overview-header .todoist-bases-project-overview-header-summary",
    );
    expect(wideContent).toContain("align-items: start");
    expect(wideContent).toContain("overflow: visible");
    expect(wideContent).toContain("border: 0");
    expect(wideContent).toContain("border-radius: 0");
    expect(wideContent).toContain("background: transparent");
    expect(wideContent).toContain("grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr)");
    expect(wideContent).toContain("column-gap: var(--size-4-4)");
    expect(wideContent).not.toContain("border-inline-end");
    expect(wideOverview).toContain("align-self: start");
    expect(wideOverview).toContain("margin-inline: 0");
    expect(wideOverview).toContain("margin-block-end: 0");
    expect(wideOverviewContent).toContain("border-block-start: 0");
    expect(wideOverviewContent).toContain("background: transparent");
    expect(wideBody).toContain("padding: 0 var(--size-4-3) var(--size-4-3)");
    expect(widePercentage).toContain("padding: 0");
    expect(widePercentage).toContain("border: 0");
    expect(widePercentage).toContain("border-radius: 0");
    expect(widePercentage).toContain("background: transparent");
    expect(wideMetric).toContain("border: 0");
    expect(wideLastMetric).toContain("grid-column: 1/-1");
    expect(wideHeatmap).toContain("padding: 0");
    expect(wideHeatmap).toContain("border: 0");
    expect(wideHeatmap).toContain("border-radius: 0");
    expect(wideHeatmap).toContain("background: transparent");
    expect(wideHeatmap).toContain("--tasks-bridge-heatmap-surface: var(--background-primary-alt)");
    expect(css).toMatch(
      /@container todoist-bases-list \(min-width: 1200px\)[\s\S]*?\.todoist-bases-project-overview-toggle,\s*\.todoist-bases-project-overview-header \{[\s\S]*?padding: var\(--size-4-3\)/,
    );
  });

  it("lays out project statistics responsively with native progress styling", () => {
    const css = compileStyles();
    const row = ruleBody(css, ".todoist-bases-project-row");
    const statistics = ruleBody(css, ".todoist-bases-project-statistics");
    const progress = ruleBody(css, ".todoist-bases-project-progress");

    expect(row).toContain("grid-template-columns: minmax(0, 1fr) minmax(18rem, 20rem)");
    expect(statistics).toContain("max-width: 20rem");
    expect(statistics).toContain(
      "grid-template-columns: minmax(4.5rem, auto) minmax(5rem, 10rem) minmax(5ch, max-content)",
    );
    const percentage = ruleBody(css, ".todoist-bases-project-statistics-percentage");
    expect(percentage).toContain("white-space: nowrap");
    expect(statistics).not.toContain("font-family");
    expect(progress).toContain("appearance: none");
    expect(progress).toContain("background: var(--background-modifier-border)");
    expect(css).toContain("background: var(--interactive-accent)");
    expect(css).toContain("@container todoist-bases-list (max-width: 760px)");
    expect(css).toContain("@container todoist-bases-list (max-width: 460px)");
    expect(css).toMatch(
      /@container todoist-bases-list \(max-width: 760px\)[\s\S]*?\.todoist-bases-project-statistics \{[\s\S]*?grid-template-columns: minmax\(4\.5rem, auto\) minmax\(5rem, 1fr\) minmax\(5ch, max-content\)/,
    );
    expect(css).toMatch(
      /\.todoist-bases-project-statistics:not\(\[data-empty=true\]\) \.todoist-bases-project-progress \{[\s\S]*?grid-column: 1\/-1;[\s\S]*?grid-row: 2/,
    );
    expect(statistics).not.toContain("box-shadow");
    expect(progress).not.toContain("box-shadow");
  });
});
