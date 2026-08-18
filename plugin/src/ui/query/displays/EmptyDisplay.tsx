import type React from "react";

import { Callout } from "@/ui/components/callout";
import { uiText } from "@/uiText";

type Props = {
  message?: string;
};

export const EmptyDisplay: React.FC<Props> = ({ message }) => {
  const text = uiText.query.displays.empty;
  const displayMessage = message ?? text.label;

  return (
    <Callout className="todoist-no-tasks" title={displayMessage} iconId="check" variant="success" />
  );
};
