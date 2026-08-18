import type React from "react";

import type { QueryWarning } from "@/query/parser";
import { Callout } from "@/ui/components/callout";
import { uiText } from "@/uiText";

type Props = {
  warnings: QueryWarning[];
};

export const QueryWarnings: React.FC<Props> = ({ warnings }) => {
  if (warnings.length === 0) {
    return null;
  }

  const text = uiText.query.warning;

  return (
    <Callout
      className="todoist-query-warnings"
      title={text.header}
      iconId="lucide-alert-triangle"
      variant="warning"
      contents={warnings}
    />
  );
};
