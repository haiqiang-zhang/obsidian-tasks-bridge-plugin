import type React from "react";
import { useState } from "react";

import { t } from "@/i18n";
import { PluginContext } from "@/ui/context";

import { Setting } from "./SettingItem";

type Props = {
  disabled: boolean;
};

export const ProjectSyncNowControl: React.FC<Props> = ({ disabled }) => {
  const [isSyncing, setIsSyncing] = useState(false);
  const plugin = PluginContext.use();
  const i18n = t().settings.projectSync.syncNow;

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
      label={isSyncing ? i18n.syncingLabel : i18n.buttonLabel}
      onClick={synchronize}
    />
  );
};
