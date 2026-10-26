import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, getFrontMatterInfo } from "obsidian";

import { MANAGED_BODY_END, MANAGED_BODY_START, MANAGED_TASK_ID_MARKER_PREFIX } from "./document";

const presentationSignature = (content: string): string => {
  const info = getFrontMatterInfo(content);
  const start = content.indexOf(MANAGED_BODY_START);
  const end = content.indexOf(MANAGED_BODY_END);
  const starts = content.split(MANAGED_BODY_START).length - 1;
  const ends = content.split(MANAGED_BODY_END).length - 1;
  const identities = content.split(MANAGED_TASK_ID_MARKER_PREFIX).length - 1;
  const region =
    starts === 1 && ends === 1 && start >= info.contentStart && end > start
      ? content.slice(start, end + MANAGED_BODY_END.length)
      : undefined;
  // Body prose and caret movement must not trigger a Vault-wide header refresh. Preserve
  // enough protocol shape to notice hydration, metadata edits, and malformed/repaired tasks.
  return JSON.stringify([info.exists, info.frontmatter, region, starts, ends, identities]);
};

/** Refresh native task presentation when an editor finishes its initial document hydration. */
export const createTaskDocumentReadyExtension = (onReady: () => void): Extension =>
  ViewPlugin.fromClass(
    class {
      private path: string | undefined;
      private signature: string | undefined;

      constructor(view: EditorView) {
        this.notifyIfReady(view);
      }

      public update(update: ViewUpdate): void {
        this.notifyIfReady(update.view, update.docChanged);
      }

      private notifyIfReady(view: EditorView, docChanged = true): void {
        const path = view.state.field(editorInfoField, false)?.file?.path;
        if (path !== this.path) {
          this.path = path;
          this.signature = undefined;
        }
        if (
          path?.endsWith(".task.md") !== true ||
          (!docChanged && this.signature !== undefined) ||
          (view.state.doc.length === 0 && this.signature === undefined)
        ) {
          return;
        }
        const signature = presentationSignature(view.state.doc.toString());
        if (signature === this.signature) {
          return;
        }
        // Native file context and initial text can arrive in separate updates. Once both exist,
        // schedule presentation through the owner without dispatching an editor transaction.
        this.signature = signature;
        onReady();
      }
    },
  );
