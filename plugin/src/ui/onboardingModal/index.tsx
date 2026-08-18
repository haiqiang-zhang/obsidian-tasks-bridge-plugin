import { Notice } from "obsidian";
import type React from "react";

import { ModalContext } from "@/ui/context";
import { uiText } from "@/uiText";

import { TokenValidation } from "../../token";
import { TokenInputForm } from "./TokenInputForm";
import "./styles.scss";

type OnTokenSubmitted = (token: string) => Promise<void>;

type OnboardingProps = {
  onTokenSubmit: OnTokenSubmitted;
};

export const OnboardingModal: React.FC<OnboardingProps> = ({ onTokenSubmit }) => {
  const modal = ModalContext.use();
  const text = uiText.onboardingModal;

  const callback = (token: string) => {
    modal.close();
    onTokenSubmit(token).catch((e) => {
      console.error("Failed to save API token", e);
      new Notice(text.failureNoticeMessage);
    });
  };

  return (
    <div className="onboarding-modal-root">
      <p>{text.explainer}</p>
      <p>
        {text.todoistGuideHint.before}
        <a href="https://todoist.com/help/articles/find-your-api-token-Jpzx9IIlB">
          {text.todoistGuideHint.linkText}
        </a>
        {text.todoistGuideHint.after}
      </p>
      <TokenInputForm onTokenSubmit={callback} tester={TokenValidation.DefaultTester} />
    </div>
  );
};
