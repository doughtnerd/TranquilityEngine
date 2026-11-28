// The editor's one press-and-drag gesture (ADR 0278, 0455): node rows, UI element rows and live rows in the
// Hierarchy, asset tiles, the Assets panel's selection box and dock panel tabs all drag with it. A press only becomes
// a drag past a few pixels, so a click still clicks. While it drags, every pointer move reports where the pointer is,
// in the window the press was in (a detached panel window's own, ADR 0174: dragging between windows isn't supported).
// Releasing drops (or clicks, when it never moved that far); Escape while dragging, or a cancelled pointer, cancels.
// The graph canvas keeps its own pan-and-zoom drag (ADR 0259).
import { eventWindow } from "./windows/dom";

/** How far (in CSS pixels) a press moves before it's a drag. */
const DRAG_THRESHOLD = 5;
/** Escape is caught before the panels see it. An options object, not `true`: Node's EventTarget (headless tests) doesn't remove a listener by a bare boolean. */
const CAPTURE: EventListenerOptions = { capture: true };

/** How a press ended: released after dragging, released without dragging, or cancelled (Escape, a cancelled pointer). */
export type PointerDragEnd = "drop" | "click" | "cancel";

export interface PointerDragHandlers {
  /** The press just became a drag, before its first `move`. `doc`: the window's document the drag is in. */
  begin?(e: PointerEvent, doc: Document): void;
  /** The pointer moved, once the press is a drag (and at the release point). `doc`: the window's document the drag is in. */
  move(e: PointerEvent, doc: Document): void;
  /** The gesture ended; every window listener is already gone. */
  end(how: PointerDragEnd): void;
}

/** A point in client pixels. */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** Whether the pointer travelled from `a` to `b` far enough to be a drag: a click that ends there isn't a click. */
export function isDragDistance(a: ClientPoint, b: ClientPoint): boolean {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) >= DRAG_THRESHOLD;
}

/** Follow a primary-button press as a possible drag. Returns at once; the handlers run as the pointer moves. */
export function startPointerDrag(e: PointerEvent, handlers: PointerDragHandlers): void {
  if (e.button !== 0) return;
  const start: ClientPoint = { clientX: e.clientX, clientY: e.clientY };
  let active = false;
  const win = eventWindow(e);
  const move = (m: PointerEvent) => {
    if (!active) {
      if (!isDragDistance(start, m)) return;
      active = true;
      handlers.begin?.(m, win.document);
    }
    handlers.move(m, win.document);
  };
  const finish = (how: PointerDragEnd) => {
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", up);
    win.removeEventListener("pointercancel", cancel);
    win.removeEventListener("keydown", escape, CAPTURE);
    handlers.end(how);
  };
  const up = (m: PointerEvent) => {
    if (active) handlers.move(m, win.document);
    finish(active ? "drop" : "click");
  };
  const cancel = () => finish("cancel");
  const escape = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish("cancel");
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", up);
  win.addEventListener("pointercancel", cancel);
  win.addEventListener("keydown", escape, CAPTURE);
}
