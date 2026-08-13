import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeLabel } from "@/factories/data";
import type TodoistPlugin from "@/index";
import { PluginContext } from "@/ui/context";

import { LabelsControl } from "./LabelsControl";

describe("LabelsControl", () => {
  it("uses the official dropdown to append only available labels", async () => {
    const focus = makeLabel("focus", { name: "Focus" });
    const later = makeLabel("later", { name: "Later" });
    const onChange = vi.fn(async () => undefined);
    const plugin = {
      services: {
        todoist: {
          data: () => ({ labels: { iterActive: () => [focus, later] } }),
          isReady: () => true,
        },
      },
    } as unknown as TodoistPlugin;

    render(
      <PluginContext.Provider value={plugin}>
        <LabelsControl onChange={onChange} value={[{ labelId: focus.id, labelName: focus.name }]} />
      </PluginContext.Provider>,
    );

    const dropdown = screen.getByRole("combobox");
    expect(screen.queryByRole("option", { name: "Focus" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Later" })).toBeInTheDocument();

    fireEvent.change(dropdown, { target: { value: later.id } });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        { labelId: focus.id, labelName: focus.name },
        { labelId: later.id, labelName: later.name },
      ]),
    );
  });
});
