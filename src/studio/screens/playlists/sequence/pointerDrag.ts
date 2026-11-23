// A press that may become a drag (the timeline's clips, edges, loops, markers, points, marquee): moves are reported
// once the pointer has travelled the threshold (3 px, proto), and the release says whether it was a drag. Listens on
// the pressed element's document, so it works in a detached panel window too.
import { DRAG_THRESHOLD } from "./timelineLayout";

export interface DragHandlers {
  /** Pixels from the press. */
  move(dx: number, dy: number, e: PointerEvent): void;
  /** `dragged`: the pointer passed the threshold. */
  up(dragged: boolean, e: PointerEvent): void;
  readonly threshold?: number;
}

export function beginDrag(e: PointerEvent, h: DragHandlers): void {
  if (e.button !== 0) return;
  const doc = (e.currentTarget as Element | null)?.ownerDocument ?? document;
  const x0 = e.clientX, y0 = e.clientY;
  const limit = h.threshold ?? DRAG_THRESHOLD;
  let dragged = false;
  const move = (ev: PointerEvent) => {
    if (!dragged && Math.hypot(ev.clientX - x0, ev.clientY - y0) < limit) return;
    dragged = true;
    h.move(ev.clientX - x0, ev.clientY - y0, ev);
  };
  const up = (ev: PointerEvent) => {
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", up);
    h.up(dragged, ev);
  };
  doc.addEventListener("pointermove", move);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", up);
}
