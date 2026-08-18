import type React from "react";
import { useState } from "react";

import { PluginContext } from "@/ui/context";
import { uiText } from "@/uiText";

import { Setting } from "./SettingItem";

type Props = {
  disabled: boolean;
};

export const ProjectSyncNowControl: React.FC<Props> = ({ disabled }) => {
  const [isSyncing, setIsSyncing] = useState(false);
  const plugin = PluginContext.use();
  const text = uiText.settings.projectSync.syncNow;

  const synchronize = async () => {
    setIsSyncing(true);
    try {
      await plugin.syncProjectFolderNow();
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Setting.ButtonControl
      disabled={disabled || isSyncing}
      icon="refresh-cw"
      label={isSyncing ? text.syncingLabel : text.buttonLabel}
      onClick={() => void synchronize()}
    />
  );
};
