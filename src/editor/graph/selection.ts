// The selection and shortcuts every graph panel has (ADR 0228): click, Shift/Ctrl-click and box
// select on the canvas (by the editor's one selection rule, ADR 0468: `pressItem`, `startBoxSelect`), and the keyboard block: Ctrl/Cmd+D duplicate, +A select all, +C copy, +X
// cut, +V paste, +G group, +F find (ADR 0117, 0259), Delete, Space (the node search), F (frame all)
// and Escape. It also moves items: node drags (xyflow's, which move the selection together) and
// group drags by the title, and adds a note in the middle of the view (ADR 0259). The edits go
// through the panel's graph document (`./document.ts`); the panel plugs in its own extras (a
// selected wire or block, its popups) through the hooks below.
//
// Every handler reads the graph when it runs (`graph()`, the document's latest), so keys pressed in
// a row see each other's edits.
import { useState } from "preact/hooks";
import { clipboardForPaste, expectPaste, takePaste, writeClipboard, type ClipboardPayload } from "../clipboard";
import { pressSelection, selectModeFor } from "../selectMode";
import { KEY_OWNER } from "./keyOwner";
import { isFieldTarget, startBoxSelect, startPointerDrag, type GraphDragHooks } from "./canvas";
import type { GraphDocument, GraphPropertyData, GraphVec } from "./document";
import { toGraph, type CanvasNode, type Point, type View } from "./xyflow";

/** Each graph kind's last copy, by clipboard format: Ctrl+V in any graph of that kind, in any window, takes it (ADR 0226). */
const copied = new Map<string, ClipboardPayload>();

/**
 * A graph canvas's selection after a press on item `id` (ADR 0468, the scene view's rule): Shift adds
 * it, Ctrl/Cmd toggles it, a plain press selects just it unless it's already selected (so the drag
 * that follows moves the whole selection). Returns `selection` itself when the press changes nothing.
 */
export function pressItem(selection: ReadonlySet<string>, id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): ReadonlySet<string> {
  const before = [...selection];
  const next = pressSelection(before, id, selectModeFor(e));
  return next === before ? selection : new Set(next);
}

/** What the selection handlers use of the canvas (`useGraphCanvas` returns it). */
export interface GraphSelectionCanvas {
  readonly pane: { readonly current: HTMLElement | null };
  readonly viewRef: { readonly current: View };
  readonly pointer: { readonly current: Point | null };
  paneCenter(): Point;
  /** Fit these nodes (all of them by default) in the view. */
  frameAll(nodes?: readonly CanvasNode[]): void;
  panBy(dx: number, dy: number): Promise<boolean>;
}

export interface GraphSelectionOptions<G, P extends GraphPropertyData, C extends ClipboardPayload> {
  /** The panel's graph document edits. */
  edits: GraphDocument<G, P, C>;
  /** The graph as it is now (the document's, edits included). */
  graph(): G;
  /** Apply an edit (one undo step; the panel's document refuses it when the file is read-only). `drag`: a move, whose quick changes in a row may make one step. */
  commit(next: G, drag?: boolean): void;
  /** Move items to these positions (the kind's own edit: the Shader Graph's nodes, the Particle Graph's systems and nodes). */
  move(graph: G, to: ReadonlyMap<string, GraphVec>): G;
  /** A read-only file: paste and drags do nothing. */
  readOnly: boolean;
  /** The panel's focusable root, which takes the keyboard when the canvas is clicked. */
  root: { readonly current: HTMLElement | null };
  /** The canvas (`useGraphCanvas`), read when a handler runs (so this hook can come before it). */
  canvas(): GraphSelectionCanvas;
  /** The canvas nodes now (where they're drawn), for box select and drags. */
  nodes(): readonly CanvasNode[];
  /** Selector for the pane's children a pointer-down on doesn't start a box select (nodes, notes, popups…). */
  paneIgnore: string;
  /** Space: open the node search. */
  openSearch(): void;
  /** Ctrl/Cmd+F: open find (`useGraphFind`). */
  openFind(): void;
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
  /** Items being dragged, where they are drawn until the drag ends. */
  const [dragging, setDragging] = useState<ReadonlyMap<string, Point> | null>(null);

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
    const next = pressItem(selection, id, e);
    if (next !== selection) setSelection(next);
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

  /** End a drag: commit the moved items' positions as one move. */
  const moveTo = (to: ReadonlyMap<string, Point>) => {
    setDragging(null);
    if (o.readOnly) return;
    o.commit(o.move(o.graph(), new Map([...to].map(([id, p]) => [id, [p.x, p.y] as GraphVec]))), true);
  };

  /** What a draggable canvas item hands xyflow (`useNodeDrag`): dragging a selected item moves the selection. */
  const drag: GraphDragHooks = {
    pane: () => o.canvas().pane.current!,
    nodes: o.nodes,
    view: () => o.canvas().viewRef.current,
    panBy: (dx, dy) => o.canvas().panBy(dx, dy),
    onMove: (m) => setDragging(new Map(m)),
    onEnd: moveTo,
  };

  /** Drag a group by its title (on its pointer-down): its items move together, as one move. */
  const startGroupDrag = (e: PointerEvent, groupId: string) => {
    if (e.button !== 0 || o.readOnly || isFieldTarget(e.target)) return;
    const members = new Set(o.edits.groups(o.graph()).find((g) => g.id === groupId)?.members ?? []);
    const base = new Map(o.nodes().filter((n) => members.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
    const moved = (dx: number, dy: number) => new Map([...base].map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
    startPointerDrag(e, {
      zoom: () => o.canvas().viewRef.current.zoom,
      onMove: (dx, dy) => setDragging(moved(dx, dy)),
      onEnd: (dx, dy) => moveTo(moved(dx, dy)),
    });
  };

  /** Add a sticky note in the middle of the view. */
  const addNoteHere = () => {
    const canvas = o.canvas();
    const at = toGraph(canvas.paneCenter(), canvas.viewRef.current);
    o.commit(o.edits.addNote(o.graph(), [at.x - 100, at.y - 50]).graph);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const key = (e.key ?? "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && key === "f" && !e.altKey) {
      // Find works from a field too (the panel's own, not the browser's).
      e.preventDefault();
      e.stopPropagation();
      o.openFind();
      return;
    }
    if (isFieldTarget(e.target)) return;
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

  /** Spread on the graph editor's root: its key and paste handlers, and the marker that it owns the editor's node keys (`./keyOwner.ts`). */
  const rootProps = { onKeyDown, onPaste, [KEY_OWNER]: "" };

  return { selection, setSelection, box, dragging, drag, startGroupDrag, addNoteHere, onItemDown, onPaneDown, rootProps, deleteSelection, groupSelection };
}
