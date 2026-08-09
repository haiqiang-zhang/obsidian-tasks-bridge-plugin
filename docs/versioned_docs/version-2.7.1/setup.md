---
sidebar_position: 2
---

# Setup

There are a few steps to get up and running with this plugin.

## 1. Install plugin

Until Todoist Sync ++ is available in the Obsidian Community Plugins directory, install it manually from the [latest GitHub release](https://github.com/haiqiang-zhang/obsidian-todoist-plus-plugin/releases/latest):

1. Download `main.js`, `manifest.json`, and `styles.css` from the release.
2. Create `<vault>/.obsidian/plugins/todoist-sync-plus/` in your Vault.
3. Copy the three downloaded files into that directory.
4. Restart Obsidian, open **Settings → Community plugins**, and enable **Todoist Sync ++**.

## 2. Setup API token

Once the plugin is installed, you'll need to enable and do some initial setup.

1. Enable the plugin from Obsidian's setting page
2. You should get a popup asking you to provide your [API token](https://todoist.com/help/articles/find-your-api-token-Jpzx9IIlB).
3. Enter your API token into the prompt. You can type it directly or use the "Paste from clipboard" button for convenience.
4. The prompt will verify that the token provided is valid and will present you with a checkmark if it is
5. Select 'Save' to complete the setup

> By default, your API token is stored securely using Obsidian's built-in secret storage. You can change this to file-based storage in the [plugin configuration](./configuration#token-storage).

## What's next?

Once you've set up the plugin you can explore adding [query blocks](./query-blocks), look at how to [add tasks from Obsidian](./commands/add-task), or explore the [plugin configuration](./configuration).
