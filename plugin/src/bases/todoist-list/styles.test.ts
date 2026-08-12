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
  it("keeps the native-styled task checkbox square and aligned to the title's first line", () => {
    const css = compileStyles();
    const wrapper = ruleBody(css, ".todoist-bases-task-action-wrap");
    const checkbox = ruleBody(
      css,
      ".todoist-bases-task-action-wrap > input.todoist-bases-task-checkbox",
    );

    expect(wrapper).toContain("align-items: flex-start");
    expect(checkbox).toContain("box-sizing: border-box");
    expect(checkbox).toContain("width: var(--checkbox-size)");
    expect(checkbox).toContain("height: var(--checkbox-size)");
    expect(checkbox).toContain("min-width: var(--checkbox-size)");
    expect(checkbox).toContain("min-height: var(--checkbox-size)");
    expect(checkbox).toContain("max-width: var(--checkbox-size)");
    expect(checkbox).toContain("max-height: var(--checkbox-size)");
    expect(checkbox).toContain("aspect-ratio: 1");
    expect(checkbox).toContain("margin: 1px 0 0");
    expect(checkbox).toContain("border-radius: var(--checkbox-radius)");
    expect(checkbox).not.toContain("border-radius: 50%");
    expect(css).not.toContain('content: "\u2713"');
  });
});
