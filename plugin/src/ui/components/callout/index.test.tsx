import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Callout, type Contents } from "./index";

describe("Callout", () => {
  it("renders Obsidian's native callout structure", () => {
    const { container } = render(
      <Callout title="Test Title" iconId="info" className="test-class" variant="info" />,
    );

    expect(screen.getByText("Test Title")).toBeInTheDocument();
    const callout = container.querySelector(".callout.todoist-callout.test-class");
    expect(callout).toHaveAttribute("data-callout", "info");
    expect(callout?.querySelector(":scope > .callout-title")).toBeInTheDocument();
    expect(callout?.querySelector(".callout-title > .callout-icon")).toBeInTheDocument();
    expect(callout?.querySelector(".callout-title > .callout-title-inner")).toHaveTextContent(
      "Test Title",
    );
  });

  it.each([
    "info",
    "success",
    "warning",
    "error",
  ] as const)("maps the %s variant to data-callout", (variant) => {
    const { container } = render(
      <Callout title="Title" iconId="info" className="test" variant={variant} />,
    );

    expect(container.querySelector(".todoist-callout")).toHaveAttribute("data-callout", variant);
  });

  it("should render flat string contents as list items", () => {
    const contents: Contents[] = ["Item 1", "Item 2", "Item 3"];

    const { container } = render(
      <Callout title="Title" iconId="info" className="test" contents={contents} variant="info" />,
    );

    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();

    const contentsElement = container.querySelector(".callout-content > .todoist-callout-contents");
    expect(contentsElement).toBeInTheDocument();
    const listItems = contentsElement?.querySelectorAll("li");
    expect(listItems).toHaveLength(3);
  });

  it("should render nested Contents objects with recursive lists", () => {
    const contents: Contents[] = [
      {
        msg: "Parent",
        children: ["Child 1", "Child 2"],
      },
    ];

    render(
      <Callout
        title="Title"
        iconId="info"
        className="test"
        contents={contents}
        variant="warning"
      />,
    );

    expect(screen.getByText("Parent")).toBeInTheDocument();
    expect(screen.getByText("Child 1")).toBeInTheDocument();
    expect(screen.getByText("Child 2")).toBeInTheDocument();

    const nestedList = document.querySelectorAll("ul ul");
    expect(nestedList).toHaveLength(1);
  });

  it("should render with no contents and no list", () => {
    const { container } = render(
      <Callout title="Title" iconId="info" className="test" variant="info" />,
    );

    expect(container.querySelector(".callout-content")).not.toBeInTheDocument();
    expect(container.querySelector(".todoist-callout-contents")).not.toBeInTheDocument();
  });

  it("should apply className to root element", () => {
    const { container } = render(
      <Callout title="Title" iconId="info" className="my-class" variant="error" />,
    );

    expect(container.querySelector(".callout.todoist-callout.my-class")).toBeInTheDocument();
  });
});
