import type React from "react";

import { ParsingError } from "@/query/parser";
import { Callout, type Contents } from "@/ui/components/callout";
import { uiText } from "@/uiText";

type Props = {
  error: unknown;
};

export const QueryError: React.FC<Props> = ({ error }) => {
  const text = uiText.query.displays.parsingError;

  return (
    <div className="todoist-query is-untitled is-parse-error">
      <div className="todoist-query-content">
        <Callout
          className="todoist-query-error"
          title={text.header}
          iconId="lucide-alert-triangle"
          variant="error"
          contents={getErrorMessages(error) ?? [text.unknownErrorMessage]}
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
