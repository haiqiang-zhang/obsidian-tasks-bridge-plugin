import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskDocumentReadyExtension } from "./taskDocumentReadyExtension";

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  const { StateField } = await import("@codemirror/state");
  return {
    ...actual,
    editorInfoField: StateField.define<{ file: { path: string } | null }>({
      create: () => ({ file: { path: "Tasks/First.task.md" } }),
      update(value, transaction) {
        const update = transaction.effects.find(
          (effect) =>
            typeof effect.value?.taskDocumentReadyPath === "string" ||
            effect.value?.taskDocumentReadyPath === null,
        );
        if (update === undefined) {
          return value;
        }
        const path = update.value.taskDocumentReadyPath;
        return { file: path === null ? null : { path } };
      },
    }),
  };
});

const contextEffect = StateEffect.define<{ taskDocumentReadyPath: string | null }>();
const taskPath = "Tasks/First.task.md";
const source = '---\n"task id": task-1\n---\nMy notes';
type EditorOptions = { doc?: string; path?: string | null; context?: boolean };

describe("native task document editor readiness", () => {
  const views = new Set<EditorView>();

  afterEach(() => {
    for (const view of views) {
      view.destroy();
    }
    views.clear();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const makeView = ({ doc = source, path = taskPath, context = true }: EditorOptions = {}) => {
    const onReady = vi.fn();
    const onUpdate = vi.fn();
    const initial = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        ...(context ? [editorInfoField] : []),
        history(),
        createTaskDocumentReadyExtension(onReady),
        EditorView.updateListener.of(onUpdate),
      ],
    });
    const state = initial.update({
      effects: contextEffect.of({ taskDocumentReadyPath: path }),
    }).state;
    const view = new EditorView({ state, parent: document.body });
    views.add(view);
    return { onReady, onUpdate, state, view };
  };

  it("notifies for an initially loaded task without changing text, selection, or history", () => {
    const { onReady, onUpdate, state, view } = makeView();

    expect(onReady).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(view.state).toBe(state);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.anchor).toBe(source.length);
    expect(undoDepth(view.state)).toBe(0);
  });

  it.each([
    "file first",
    "content first",
  ])("waits for initial file context and content arriving separately: %s", (order) => {
    const { onReady, onUpdate, view } = makeView({ path: null, doc: "" });
    const loadFile = () =>
      view.dispatch({ effects: contextEffect.of({ taskDocumentReadyPath: taskPath }) });
    const loadContent = () =>
      view.dispatch({
        changes: { from: 0, insert: source },
        annotations: Transaction.addToHistory.of(false),
      });
    expect(onReady).not.toHaveBeenCalled();

    const steps = order === "file first" ? [loadFile, loadContent] : [loadContent, loadFile];
    steps[0]();
    expect(onReady).not.toHaveBeenCalled();
    steps[1]();

    expect(onReady).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe(source);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("notifies when file context becomes available after text was already loaded", () => {
    const { onReady, view } = makeView({ path: null });
    expect(onReady).not.toHaveBeenCalled();

    view.dispatch({ effects: contextEffect.of({ taskDocumentReadyPath: taskPath }) });

    expect(onReady).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("waits for a missing editor context field to be installed", () => {
    const { onReady, view } = makeView({ context: false });
    expect(onReady).not.toHaveBeenCalled();

    view.dispatch({ effects: StateEffect.appendConfig.of(editorInfoField) });

    expect(onReady).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("observes late file assignment on the shared editor info during a selection-only update", () => {
    const { onReady, view } = makeView({ path: null });
    const info = view.state.field(editorInfoField);
    Object.defineProperty(info, "file", { value: { path: taskPath }, configurable: true });

    view.dispatch({ selection: { anchor: 0 } });

    expect(onReady).toHaveBeenCalledOnce();
    expect(view.state.field(editorInfoField)).toBe(info);
    expect(view.state.doc.toString()).toBe(source);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("notifies once on each task file visit and waits for empty switched files to hydrate", () => {
    const { onReady, view } = makeView();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length },
      effects: contextEffect.of({ taskDocumentReadyPath: "Tasks/Second.task.md" }),
    });
    expect(onReady).toHaveBeenCalledOnce();

    view.dispatch({ changes: { from: 0, insert: source } });
    expect(onReady).toHaveBeenCalledTimes(2);
    view.dispatch({ effects: contextEffect.of({ taskDocumentReadyPath: taskPath }) });
    expect(onReady).toHaveBeenCalledTimes(3);
    view.dispatch({ effects: contextEffect.of({ taskDocumentReadyPath: "Notes/Ordinary.md" }) });
    expect(onReady).toHaveBeenCalledTimes(3);
    view.dispatch({ effects: contextEffect.of({ taskDocumentReadyPath: taskPath }) });
    expect(onReady).toHaveBeenCalledTimes(4);
  });

  it.each([
    "Notes/Ordinary.md",
    "Notes/Example.task.md.bak",
  ])("ignores ordinary documents and their edits: %s", (path) => {
    const { onReady, view } = makeView({ path });
    view.dispatch({ changes: { from: view.state.doc.length, insert: "More notes" } });
    view.dispatch({ selection: { anchor: 0 } });

    expect(onReady).not.toHaveBeenCalled();
  });

  it("does not notify again for edits, selection changes, undo, or deleting and retyping all text", () => {
    const { onReady, onUpdate, view } = makeView();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " added" },
      userEvent: "input.type",
    });
    view.dispatch({ selection: { anchor: 0 } });
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
    view.dispatch({ changes: { from: 0, insert: source } });

    expect(onReady).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledTimes(5);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("leaves no readiness callback pending after an unhydrated editor is destroyed", async () => {
    vi.useFakeTimers();
    const { onReady, view } = makeView({ doc: "" });
    view.destroy();
    views.delete(view);

    await vi.runOnlyPendingTimersAsync();

    expect(onReady).not.toHaveBeenCalled();
  });
});
