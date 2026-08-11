import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSyncWriterControl } from "./ProjectSyncWriterControl";

describe("ProjectSyncWriterControl", () => {
  it("lets an unassigned device explicitly become the automatic writer", async () => {
    const useThisDevice = vi.fn(async () => undefined);
    render(
      <ProjectSyncWriterControl
        state="unassigned"
        onUseThisDevice={useThisDevice}
        onStopUsingThisDevice={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("No automatic writer is assigned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use this device" }));

    await waitFor(() => expect(useThisDevice).toHaveBeenCalledOnce());
  });

  it("requires an explicit takeover when another device owns automatic projection", async () => {
    const useThisDevice = vi.fn(async () => undefined);
    render(
      <ProjectSyncWriterControl
        state="another-device"
        onUseThisDevice={useThisDevice}
        onStopUsingThisDevice={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Another device is the automatic writer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use this device instead" }));

    await waitFor(() => expect(useThisDevice).toHaveBeenCalledOnce());
  });

  it("can release the current writer assignment", async () => {
    const stopUsingThisDevice = vi.fn(async () => undefined);
    render(
      <ProjectSyncWriterControl
        state="this-device"
        onUseThisDevice={vi.fn(async () => undefined)}
        onStopUsingThisDevice={stopUsingThisDevice}
      />,
    );

    expect(screen.getByText("This device is the automatic writer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop using this device" }));

    await waitFor(() => expect(stopUsingThisDevice).toHaveBeenCalledOnce());
  });
});
