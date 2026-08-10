import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";
import { PluginContext } from "@/ui/context";
import { ProjectSyncFolderControl } from "@/ui/settings/ProjectSyncFolderControl";

const plugin = {
  app: {},
} as TodoistPlugin;

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <PluginContext.Provider value={plugin}>{children}</PluginContext.Provider>
);

describe("ProjectSyncFolderControl", () => {
  it("uses Obsidian's native search control and forwards accessibility attributes", () => {
    const onChange = vi.fn(async () => undefined);
    const view = render(
      <ProjectSyncFolderControl
        ariaDescribedBy="folder-hint folder-errors"
        ariaLabel="Vault folder, Project mapping 1"
        folders={["Todoist/Archive", "Todoist/Work"]}
        id="folder-control"
        invalid
        onChange={onChange}
        value="Missing"
      />,
      { wrapper: Wrapper },
    );

    const input = screen.getByLabelText("Vault folder, Project mapping 1");
    expect(view.container.querySelector(".search-input-container")).toBeInTheDocument();
    expect(view.container.querySelector("datalist")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("id", "folder-control");
    expect(input).toHaveAttribute("aria-describedby", "folder-hint folder-errors");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("placeholder", "Choose an existing folder");
    expect(input).toHaveAttribute("type", "search");
    expect(input).toHaveValue("Missing");
  });

  it("filters native suggestions and commits their exact Vault paths", async () => {
    const onChange = vi.fn(async () => undefined);
    render(
      <ProjectSyncFolderControl
        ariaLabel="Vault folder"
        folders={["Todoist/Archive", "Todoist/Work", "Personal"]}
        onChange={onChange}
        value=""
      />,
      { wrapper: Wrapper },
    );

    const input = screen.getByLabelText("Vault folder");
    fireEvent.input(input, { target: { value: "work" } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("work"));
    const suggestion = await screen.findByText("Todoist/Work");
    expect(screen.queryByText("Todoist/Archive")).not.toBeInTheDocument();

    fireEvent.click(suggestion);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("Todoist/Work"));
    expect(input).toHaveValue("Todoist/Work");
    expect(screen.queryByText("Todoist/Work")).not.toBeInTheDocument();
  });

  it("keeps one native input across rerenders and cleans up its popover", async () => {
    const onChange = vi.fn(async () => undefined);
    const view = render(
      <ProjectSyncFolderControl
        ariaLabel="Vault folder, old"
        folders={["Todoist/Old"]}
        invalid
        onChange={onChange}
        value="Todoist/Old"
      />,
      { wrapper: Wrapper },
    );
    const input = screen.getByLabelText("Vault folder, old");

    view.rerender(
      <ProjectSyncFolderControl
        ariaDescribedBy="new-hint"
        ariaLabel="Vault folder, new"
        folders={["Todoist/New"]}
        invalid={false}
        onChange={onChange}
        value="Todoist/New"
      />,
    );

    const updatedInput = screen.getByLabelText("Vault folder, new");
    expect(updatedInput).toBe(input);
    expect(updatedInput).toHaveValue("Todoist/New");
    expect(updatedInput).toHaveAttribute("aria-describedby", "new-hint");
    expect(updatedInput).toHaveAttribute("aria-invalid", "false");

    fireEvent.focus(updatedInput);
    expect(await screen.findByText("Todoist/New")).toBeInTheDocument();
    view.unmount();
    expect(document.querySelector(".suggestion-container")).not.toBeInTheDocument();
  });

  it("uses the native clear button to clear the configured folder", async () => {
    const onChange = vi.fn(async () => undefined);
    render(
      <ProjectSyncFolderControl
        ariaLabel="Vault folder"
        folders={["Todoist/Work"]}
        onChange={onChange}
        value="Todoist/Work"
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
    expect(screen.getByLabelText("Vault folder")).toHaveValue("");
  });
});
