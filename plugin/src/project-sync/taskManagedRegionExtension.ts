import {
  type ChangeSpec,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, getFrontMatterInfo, parseYaml } from "obsidian";

import {
  hasManagedTaskBody,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  readManagedNoteIdentity,
} from "./document";

type ManagedRegion = {
  from: number;
  to: number;
  frontmatterEnd: number;
  presentationFrom: number;
  presentationTo: number;
  bodyStart: number;
};

type ManagedRegionState = {
  path: string | undefined;
  livePreview: boolean;
  region?: ManagedRegion;
  decorations: DecorationSet;
};

// A copied protocol example inside a user-authored fence must remain ordinary source text.
const isInsideCodeFence = (prefix: string): boolean => {
  let fence: { character: string; length: number } | undefined;
  for (const line of prefix.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (match === null) {
      continue;
    }
    if (fence !== undefined) {
      if (
        match[1][0] === fence.character &&
        match[1].length >= fence.length &&
        match[2].trim() === ""
      ) {
        fence = undefined;
      }
    } else if (match[1][0] !== "`" || !match[2].includes("`")) {
      fence = { character: match[1][0], length: match[1].length };
    }
  }
  return fence !== undefined;
};

const readManagedRegion = (
  state: EditorState,
  path: string | undefined,
  livePreview: boolean,
): ManagedRegion | undefined => {
  if (!livePreview || path?.endsWith(".task.md") !== true) {
    return undefined;
  }
  const content = state.doc.toString();
  const info = getFrontMatterInfo(content);
  if (!info.exists) {
    return undefined;
  }
  try {
    const frontmatter: unknown = parseYaml(info.frontmatter);
    if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
      return undefined;
    }
    const identity = readManagedNoteIdentity(frontmatter as Record<string, unknown>);
    if (identity === null || !hasManagedTaskBody(content, info.contentStart, identity.taskId)) {
      return undefined;
    }
    const from = content.indexOf(MANAGED_BODY_START);
    const endMarker = content.indexOf(MANAGED_BODY_END);
    const firstLine = state.doc.lineAt(from);
    const lastLine = state.doc.lineAt(endMarker);
    if (
      firstLine.from !== from ||
      firstLine.text !== MANAGED_BODY_START ||
      lastLine.from !== endMarker ||
      lastLine.text !== MANAGED_BODY_END ||
      isInsideCodeFence(content.slice(info.contentStart, from))
    ) {
      return undefined;
    }
    const to = lastLine.to < state.doc.length ? lastLine.to + 1 : lastLine.to;
    const startsBody = content.slice(info.contentStart, from).trim() === "";
    const followingBlankLines = startsBody
      ? (content.slice(to).match(/^(?:[\t ]*\n)*/u)?.[0].length ?? 0)
      : 0;
    const bodyStart = to + followingBlankLines;
    return {
      from,
      to,
      frontmatterEnd: info.contentStart,
      presentationFrom: startsBody ? info.contentStart : from,
      // Preserve the final line break so native line decorations still belong to the body line.
      presentationTo: bodyStart > lastLine.to ? bodyStart - 1 : bodyStart,
      bodyStart,
    };
  } catch {
    // Invalid or conflicting YAML stays visible so the user can inspect it in the native editor.
    return undefined;
  }
};

const readContext = (state: EditorState) => ({
  path: state.field(editorInfoField, false)?.file?.path,
  livePreview: state.field(editorLivePreviewField, false) === true,
});

const makeState = (state: EditorState): ManagedRegionState => {
  const context = readContext(state);
  const region = readManagedRegion(state, context.path, context.livePreview);
  return {
    ...context,
    region,
    decorations:
      region === undefined
        ? Decoration.none
        : Decoration.set([
            Decoration.replace({ block: true, inclusiveStart: true, inclusiveEnd: false }).range(
              region.presentationFrom,
              region.presentationTo,
            ),
          ]),
  };
};

/**
 * Protect only hidden task metadata from user editing in Live Preview. Changes outside it and
 * programmatic synchronization remain native transactions, as do all Source-mode edits.
 */
const protectManagedRegion = (transaction: Transaction, region: ManagedRegion | undefined) => {
  if (
    region === undefined ||
    !transaction.docChanged ||
    transaction.annotation(Transaction.remote) === true ||
    !(
      transaction.isUserEvent("input") ||
      transaction.isUserEvent("delete") ||
      transaction.isUserEvent("move") ||
      transaction.isUserEvent("indent")
    )
  ) {
    return transaction;
  }
  // Keep the newline before a non-leading protocol region so it cannot be joined to user prose.
  // Display-only padding outside these two ranges remains editable and is never persisted away.
  const protocolFrom = Math.max(region.frontmatterEnd, region.from - 1);
  const protectedRanges = [
    { from: 0, to: region.frontmatterEnd },
    { from: protocolFrom, to: region.to },
  ];
  const rejectEdit = () => ({
    selection: transaction.startState.selection,
    effects: StateEffect.mapEffects(transaction.effects, transaction.changes.invertedDesc),
    annotations: Transaction.addToHistory.of(false),
    scrollIntoView: transaction.scrollIntoView,
  });
  if (
    transaction.isUserEvent("input.copyline") &&
    transaction.startState.selection.ranges.some(
      (range) =>
        range.from < region.frontmatterEnd || (range.from < region.to && range.to >= protocolFrom),
    )
  ) {
    return rejectEdit();
  }
  const lineFormatting =
    transaction.isUserEvent("input.indent") ||
    transaction.isUserEvent("delete.dedent") ||
    transaction.isUserEvent("indent");
  let intersects = false;
  transaction.changes.iterChangedRanges((from, to) => {
    intersects ||=
      protectedRanges.some((range) => from < range.to && to > range.from) ||
      (from === to && from >= region.presentationFrom && from < region.presentationTo) ||
      (from === to && from < region.frontmatterEnd) ||
      (from === to &&
        from === region.to &&
        from === transaction.startState.doc.length &&
        transaction.startState.doc.sliceString(from - 1, from) !== "\n");
  });
  if (!intersects) {
    return transaction;
  }
  if (transaction.isUserEvent("move")) {
    // Moving a line/selection across the hidden metadata boundary would move protocol source too.
    return rejectEdit();
  }

  const deletions: { from: number; to: number }[] = [];
  const insertions: {
    at: number;
    text: string;
    fromB: number;
    toB: number;
    prefixLength: number;
    offset?: number;
  }[] = [];
  transaction.changes.iterChanges((from, to, fromB, toB, inserted) => {
    let cursor = from;
    for (const range of protectedRanges) {
      if (range.to <= cursor || range.from >= to) {
        continue;
      }
      if (cursor < range.from) {
        deletions.push({ from: cursor, to: range.from });
      }
      cursor = Math.max(cursor, range.to);
    }
    if (cursor < to) {
      deletions.push({ from: cursor, to });
    }
    if (inserted.length > 0) {
      const hiddenInsertion =
        from < region.frontmatterEnd ||
        (from >= region.presentationFrom && from < region.presentationTo) ||
        (from >= protocolFrom && from < region.to);
      if (hiddenInsertion && lineFormatting) {
        // Line-wise indentation applies only to visible user text, never accumulates in the body.
        return;
      }
      const at = hiddenInsertion ? region.bodyStart : from;
      const separator =
        at === region.to &&
        at === transaction.startState.doc.length &&
        transaction.startState.doc.sliceString(at - 1, at) !== "\n"
          ? "\n"
          : "";
      insertions.push({
        at,
        text: separator + inserted.toString(),
        fromB,
        toB,
        prefixLength: separator.length,
      });
    }
  });
  // Multiple cursors can route into the same editable boundary. Retain every insertion in order.
  const changes = new Map<number, { from: number; to: number; insert: string }>();
  for (const deletion of deletions) {
    changes.set(deletion.from, { ...deletion, insert: "" });
  }
  for (const insertion of insertions) {
    const deletion = deletions.find(
      (range) => range.from <= insertion.at && insertion.at <= range.to,
    );
    const at = deletion?.from ?? insertion.at;
    const change = changes.get(at) ?? { from: at, to: at, insert: "" };
    insertion.at = at;
    insertion.offset = change.insert.length + insertion.prefixLength;
    change.insert += insertion.text;
    changes.set(at, change);
  }
  const safeChanges = transaction.startState.changes(
    [...changes.values()].sort((left, right) => left.from - right.from) satisfies ChangeSpec,
  );
  const correction = transaction.changes.invert(transaction.startState.doc).compose(safeChanges);
  if (safeChanges.empty) {
    // A blocked boundary Backspace/Delete is a no-op, including its caret and undo history.
    return rejectEdit();
  }
  const hiddenFrom = safeChanges.mapPos(region.presentationFrom, -1);
  const hiddenTo = safeChanges.mapPos(region.presentationTo, -1);
  const metadataEnd = safeChanges.mapPos(region.frontmatterEnd, -1);
  const bodyCursor = safeChanges.mapPos(region.bodyStart, 1);
  const visiblePosition = (position: number) =>
    position < metadataEnd || (position >= hiddenFrom && position < hiddenTo)
      ? bodyCursor
      : position;
  const remapEndpoint = (original: number, mapped: number): number => {
    const insertion =
      insertions.find((item) => original > item.fromB && original <= item.toB) ??
      insertions.find((item) => original === item.fromB);
    return insertion === undefined
      ? visiblePosition(mapped)
      : safeChanges.mapPos(insertion.at, -1) + (insertion.offset ?? 0) + original - insertion.fromB;
  };
  const selection = EditorSelection.create(
    transaction.newSelection.ranges.map((original) => {
      const range = original.map(correction);
      const anchor = remapEndpoint(original.anchor, range.anchor);
      const head = remapEndpoint(original.head, range.head);
      if (anchor === range.anchor && head === range.head) {
        return range;
      }
      return anchor === head
        ? EditorSelection.cursor(head, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
        : EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined);
    }),
    transaction.newSelection.mainIndex,
  );
  // Correct within the same transaction, preserving the original annotations, effects and native
  // history entry. Only a caret that would land in hidden metadata is moved to editable body text.
  return [transaction, { changes: correction, selection, sequential: true }];
};

export const taskManagedRegionExtension = StateField.define<ManagedRegionState>({
  create: makeState,
  update(value, transaction) {
    const context = readContext(transaction.state);
    if (
      !transaction.docChanged &&
      context.path === value.path &&
      context.livePreview === value.livePreview
    ) {
      return value;
    }
    return makeState(transaction.state);
  },
  provide: (field) => [
    EditorView.editorAttributes.from(
      field,
      (value): Record<string, string> =>
        value.region === undefined ? {} : { class: "tasks-bridge-task-editor" },
    ),
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
    EditorState.transactionFilter.of((transaction) =>
      protectManagedRegion(transaction, transaction.startState.field(field).region),
    ),
  ],
});
