import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NotReadyDisplay } from "./NotReadyDisplay";

describe("NotReadyDisplay", () => {
  it("should render an accessible Todoist loading indicator", () => {
    const { container } = render(<NotReadyDisplay />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Todoist tasks");
    expect(container.querySelector(".todoist-query-loading-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
