import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueryWarnings } from "./QueryWarnings";

describe("QueryWarnings", () => {
  it("should return null when warnings array is empty", () => {
    const { container } = render(<QueryWarnings warnings={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("should render callout with warnings when non-empty", () => {
    const warnings = ["Warning 1", "Warning 2"];

    const { container } = render(<QueryWarnings warnings={warnings} />);

    expect(screen.getByText("Warnings")).toBeInTheDocument();
    expect(screen.getByText("Warning 1")).toBeInTheDocument();
    expect(screen.getByText("Warning 2")).toBeInTheDocument();
    expect(
      container.querySelector(".callout.todoist-callout.todoist-query-warnings"),
    ).toHaveAttribute("data-callout", "warning");
    expect(container.querySelector(".todoist-query-warnings .callout-content")).toBeInTheDocument();
    expect(container.querySelector(".todoist-no-tasks")).not.toBeInTheDocument();
  });
});
