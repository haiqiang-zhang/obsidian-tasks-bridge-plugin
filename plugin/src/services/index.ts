import { MarkdownView } from "obsidian";

import { TodoistAdapter } from "@/data";
import type TodoistPlugin from "@/index";
import {
  ObsidianProjectSyncStatisticsRepository,
  ObsidianProjectSyncVault,
  ProjectFolderSyncService,
} from "@/project-sync";
import { ModalHandler } from "@/services/modals";
import { TodoistProjectSyncSource } from "@/services/projectSyncSource";
import {
  ProjectTaskCommandService,
  type ProjectTaskProjectionCoordinator,
} from "@/services/projectTaskCommands";
import { VaultTokenAccessor } from "@/services/tokenAccessor";
import { useSettingsStore } from "@/settings";

export type Services = {
  modals: ModalHandler;
  token: VaultTokenAccessor;
  todoist: TodoistAdapter;
  projectSync: ProjectFolderSyncService;
  projectTasks: ProjectTaskCommandService;
};

export const makeServices = (plugin: TodoistPlugin): Services => {
  const todoist = new TodoistAdapter({
    onTaskClosed: async (taskId, completedAt) => {
      await plugin.completeTaskInAllQueryCaches(taskId, completedAt);
    },
  });
  const settings = useSettingsStore.getState();
  const projectSyncConfig = {
    enabled: settings.projectSyncEnabled,
    mappings: settings.projectSyncMappings,
  };
  const runInternalMutation = async <T>(
    affectedPaths: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> => await plugin.runProjectSyncVaultMutation(affectedPaths, operation);
  const projectSync = new ProjectFolderSyncService(
    new TodoistProjectSyncSource(todoist),
    new ObsidianProjectSyncVault(
      plugin.app.vault,
      plugin.app.fileManager,
      () => {
        const paths = new Set<string>();
        plugin.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file !== null) {
            paths.add(leaf.view.file.path);
          }
        });
        return paths;
      },
      runInternalMutation,
    ),
    projectSyncConfig,
    new ObsidianProjectSyncStatisticsRepository(
      plugin.app.vault,
      plugin.app.fileManager,
      projectSyncConfig,
      plugin.projectCatalogStorage,
    ),
  );
  const projectTaskProjectionCoordinator: ProjectTaskProjectionCoordinator = {
    runAutomaticProjection: (operation) => plugin.runAutomaticProjectProjection(operation),
    runInternalMutation,
  };

  return {
    modals: new ModalHandler(plugin),
    token: new VaultTokenAccessor(plugin.app.vault, plugin.app.secretStorage),
    todoist,
    projectSync,
    projectTasks: new ProjectTaskCommandService(
      plugin.app.vault,
      plugin.app.fileManager,
      plugin.app.metadataCache,
      todoist,
      projectSync,
      projectTaskProjectionCoordinator,
    ),
  };
};
