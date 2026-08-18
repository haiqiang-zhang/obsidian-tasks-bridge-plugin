import type React from "react";
import { useMemo, useState } from "react";

import type { ProjectDefaultSetting } from "@/settings";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { PluginContext } from "@/ui/context";
import { uiText } from "@/uiText";

import { ObsidianDropdown } from "./ObsidianDropdown";

type Props = {
  value: ProjectDefaultSetting;
  onChange: (val: ProjectDefaultSetting) => Promise<void>;
};

export const ProjectDropdownControl: React.FC<Props> = ({ value, onChange }) => {
  const [selected, setSelected] = useState(value);
  const plugin = PluginContext.use();
  const todoist = plugin.services.todoist;
  const text = uiText.settings.taskCreation.defaultProject;

  const projects = useMemo(() => {
    if (!todoist.isReady()) {
      return [];
    }

    const allProjects = Array.from(todoist.data().projects.iterActive());
    return allProjects
      .filter((project) => !project.inboxProject)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [todoist]);

  const selectedProject =
    selected !== null ? projects.find((p) => p.id === selected.projectId) : null;
  const isProjectDeleted = selected !== null && !selectedProject;

  const handleChange = async (selectedValue: string) => {
    let newValue: ProjectDefaultSetting;
    if (selectedValue === "") {
      newValue = null;
    } else {
      const project = projects.find((p) => p.id === selectedValue);
      if (project === undefined) {
        return;
      }

      newValue = {
        projectId: project.id,
        projectName: project.name,
      };
    }

    setSelected(newValue);
    await onChange(newValue);
  };

  return (
    <div className="project-dropdown-container">
      {isProjectDeleted && (
        <div className="project-dropdown-warning-icon" title={text.deletedWarning}>
          <ObsidianIcon size="s" id="lucide-alert-triangle" />
        </div>
      )}
      <ObsidianDropdown
        value={selected?.projectId ?? ""}
        onChange={handleChange}
        options={[
          { label: text.noDefault, value: "" },
          ...projects.map((project) => ({ label: project.name, value: project.id })),
          ...(isProjectDeleted && selected !== null
            ? [
                {
                  disabled: true,
                  label: `${selected.projectName} (${text.deleted})`,
                  value: selected.projectId,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
};
