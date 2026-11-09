// The active history (ADR 0143): the one edit history that Undo and Redo act on right now, wherever
// they come from (Edit menu, Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl+Y, Ctrl/Cmd+Alt(+Shift)+Z, the
// History panel). It follows focus:
//
// 1. a panel-local history, while focus or the last click is inside the root a panel registered it
//    on (`providePanelHistory` / `usePanelHistory`: Project Settings, Worlds, the Sprite Editor, the
//    Particle Graph);
// 2. otherwise the focused asset document's (`focusedAssetDocument`: an editor root marked
//    `data-asset-document`, such as Sky, a material, a shader graph, a formation or a tileset);
// 3. otherwise the open scene's CommandStack.
//
// Clicks and focus in the History panel and the menu bar keep the current choice (KEEPS_HISTORY_FOCUS).
// The histories keep their own implementations; this module only sees them through `UndoHistory`.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { focusedAssetDocument, KEEPS_HISTORY_FOCUS, type AssetDocument } from "./assetDocuments";
import type { CommandStack, HistoryState } from "./document";
import { docVersion, openScene } from "./state";

/** A history tree the History panel can draw and jump through (ADR 0027). */
export interface HistoryTree {
  /** Every state, oldest first. */
  readonly states: readonly HistoryState[];
  readonly current: number;
  /** The state matching the file as last written (-1 if none does). */
  readonly saved: number;
  jumpTo(seq: number): void;
  /** Bumped on every change to the tree, if it isn't followed through `docVersion`. */
  readonly version?: ReadonlySignal<number>;
}

/**
 * One edit history, as Undo and Redo see it. Getters may read signals, so the Edit menu and the
 * History panel follow changes; a history whose state isn't in signals re-registers when it changes.
 */
export interface UndoHistory {
  /** What it's the history of, for the History panel ("Worlds", "Sprite Editor"). */
  readonly name?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The name of the step undo / redo would revert or make, or null. */
  readonly undoLabel?: string | null;
  readonly redoLabel?: string | null;
  undo(): void;
  redo(): void;
  /** Step through states in creation order (Vim's g- / g+); histories without branches leave these out. */
  back?(): void;
  forward?(): void;
  /** Its tree, when it's one (scenes and asset documents). */
  readonly tree?: HistoryTree;
}

export interface ActiveHistory {
  readonly kind: "panel" | "asset" | "scene";
  readonly history: UndoHistory;
  /** The asset document's or scene's file. */
  readonly path?: string;
}

// --- the scene and asset documents as histories ---------------------------------------------------

const sceneHistories = new WeakMap<CommandStack, UndoHistory>();

/** The scene's CommandStack as an UndoHistory (it changes `docVersion`, which the getters read). */
export function sceneHistory(stack: CommandStack): UndoHistory {
  let h = sceneHistories.get(stack);
  if (h) return h;
  const read = () => (docVersion.value, stack);
  h = {
    get canUndo() {
      return read().canUndo;
    },
    get canRedo() {
      return read().canRedo;
    },
    get undoLabel() {
      return read().undoLabel;
    },
    get redoLabel() {
      return read().redoLabel;
    },
    undo: () => void stack.undo(),
    redo: () => void stack.redo(),
    back: () => void stack.back(),
    forward: () => void stack.forward(),
    tree: {
      get states() {
        return read().allStates;
      },
      get current() {
        return read().current;
      },
      get saved() {
        return read().saved;
      },
      jumpTo: (seq) => void stack.jumpTo(seq),
    },
  };
  sceneHistories.set(stack, h);
  return h;
}

const documentHistories = new WeakMap<AssetDocument<unknown>, UndoHistory>();

/** An asset document as an UndoHistory: nothing to undo on a read-only project, which refuses edits. */
export function assetDocumentHistory(doc: AssetDocument<unknown>): UndoHistory {
  let h = documentHistories.get(doc);
  if (h) return h;
  h = {
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
  documentHistories.set(doc, h);
  return h;
}

// --- panel-local histories ------------------------------------------------------------------------

const panels = new Map<Element, UndoHistory>();
const panelsVersion = signal(0);
/** The registered root that focus or the last click was in (kept for clicks in KEEPS_HISTORY_FOCUS), or null. */
const focusedRoot = signal<Element | null>(null);
let stopTracking: (() => void) | null = null;

/** The registered root `el` is in, if any. */
function rootOf(el: Element | null): Element | null {
  for (let n = el; n; n = n.parentElement) if (panels.has(n)) return n;
  return null;
}

/** Follow focus and clicks into registered roots (installed by installShortcuts and the first registration). */
export function trackHistoryFocus(): void {
  if (stopTracking || typeof document === "undefined") return;
  const onFocus = (e: Event) => {
    const el = e.target as Element | null;
    if (!el?.closest) return;
    const root = rootOf(el);
    if (root) focusedRoot.value = root;
    else if (!el.closest(KEEPS_HISTORY_FOCUS)) focusedRoot.value = null;
  };
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("pointerdown", onFocus, true);
  stopTracking = () => {
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("pointerdown", onFocus, true);
  };
}

/**
 * While focus or the last click is inside `root`, `history` is the active one (it wins over an asset
 * document marked on the same root, so a panel can wrap its document's undo). Returns the unregister.
 * Registering again for the same root replaces the history.
 */
export function providePanelHistory(root: Element, history: UndoHistory): () => void {
  trackHistoryFocus();
  // Focus may already be inside a panel that registers as it mounts.
  const active = typeof document !== "undefined" ? (document.activeElement as Element | null) : null;
  panels.set(root, history);
  if (active && root.contains?.(active)) focusedRoot.value = root;
  panelsVersion.value++;
  return () => {
    if (panels.get(root) !== history) return;
    panels.delete(root);
    if (focusedRoot.peek() === root) focusedRoot.value = null;
    panelsVersion.value++;
  };
}

/**
 * `providePanelHistory` on `ref`'s element while the component is mounted, following the element (it
 * may appear on a later render) and `history` (pass a new object to re-register, e.g. when a history
 * kept in component state changes, so the Edit menu follows). Null: none.
 */
export function usePanelHistory(ref: { readonly current: Element | null }, history: UndoHistory | null): void {
  const registered = useRef<{ el: Element | null; history: UndoHistory | null; stop?: () => void }>({ el: null, history: null });
  useEffect(() => {
    const el = ref.current;
    const was = registered.current;
    if (was.el === el && was.history === history) return;
    was.stop?.();
    registered.current = { el, history, stop: el && history ? providePanelHistory(el, history) : undefined };
  });
  useEffect(() => () => registered.current.stop?.(), []);
}

// --- resolving ------------------------------------------------------------------------------------

/** The asset document's editor is still on the page (a replaced inspector doesn't leave its history active). */
function editorShown(path: string): boolean {
  if (typeof document === "undefined" || !document.querySelector) return true;
  return document.querySelector(`[data-asset-document=${JSON.stringify(path)}]`) !== null;
}

function resolve(): ActiveHistory | null {
  panelsVersion.value;
  const root = focusedRoot.value;
  const panel = root ? panels.get(root) : undefined;
  if (panel && root!.isConnected !== false) return { kind: "panel", history: panel };
  const doc = focusedAssetDocument.value;
  if (doc && editorShown(doc.path)) return { kind: "asset", history: assetDocumentHistory(doc), path: doc.path };
  const scene = openScene.value;
  return scene ? { kind: "scene", history: sceneHistory(scene.stack), path: scene.path } : null;
}

/** The history Undo and Redo act on now, or null (no scene open and no editor with a history focused). */
export const activeHistory: ReadonlySignal<ActiveHistory | null> = computed(resolve);

/** Undo in the active history; false if there was nothing to undo. Resolved afresh, so a just-closed editor isn't used. */
export function undo(): boolean {
  const h = resolve()?.history;
  if (!h?.canUndo) return false;
  h.undo();
  return true;
}

export function redo(): boolean {
  const h = resolve()?.history;
  if (!h?.canRedo) return false;
  h.redo();
  return true;
}

/** The previous state in creation order (Vim's g-), where the active history has branches. */
export function stepBack(): void {
  resolve()?.history.back?.();
}

export function stepForward(): void {
  resolve()?.history.forward?.();
}

/** Tests: forget the registrations and stop following focus. */
export function _resetActiveHistory(): void {
  stopTracking?.();
  stopTracking = null;
  panels.clear();
  focusedRoot.value = null;
  panelsVersion.value++;
}
