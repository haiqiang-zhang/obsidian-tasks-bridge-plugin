import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParsingError } from "@/query/parser";

import { QueryError } from "./QueryError";

describe("QueryError", () => {
  it("should render ParsingError messages", () => {
    const error = new ParsingError(["Invalid filter", "Missing field"]);

    const { container } = render(<QueryError error={error} />);

    expect(screen.getByText("Error: Query parsing failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid filter")).toBeInTheDocument();
    expect(screen.getByText("Missing field")).toBeInTheDocument();
    const shell = container.querySelector(".todoist-query.is-untitled.is-parse-error");
    expect(shell).toBeInTheDocument();
    expect(
      shell?.querySelector(
        ":scope > .todoist-query-content > .callout.todoist-callout.todoist-query-error",
      ),
    ).toHaveAttribute("data-callout", "error");
    expect(shell?.querySelector(".todoist-query-error .callout-content")).toBeInTheDocument();
    expect(shell?.querySelector(".todoist-no-tasks")).not.toBeInTheDocument();
  });

  it("should render generic Error message", () => {
    const error = new Error("Something went wrong");

    render(<QueryError error={error} />);

    expect(screen.getByText("Error: Query parsing failed")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("should render unknown error fallback for non-Error objects", () => {
    render(<QueryError error="not an error" />);

    expect(screen.getByText("Error: Query parsing failed")).toBeInTheDocument();
    expect(screen.getByText(/Unknown error occurred/)).toBeInTheDocument();
  });
});
