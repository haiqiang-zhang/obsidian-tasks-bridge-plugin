import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AutoRefreshIntervalControl } from "./AutoRefreshIntervalControl";

describe("AutoRefreshIntervalControl", () => {
  it("stores a finite whole-second interval", async () => {
    const onChange = vi.fn(async () => undefined);
    render(<AutoRefreshIntervalControl initialValue={60} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Auto-refresh interval" });

    fireEvent.change(input, { target: { value: "45.9" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(45));
    expect(input).toHaveValue(45);
  });

  it.each(["", "-1"])("rejects an unsafe interval of '%s'", async (value) => {
    const onChange = vi.fn(async () => undefined);
    render(<AutoRefreshIntervalControl initialValue={60} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Auto-refresh interval" });

    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);

    await waitFor(() => expect(input).toHaveValue(60));
    expect(onChange).not.toHaveBeenCalled();
  });
});
