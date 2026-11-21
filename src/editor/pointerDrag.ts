// The editor's one press-and-drag gesture for moving rows (ADR 0278): node rows, UI element rows and live rows in
// the Hierarchy all drag with it. A press only becomes a drag past a few pixels, so a click still selects. While it
// drags, every pointer move reports where the pointer is, in the window the press was in (a detached panel window's
// own, ADR 0174: dragging between windows isn't supported). Releasing drops; Escape or a cancelled pointer ends it
// without dropping.
import { eventWindow } from "./windows/dom";

/** How far (in CSS pixels) a press moves before it's a drag. */
const DRAG_THRESHOLD = 5;

export interface PointerDragHandlers {
  /** The pointer moved, once the press is a drag (and at the release point). `doc`: the window's document the drag is in. */
  move(e: PointerEvent, doc: Document): void;
  /** The gesture ended: `drop` is true when a drag was released, false for Escape, a cancelled pointer or a plain click. */
  end(drop: boolean): void;
}

/** Follow a primary-button press as a possible drag. Returns at once; the handlers run as the pointer moves. */
export function startPointerDrag(e: PointerEvent, handlers: PointerDragHandlers): void {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let active = false;
  const win = eventWindow(e);
  const move = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    active = true;
    handlers.move(m, win.document);
  };
  const finish = (drop: boolean) => {
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", up);
    win.removeEventListener("pointercancel", cancel);
    win.removeEventListener("keydown", escape, true);
    handlers.end(drop && active);
  };
  const up = (m: PointerEvent) => {
    if (active) handlers.move(m, win.document);
    finish(true);
  };
  const cancel = () => finish(false);
  const escape = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish(false);
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", up);
  win.addEventListener("pointercancel", cancel);
  win.addEventListener("keydown", escape, true);
}
