---
sidebar_position: 5
---

# Configuration

There are a number of options that allow you to configure the behaviour of the plugin. These are listed below, but the settings page also gives brief descriptions.

## General

### Token storage

Controls where the plugin stores your Todoist API token. There are two options:

- **Obsidian secrets** - Uses Obsidian's built-in secret storage. This is the recommended option as it keeps your token out of your vault files.
- **File-based** - Stores the token in a file at `.obsidian/todoist-token` inside your vault. If you synchronize your vault, you should consider _not_ syncing this file for security reasons. You may want to use this option if you have issues with Obsidian secrets.

Changing this setting will automatically migrate your token to the new storage location.

## Project sync

Project sync is an independent, one-way Todoist-to-Vault projection. You can configure multiple Todoist-project-to-Vault-folder mappings. Its controls remain available while the mode is disabled, so you can prepare every destination and scope before enabling it. See the [project sync guide](./project-mode) for the folder layout, task properties, and safety behavior.

### Enable project sync

Enables synchronization for every valid project mapping. An enabled configuration can be synchronized manually at any time and participates in periodic synchronization on every device where global **Auto-refresh** is enabled. Tasks Bridge waits for the configured interval instead of writing Project sync notes immediately at startup. Disabling the mode stops synchronization and leaves existing Markdown files in place.

### Project mappings

Select **Add project mapping** to configure one or more independent project trees. Every mapping contains the following three controls.

#### Todoist project

Select the root project to synchronize. Projects are displayed hierarchically with their parent path so projects with the same name remain distinguishable.

#### Vault folder

Select or enter an existing Vault folder. This is the selected Todoist project's **exact root folder**, not a parent destination. Tasks belonging directly to the selected project are written into this folder. The plugin does not add another folder named after the selected project.

If you later change this folder, the plugin migrates the mapping's managed notes from every registered previous root. Open notes are deferred and retried, so an interrupted move does not create a second copy or discard user-authored content.

#### Include child projects

When enabled, all descendants of the selected project are synchronized recursively. Each child project becomes a nested folder below the mapped root folder. When disabled, only the selected project and its own tasks are synchronized. Previously synchronized descendant notes remain in place and become `out_of_scope` rather than being deleted.

#### Mapping validation

Validation messages appear directly in each mapping. All mappings must be valid before a manual or automatic project sync can start. The settings reject:

- an incomplete mapping;
- a Todoist project that is unavailable or selected more than once;
- a Vault folder that does not exist;
- equal or nested Vault folders, including case and Unicode-normalization variants; and
- a separately mapped Todoist project already covered by another mapping with **Include child projects** enabled.

These restrictions ensure that two mappings never own the same Todoist tasks or write inside the same Vault tree.

If a mapping edit makes an enabled configuration invalid, the plugin turns project sync off in the same settings update. It also turns the mode off if live project or folder metadata later makes the configuration invalid.

### Synchronize project now

Runs every project mapping immediately. The button is available only after project sync is enabled, at least one mapping exists, Todoist project metadata is ready, and all mappings pass validation.

Project mode retrieves the full completed-task history available from Todoist's project endpoint. It does not use the progressive **Load earlier** controls from query blocks. Query-block filters, caching, and rendering settings remain independent of these mappings.

### Obsidian Sync coordination

Automatic Project sync runs independently on every configured device. Before an automatic projection begins, Tasks Bridge checks the local Obsidian Sync activity and defers only while incoming changes can modify the Vault, including downloads, merges, and remote deletions being applied locally. After an incoming cycle reaches **Fully synced**, the plugin waits for a brief settle window and then continues the same pending refresh.

Upload-only activity does not delay automatic Project sync. This includes uploads caused by Tasks Bridge's own atomic projection writes, so the plugin does not wait on the Sync work it just created. If incoming work appears after an automatic projection starts, that run is invalidated and retried after the incoming cycle settles.

Manual **Sync now** and the **Sync Todoist projects** command bypass this automatic gate. The gate is local coordination with Obsidian Sync on each device; it does not elect one device, claim cross-device ownership, or provide a distributed lock. Atomic writes, live-file validation, and revision checks remain the final conflict safeguards.

This gate applies only to automatic Project sync writes. It does not pause query-block refreshes, which do not rewrite the Project sync Markdown projection.

Obsidian does not expose a public API for Sync direction. Tasks Bridge isolates and feature-detects the built-in Sync status it uses for this gate. If that internal status is unavailable or incompatible, automatic Project sync remains enabled and relies on the projection safeguards instead of leaving a device permanently blocked.

## Auto-refresh

### Auto-refresh enabled

When enabled, periodic refreshes apply to both synchronization modes:

- query blocks that do not define their own `autorefresh` value; and
- Project sync on every device where **Enable project sync** is also enabled and every mapping is valid.

Manual synchronization through **Sync now** or the **Sync Todoist projects** command remains available when global auto-refresh is disabled.

### Auto-refresh interval

This defines the shared interval, in seconds, for automatic query-block refreshes and Project sync on each configured device. A query block can define an explicit [`autorefresh`](./query-blocks#autorefresh) value, which overrides the shared interval for that block only. Project sync always uses the shared interval.

Query cache entries are stored in Obsidian's vault-specific, device-local storage. They are not written to the synchronized plugin `data.json`, so background query refreshes cannot overwrite settings received from another device. Tasks Bridge also implements Obsidian's external-settings callback so synchronized setting changes take effect without reloading the plugin.

## Rendering

### Task fade animation

When enabled, tasks will fade-in or fade-out when tasks are added or removed respectively. Just some eye candy if you like that.

### Render date icon

When enabled, queries will render an icon accompanying the due date.

### Render project & section icon

When enabled, queries will render an icon accompanying the project & section.

### Render labels icon

When enabled, queries will render an icon accompanying the labels.

## Task creation

### Add parenthesis to page links

When enabled, page links added to tasks created via the [command](./commands/add-task) will be wrapped in parenthesis. This may help identifying links if you primarily use Todoist on mobile platforms.

### Add task button adds page link

When enabled, the embedded add task button in queries will add a link to the page to the task in the specified place. This behaviour can also be disabled completely.

### Default due date

This defines the default due date assigned to tasks created via [commands](./commands/add-task). This can be one of: none, today, or tomorrow.

### Default project

This defines the default project assigned to tasks created via [commands](./commands/add-task). This can be configured to any of your projects, or the Inbox.

If the project referenced here no longer exists, you will get a warning when opening the task creation modal and the Inbox will be used instead.

### Default labels

This defines the default labels assigned to tasks created via [commands](./commands/add-task). You can select zero, one, or multiple labels to be automatically applied to new tasks.

If any of the selected labels no longer exist in Todoist, you will get a warning when opening the task creation modal and they will be skipped.

### Default add task action

This setting controls the default action for the 'Add task' button in the task creation modal. You can choose between:

- **Add task** - Creates the task without copying a link
- **Add task and copy link (app)** - Creates the task and copies a markdown-formatted link using the Todoist app URI
- **Add task and copy link (web)** - Creates the task and copies a markdown-formatted link using the Todoist web URL

This sets the initial button action when opening the modal, but you can change it per-task using the split button dropdown. See the [Add task command documentation](./commands/add-task#copy-markdown-link-after-creating-task) for more details.

## Advanced

### Debug logging

When enabled, the plugin will print extra information to the Developer Tools console. You generally do not need to enable this.
