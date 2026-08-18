---
sidebar_position: 2
---

# Insert blocks

Tasks Bridge provides two commands for inserting its canonical fenced blocks. These commands
appear in the Command palette only while a Markdown editor is active. Tasks Bridge uses Obsidian's
official editor command API, so Obsidian supplies the active editor and its current caret or
selection; the plugin does not infer another insertion target.

## Insert a query block

Run **Tasks Bridge: Insert query block** to insert a `tasks-bridge-query` block at Obsidian's
current caret or selection.

- If text is selected, Tasks Bridge trims each line, joins non-empty lines with spaces, safely
  quotes the result as YAML, and lets Obsidian replace the selection with the complete block.
- If nothing is selected, Tasks Bridge inserts the working `today | overdue` example at the caret.

For example, selecting `today | overdue` and running the command inserts:

````md
```tasks-bridge-query
filter: "today | overdue"
```
````

Without a selection, it inserts the same ready-to-use example:

````md
```tasks-bridge-query
filter: "today | overdue"
```
````

You can then add any of the options described in [Query blocks](../query-blocks).

## Insert a project task block

Run **Tasks Bridge: Insert project task block** to open a searchable picker containing the Project
tasks already synchronized to your Vault. The picker reads the local Project sync projection, so it
opens immediately and remains available offline without requesting Todoist.

Search by task name, project path, or section. If text is selected before you run the
command, that text becomes the picker's initial search. The note is not changed while the picker is
open.

Choosing a task lets Obsidian insert a block containing that task's immutable ID at its current
caret or selection:

````md
```tasks-bridge-project-task
task_id: "6hGr78cXw24jQC7W"
```
````

The block can be inserted into any note; it resolves the corresponding local Project task by
`task_id`. Pressing **Esc** or otherwise closing the picker without choosing a task leaves the note
unchanged.

If no synchronized tasks are available, Tasks Bridge shows a notice instead of opening the picker.
Configure [Project sync](../project-mode), run [Sync](./sync), and try again. If the picker opens but
the current search has no matches, clear or refine the search text.
