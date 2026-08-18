import type React from "react";
import { useEffect, useState } from "react";

import { PluginContext } from "@/ui/context";
import { uiText } from "@/uiText";

import { TokenValidation, type TokenValidationResult } from "../../token";
import { TokenValidationIcon } from "../components/token-validation-icon";
import { Setting } from "./SettingItem";

type Props = {
  tester: (token: string) => Promise<boolean>;
};

export const TokenChecker: React.FC<Props> = ({ tester }) => {
  const plugin = PluginContext.use();
  const { token: tokenAccessor, modals } = plugin.services;

  const [tokenState, setTokenState] = useState<TokenValidationResult>({
    kind: "in-progress",
  });
  const [tokenValidationCount, setTokenValidationCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: we are using tokenValidationCount to force a refresh when the modal is closed.
  useEffect(() => {
    setTokenState({ kind: "in-progress" });
    void (async () => {
      const token = await tokenAccessor.read();
      if (token === null) {
        setTokenState({
          kind: "error",
          message: "API token not found",
        });
        return;
      }

      setTokenState(await TokenValidation.validate(token, tester));
    })().catch((error: unknown) => {
      console.error("Failed to read or validate Todoist token", error);
      setTokenState({ kind: "error", message: "Unable to validate API token" });
    });
  }, [plugin, tester, tokenValidationCount]);

  const openModal = () => {
    modals.onboarding({
      onTokenSubmit: async (token) => {
        setTokenValidationCount((old) => old + 1);

        await plugin.updateApiToken(token);
      },
    });
  };

  const buttonLabel = uiText.settings.general.apiToken.buttonLabel;

  return (
    <>
      <TokenValidationIcon status={tokenState} />
      <Setting.ButtonControl
        label={buttonLabel}
        icon="settings"
        onClick={openModal}
        disabled={tokenState.kind === "in-progress"}
      />
    </>
  );
};
