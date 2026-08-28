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
import { ProjectTaskPropertySyncService } from "@/services/projectTaskProperties";
import { VaultTokenAccessor } from "@/services/tokenAccessor";
import { useSettingsStore } from "@/settings";

export type Services = {
  modals: ModalHandler;
  token: VaultTokenAccessor;
  todoist: TodoistAdapter;
  projectSync: ProjectFolderSyncService;
  projectTasks: ProjectTaskCommandService;
  projectTaskProperties: ProjectTaskPropertySyncService;
};

export const makeServices = (plugin: TodoistPlugin): Services => {
  const todoist = new TodoistAdapter({
    onMetadataUpdated: async (data) => {
      await plugin.rebindQueryCacheMetadata(data);
    },
    onTaskClosed: async (taskId, completedAt) => {
      await plugin.completeTaskInAllQueryCaches(taskId, completedAt);
    },
  });
  const settings = useSettingsStore.getState();
  const projectSyncConfig = {
    enabled: settings.projectSyncEnabled,
    preserveUnmanagedItems: settings.projectSyncPreserveUnmanagedItems,
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
      plugin.projectCatalogStorage,
      plugin.projectSyncFolderOwnershipStorage,
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

  const projectTasks = new ProjectTaskCommandService(
    plugin.app.vault,
    plugin.app.fileManager,
    plugin.app.metadataCache,
    todoist,
    projectSync,
    projectTaskProjectionCoordinator,
    plugin.projectCatalogStorage,
  );

  return {
    modals: new ModalHandler(plugin),
    token: new VaultTokenAccessor(plugin.app.vault, plugin.app.secretStorage),
    todoist,
    projectSync,
    projectTasks,
    projectTaskProperties: new ProjectTaskPropertySyncService(projectTasks),
  };
};
