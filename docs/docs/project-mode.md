---
sidebar_position: 4
toc_max_heading_level: 3
---

# Project Sync

Project sync is a second mode that is independent of [query blocks](./query-blocks). It creates one or more one-way, file-based Todoist project projections for use with Markdown tools and [Obsidian Bases](https://help.obsidian.md/bases).

Each mapping connects one Todoist project to one existing Vault folder. That Vault folder is the selected project's **exact root folder**: root-project tasks are written directly into it. The plugin does not create another folder named after the root project. If child projects are included, each child becomes a nested folder, and every task becomes one Markdown file.

```text
Todoist projects/
├── Work/                              ← mapped directly to Todoist “Work”
│   ├── Prepare quarterly plan.md
│   ├── Prepare quarterly plan (2).md   ← duplicate title in the same folder
│   └── Product launch/                ← child Todoist project
│       └── Publish release notes.md
└── Personal/                          ← a second independent mapping
    └── Renew passport.md
```

Task filenames use the sanitized Todoist task title. When tasks in the same folder would have the same filename, one uses `Title.md` and additional tasks use `Title (2).md`, `Title (3).md`, and so on. Stable task identity remains in the `todoist_task_id` frontmatter property and is not exposed in the filename.

## Configure project sync

1. Create the destination folders in your Vault if they do not already exist.
2. Open **Settings → Tasks Bridge → Project sync**.
3. Select **Add project mapping**.
4. Choose one **Todoist project**. The selector displays parent paths to distinguish projects with the same name.
5. Choose its existing **Vault folder**. This folder represents the selected project itself, not a parent container.
6. Enable **Include child projects** if you want to reproduce the complete descendant hierarchy below that folder.
7. Add more mappings for any other independent Todoist project trees.
8. Enable **Project sync**.
9. Under **Automatic Project sync device**, select **Use this device** on exactly one device.
10. Select **Sync now** to create the initial projections immediately.

The settings validate every mapping inline. A mapping is rejected if it is incomplete, refers to a missing Vault folder or unavailable Todoist project, duplicates another Todoist project, overlaps another mapped Vault folder, or selects a project already covered by another mapping's included child hierarchy. Folder overlap checks are case-insensitive and cover equal, parent, and descendant paths.

**Sync now** remains disabled until project sync is globally enabled and every mapping is valid. The configuration controls remain available while project sync is disabled. If an enabled configuration becomes invalid because a mapping, project, or folder changes, project sync turns itself off before another synchronization. Disabling the mode stops automatic updates and does not remove files already created.

## What is synchronized

For every project in every mapping's scope, the plugin retrieves:

- all active tasks;
- all completed tasks available through Todoist's project completed-task endpoint; and
- project, section, parent-task, label, priority, date, duration, and completion metadata.

Completed tasks do not require **Load earlier** in project sync. The plugin follows the project-specific endpoint's pagination to retrieve the complete available history for every mapped project and included descendant.

:::info Query blocks use a different Todoist API

The `completedTasks: true` option in a query block still loads the newest three months first and exposes **Load 6 months**, **Load 9 months**, and later steps. Todoist applies that date-window restriction to completed tasks matched by an arbitrary filter. Project sync uses a project-specific endpoint and therefore does not share that workflow.

:::

## Markdown task files

Each task note has two plugin-managed areas:

- flat `todoist_*` frontmatter properties for Bases; and
- a body section between `todoist-sync-plus:managed` HTML comments containing the current task title, Todoist link, and description.

Text outside the managed body comments is preserved. Frontmatter properties not listed below are also preserved. You can therefore add your own notes, links, tags, and Base-specific properties to a synchronized file.

The synchronized files remain a one-way projection. Changes made to plugin-managed `todoist_*` properties or to the managed body section are replaced with Todoist's values during the next synchronization. Other local content is not sent to Todoist. Use the explicit actions in **Tasks List** when you want to update a task on the server.

### Properties available to Bases

| Property | Meaning |
| --- | --- |
| `todoist_task_id` | Stable Todoist task ID |
| `todoist_content` | Task name |
| `todoist_description` | Task description |
| `todoist_status` | `active`, `completed`, `stale`, or `out_of_scope` |
| `todoist_completed` | Whether the task is completed |
| `todoist_project_id` | Todoist project ID |
| `todoist_project` | Project name |
| `todoist_project_path` | Project hierarchy as a list of names |
| `todoist_project_id_path` | Project hierarchy as a list of stable Todoist project IDs |
| `todoist_parent_task_id` | Parent task ID for a subtask |
| `todoist_section_id` | Section ID |
| `todoist_section` | Section name |
| `todoist_labels` | List of Todoist label names |
| `todoist_priority` | Todoist priority from `P1` to `P4` |
| `todoist_created_at` | Task creation date and time |
| `todoist_updated_at` | Todoist's source revision time when the API provides it |
| `todoist_completed_at` | Completion date and time |
| `todoist_due_date` | Due date |
| `todoist_due_datetime` | Due date and time when the task has a scheduled time |
| `todoist_due_timezone` | Todoist time zone for a scheduled due time |
| `todoist_due_is_recurring` | Whether the due rule is recurring |
| `todoist_deadline` | Task deadline |
| `todoist_duration` | Duration amount |
| `todoist_duration_unit` | Duration unit |
| `todoist_order` | Todoist child order |
| `todoist_url` | Web link to the task in Todoist |
| `todoist_synced_at` | Time of the last successful update to this note |
| `todoist_stale_since` | Time the task was first marked stale |
| `todoist_sync_managed` | Ownership marker used by Tasks Bridge |
| `todoist_sync_mapping_id` | Stable identity of the project mapping that owns the projection |
| `todoist_sync_root_id` | Root project that owns this projection |
| `todoist_sync_missing_count` | Number of complete snapshots in which the task was absent |

Properties that do not apply to a task are omitted rather than written with placeholder values.

## Manage project tasks with Tasks List

**Tasks List** is a custom Obsidian Bases view included with Tasks Bridge. It presents the Markdown notes created by Project sync as a focused project workspace instead of a flat file table. The layout follows the hierarchy stored by Todoist:

```text
Project
├── Section
│   ├── Task
│   │   └── Subtask
│   └── Task
└── Child project
    └── Task
```

Project and section headers, nested task indentation, descriptions, status counts, and compact property badges make a large hierarchy easier to scan. A collapsible **Project overview** summarizes the synchronized hierarchy above the task rows. Its flat, Notion-inspired workspace uses Obsidian's theme variables, so it follows the active theme and remains consistent with native Bases controls.

### Create the view

1. Enable Project sync and complete at least one successful synchronization.
2. Create a new Base in Obsidian, or open an existing `.base` file.
3. Add a filter for `todoist_sync_managed == true`. Add any folder or status filters needed for this particular workspace.
4. Open the view menu on the left side of the Base toolbar. Select the chevron beside the view, and change its layout to **Tasks List**.
5. Open **Properties** and choose the task properties to display. Their order in the Properties menu is also their display order in each task row.

You can also start with the [Tasks List Base template](/examples/todoist-projects.base). Download it into the Vault, then adjust its filters and properties in Obsidian.

The view menu also provides **Density** with **Comfortable** and **Compact** layouts, **Show descriptions**, and **Show sections**. These choices are stored separately for each Base view.

:::note Managed Project sync notes only

Tasks List renders only valid notes created and owned by Project sync. A normal Markdown note is ignored even if it passes the Base filter. Keep the `todoist_sync_managed`, task identity, and project hierarchy properties intact; Project sync maintains them automatically.

:::

### Choose any project as the root

Use **Root** in the Tasks List toolbar to focus the view on one project and all of its descendants. The selected project can be a top-level Todoist project or a child at any depth, so each Base can become a workspace for exactly the part of the hierarchy you want to manage. Choose **All projects** to return to every project available to the view.

Projects with the same name are distinguished by their complete parent path. The selected root is saved in that view's Base configuration.

The selected root controls both the complete Project overview and the filtered task rows. It cannot add a filtered task row back to the Base result.

### Review the complete Project overview

Expand **Project overview** above the task list to see statistics for the selected root project and every synchronized descendant below it. Choose **All projects** to combine every synchronized mapping. The overview includes:

- total, active, and completed task counts;
- completion percentage and a status breakdown;
- a GitHub-style heatmap of daily completion activity;
- the number of projects in the selected hierarchy;
- the time of the latest complete Project sync; and
- a nested project breakdown in which each project's counts include all of its descendants.

These statistics come from the latest complete Project Sync snapshot, not from the files currently visible in the Base. The snapshot retains the complete synchronized project catalog, so child projects remain in the breakdown even when they contain no tasks or all of their task notes are excluded by Base filters. A failed or interrupted refresh does not replace the last complete snapshot.

Select the **Project overview** header to collapse or expand the panel. That choice is saved for the individual Base view. Before the first complete Project sync, the panel displays a waiting state instead of partial statistics. If Project Sync is not configured, disabled, or the initial sync fails, it shows that state directly instead of leaving an indefinite loading indicator.

The completion heatmap initially shows the last year. Use its native range menu to switch among the last 4 weeks, 3 months, 6 months, the last year, or any calendar year from the earliest synchronized completion through the current year. The chosen range is saved for the individual Base view. Month and weekday labels, Obsidian tooltips, a Less-to-More intensity legend, horizontal scrolling on narrow screens, and keyboard navigation follow the familiar GitHub contribution-calendar interaction. Select one day to inspect its count, or select a second day while holding **Shift** to summarize the complete date range between them.

The heatmap counts completion occurrences for the selected root and all of its synchronized descendants. A recurring task completed several times therefore contributes once for each completion event, and a reopened task keeps its earlier completion activity. The completion ring is intentionally different: it summarizes the tasks that are currently completed in the latest snapshot. Choosing **All projects** combines completion events from every synchronized mapping and deduplicates them by Todoist event ID.

:::info Project statistics and Base results use different scopes

The Project overview always describes the complete synchronized subtree for the selected root. Task rows and the active, completed, and unavailable counts in the Tasks List toolbar still respect the current Base filters. The overview totals can therefore be larger than the number of task rows on screen. This is intentional: use the overview to understand the whole synchronized project, and use native Base filters to create the working list you need.

:::

### Combine it with native Base controls

Tasks List is an additional layout for the official Bases query system, not a separate task query engine. Configure the Base with the same native controls used by table, cards, and list views:

- **Filters** decide which managed task notes and toolbar counts appear. They do not reduce the complete Project overview. For example, create separate views for active work, completed work, or a particular mapping folder.
- **Sort** determines the order supplied by Bases. Tasks List preserves that order among projects, sections, and sibling tasks while rebuilding parent-child relationships.
- **Group** remains visible as separate Base groups. Todoist hierarchy is reconstructed independently inside each group.
- **Properties** controls the task metadata shown in each row and the order in which it appears. Identity and hierarchy properties are used internally and are not repeated as badges.

Because filtering happens before the hierarchy is rebuilt, a filtered-out parent task cannot contain its visible subtasks in the result. Such subtasks remain visible at the nearest safe level rather than disappearing.

### Open, complete, reopen, and edit tasks

Select a task title to open its Markdown note. Task actions always operate on Todoist first. If the current device is the selected writer and the Vault is quiet, Tasks Bridge then projects the result immediately. Other devices leave the synchronized Markdown note to the writer's next automatic interval or a later manual sync:

- **Complete** completes an active task in Todoist.
- **Reopen** reopens a completed task in Todoist.
- **Edit** uses the same native-styled controls as the plugin's task editor for the task name, description, labels, priority, due date and time, duration, and deadline.

The project and section are shown as context in the editor but cannot be moved by this first Tasks List view. Recurring due rules are kept unchanged unless you explicitly replace the due date. A completed task must be reopened before it can be edited. Stale and out-of-scope tasks remain read-only until a later synchronization restores an actionable status; actions are also unavailable while Todoist is not ready.

Do not edit plugin-managed `todoist_*` fields as a substitute for these actions. Project sync remains the authoritative projection writer and replaces local changes to managed fields during synchronization. If Todoist accepts an action but immediate projection is skipped, deferred, or fails, the remote change is still saved. Do not repeat the remote action; use **Sync Todoist projects** to refresh its note later.

## Synchronization timing

Tasks Bridge never writes Project sync Markdown files immediately at startup. Obsidian does not expose a public API that reports when Obsidian Sync has completely finished downloading a Vault, so startup projection could otherwise race a remote copy of the same note.

Automatic Project sync requires all of the following:

- **Enable project sync** is enabled and every mapping is valid;
- global **Auto-refresh** is enabled;
- exactly one device is selected under **Automatic Project sync device**; and
- the mapped folders have been quiet for at least 30 seconds after startup, a mapping or writer change, or a relevant Vault create, modify, rename, or delete event.

Each device generates its identity in vault-specific local storage, and the selected writer ID is copied into plugin settings. The assignment reaches other devices only when Obsidian Sync's **Vault configuration sync** includes the community plugin and therefore synchronizes the plugin `data.json`; enable **Active community plugin list** and **Installed community plugin list** on every device. Otherwise, you must manually ensure that exactly one device is selected. A device never claims ownership automatically. If you select **Use this device instead**, the new device waits for the quiet period, and updated devices stop automatic projection as soon as they receive the setting through Obsidian Sync. This is a conservative single-writer protocol, not a network lock: an offline old writer cannot see the transfer until it reconnects. Update or disable older Tasks Bridge versions on every synced device before assigning a writer.

If a relevant Vault event arrives after an automatic run has started, Tasks Bridge invalidates that run and waits for another complete 30-second quiet period. Exact path scopes distinguish the plugin's own atomic mutations from unrelated user or Obsidian Sync activity, so a run neither cancels itself nor ignores changes elsewhere in a mapped tree.

You can start it manually at any time with either:

- **Settings → Tasks Bridge → Project sync → Sync now**; or
- the **Sync Todoist projects** command.

Manual synchronization does not depend on global **Auto-refresh** or the automatic writer assignment. Wait for Obsidian Sync to finish before using it, and do not run it on multiple devices at the same time.

Overlapping requests are combined, so repeatedly starting a sync does not create concurrent writers. Todoist data is fetched before any mapping is reconciled with the Vault, so a failed or incomplete fetch cannot apply a partial multi-project snapshot.

## Safety and stale tasks

Each mapped Vault folder is an independent projection boundary, but the plugin does not assume ownership of every file inside it. The settings prevent mapped boundaries from being equal, nested, case variants, or Unicode-normalization variants of one another.

- Only notes carrying the plugin's ownership properties are updated or moved. Unrelated notes are never adopted, including when a managed task transfers between configured mappings.
- An unrelated file at a required path is reported as a conflict and is never overwritten.
- User-authored body text outside the managed comments and non-managed frontmatter properties are retained.
- Managed frontmatter and the managed body are revalidated against the live file and written together with one atomic `Vault.process()` operation. If Obsidian Sync changes the note's task, mapping, root, project, or newer Todoist revision between scan and write, the older projection is rejected instead of overwriting it.
- File creation and rename destinations are checked again immediately before the operation. A path that appears during synchronization becomes a reported conflict and is never overwritten.
- A damaged or structurally unreadable likely-managed YAML document fences new file creation for that mapping during the run, preventing an unsafe `Task (2).md` replacement.
- If a live note has `todoist_updated_at` but Todoist returns a revisionless snapshot, semantic changes are blocked. Missing-task bookkeeping also compares the live source and sync revisions inside the atomic write, so an older empty snapshot cannot mark a newer note as missing.
- A failed or incomplete Todoist fetch is not applied as a successful snapshot.
- A task missing from one complete successful snapshot is retained with `todoist_sync_missing_count: 1`. If it is absent from the next complete snapshot as well, its status becomes `stale` and `todoist_stale_since` is recorded. Stale notes are never automatically trashed or deleted.
- If a stale task reappears, its current Todoist data is restored, the missing count returns to zero, and `todoist_stale_since` is removed.
- If **Include child projects** is turned off, previously synchronized descendant tasks are retained and marked `out_of_scope`. They are not deleted. Re-enabling descendants restores their current Todoist state on the next sync.
- If a task moves from one currently configured project mapping to another, its existing managed note is moved to the destination mapping so user-authored content is retained and a duplicate note is not created.
- If you change a mapping's **Vault folder**, the plugin remembers every previous projection root and moves its managed notes into the new root. Interrupted or deferred moves resume on a later sync. Historical roots remain registered so a note delivered late by Obsidian Sync can still be recognized and moved instead of becoming an orphan or duplicate; the mapping's Settings card lists these monitored roots.
- A managed task note that is open in any editor, including a split or pop-out window, is never rewritten in the background. If it needs changes, that note is reported as deferred and retried by a later sync after it has been closed.
- If the managed-body comments were removed, the plugin adds a fresh managed section without discarding the existing body. Duplicated or malformed comments are reported as a conflict, and no body text is replaced.
- Removing a mapping or disabling project sync does not silently delete its previous projection.

Task and project names are converted to portable Vault paths. Unsupported filesystem characters are replaced, long names are shortened safely, and stable IDs disambiguate collisions.

## Source of truth

Todoist remains the source of truth for plugin-managed task data. Tasks List provides explicit remote actions and a controlled editor, but arbitrary changes made directly to a synchronized Markdown file or to managed Base properties are not sent to Todoist. Project moves and general bidirectional file-to-Todoist synchronization require additional conflict rules and are outside this first view.
