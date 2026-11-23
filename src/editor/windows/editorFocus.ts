// The editor's focus (ADR 0145, ADR 0174): the element focus or the last press went to, in whichever
// editor window it happened, the main window or a detached panel window. The active history
// (activeHistory.ts) and the focused asset document (assetDocuments.ts) both follow it, so there is
// one listener per window and one rule for what keeps the previous focus.
//
// It follows every editor window from the moment this module loads, and each window as it opens
// (`forEachEditorWindow`): `focusin` and `pointerdown`, in the capture phase, on its document.
import { signal, type ReadonlySignal } from "@preact/signals";
import { forEachEditorWindow } from "./editorWindows";

/**
 * Presses and focus inside these keep the editor focus where it was: the History panel showing the
 * focused editor's history, and the menu bar and menus whose Edit > Undo acts on it (ADR 0145); a
 * popover of a document's fields drawn at the page's floating root (`data-keeps-history-focus`); and the
 * Audio Studio's player bar, whose transport (Trigger, Play) acts on the document in hand.
 */
export const KEEPS_HISTORY_FOCUS = '.history-panel, [role="menubar"], [role="menu"], [data-keeps-history-focus], .studio-player';

const focused = signal<Element | null>(null);

/**
 * The element focus or the last press last went to in any editor window, or null before any. Focus
 * and presses inside `KEEPS_HISTORY_FOCUS` leave it as it was. Events whose target isn't an element
 * (the window or document itself) are ignored. The element may since have left its page; readers
 * that care check `isConnected`.
 */
export const editorFocus: ReadonlySignal<Element | null> = focused;

function follow(e: Event): void {
  const el = e.target as Element | null;
  if (typeof el?.closest !== "function") return;
  if (!el.closest(KEEPS_HISTORY_FOCUS)) focused.value = el;
}

forEachEditorWindow((win) => {
  const doc = win.document;
  doc.addEventListener("focusin", follow, true);
  doc.addEventListener("pointerdown", follow, true);
  return () => {
    doc.removeEventListener("focusin", follow, true);
    doc.removeEventListener("pointerdown", follow, true);
  };
});
