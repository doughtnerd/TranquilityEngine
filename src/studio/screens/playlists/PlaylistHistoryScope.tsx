// The open playlist's history wherever the Playlists screen has the focus (UI pass H3): the Studio header's Undo, Redo
// and History, Ctrl+Z and the History panel act on the open playlist's document while the focus (or the last click) is
// in any of the screen's panels — the tree, the Library, Plays now, Parameters — not only inside the editor. Each
// panel's content sits in a scope that registers the document's history on it (the engine's `usePanelHistory`, ADR
// 0145); the scope draws no box of its own.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { usePanelHistory, type UndoHistory } from "../../../editor/activeHistory";
import type { AssetDocument } from "../../../editor/assetDocuments";

const histories = new WeakMap<AssetDocument<unknown>, UndoHistory>();

/** A playlist document as an undo history, named by its file (one per document, so registering again is a no-op). */
function historyOf(doc: AssetDocument<unknown>): UndoHistory {
  let h = histories.get(doc);
  if (h) return h;
  h = {
    get name() {
      return doc.path.slice(doc.path.lastIndexOf("/") + 1);
    },
    get canUndo() {
      return !doc.readOnly && doc.canUndo.value;
    },
    get canRedo() {
      return !doc.readOnly && doc.canRedo.value;
    },
    get undoLabel() {
      return doc.undoLabel.value;
    },
    get redoLabel() {
      return doc.redoLabel.value;
    },
    undo: () => doc.undo(),
    redo: () => doc.redo(),
    back: () => doc.history.back(),
    forward: () => doc.history.forward(),
    tree: doc.history,
  };
  histories.set(doc, h);
  return h;
}

export function PlaylistHistoryScope(props: { readonly doc: AssetDocument<unknown> | null; readonly children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelHistory(ref, props.doc ? historyOf(props.doc) : null);
  return (
    <div ref={ref} class="pl-history-scope">
      {props.children}
    </div>
  );
}
