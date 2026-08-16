import type { Task } from "@/data/task";
import { groupBy } from "@/data/transformations/grouping";
import { buildTaskTree, type TaskTree } from "@/data/transformations/relationships";
import { sortTasks } from "@/data/transformations/sorting";
import type { GroupingKey } from "@/query/schema/grouping";
import type { SortingKey } from "@/query/schema/sorting";

export type GroupedTaskTrees = {
  id: string;
  header: string;
  trees: TaskTree[];
};

export const getTaskTrees = (tasks: Task[], sorting: SortingKey[] | undefined): TaskTree[] => {
  const sortedTasks = [...tasks];
  sortTasks(sortedTasks, sorting ?? ["order"]);
  return buildTaskTree(sortedTasks);
};

export const getGroupedTaskTrees = (
  tasks: Task[],
  grouping: GroupingKey,
  sorting: SortingKey[] | undefined,
): GroupedTaskTrees[] => {
  const trees = getTaskTrees(tasks, sorting);
  const treeById = new Map(trees.map((tree) => [tree.id, tree]));

  // Group only the roots. Descendants belong to their root's group even when
  // their own project, section, priority, due date, or labels are different.
  return groupBy(trees, grouping).map(({ id, header, tasks: groupedRoots }) => ({
    id,
    header,
    trees: groupedRoots.map((root) => {
      const tree = treeById.get(root.id);
      if (tree === undefined) {
        throw new Error("Expected grouped task root to exist in task tree");
      }
      return tree;
    }),
  }));
};
