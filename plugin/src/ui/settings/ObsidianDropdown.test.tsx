import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ObsidianDropdown } from "./ObsidianDropdown";

describe("ObsidianDropdown", () => {
  it("bridges options and accessibility state through Obsidian's dropdown control", () => {
    const onChange = vi.fn();
    const view = render(
      <ObsidianDropdown
        ariaDescribedBy="project-help"
        ariaInvalid
        ariaLabel="Todoist project"
        className="project-control"
        disabled
        id="project-control"
        onChange={onChange}
        options={[
          { label: "Select a project", value: "" },
          { label: "Work", value: "work" },
          { disabled: true, label: "Deleted project", value: "deleted" },
        ]}
        value="work"
      />,
    );

    const dropdown = screen.getByRole("combobox", { name: "Todoist project" });
    expect(dropdown).toHaveClass("dropdown", "project-control");
    expect(dropdown).toHaveAttribute("aria-describedby", "project-help");
    expect(dropdown).toHaveAttribute("aria-invalid", "true");
    expect(dropdown).toHaveAttribute("id", "project-control");
    expect(dropdown).toBeDisabled();
    expect(dropdown).toHaveValue("work");
    expect(screen.getByRole("option", { name: "Deleted project" })).toBeDisabled();

    view.rerender(
      <ObsidianDropdown
        ariaLabel="Todoist project"
        onChange={onChange}
        options={[
          { label: "Select a project", value: "" },
          { label: "Personal", value: "personal" },
        ]}
        value="personal"
      />,
    );

    expect(dropdown).toBeEnabled();
    expect(dropdown).toHaveValue("personal");
    expect(dropdown).not.toHaveClass("project-control");
    expect(dropdown).not.toHaveAttribute("aria-describedby");
    expect(dropdown).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("option", { name: "Work" })).not.toBeInTheDocument();

    fireEvent.change(dropdown, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });
});
