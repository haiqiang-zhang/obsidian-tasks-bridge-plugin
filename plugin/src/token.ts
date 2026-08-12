import { TodoistApiClient } from "@/api";
import { ObsidianFetcher } from "@/api/fetcher";
import { t } from "@/i18n";

export type TokenValidationResult =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "in-progress" }
  | { kind: "success" };

export type TokenTester = (token: string) => Promise<boolean>;

const validate = async (token: string, tester: TokenTester): Promise<TokenValidationResult> => {
  const i18n = t().tokenValidation;

  if (token.length === 0) {
    return {
      kind: "error",
      message: i18n.emptyTokenError,
    };
  }

  const isValid = await tester(token);

  if (!isValid) {
    return {
      kind: "error",
      message: i18n.invalidTokenError,
    };
  }

  return { kind: "success" };
};

const DefaultTester: TokenTester = async (token: string): Promise<boolean> => {
  const api = new TodoistApiClient(token, new ObsidianFetcher());

  try {
    await api.getUser();
    return true;
  } catch {
    return false;
  }
};

export const TokenValidation = {
  validate,
  DefaultTester,
};
