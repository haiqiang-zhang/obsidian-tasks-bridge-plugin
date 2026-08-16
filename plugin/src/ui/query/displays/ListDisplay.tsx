import type React from "react";

import type { Task } from "@/data/task";
import { QueryContext } from "@/ui/context";
import { getTaskTrees } from "@/ui/query/displays/taskTrees";
import { TaskList } from "@/ui/query/task/TaskList";

type Props = {
  tasks: Task[];
};

export const ListDisplay: React.FC<Props> = ({ tasks }) => {
  const query = QueryContext.use();
  const trees = getTaskTrees(tasks, query.sorting);

  return <TaskList trees={trees} />;
};
