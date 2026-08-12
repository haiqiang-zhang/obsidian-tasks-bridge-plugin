---
sidebar_position: 1
---

# Overview

Tasks Bridge is based on the original [Todoist Sync](https://github.com/jamiebrynes7/obsidian-todoist-plugin) plugin created by [Jamie Brynes](https://github.com/jamiebrynes7).

Tasks Bridge connects Obsidian to external task-management services. Each service remains the task backend and system of record, responsible for primary storage and synchronization. Obsidian is the interaction and presentation layer for viewing, organizing, and updating those tasks.

Todoist is the first supported backend. Its current integration works on desktop and mobile and provides two independent synchronization modes.

## Current Todoist workflows

### Query blocks

[Query blocks](./query-blocks) render the result of a Todoist filter directly inside a note. They are cache-first, support the existing task controls, and can include completed tasks through progressive three-month history windows.

### Project sync

[Project sync](./project-mode) creates one or more one-way Todoist-to-Vault projections designed for [Obsidian Bases](https://help.obsidian.md/bases). Each mapping assigns a Todoist project to an existing Vault folder that acts as that project's exact root. You can optionally reproduce its complete child hierarchy as nested folders. Every active or completed task becomes a Markdown file with flat `todoist_*` properties.

Its custom **Tasks List** Base view rebuilds Project → Section → Task → Subtask hierarchy, lets each view choose any project as its root, and continues to honor native Base filters, sorting, grouping, and property order. A collapsible **Project overview** uses the latest complete Project Sync snapshot to summarize the selected root and all synchronized descendants, including child projects with no tasks. It also includes a GitHub-style daily completion heatmap with recent-range and calendar-year choices. Task rows and toolbar counts remain scoped to the current Base filters. Explicit actions edit, complete, or reopen the Todoist task before Project sync refreshes the Markdown projection.

The two modes keep independent data and workflows, but share the plugin-level **Auto-refresh** toggle and interval. A query block can override the shared interval for that block with its own `autorefresh` value. Every device with Project sync and Auto-refresh enabled can run the periodic projection. Before an automatic Project sync write, Tasks Bridge waits for incoming Obsidian Sync downloads, merges, and remote deletions to finish and briefly settle; an upload-only Sync cycle, including one triggered by the plugin's own writes, does not block the refresh. This gate does not pause query-block refreshes, and manual Project sync bypasses it. Project sync retrieves complete completed-task history through Todoist's project endpoint and does not use query filters or the **Load earlier** workflow. Query blocks do not create task files.

## What Tasks Bridge adds to Todoist Sync

- Cache-first rendering shows previously loaded Todoist blocks immediately while fresh data synchronizes in the background.
- A native-styled loading indicator appears when no cached result is available.
- `completedTasks: true` adds completed tasks from the same filter. The plugin loads the newest three months automatically, follows every cursor with up to 200 tasks per request, and lets users load older history in three-month steps.
- Account-isolated persistent caching includes validation, bounded storage, and stale-request protection.
- Task completion rolls back on API failure and updates matching cached queries consistently.
- Block actions no longer overlap Obsidian's built-in **Edit this block** button.
- Titled and untitled blocks use compact, consistent layouts.
- Same-day due dates are handled correctly across time zones.
- Independent multi-project sync maps separate Todoist project trees into Base-friendly Markdown files with complete active and completed history, including resumable moves when a mapping's Vault folder changes.
- Automatic Project sync runs on every configured device and defers for incoming Obsidian Sync file changes without waiting on local uploads.
- The **Tasks List** Base view adds a native-styled hierarchical workspace with arbitrary project roots, a collapsible complete-project overview, a daily completion heatmap, and controlled server-backed task actions.
- Symlink-safe production builds preserve the plugin's existing `data.json`.
