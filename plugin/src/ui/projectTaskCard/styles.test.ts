import * as sass from "sass";
import { describe, expect, it } from "vitest";

import { resolve } from "node:path";

const compileStyles = (): string =>
  sass.compile(resolve(process.cwd(), "src/ui/projectTaskCard/styles.scss")).css;

const ruleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  const bodyEnd = css.indexOf("}", bodyStart);
  return css.slice(bodyStart, bodyEnd);
};

describe("Project task card styles", () => {
  it("uses one shadow-free Obsidian surface instead of a nested floating card", () => {
    const card = ruleBody(compileStyles(), ".tasks-bridge-note-card");

    expect(card).toContain("margin: 0");
    expect(card).toContain("border: 0");
    expect(card).toContain("border-radius: 0");
    expect(card).toContain("background: var(--background-secondary)");
    expect(card).toContain("box-shadow: none");
    expect(card).toContain("font-family: var(--font-interface)");
    expect(card).toContain("flex-direction: column");
    expect(card).not.toContain("padding-inline-end");
    expect(card).not.toContain("var(--shadow-");

    const heading = ruleBody(compileStyles(), ".tasks-bridge-note-card-heading");
    expect(heading).toContain(
      "--tasks-bridge-note-card-actions-width: calc(var(--size-4-18) + var(--size-4-9))",
    );
    expect(heading).toContain("padding-inline-end: var(--tasks-bridge-note-card-actions-width)");

    const host = ruleBody(
      compileStyles(),
      ":is(.cm-lang-tasks-bridge-project-task, .cm-lang-tasks-bridge-task)",
    );
    expect(host).toContain("--embed-block-shadow-hover: none");
  });

  it("uses Obsidian navigation, checkbox, list, and typography variables for subtasks", () => {
    const css = compileStyles();
    const heading = ruleBody(css, ".tasks-bridge-note-card-subtask-heading");
    const expandedHeading = ruleBody(
      css,
      ".tasks-bridge-note-card-subtask-heading[aria-expanded=true]",
    );
    const collapsedHeading = ruleBody(
      css,
      ".tasks-bridge-note-card-subtask-heading[aria-expanded=false]",
    );
    const list = ruleBody(css, ".tasks-bridge-note-card-subtasks");
    const nestedList = ruleBody(
      css,
      '.tasks-bridge-note-card-subtasks[data-depth]:not([data-depth="0"])',
    );
    const rootList = ruleBody(css, '.tasks-bridge-note-card-subtasks[data-depth="0"]');
    const row = ruleBody(css, ".tasks-bridge-note-card-subtask-row");
    const item = ruleBody(
      css,
      ".tasks-bridge-note-card-subtasks > .tasks-bridge-note-card-subtask",
    );
    const disclosure = ruleBody(css, ".tasks-bridge-note-card-subtask-disclosure");
    const completion = ruleBody(css, ".tasks-bridge-note-card-subtask-completion");
    const rootCompletion = ruleBody(css, ".tasks-bridge-note-card-completion");
    const link = ruleBody(css, ".tasks-bridge-note-card-subtask-link");

    expect(heading).toContain("margin-block: var(--size-2-2) var(--size-4-2)");
    expect(heading).toContain("margin-inline: 0");
    expect(heading).toContain("padding: var(--size-2-2) var(--size-4-2)");
    expect(heading).toContain("border: var(--border-width) solid transparent");
    expect(heading).toContain("border-radius: var(--button-radius)");
    expect(heading).toContain("background: transparent");
    expect(heading).toContain("box-shadow: none");
    expect(expandedHeading).toContain("border-color: var(--background-modifier-border-focus)");
    expect(expandedHeading).toContain("background: var(--background-modifier-active-hover)");
    expect(expandedHeading).toContain("box-shadow: none");
    expect(expandedHeading).toContain("color: var(--text-normal)");
    expect(collapsedHeading).toContain("border-color: transparent");
    expect(collapsedHeading).toContain("background: transparent");
    expect(collapsedHeading).toContain("box-shadow: none");
    expect(list).not.toContain("border-block-start");
    expect(css).toContain(".tasks-bridge-note-card .tasks-bridge-note-card-subtasks");
    expect(css).toContain("margin-block: 0");
    expect(rootList).toContain("border: var(--border-width)");
    expect(rootList).toContain("background: var(--background-primary)");
    expect(nestedList).toContain("margin: 0");
    expect(nestedList).toContain("padding-inline-start: var(--nav-item-children-padding-start)");
    expect(row).toContain("border-radius: var(--nav-item-radius)");
    expect(row).toContain("color: var(--nav-item-color)");
    expect(row).toContain("border: 0");
    expect(item).toContain("margin-inline-start: 0");
    expect(item).toContain("padding-block: 0");
    expect(disclosure).toContain("color: var(--nav-collapse-icon-color)");
    expect(disclosure).toContain("border-radius: var(--clickable-icon-radius)");
    expect(disclosure).toContain("box-shadow: none");
    expect(disclosure).not.toMatch(/#[\da-f]{3,8}/i);
    expect(css).not.toContain("data-branch-path");
    expect(css).not.toContain("data-branch");
    expect(completion).toContain("width: var(--checkbox-size)");
    expect(completion).toContain("place-items: center");
    expect(completion).toContain("line-height: 0");
    expect(completion).not.toContain("position: absolute");
    expect(rootCompletion).toContain("place-items: center");
    expect(rootCompletion).toContain("line-height: 0");
    expect(rootCompletion).not.toContain("position: absolute");
    expect(css).not.toContain('[data-loading="true"] input');
    expect(link).toContain("font-family: var(--font-interface)");
    expect(link).toContain("font-size: var(--font-ui-small)");
    expect(link).toContain("font-weight: var(--font-normal)");
    expect(link).not.toContain("background:");
    expect(link).not.toContain("box-shadow:");
    expect(css).not.toContain(".edit-block-button");
  });

  it("places native-sized plugin controls before Obsidian's edit-block control", () => {
    const css = compileStyles();
    const toolbar = ruleBody(css, ".embed-actions > .tasks-bridge-note-card-actions");
    const action = ruleBody(css, ".tasks-bridge-note-card-action");
    const disabledAction = ruleBody(css, ".tasks-bridge-note-card-action:disabled");

    expect(toolbar).toContain("order: -1");
    expect(action).toContain("--icon-size: var(--icon-m)");
    expect(action).toContain("--icon-stroke: var(--icon-m-stroke-width)");
    expect(action).toContain("border-radius: var(--clickable-icon-radius)");
    expect(action).toContain("box-shadow: none");
    expect(action).toContain("color: var(--embed-action-color)");
    expect(action).toContain("opacity: 1");
    expect(disabledAction).toContain("color: var(--embed-action-color)");
    expect(disabledAction).toContain("opacity: 1");
    expect(css).not.toContain(
      ":is(.cm-lang-tasks-bridge-project-task, .cm-lang-tasks-bridge-task) > .embed-actions .embed-action {",
    );
  });
});
