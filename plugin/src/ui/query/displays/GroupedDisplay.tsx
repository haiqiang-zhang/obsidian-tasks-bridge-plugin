import type React from "react";
import { useState } from "react";

import type { Task } from "@/data/task";
import { ObsidianIcon } from "@/ui/components/obsidian-icon";
import { QueryContext } from "@/ui/context";
import { getGroupedTaskTrees } from "@/ui/query/displays/taskTrees";
import { TaskList } from "@/ui/query/task/TaskList";

type Props = {
  tasks: Task[];
};

export const GroupedDisplay: React.FC<Props> = ({ tasks }) => {
  const query = QueryContext.use();

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // GroupedDisplay should only be rendered when groupBy is defined
  if (!query.groupBy) {
    return null;
  }

  const groups = getGroupedTaskTrees(tasks, query.groupBy, query.sorting);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const newState = { ...prev };
      if (newState[groupId]) {
        delete newState[groupId];
      } else {
        newState[groupId] = true;
      }
      return newState;
    });
  };

  return (
    <>
      {groups.map((group) => {
        const isCollapsed = group.id in collapsedGroups;
        return (
          <div className="todoist-group" key={group.id}>
            {/* biome-ignore lint/a11y/useSemanticElements: Keeping as div to preserve CSS styling */}
            <div
              className={`todoist-group-title ${isCollapsed ? "collapsed" : ""}`}
              onClick={() => toggleGroup(group.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleGroup(group.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span>{group.header}</span>
              <ObsidianIcon
                size="s"
                id={isCollapsed ? "chevron-right" : "chevron-down"}
                className="todoist-group-collapse-icon"
              />
            </div>
            {!isCollapsed && <TaskList trees={group.trees} />}
          </div>
        );
      })}
    </>
  );
};
