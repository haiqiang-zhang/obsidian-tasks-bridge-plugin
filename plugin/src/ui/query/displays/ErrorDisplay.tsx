import type React from "react";

import { QueryErrorKind } from "@/data";
import { Callout } from "@/ui/components/callout";
import type { UiText } from "@/uiText";
import { uiText } from "@/uiText";

const getErrorMessage = (
  kind: QueryErrorKind,
  text: UiText["query"]["displays"]["error"],
): string => {
  switch (kind) {
    case QueryErrorKind.BadRequest:
      return text.badRequest;
    case QueryErrorKind.Unauthorized:
    case QueryErrorKind.Forbidden:
      return text.unauthorized;
    case QueryErrorKind.ServerError:
      return text.serverError;
    default:
      return text.unknown;
  }
};

type Props = {
  kind: QueryErrorKind;
};

export const ErrorDisplay: React.FC<Props> = ({ kind }) => {
  const text = uiText.query.displays.error;

  const errorMessage = getErrorMessage(kind, text);

  return (
    <Callout
      className="todoist-query-error"
      title={text.header}
      iconId="lucide-alert-triangle"
      variant="error"
      contents={[errorMessage]}
    />
  );
};
