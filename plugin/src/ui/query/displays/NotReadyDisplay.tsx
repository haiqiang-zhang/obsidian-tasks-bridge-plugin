import { ObsidianLoadingIcon } from "@/ui/components/obsidian-icon";
import { uiText } from "@/uiText";

export const NotReadyDisplay: React.FC = () => {
  return (
    <output className="todoist-query-loading" aria-live="polite">
      <ObsidianLoadingIcon size="xl" className="todoist-query-loading-icon" aria-hidden="true" />
      <span>{uiText.query.displays.loading.label}</span>
    </output>
  );
};
