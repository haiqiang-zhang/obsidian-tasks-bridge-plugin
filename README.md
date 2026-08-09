# Obsidian Todoist Sync ++

Todoist Sync ++ is based on the original [Todoist Sync](https://github.com/jamiebrynes7/obsidian-todoist-plugin) plugin created by [Jamie Brynes](https://github.com/jamiebrynes7).

## What is it?

**Todoist Sync ++** is an unofficial Obsidian plugin that displays Todoist tasks in Obsidian notes and supports selected updates from Obsidian.

This project is not created by, affiliated with, endorsed by, or supported by Doist.

The [original documentation](https://jamiebrynes7.github.io/obsidian-todoist-plugin/docs/overview) remains the reference for installation, query syntax, and general usage.

## Improvements in Todoist Sync ++

Compared with the upstream Todoist Sync codebase, this fork adds:

- Cache-first rendering: previously loaded Todoist blocks appear immediately while fresh data synchronizes in the background.
- An accessible, Obsidian-styled loading indicator when no cached result is available.
- Account-isolated persistent caching with validation, bounded storage, and stale-request protection.
- Reliable task completion with rollback on API failure and consistent updates across cached queries.
- Block actions that no longer overlap Obsidian's built-in **Edit this block** button.
- Compact, consistent layouts for both titled and untitled Todoist blocks.
- Time-zone-correct same-day due-date handling.
- Symlink-safe production builds that preserve the plugin's existing `data.json`.

## Acknowledgements

Todoist Sync ++ is based on [Todoist Sync](https://github.com/jamiebrynes7/obsidian-todoist-plugin). Thank you to Jamie Brynes and all [upstream contributors](https://github.com/jamiebrynes7/obsidian-todoist-plugin/graphs/contributors) for creating and maintaining the original project.

## Support the original project

If you would like to support Jamie Brynes's work on the original plugin:

<a href="https://www.buymeacoffee.com/jamiebrynes" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Jamie Brynes a coffee" style="height: 60px !important; width: 217px !important;"></a>
