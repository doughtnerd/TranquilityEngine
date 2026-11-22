// The elevation strip (the prototype's slab, S:842-848; B.2 "Elevation"): which heights the plan shows at full strength.
// Following, the slab is the active listener's height ±3 m; else a range you set. Items outside it dim. The strip draws
// each object's height (a bar for a box, a dot for a point) over the scene's height range, and labels heights relative to
// the active listener ("↑6 m").
//
// Pure: no DOM, no signals.
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { activeListener, allObjects, boxOf, positionOf, type ObjectKind } from "./sceneEdits";

export interface Slab {
  /** Follow the active listener (±`FOLLOW_HALF` m). */
  readonly follow: boolean;
  /** The manual range, metres. */
  readonly low: number;
  readonly high: number;
}

/** Half the slab's height while following, metres. */
export const FOLLOW_HALF = 3;
/** The least slab height, metres. */
export const MIN_SLAB = 1;
/** The prototype's height range when a scene stays inside it (scene bounds come from the game). */
export const DEFAULT_HEIGHTS: readonly [number, number] = [0, 30];

export const INITIAL_SLAB: Slab = { follow: true, low: 0, high: 6 };

/** The scene's height range: the default range grown to every object's height. */
export function heightRange(scene: AudioTestScene): [number, number] {
  let lo = DEFAULT_HEIGHTS[0], hi = DEFAULT_HEIGHTS[1];
  for (const o of allObjects(scene)) {
    const b = boxOf(o);
    if (b) {
      lo = Math.min(lo, b.bottom);
      hi = Math.max(hi, b.top);
      continue;
    }
    const p = positionOf(o);
    if (p) {
      lo = Math.min(lo, p.y);
      hi = Math.max(hi, p.y);
    }
  }
  return [Math.floor(lo), Math.ceil(hi)];
}

/** The slab's range now: the listener's height ±3 m (kept inside `range`), or the manual one. */
export function slabRange(slab: Slab, listenerY: number, range: readonly [number, number]): [number, number] {
  if (!slab.follow) return [slab.low, slab.high];
  let lo = listenerY - FOLLOW_HALF, hi = listenerY + FOLLOW_HALF;
  if (lo < range[0]) [lo, hi] = [range[0], range[0] + FOLLOW_HALF * 2];
  if (hi > range[1]) [lo, hi] = [Math.max(range[0], range[1] - FOLLOW_HALF * 2), range[1]];
  return [lo, hi];
}

/** Whether a height (a point) or a span (a box's bottom..top) is in the slab. */
export function inSlab(range: readonly [number, number], lo: number, hi = lo): boolean {
  return hi >= range[0] - 1e-9 && lo <= range[1] + 1e-9;
}

/** The slab moved so its middle is at `center` (keeping its height, inside `range`); following stops. */
export function moveSlab(slab: Slab, current: readonly [number, number], center: number, range: readonly [number, number]): Slab {
  const h = current[1] - current[0];
  let low = center - h / 2;
  low = Math.min(range[1] - h, Math.max(range[0], low));
  return { follow: false, low: round(low), high: round(low + h) };
}

/** One edge of the slab dragged to `y` (the other stays; at least `MIN_SLAB` apart); following stops. */
export function dragSlabEdge(current: readonly [number, number], edge: "low" | "high", y: number, range: readonly [number, number]): Slab {
  const v = Math.min(range[1], Math.max(range[0], y));
  if (edge === "low") return { follow: false, low: round(Math.min(v, current[1] - MIN_SLAB)), high: current[1] };
  return { follow: false, low: current[0], high: round(Math.max(v, current[0] + MIN_SLAB)) };
}

const round = (v: number) => Math.round(v * 10) / 10;

/** A height relative to the listener's, when at least a metre off: "↑6 m", "↓1 m"; else "". */
export function relativeHeight(y: number, listenerY: number): string {
  const d = y - listenerY;
  if (Math.abs(d) < 1) return "";
  return `${d > 0 ? "↑" : "↓"}${Math.round(Math.abs(d))} m`;
}

/** One object's height on the strip. */
export interface HeightMark {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly name: string;
  /** A box's bottom..top; a point's height twice. */
  readonly low: number;
  readonly high: number;
  readonly point: boolean;
  readonly active: boolean;
}

/** Every visible object's height (2D sounds have none). */
export function heightMarks(scene: AudioTestScene): HeightMark[] {
  const active = activeListener(scene).id;
  const out: HeightMark[] = [];
  for (const o of allObjects(scene)) {
    if (o.obj.hidden && o.obj.id !== active) continue;
    const b = boxOf(o);
    if (b) {
      out.push({ id: o.obj.id, kind: o.kind, name: o.obj.name, low: b.bottom, high: b.top, point: false, active: false });
      continue;
    }
    const p = positionOf(o);
    if (p) out.push({ id: o.obj.id, kind: o.kind, name: o.obj.name, low: p.y, high: p.y, point: true, active: o.obj.id === active });
  }
  return out;
}

/** The objects whose height is within `range`: the strip's "In range" menu. */
export const inRange = (scene: AudioTestScene, range: readonly [number, number]): HeightMark[] => heightMarks(scene).filter((m) => inSlab(range, m.low, m.high));

/** A box's bottom and top moved together so its bottom is at `bottom` (a bar dragged: thickness kept). */
export const shiftSpan = (low: number, high: number, bottom: number): [number, number] => [round(bottom), round(bottom + (high - low))];

/** Raising or lowering the listener: the step, metres. */
export const LISTENER_STEP = 1;
