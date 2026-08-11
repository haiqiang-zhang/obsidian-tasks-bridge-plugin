import type React from "react";
import { useState } from "react";

import { t } from "@/i18n";
import type { ProjectSyncWriterState } from "@/index";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";

type Props = {
  state: ProjectSyncWriterState;
  onUseThisDevice: () => Promise<void>;
  onStopUsingThisDevice: () => Promise<void>;
};

export const ProjectSyncWriterControl: React.FC<Props> = ({
  state,
  onUseThisDevice,
  onStopUsingThisDevice,
}) => {
  const [busy, setBusy] = useState(false);
  const copy = t().settings.projectSync.automaticWriter;
  const isThisDevice = state === "this-device";
  const { status, buttonLabel } = writerCopy(state, copy);

  const update = async () => {
    setBusy(true);
    try {
      if (isThisDevice) {
        await onStopUsingThisDevice();
      } else {
        await onUseThisDevice();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-sync-writer-control">
      <div className="project-sync-writer-status" data-state={state}>
        <ObsidianIcon id={isThisDevice ? "shield-check" : "shield-alert"} size="s" />
        <span>{status}</span>
      </div>
      <button
        type="button"
        className={isThisDevice ? undefined : "mod-cta"}
        disabled={busy}
        onClick={() => void update()}
      >
        {buttonLabel}
      </button>
    </div>
  );
};

const writerCopy = (
  state: ProjectSyncWriterState,
  copy: ReturnType<typeof t>["settings"]["projectSync"]["automaticWriter"],
): { status: string; buttonLabel: string } => {
  if (state === "this-device") {
    return { status: copy.statusThisDevice, buttonLabel: copy.stopUsingThisDevice };
  }
  if (state === "another-device") {
    return { status: copy.statusAnotherDevice, buttonLabel: copy.takeOver };
  }
  return { status: copy.statusUnassigned, buttonLabel: copy.useThisDevice };
};
