import {
  copyLineDown,
  deleteCharBackward,
  deleteCharForward,
  history,
  indentLess,
  indentMore,
  moveLineUp,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorSelection, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { makeTask } from "@/factories/data";

import {
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  makeManagedBody,
  makeManagedTaskIdentityMarker,
  makeProjectTaskBlock,
  renderNewTaskDocument,
} from "./document";
import { taskManagedRegionExtension } from "./taskManagedRegionExtension";

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  const { StateField } = await import("@codemirror/state");
  const { load } = await import("js-yaml");
  return {
    ...actual,
    parseYaml: (yaml: string) => load(yaml),
    editorInfoField: StateField.define({
      create: () => ({ file: { path: "Tasks/Example.task.md" } }),
      update(value, transaction) {
        const update = transaction.effects.find((effect) => typeof effect.value?.path === "string");
        return update === undefined ? value : { file: { path: update.value.path } };
      },
    }),
    editorLivePreviewField: StateField.define({
      create: () => true,
      update(value, transaction) {
        const update = transaction.effects.find(
          (effect) => typeof effect.value?.livePreview === "boolean",
        );
        return update === undefined ? value : update.value.livePreview;
      },
    }),
  };
});

const contextEffect = StateEffect.define<{ path?: string; livePreview?: boolean }>();
const body = makeManagedBody(makeTask("task-1"));
const source = renderNewTaskDocument({ "task id": "task-1" }, `${body}\n\nMy notes`);
const createState = (doc = source, fields = true) =>
  EditorState.create({
    doc,
    extensions: [
      ...(fields ? [editorInfoField, editorLivePreviewField] : []),
      taskManagedRegionExtension,
    ],
  });
const ranges = (state: EditorState) => {
  const values: { from: number; to: number; block: boolean }[] = [];
  state
    .field(taskManagedRegionExtension)
    .decorations.between(0, state.doc.length, (from, to, value) => {
      values.push({ from, to, block: value.spec.block === true });
    });
  return values;
};

const region = (inner: string) => `${MANAGED_BODY_START}\n${inner}\n${MANAGED_BODY_END}`;

describe("taskManagedRegionExtension", () => {
  it.each([
    ["source-only comment", body],
    ["historical card", region(makeProjectTaskBlock("task-1"))],
    ["legacy empty card", region("```tasks-bridge-task\n```")],
  ])("hides only the verified %s region, preserving user comments and explicit cards", (_kind, managed) => {
    const prefix = "<!-- My own comment -->\n\n";
    const suffix = `\n${makeProjectTaskBlock("other-task")}\n<!-- Another comment -->\n`;
    const doc = renderNewTaskDocument({ "task id": "task-1" }, `${prefix}${managed}${suffix}`);
    const state = createState(doc);
    const hidden = ranges(state);
    expect(hidden).toEqual([
      {
        from: doc.indexOf(MANAGED_BODY_START),
        to: doc.indexOf(MANAGED_BODY_END) + MANAGED_BODY_END.length,
        block: true,
      },
    ]);
    expect(doc.slice(0, hidden[0].from)).toContain(prefix);
    expect(doc.slice(hidden[0].to)).toContain(makeProjectTaskBlock("other-task"));
    expect(state.doc.toString()).toBe(doc);
  });

  it("removes decorations in Source mode and restores them when Live Preview returns", () => {
    const live = createState();
    const sourceState = live.update({ effects: contextEffect.of({ livePreview: false }) }).state;
    expect(ranges(live)).toHaveLength(1);
    expect(ranges(sourceState)).toEqual([]);
    expect(sourceState.doc.eq(live.doc)).toBe(true);
    const restored = sourceState.update({ effects: contextEffect.of({ livePreview: true }) }).state;
    expect(ranges(restored)).toEqual(ranges(live));
  });

  it("rechecks the file path on editor context changes", () => {
    const live = createState();
    const ordinary = live.update({ effects: contextEffect.of({ path: "Notes/Example.md" }) }).state;
    expect(ranges(ordinary)).toEqual([]);
    const task = ordinary.update({
      effects: contextEffect.of({ path: "Tasks/Renamed.task.md" }),
    }).state;
    expect(ranges(task)).toHaveLength(1);
  });

  it("leaves ordinary Markdown and missing editor context untouched", () => {
    const state = createState().update({ effects: contextEffect.of({ path: "Example.md" }) }).state;
    expect(ranges(state)).toEqual([]);
    expect(ranges(createState(source, false))).toEqual([]);
  });

  it.each([
    ["wrong marker ID", region(makeManagedTaskIdentityMarker("other-task"))],
    [
      "duplicate marker",
      region(
        `${makeManagedTaskIdentityMarker("task-1")}\n${makeManagedTaskIdentityMarker("task-1")}`,
      ),
    ],
    ["duplicate boundary", `${body}\n${MANAGED_BODY_START}`],
    ["missing boundary", body.replace(MANAGED_BODY_END, "")],
    ["unknown user content", region("<!-- User-authored content -->")],
    ["wrong historical ID", region(makeProjectTaskBlock("other-task"))],
    ["inline region", `User text ${body}`],
    ["trailing user content", `${body} User text`],
    ["copied fenced example", `~~~~md\n${body}\n~~~~`],
    ["copied backtick example", `\`\`\`\`md\n${body}\n\`\`\`\``],
  ])("keeps %s visible", (_kind, managed) => {
    const doc = renderNewTaskDocument({ "task id": "task-1" }, managed);
    expect(ranges(createState(doc))).toEqual([]);
  });

  it.each([
    "task id: [unfinished",
    "task id: task-1\ntodoist_task_id: another-task",
    "unrelated: value",
  ])("keeps invalid or unidentified task source visible: %j", (yaml) => {
    expect(ranges(createState(`---\n${yaml}\n---\n${body}`))).toEqual([]);
  });

  it("preserves edit and inverse-edit transactions and updates the decoration from current text", () => {
    const initial = createState();
    const offset = source.indexOf("My notes");
    const edit = initial.update({
      changes: { from: offset, insert: "New " },
      selection: { anchor: offset + 4 },
    });
    expect(edit.newDoc.toString()).toBe(`${source.slice(0, offset)}New ${source.slice(offset)}`);
    expect(edit.newSelection.main.head).toBe(offset + 4);
    expect(ranges(edit.state)).toEqual(ranges(initial));
    const restored = edit.state.update({ changes: edit.changes.invert(initial.doc) }).state;
    expect(restored.doc.eq(initial.doc)).toBe(true);
    expect(ranges(restored)).toEqual(ranges(initial));
    const badId = initial.update({
      changes: {
        from: source.indexOf('"task-1"'),
        to: source.indexOf('"task-1"') + '"task-1"'.length,
        insert: '"other-task"',
      },
    }).state;
    expect(ranges(badId)).toEqual([]);
  });

  it("renders the native editor without managed lines and restores source without changing the document", () => {
    const view = new EditorView({ state: createState(), parent: document.body });
    try {
      expect(view.contentDOM.textContent).toContain("My notes");
      expect(view.contentDOM.textContent).not.toContain("tasks-bridge:task-id");
      const hidden = ranges(view.state)[0];
      expect(view.moveByChar(EditorSelection.cursor(hidden.from), true).head).toBe(hidden.to);
      view.dispatch({ effects: contextEffect.of({ livePreview: false }) });
      expect(view.contentDOM.textContent).toContain("tasks-bridge:task-id");
      expect(view.state.doc.toString()).toBe(source);
    } finally {
      view.destroy();
    }
  });
});

describe("Live Preview managed-region editing protection", () => {
  const editableSource = renderNewTaskDocument({ "task id": "task-1" }, `${body}\nMy notes`);
  const makeView = (doc = editableSource) =>
    new EditorView({
      state: createState(doc).update({ effects: StateEffect.appendConfig.of(history()) }).state,
      parent: document.body,
    });

  it("keeps the protocol and caret intact when Backspace crosses it from the first body character", () => {
    const view = makeView();
    try {
      const bodyStart = view.state.doc.toString().indexOf("My notes");
      view.dispatch({ selection: { anchor: bodyStart } });
      expect(deleteCharBackward(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(view.state.selection.main.head).toBe(bodyStart);
      expect(undoDepth(view.state)).toBe(0);
      view.dispatch({ ...view.state.replaceSelection("New "), userEvent: "input.type" });
      expect(view.state.doc.toString()).toContain("\nNew My notes");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(redo(view)).toBe(true);
      expect(view.state.doc.toString()).toContain("\nNew My notes");
    } finally {
      view.destroy();
    }
  });

  it("protects forward Delete across the hidden region and retains native undo for body edits", () => {
    const view = makeView();
    try {
      const hidden = ranges(view.state)[0];
      view.dispatch({ selection: { anchor: hidden.from } });
      expect(deleteCharForward(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(undoDepth(view.state)).toBe(0);
      const bodyStart = view.state.doc.toString().indexOf("My notes");
      view.dispatch({ selection: { anchor: bodyStart } });
      expect(deleteCharForward(view)).toBe(true);
      expect(view.state.doc.toString()).toContain("\ny notes");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
    } finally {
      view.destroy();
    }
  });

  it("treats select-all replacement as replacing body text while preserving task metadata", () => {
    const view = makeView();
    try {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.dispatch({
        ...view.state.replaceSelection("Replacement body"),
        userEvent: "input.paste",
      });
      const expected = `${renderNewTaskDocument({ "task id": "task-1" }, body)}Replacement body`;
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.main.head).toBe(expected.length);
      expect(ranges(view.state)).toHaveLength(1);
      expect(undoDepth(view.state)).toBe(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(redo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
    } finally {
      view.destroy();
    }
  });

  it("deletes selected body text across a managed region without deleting the region itself", () => {
    const doc = renderNewTaskDocument({ "task id": "task-1" }, `Before\n${body}\nAfter`);
    const view = makeView(doc);
    try {
      view.dispatch({
        selection: { anchor: doc.indexOf("Before"), head: doc.indexOf("After") + "After".length },
      });
      expect(deleteCharBackward(view)).toBe(true);
      expect(view.state.doc.toString()).toContain(body);
      expect(view.state.doc.toString()).not.toContain("Before");
      expect(view.state.doc.toString()).not.toContain("After");
      expect(ranges(view.state)).toHaveLength(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("routes input inside an invisible marker into the body without changing the marker", () => {
    const view = makeView();
    try {
      view.dispatch({ selection: { anchor: editableSource.indexOf("tasks-bridge:task-id") + 3 } });
      view.dispatch({ ...view.state.replaceSelection("Inserted "), userEvent: "input.type" });
      expect(view.state.doc.toString()).toContain(body);
      expect(view.state.doc.toString()).toContain("\nInserted My notes");
      expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("My notes"));
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
    } finally {
      view.destroy();
    }
  });

  it("indents only visible lines after select-all, with native dedent and undo", () => {
    const view = makeView();
    try {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      expect(indentMore(view)).toBe(true);
      const indented = editableSource.replace("My notes", "  My notes");
      expect(view.state.doc.toString()).toBe(indented);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(redo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(indented);
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      expect(indentLess(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(indented);
    } finally {
      view.destroy();
    }
  });

  it("does not move a body line into hidden protocol, while body-only line moves remain native", () => {
    const doc = renderNewTaskDocument({ "task id": "task-1" }, `${body}\nFirst\nSecond`);
    const view = makeView(doc);
    try {
      view.dispatch({ selection: { anchor: doc.indexOf("First") } });
      expect(moveLineUp(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(undoDepth(view.state)).toBe(0);
      view.dispatch({ selection: { anchor: doc.indexOf("Second") } });
      expect(moveLineUp(view)).toBe(true);
      expect(view.state.doc.toString()).toContain("\nSecond\nFirst");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does not copy hidden protocol as line content, while body-only line copies remain native", () => {
    const view = makeView();
    try {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      expect(copyLineDown(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(undoDepth(view.state)).toBe(0);
      view.dispatch({ selection: { anchor: editableSource.indexOf("My notes") } });
      expect(copyLineDown(view)).toBe(true);
      expect(view.state.doc.toString()).toContain("My notes\nMy notes");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
    } finally {
      view.destroy();
    }
  });

  it("keeps Source-mode delete, select-all replacement, and undo fully native", () => {
    const view = makeView();
    try {
      view.dispatch({ effects: contextEffect.of({ livePreview: false }) });
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.dispatch({ ...view.state.replaceSelection("Just source"), userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe("Just source");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
      expect(redo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("Just source");
    } finally {
      view.destroy();
    }
  });

  it("keeps the next heading line decorated on its own text after collapsing padding", () => {
    const doc = renderNewTaskDocument({ "task id": "task-1" }, `\n${body}\n\n## Heading`);
    const headingStart = doc.indexOf("## Heading");
    const state = createState(doc).update({
      effects: StateEffect.appendConfig.of(
        EditorView.decorations.of(
          Decoration.set([Decoration.line({ class: "native-heading" }).range(headingStart)]),
        ),
      ),
    }).state;
    const view = new EditorView({ state, parent: document.body });
    try {
      expect(view.contentDOM.querySelector(".native-heading")?.textContent).toBe("## Heading");
      expect(view.contentDOM.textContent).not.toContain("tasks-bridge:task-id");
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("inserts the first body text safely when the protocol ends at EOF without a newline", () => {
    const doc = renderNewTaskDocument({ "task id": "task-1" }, body).trimEnd();
    const view = makeView(doc);
    try {
      view.dispatch({ selection: { anchor: doc.length } });
      view.dispatch({ ...view.state.replaceSelection("First note"), userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe(`${doc}\nFirst note`);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
      expect(ranges(view.state)).toHaveLength(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("retains every insertion from multiple cursors when one cursor is inside hidden metadata", () => {
    const view = makeView();
    try {
      view.dispatch({
        effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)),
      });
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(editableSource.indexOf("tasks-bridge:task-id") + 3),
          EditorSelection.cursor(editableSource.indexOf("My notes") + "My notes".length),
        ]),
      });
      view.dispatch({ ...view.state.replaceSelection("X"), userEvent: "input.type" });
      expect(view.state.doc.toString()).toContain("\nXMy notesX");
      expect(view.state.doc.toString()).toContain(body);
      const start = view.state.doc.toString().indexOf("My notes");
      expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
        start,
        start + "My notesX".length,
      ]);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(editableSource);
    } finally {
      view.destroy();
    }
  });

  it("allows programmatic synchronization through without applying the user-edit guard", () => {
    const initial = createState(editableSource);
    const updated = initial.update({
      changes: { from: 0, to: initial.doc.length, insert: "External update" },
    });
    expect(updated.newDoc.toString()).toBe("External update");
    const remote = initial.update({
      changes: { from: 0, to: initial.doc.length, insert: "Remote update" },
      userEvent: "input",
      annotations: Transaction.remote.of(true),
    });
    expect(remote.newDoc.toString()).toBe("Remote update");
  });

  it("collapses leading blank padding only in presentation without deleting source whitespace", () => {
    const padded = renderNewTaskDocument({ "task id": "task-1" }, `\n\n${body}\n\n\nMy notes`);
    const state = createState(padded);
    expect(ranges(state)).toEqual([
      { from: padded.indexOf("\n\n") + 1, to: padded.indexOf("My notes") - 1, block: true },
    ]);
    expect(state.doc.toString()).toBe(padded);
  });
});
