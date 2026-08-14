import type React from "react";

import { t } from "@/i18n";
import { ParsingError } from "@/query/parser";
import { Callout, type Contents } from "@/ui/components/callout";

type Props = {
  error: unknown;
};

export const QueryError: React.FC<Props> = ({ error }) => {
  const i18n = t().query.displays.parsingError;

  return (
    <div className="todoist-query is-untitled is-parse-error">
      <div className="todoist-query-content">
        <Callout
          className="todoist-query-error"
          title={i18n.header}
          iconId="lucide-alert-triangle"
          variant="error"
          contents={getErrorMessages(error) ?? [i18n.unknownErrorMessage]}
        />
      </div>
    </div>
  );
};

const getErrorMessages = (error: unknown): Contents[] | undefined => {
  if (error instanceof ParsingError) {
    return error.messages;
  }

  if (error instanceof Error) {
    return [error.message];
  }

  return;
};
