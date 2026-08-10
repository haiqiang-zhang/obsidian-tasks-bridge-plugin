---
sidebar_position: 2
---

# Setup

There are a few steps to get up and running with this plugin.

## 1. Install plugin

Until Tasks Bridge is available in the Obsidian Community Plugins directory, install it manually from the [latest GitHub release](https://github.com/haiqiang-zhang/tasks-bridge/releases/latest):

1. Download `main.js`, `manifest.json`, and `styles.css` from the release.
2. Create `<vault>/.obsidian/plugins/tasks-bridge/` in your Vault.
3. Copy the three downloaded files into that directory.
4. Restart Obsidian, open **Settings → Community plugins**, and enable **Tasks Bridge**.

:::caution Existing Todoist Sync ++ installations

The plugin ID changed from `todoist-sync-plus` to `tasks-bridge`. Disable **Todoist Sync ++**, rename its plugin folder to `tasks-bridge` without deleting `data.json`, replace the three plugin assets, restart Obsidian, and then enable **Tasks Bridge**. Do not keep both plugin folders installed.

Because Obsidian prefixes command IDs with the plugin ID, integrations that refer to a complete command ID must be updated from `todoist-sync-plus:<command>` to `tasks-bridge:<command>`.

:::

## 2. Configure the Todoist backend

Todoist is currently the first supported task backend. After enabling the plugin, connect it with your Todoist API token:

1. Enable the plugin from Obsidian's Settings page.
2. In the prompt, provide your [Todoist API token](https://todoist.com/help/articles/find-your-api-token-Jpzx9IIlB).
3. Enter the token directly or use **Paste from clipboard**.
4. Wait for the checkmark confirming that the token is valid.
5. Select **Save** to complete the setup.

> By default, your API token is stored securely using Obsidian's built-in secret storage. You can change this to file-based storage in the [plugin configuration](./configuration#token-storage).

## What's next?

Once you've set up the plugin you can explore adding [query blocks](./query-blocks), look at how to [add tasks from Obsidian](./commands/add-task), or explore the [plugin configuration](./configuration).
