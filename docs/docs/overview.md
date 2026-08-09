---
sidebar_position: 1
---

# Overview

![Obsidian Todoist Sync ++ banner](/img/obsidian-todoist-sync-plus-banner.svg)

Todoist Sync ++ is based on the original [Todoist Sync](https://github.com/jamiebrynes7/obsidian-todoist-plugin) plugin created by [Jamie Brynes](https://github.com/jamiebrynes7).

Todoist Sync ++ is an _**unofficial**_ plugin for synchronizing Todoist tasks with Obsidian. It works on desktop and mobile, displays Todoist tasks in notes, and supports selected task updates from Obsidian.

## Improvements in Todoist Sync ++

- Cache-first rendering shows previously loaded Todoist blocks immediately while fresh data synchronizes in the background.
- A native-styled loading indicator appears when no cached result is available.
- `completedTasks: true` adds completed tasks from the same filter. The plugin loads the newest three months automatically, follows every cursor with up to 200 tasks per request, and lets users load older history in three-month steps.
- Account-isolated persistent caching includes validation, bounded storage, and stale-request protection.
- Task completion rolls back on API failure and updates matching cached queries consistently.
- Block actions no longer overlap Obsidian's built-in **Edit this block** button.
- Titled and untitled blocks use compact, consistent layouts.
- Same-day due dates are handled correctly across time zones.
- Symlink-safe production builds preserve the plugin's existing `data.json`.
