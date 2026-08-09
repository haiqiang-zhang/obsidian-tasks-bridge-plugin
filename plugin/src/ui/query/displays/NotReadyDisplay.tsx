import { t } from "@/i18n";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";

export const NotReadyDisplay: React.FC = () => {
  return (
    <output className="todoist-query-loading" aria-live="polite">
      <ObsidianIcon
        id="loader-circle"
        size="xl"
        className="todoist-query-loading-icon"
        aria-hidden="true"
      />
      <span>{t().query.displays.loading.label}</span>
    </output>
  );
};
