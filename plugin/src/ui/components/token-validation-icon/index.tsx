import type React from "react";

import type { TokenValidationResult } from "../../../token";
import { ObsidianIcon, ObsidianLoadingIcon } from "../obsidian-icon";
import "./styles.scss";

export const TokenValidationIcon: React.FC<{
  status: TokenValidationResult;
}> = ({ status }) => {
  switch (status.kind) {
    case "none":
      return null;
    case "in-progress":
      return <ObsidianLoadingIcon className="token-validation-in-progress" size="m" />;
    case "error":
      return <ObsidianIcon id="x-circle" className="token-validation-error" size="m" />;
    case "success":
      return <ObsidianIcon id="check-circle-2" className="token-validation-success" size="m" />;
    default:
      return assertUnreachable(status);
  }
};

const assertUnreachable = (value: never): never => {
  throw new Error(`Unknown token validation status: ${JSON.stringify(value)}`);
};
