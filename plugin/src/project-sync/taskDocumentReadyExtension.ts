import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";

/** Refresh native task presentation when an editor finishes its initial document hydration. */
export const createTaskDocumentReadyExtension = (onReady: () => void): Extension =>
  ViewPlugin.fromClass(
    class {
      private path: string | undefined;
      private notified = false;

      constructor(view: EditorView) {
        this.notifyIfReady(view);
      }

      public update(update: ViewUpdate): void {
        this.notifyIfReady(update.view);
      }

      private notifyIfReady(view: EditorView): void {
        const path = view.state.field(editorInfoField, false)?.file?.path;
        if (path !== this.path) {
          this.path = path;
          this.notified = false;
        }
        if (this.notified || path?.endsWith(".task.md") !== true || view.state.doc.length === 0) {
          return;
        }
        // Native file context and initial text can arrive in separate updates. Once both exist,
        // schedule presentation through the owner without dispatching an editor transaction.
        this.notified = true;
        onReady();
      }
    },
  );
