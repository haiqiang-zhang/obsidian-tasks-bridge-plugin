import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeProject } from "@/factories/data";
import type TodoistPlugin from "@/index";
import { PluginContext } from "@/ui/context";

import { ProjectDropdownControl } from "./ProjectDropdownControl";

describe("ProjectDropdownControl", () => {
  it("preserves a deleted default and writes a newly selected active project", async () => {
    const work = makeProject("work", { name: "Work" });
    const onChange = vi.fn(async () => undefined);
    const plugin = {
      services: {
        todoist: {
          data: () => ({ projects: { iterActive: () => [work] } }),
          isReady: () => true,
        },
      },
    } as unknown as TodoistPlugin;

    render(
      <PluginContext.Provider value={plugin}>
        <ProjectDropdownControl
          onChange={onChange}
          value={{ projectId: "deleted", projectName: "Old project" }}
        />
      </PluginContext.Provider>,
    );

    const dropdown = screen.getByRole("combobox");
    expect(dropdown).toHaveValue("deleted");
    expect(screen.getByRole("option", { name: /Old project/ })).toBeDisabled();

    fireEvent.change(dropdown, { target: { value: "work" } });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ projectId: "work", projectName: "Work" }),
    );
  });
});
