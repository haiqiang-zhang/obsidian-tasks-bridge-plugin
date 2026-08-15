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
│   ├── Prepare quarterly plan/         ← a task with subtasks
│   │   ├── Prepare quarterly plan.md   ← parent task, matching its folder name
│   │   ├── Draft milestones.md         ← direct subtask
│   │   └── Review owners/              ← a subtask with its own children
│   │       ├── Review owners.md
│   │       └── Confirm launch owner.md
│   ├── Prepare quarterly plan (2).md   ← duplicate leaf-task title
│   └── Product launch/                ← child Todoist project
│       └── Publish release notes.md
└── Personal/                          ← a second independent mapping
    └── Renew passport.md
```

Leaf-task filenames use the sanitized Todoist task title. A task with direct subtasks becomes a same-named folder and its own Markdown note is placed inside that folder beside its subtasks. The same rule is applied recursively at every task depth. When sibling tasks would use the same file or folder name, stable numbered names such as `Title (2)` and `Title (3)` keep them distinct. Stable task identity remains in the `todoist_task_id` frontmatter property and is not exposed in the filename.

If Todoist changes a task's title or parent relationship, the existing managed note is moved to its new canonical location with `FileManager.renameFile()`, so Obsidian can update links according to the user's preferences. User-authored frontmatter and body content move with the note. Missing, cyclic, self-referential, or cross-project parent references are not followed into unsafe paths; those tasks remain at their project root.

## Configure project sync

1. Create the destination folders in your Vault if they do not already exist.
2. Open **Settings → Tasks Bridge → Project sync**.
3. Select **Add project mapping**.
4. Choose one **Todoist project**. The selector displays parent paths to distinguish projects with the same name.
5. Choose its existing **Vault folder**. This folder represents the selected project itself, not a parent container.
6. Enable **Include child projects** if you want to reproduce the complete descendant hierarchy below that folder.
7. Add more mappings for any other independent Todoist project trees.
8. Enable **Project sync**.
9. Select **Sync now** to create the initial projections immediately.

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
- a body section between `todoist-sync-plus:managed` HTML comments containing an Obsidian-styled task card.

Text outside the managed body comments is preserved. Frontmatter properties not listed below are also preserved. You can therefore add your own notes, links, tags, and Base-specific properties to a synchronized file.

The task card shows the task, description, ordered project path, section, priority, and labels without exposing synchronization metadata. Its checkbox, edit action, and Todoist link use Obsidian's native interaction patterns.

All user-relevant task data remains visible as native Markdown properties, including the task name, description, completion state, status, ordered project path, section, priority, labels, dates, deadline, duration, and task ID. This is the canonical data surface for Obsidian Bases. Tasks Bridge does not depend on a third-party property-hiding mechanism.

`todoist_task_id` is the only binding identifier stored in a task note. Mapping ownership, project and section IDs, parent relationships, Todoist order, missing-task counters, and completion-event history are synchronization implementation details stored in the plugin's `data.json`. This keeps Markdown useful to people and native Bases while preserving a complete local sync index.

Most synchronized values remain a one-way projection. Changes made to plugin-managed `todoist_*` properties or to the managed body section are replaced with Todoist's values during the next synchronization. The exception is **`todoist_completed`**: changing its checkbox completes or reopens the task in Todoist and immediately refreshes the Markdown projection. If Todoist rejects the request, the checkbox is restored. Other local content is not sent to Todoist.

`todoist_project_path` is an ordered YAML list from the hierarchy root to the task's current project. Tasks Bridge never stores it as a set or alphabetically re-sorts it.

### Properties available to Bases

| Property | Meaning |
| --- | --- |
| `todoist_task_id` | Stable Todoist task ID |
| `todoist_content` | Task name |
| `todoist_description` | Task description |
| `todoist_status` | `active`, `completed`, or `out_of_scope` |
| `todoist_completed` | Whether the task is completed; this user-editable checkbox is synchronized back to Todoist |
| `todoist_project` | Project name |
| `todoist_project_path` | Project hierarchy as a list of names |
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
| `todoist_url` | Web link to the task in Todoist |
| `todoist_synced_at` | Time of the last successful update to this note |

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
3. Add a filter for `todoist_task_id != null`. Add a folder filter for the Project sync mapping, plus any status filters needed for this particular workspace.
4. Open the view menu on the left side of the Base toolbar. Select the chevron beside the view, and change its layout to **Tasks List**.
5. Open **Properties** and choose the task properties to display. Their order in the Properties menu is also their display order in each task row.

You can also start with the [Tasks List Base template](https://haiqiang-zhang.github.io/obsidian-tasks-bridge-plugin/examples/todoist-projects.base). Download it into the Vault, then adjust its filters and properties in Obsidian.

Open **Configure view** in the Bases toolbar to customize Tasks List. Native Obsidian controls keep these settings in two clear groups:

- **Project scope** contains **Root project**.
- **Appearance** contains **Density**, **Show descriptions**, and **Show sections**.

Obsidian stores every choice in that individual view's entry in the `.base` file, so different views of the same Base can keep different scopes and layouts.

:::note Managed Project sync notes only

Tasks List renders only valid notes whose `todoist_task_id` is present in the local Project sync catalog. A normal Markdown note is ignored even if it passes the Base filter. Keep the task ID intact; Project sync maintains the remaining projection properties automatically.

:::

### Choose any project as the root

Open **Configure view** in the Bases toolbar, expand **Project scope**, and set **Root project** to focus the view on one project and all of its descendants. The selected project can be a top-level Todoist project or a child at any depth, so each view can become a workspace for exactly the part of the hierarchy you want to manage. Choose **All synchronized projects** to return to every project available to the view.

Projects with the same name are distinguished by their complete parent path. Tasks Bridge stores the stable Todoist project ID rather than its editable name, and Obsidian persists that value in the view's `.base` configuration.

If a saved root becomes unavailable after a project is removed, a mapping is paused, or the Todoist account changes, Tasks List keeps the saved scope and reports it explicitly. Open **Configure view** and choose another **Root project**; it never silently expands the view to unrelated projects.

The selected root controls both the complete Project overview and the filtered task rows. It cannot add a filtered task row back to the Base result.

### Review the complete Project overview

Expand **Project overview** above the task list to see statistics for the selected root project and every synchronized descendant below it. Choose **All synchronized projects** in **Configure view** to combine every synchronized mapping. The overview includes:

![Tasks List Project overview showing completion statistics, the daily completion heatmap, and the hierarchical project breakdown](./project-overview.png)

- total, active, and completed task counts;
- completion percentage and a status breakdown;
- a GitHub-style heatmap of daily completion activity;
- the number of projects in the selected hierarchy;
- the time of the latest complete Project sync; and
- a nested project breakdown in which each project's counts include all of its descendants.

These statistics come from the complete local Project Sync projection, not from the files currently visible after Base filters are applied. Task Markdown stores the current user-facing state. Tasks Bridge stores each mapping's complete project hierarchy, task relationships, and every completion occurrence—including projects with no tasks—in the plugin's own `data.json`. Project Overview reads that local projection immediately when the Vault opens and rebuilds after local or synchronized file changes. A failed or interrupted Todoist refresh leaves the last complete local projection available.

Select the **Project overview** header to collapse or expand the panel. That choice is saved for the individual Base view. Before the first complete Project sync has created the local catalog, the panel displays a waiting state instead of partial statistics. If Project Sync is not configured, disabled, or the initial sync fails, the panel reports that state directly.

The completion heatmap initially shows the last year. Use its Obsidian range menu to switch among the last 4 weeks, 3 months, 6 months, the last year, or any calendar year from the earliest synchronized completion through the current year. The menu follows Obsidian's **Native menus** preference, and the chosen range is saved for the individual Base view. Month and weekday labels, Obsidian tooltips, a Less-to-More intensity legend, horizontal scrolling on narrow screens, and keyboard navigation follow the familiar GitHub contribution-calendar interaction. Select one day to inspect its count, or select a second day while holding **Shift** to summarize the complete date range between them.

The heatmap counts completion occurrences for the selected root and all of its synchronized descendants. A recurring task completed several times therefore contributes once for each completion event, and a reopened task keeps its earlier completion activity. The completion ring is intentionally different: it summarizes the tasks that are currently completed in the latest snapshot. Choosing **All synchronized projects** combines completion events from every synchronized mapping and deduplicates them by Todoist event ID.

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

Select a task title to open its Markdown note. Task actions always operate on Todoist first, then refresh the Markdown projection:

- **Complete** completes an active task in Todoist.
- **Reopen** reopens a completed task in Todoist.
- **Edit** uses the same native-styled controls as the plugin's task editor for the task name, description, labels, priority, due date and time, duration, and deadline.

The project and section are shown as context in the editor but cannot be moved by this first Tasks List view. Recurring due rules are kept unchanged unless you explicitly replace the due date. A completed task must be reopened before it can be edited. Out-of-scope tasks remain read-only until a later synchronization restores an actionable status; actions are also unavailable while Todoist is not ready.

Do not edit plugin-managed `todoist_*` fields as a substitute for these actions. Project sync remains the authoritative projection and replaces local changes to managed fields during synchronization. If Todoist accepts an action but immediate projection is skipped, deferred, or fails, the remote change is still saved. Do not repeat the remote action; use **Sync Todoist projects** to refresh its note later.

## Synchronization timing

Periodic projection starts on the configured Auto-refresh interval.

Automatic Project sync requires all of the following:

- **Enable project sync** is enabled and every mapping is valid;
- global **Auto-refresh** is enabled; and
- Todoist is ready on that device.

You can start it manually at any time with either:

- **Settings → Tasks Bridge → Project sync → Sync now**; or
- the **Sync Todoist projects** command.

Manual synchronization does not depend on global **Auto-refresh**.

Overlapping requests on one device are combined, so repeatedly starting a sync does not create concurrent local runs. Todoist data is fetched before any mapping is reconciled with the Vault, so a failed or incomplete fetch cannot apply a partial multi-project snapshot.

## Safety and remote deletions

Each mapped Vault folder is an independent projection boundary, but the plugin does not assume ownership of every file inside it. The settings prevent mapped boundaries from being equal, nested, case variants, or Unicode-normalization variants of one another.

- Only notes whose `todoist_task_id` belongs to a configured mapping's local catalog are updated or moved. Unrelated notes are never adopted, including when a managed task transfers between configured mappings.
- An unrelated file at a required path is reported as a conflict and is never overwritten.
- User-authored body text outside the managed comments and non-managed frontmatter properties are retained.
- Managed frontmatter and the managed body are revalidated against the live file and written together with one atomic `Vault.process()` operation. If Obsidian Sync changes the note's task ID or newer Todoist revision between scan and write, the older projection is rejected instead of overwriting it.
- File creation and rename destinations are checked again immediately before the operation. A path that appears during synchronization becomes a reported conflict and is never overwritten.
- A damaged or structurally unreadable likely-managed YAML document fences new file creation for that mapping during the run, preventing an unsafe `Task (2).md` replacement.
- If a live note has `todoist_updated_at` but Todoist returns a revisionless snapshot, semantic changes are blocked. Remote deletion revalidates the live task identity and source revision immediately before the official trash operation, so an older snapshot cannot remove a newer projection.
- A failed or incomplete Todoist fetch is not applied as a successful snapshot.
- A task absent from a complete successful Todoist snapshot is removed from its Project sync folder with Obsidian's official trash operation. Obsidian follows the user's configured trash preference, so the Markdown remains recoverable from the Vault or system trash.
- Remote deletion is applied only after every paginated active-task and completed-task request needed by the selected Project hierarchy succeeds. A failed, interrupted, or incomplete fetch never deletes a local note.
- If the same task appears in another configured Project mapping during the same complete snapshot, its existing Markdown is moved to that mapping instead of being deleted.
- Notes carrying the legacy `stale` status from an earlier Tasks Bridge version are moved to trash the next time a complete snapshot confirms that the Todoist task is absent.
- If **Include child projects** is turned off, previously synchronized descendant tasks are retained and marked `out_of_scope`. They are not deleted. Re-enabling descendants restores their current Todoist state on the next sync.
- If a task moves from one currently configured project mapping to another, its existing managed note is moved to the destination mapping so user-authored content is retained and a duplicate note is not created.
- If you change a mapping's **Vault folder**, the plugin remembers every previous projection root and moves its managed notes into the new root. Interrupted or deferred moves resume on a later sync. Historical roots remain registered so a note delivered late by Obsidian Sync can still be recognized and moved instead of becoming an orphan or duplicate; the mapping's Settings card lists these monitored roots.
- A managed task note that is open in any editor, including a split or pop-out window, is never rewritten in the background. If it needs changes, that note is reported as deferred and retried by a later sync after it has been closed.
- If the managed-body comments were removed, the plugin adds a fresh managed section without discarding the existing body. Duplicated or malformed comments are reported as a conflict, and no body text is replaced.
- Removing a mapping or disabling project sync does not silently delete its previous projection.

Task and project names are converted to portable Vault paths. Unsupported filesystem characters are replaced, long names are shortened safely, and stable IDs disambiguate collisions.

Parent-task folders are created only when every existing item inside the candidate folder belongs to that Todoist task subtree. An unrelated file or project folder is never adopted. If the preferred folder name is already in use, Project sync preserves it and chooses a stable numbered folder for the task hierarchy.

## Source of truth

Todoist remains the source of truth for plugin-managed task data. Tasks List provides explicit remote actions and a controlled editor, but arbitrary changes made directly to a synchronized Markdown file or to managed Base properties are not sent to Todoist. Project moves and general bidirectional file-to-Todoist synchronization require additional conflict rules and are outside this first view.
