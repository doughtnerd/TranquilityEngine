/**
 * CSS Scroll Snap 1 (ADR 0428): where a scroll comes to rest on one axis of a snapping scroller, from the snap areas
 * the UI core measured at its last layout (`UIScrollSnap`). Pure: the scrolling module asks it, and moves the scroller.
 *
 * - **Explicit** scrolls (`scrollTo`, `scrollIntoView`, Home/End) rest on the snap position nearest where they were
 *   going (one that keeps a given range in view first, for `scrollIntoView` and navigation).
 * - **Directional** scrolls (arrow and page keys, `scrollBy`, the wheel once it settles) rest on the position nearest
 *   their end among those past where they started, so a short step still moves on to the next one.
 * - **Gesture ends** (a touch or pen drag's momentum, a scrollbar thumb let go) rest on the position nearest the
 *   momentum's end.
 * - `scroll-snap-stop: always`: a directional scroll or gesture that would pass over (or reach) such a position stops
 *   at the first one.
 * - `mandatory` always rests on a position when there is one; `proximity` only within `PROXIMITY_SHARE` of the
 *   snapport's length of one, else where it was going.
 */
import type { UIComponentType } from "./components";
import type { UIScrollSnap } from "./uiCoreTypes";

/** `proximity` snaps when the nearest position is within this share of the snapport's length. */
export const PROXIMITY_SHARE = 0.3;

export type UISnapMode = "explicit" | "directional" | "end";

export interface UISnapRequest {
  readonly axis: "x" | "y";
  /** The offsets' range on the axis. */
  readonly min: number;
  readonly max: number;
  /** Where the scroll starts (the gesture's start, for `end`) and where it was going. */
  readonly from: number;
  readonly to: number;
  readonly mode: UISnapMode;
  /** Explicit only: a range in content space (start, length) to keep in the viewport (`client` long) when a position does. */
  readonly keep?: { readonly start: number; readonly size: number; readonly client: number } | null;
}

export interface UISnapChoice {
  /** Where to rest. */
  readonly to: number;
  /** The snap area it rests on, or null (it doesn't snap). */
  readonly area: UIComponentType | null;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Where a scroll on `req.axis` of a scroller snapping as `snap` rests. */
export function chooseSnap(snap: UIScrollSnap, req: UISnapRequest): UISnapChoice {
  const { axis, min, max, from, to, mode } = req;
  const none: UISnapChoice = { to, area: null };
  if (!snap[axis]) return none;
  let cands: { v: number; comp: UIComponentType; stop: boolean }[] = [];
  for (const a of snap.areas) {
    const p = a[axis];
    if (p !== null) cands.push({ v: clamp(p, min, max), comp: a.comp, stop: a.stop });
  }
  if (!cands.length) return none;
  const keep = req.keep;
  if (keep) {
    const shown = cands.filter((c) => c.v <= keep.start + 0.5 && c.v + keep.client >= keep.start + keep.size - 0.5);
    if (shown.length) cands = shown;
  }
  const dir = Math.sign(to - from);
  if (mode !== "explicit" && dir !== 0) {
    if (mode === "directional") {
      const ahead = cands.filter((c) => (c.v - from) * dir > 0.5);
      if (ahead.length) cands = ahead;
      else if (!snap.mandatory) return none;
    }
    // scroll-snap-stop: the first `always` position it would pass over or reach.
    let stop: (typeof cands)[number] | null = null;
    for (const c of cands) {
      if (!c.stop || (c.v - from) * dir <= 0.5 || (to - c.v) * dir < -0.5) continue;
      if (!stop || Math.abs(c.v - from) < Math.abs(stop.v - from)) stop = c;
    }
    if (stop) return { to: stop.v, area: stop.comp };
  }
  let best = cands[0];
  for (const c of cands) if (Math.abs(c.v - to) < Math.abs(best.v - to)) best = c;
  const port = axis === "x" ? snap.port.width : snap.port.height;
  if (!snap.mandatory && Math.abs(best.v - to) > PROXIMITY_SHARE * port) return none;
  return { to: best.v, area: best.comp };
}
