// The selection and shortcuts every graph panel has (ADR 0228): click, Shift/Ctrl-click and box
// select on the canvas, and the keyboard block: Ctrl/Cmd+D duplicate, +A select all, +C copy, +X
// cut, +V paste, +G group, Delete, Space (the node search), F (frame all) and Escape. The edits go
// through the panel's graph document (`./document.ts`); the panel plugs in its own extras (a
// selected wire or block, its popups) through the hooks below.
//
// Every handler reads the graph when it runs (`graph()`, the document's latest), so keys pressed in
// a row see each other's edits.
import { useState } from "preact/hooks";
import { clipboardForPaste, expectPaste, takePaste, writeClipboard, type ClipboardPayload } from "../clipboard";
import { isFieldTarget, startBoxSelect } from "./canvas";
import type { GraphDocument, GraphPropertyData } from "./document";
import { toGraph, type CanvasNode, type Point, type View } from "./xyflow";

/** Each graph kind's last copy, by clipboard format: Ctrl+V in any graph of that kind, in any window, takes it (ADR 0226). */
const copied = new Map<string, ClipboardPayload>();

/** What the selection handlers use of the canvas (`useGraphCanvas` returns it). */
export interface GraphSelectionCanvas {
  readonly pane: { readonly current: HTMLElement | null };
  readonly viewRef: { readonly current: View };
  readonly pointer: { readonly current: Point | null };
  paneCenter(): Point;
  frameAll(): void;
}

export interface GraphSelectionOptions<G, P extends GraphPropertyData, C extends ClipboardPayload> {
  /** The panel's graph document edits. */
  edits: GraphDocument<G, P, C>;
  /** The graph as it is now (the document's, edits included). */
  graph(): G;
  /** Apply an edit (one undo step; the panel's document refuses it when the file is read-only). */
  commit(next: G): void;
  /** A read-only file: paste does nothing. */
  readOnly: boolean;
  /** The panel's focusable root, which takes the keyboard when the canvas is clicked. */
  root: { readonly current: HTMLElement | null };
  /** The canvas (`useGraphCanvas`), read when a handler runs (so this hook can come before it). */
  canvas(): GraphSelectionCanvas;
  /** The canvas nodes now, for box select. */
  nodes(): readonly CanvasNode[];
  /** Selector for the pane's children a pointer-down on doesn't start a box select (nodes, notes, popups…). */
  paneIgnore: string;
  /** Space: open the node search. */
  openSearch(): void;
  /** Delete: remove what else the panel has selected (a wire, a block) and return true, or return false to delete the selected items. */
  deleteOther?(): boolean;
  /** An item was pressed: clear the panel's other selections as it needs. */
  onItemDown?(e: PointerEvent): void;
  /** The empty pane was pressed: close the panel's popups and clear its other selections. */
  onPaneDown?(): void;
  /** Escape (the selection is cleared too). */
  onEscape?(): void;
}

/** The selection of a graph panel and its pointer and keyboard handlers. */
export function useGraphSelection<G, P extends GraphPropertyData, C extends ClipboardPayload>(o: GraphSelectionOptions<G, P, C>) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);

  const focus = () => o.root.current?.focus({ preventScroll: true });

  /** Delete what the panel has selected: its own extra first, else the selected items. */
  const deleteSelection = () => {
    if (o.deleteOther?.()) return;
    if (selection.size === 0) return;
    o.commit(o.edits.remove(o.graph(), selection));
    setSelection(new Set());
  };

  const groupSelection = () => {
    if (selection.size === 0) return;
    o.commit(o.edits.group(o.graph(), selection).graph);
  };

  /** Copy the selection to the editor's memory and the system clipboard; true if anything was copied. */
  const copySelection = (): boolean => {
    const clip = o.edits.copy(o.graph(), selection);
    if (!clip) return false;
    copied.set(clip.format, clip);
    writeClipboard(clip);
    return true;
  };

  /** Paste where the pointer last was (or the pane's middle): the system clipboard's `text` when another editor process copied since, else this editor's last copy (ADR 0226). */
  const pasteHere = (text: string | null) => {
    if (o.readOnly) return;
    const clip = clipboardForPaste(text, (copied.get(o.edits.clipboardFormat) as C | undefined) ?? null, o.edits.clipboardFromText);
    if (!clip) return;
    copied.set(clip.format, clip);
    const canvas = o.canvas();
    const at = toGraph(canvas.pointer.current ?? canvas.paneCenter(), canvas.viewRef.current);
    const made = o.edits.paste(o.graph(), clip, [at.x, at.y]);
    o.commit(made.graph);
    setSelection(new Set(made.ids));
  };

  const onItemDown = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (!isFieldTarget(e.target)) focus();
    o.onItemDown?.(e);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    } else if (!selection.has(id)) setSelection(new Set([id]));
  };

  const onPaneDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest(o.paneIgnore)) return;
    focus();
    o.onPaneDown?.();
    const canvas = o.canvas();
    startBoxSelect(e, { pane: canvas.pane.current!, view: () => canvas.viewRef.current, nodes: o.nodes, selection, onSelection: setSelection, onBox: setBox });
  };

  /** A `paste` event on the panel: the paste Ctrl+V is waiting with gets its text (or one from the Edit menu runs). */
  const onPaste = (e: ClipboardEvent) => {
    if (isFieldTarget(e.target)) return;
    e.stopPropagation();
    takePaste(e, pasteHere);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isFieldTarget(e.target)) return;
    const key = (e.key ?? "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    // Ctrl/Cmd+Z / Shift+Z / Y reach the editor's shortcuts, which undo the active history: the panel's document (ADR 0145).
    if (mod && key === "d") {
      const made = o.edits.duplicate(o.graph(), selection);
      o.commit(made.graph);
      setSelection(new Set(made.ids));
    } else if (mod && key === "a") setSelection(new Set(o.edits.items(o.graph())));
    else if (mod && key === "c") copySelection();
    else if (mod && key === "x") {
      if (copySelection()) {
        o.commit(o.edits.remove(o.graph(), selection));
        setSelection(new Set());
      }
    } else if (mod && key === "v") {
      // Not prevented, so the browser fires `paste` with the system clipboard's text (onPaste).
      expectPaste(pasteHere);
      e.stopPropagation();
      return;
    } else if (mod && key === "g") groupSelection();
    else if (!mod && (key === "delete" || key === "backspace")) deleteSelection();
    else if (!mod && key === " ") o.openSearch();
    else if (!mod && key === "f") o.canvas().frameAll();
    else if (key === "escape") {
      setSelection(new Set());
      o.onEscape?.();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return { selection, setSelection, box, onItemDown, onPaneDown, onKeyDown, onPaste, deleteSelection, groupSelection };
}
