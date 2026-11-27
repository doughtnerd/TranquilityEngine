/**
 * Scrolling (ADR 0423): what scripts, navigation and the UI core's input share to move an element's `scrollX`/`scrollY`.
 * Nothing here is public API; hosted elements and the Svelte renderer's nodes offer it as the DOM's scrolling
 * members (`scrollTo`, `scrollBy`, `scrollIntoView`, `scrollTop`…).
 *
 * - **Where things are.** Scroll ranges come from the UI core's last layout (`UILaidOutElement.scroll`), read through the
 *   World's interaction log (`layout`), so this works on whatever core routes the World's pointer. Before a layout,
 *   offsets are written as asked and the core clamps them at its next one.
 * - **Smooth scrolling** (`behavior: "smooth"`, or `scroll-behavior: smooth` with `auto`) eases from where the element is
 *   to where it's going with CSS's `ease` over 0.2 s to 0.5 s (longer for further), advanced by the routing core each
 *   frame on the unscaled clock (`advanceUIScrolling`). A script writing the field meanwhile wins, as with transitions.
 * - **Momentum**: a touch or pen drag that lets go while moving keeps scrolling, slowing exponentially (`MOMENTUM_DECAY`
 *   per second) until it's slower than 20 UI pixels a second or reaches an end.
 * - **Snapping** (ADR 0428, `scrollSnap.ts` chooses where): `scrollTo` and `scrollIntoView` snap as explicit scrolls,
 *   `scrollBy` and keys as directional ones; the wheel scrolls at once and snaps (smoothly) once it has been still
 *   for `WHEEL_SETTLE`; a drag let go eases (`ease-out`) to the position nearest its momentum's end instead of
 *   coasting. Each snap remembers the area it rests on, and the routing core's layout snaps to it again when the
 *   layout moves it (`uiResnap`), or, for `mandatory`, to the nearest position when nothing holds the offset there.
 * - **Ranges** (ADR 0428): an axis scrolling from its end has offsets from a negative `min` up to 0.
 */
import { evalCurve } from "../core/curve";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { timingCurve } from "./animation/timingCurves";
import type { UICanvas, UIComponentType } from "./components";
import { uiInteractions } from "./interactions";
import { chooseSnap, type UISnapMode } from "./scrollSnap";
import type { UILaidOutElement, UIScrollInfo, UIScrollSnap } from "./uiCoreTypes";

/** An element that can scroll (any element; it scrolls when its `overflow` clips). */
export type UIScrollable = Exclude<UIComponentType, UICanvas>;

/** How a scripted scroll moves: `smooth` animates, `instant` jumps, `auto` follows the element's `scrollBehavior`. */
export type UIScrollBehaviorOption = "auto" | "smooth" | "instant";

/** Where `scrollIntoView` puts the element in each scrolling ancestor, as the DOM's `ScrollIntoViewOptions`. */
export type UIScrollAlignment = "start" | "center" | "end" | "nearest";

export interface UIScrollIntoViewOptions {
  readonly block?: UIScrollAlignment;
  readonly inline?: UIScrollAlignment;
  readonly behavior?: UIScrollBehaviorOption;
}

/** Momentum's slowdown: velocity is multiplied by e^(−MOMENTUM_DECAY · seconds). */
export const MOMENTUM_DECAY = 3.5;
/** Momentum ends below this speed, UI pixels per second. */
const MOMENTUM_STOP = 20;
/** ADR 0428: a snapping scroller snaps once the wheel has been still this long (seconds). */
export const WHEEL_SETTLE = 0.12;

const EASE = timingCurve({ kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })!;
const EASE_OUT = timingCurve({ kind: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 })!;

/**
 * ADR 0428: how a scroll snaps. `explicit` (`scrollTo`, `scrollIntoView`) and `directional` (`scrollBy`, keys) as CSS
 * Scroll Snap's kinds; `none` for moves that snap only when they end (a drag, the wheel, a thumb).
 */
export type UIScrollSnapKind = "explicit" | "directional" | "none";

interface Animation {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  elapsed: number;
  duration: number;
  /** What it last wrote, to see a script writing the field (which stops it). */
  wroteX: number;
  wroteY: number;
  curve: typeof EASE;
}

interface Momentum {
  vx: number;
  vy: number;
  wroteX: number;
  wroteY: number;
}

/** ADR 0428: the snap area an axis rests on, and the offset it put it at. */
interface Snapped {
  area: UIComponentType;
  at: number;
}

/** ADR 0428: a wheel gesture on a snapping scroller: where it started, and how long the wheel has been still. */
interface WheelGesture {
  fromX: number;
  fromY: number;
  idle: number;
}

class Scrolling {
  readonly animations = new Map<UIScrollable, Animation>();
  readonly momentum = new Map<UIScrollable, Momentum>();
  readonly snapped = new Map<UIScrollable, { x: Snapped | null; y: Snapped | null }>();
  readonly wheel = new Map<UIScrollable, WheelGesture>();
}

const states = new WeakMap<World, Scrolling>();

function stateOf(world: World): Scrolling {
  let s = states.get(world);
  if (!s) states.set(world, (s = new Scrolling()));
  return s;
}

/** The element as laid out at the World's last layout, or null. */
export function uiLaidOut(world: World, comp: UIComponentType): UILaidOutElement | null {
  const layout = uiInteractions(world).layout;
  if (!layout) return null;
  for (const e of layout.elements()) if (e.comp === comp) return e;
  return null;
}

/** An element's scroll state at the last layout (null: it doesn't clip, or isn't laid out). */
export function uiScrollInfo(world: World, comp: UIComponentType): UIScrollInfo | null {
  return uiLaidOut(world, comp)?.scroll ?? null;
}

/** `v` within `[min, max]`; before a layout (no range), only made finite. */
function clamp(v: number, min: number | undefined, max: number | undefined): number {
  if (!Number.isFinite(v)) return 0;
  return min === undefined || max === undefined ? v : Math.min(Math.max(min, v), max);
}

/** ADR 0428: options of a scroll that snaps. */
interface SnapOptions {
  readonly snap?: UIScrollSnapKind;
}

/** Remember (or forget) the snap area `comp` rests on along `axis`. */
function noteSnap(s: Scrolling, comp: UIScrollable, axis: "x" | "y", area: UIComponentType | null, at: number): void {
  let rec = s.snapped.get(comp);
  if (!rec) s.snapped.set(comp, (rec = { x: null, y: null }));
  rec[axis] = area ? { area, at } : null;
}

/** ADR 0428: where a scroll from `from` toward `to` rests on `axis`, noting the area (or none) it rests on. */
function snapped(s: Scrolling, comp: UIScrollable, info: UIScrollInfo, snap: UIScrollSnap, axis: "x" | "y", from: number, to: number, mode: UISnapMode, keep?: { start: number; size: number } | null): number {
  if (!snap[axis]) return to;
  const min = axis === "x" ? info.minX : info.minY, max = axis === "x" ? info.maxX : info.maxY;
  const client = axis === "x" ? info.clientWidth : info.clientHeight;
  const choice = chooseSnap(snap, { axis, min, max, from, to, mode, keep: keep ? { ...keep, client } : null });
  noteSnap(s, comp, axis, choice.area, choice.to);
  return choice.to;
}

/** Whether `comp` scrolls smoothly for `behavior`. */
function smooth(comp: UIScrollable, behavior: UIScrollBehaviorOption): boolean {
  return behavior === "smooth" || (behavior === "auto" && comp.scrollBehavior === "smooth");
}

/**
 * Scroll `comp` to `x`, `y` (UI pixels; null keeps an axis), clamped to its range when it's laid out. ADR 0428: on a
 * snapping scroller an axis given rests on a snap position as `options.snap` says (`explicit` by default).
 */
export function uiScrollTo(world: World, comp: UIScrollable, x: number | null, y: number | null, behavior: UIScrollBehaviorOption = "auto", options: SnapOptions = {}): void {
  const info = uiScrollInfo(world, comp);
  const s = stateOf(world);
  s.momentum.delete(comp);
  s.wheel.delete(comp);
  const running = s.animations.get(comp);
  const fromX = comp.scrollX, fromY = comp.scrollY;
  let toX = x === null ? (running?.toX ?? fromX) : clamp(x, info?.minX, info?.maxX);
  let toY = y === null ? (running?.toY ?? fromY) : clamp(y, info?.minY, info?.maxY);
  const kind = options.snap ?? "explicit";
  const snap = info?.snap;
  if (info && snap && kind !== "none") {
    const mode: UISnapMode = kind === "directional" ? "directional" : "explicit";
    if (x !== null) toX = snapped(s, comp, info, snap, "x", running?.toX ?? fromX, toX, mode);
    if (y !== null) toY = snapped(s, comp, info, snap, "y", running?.toY ?? fromY, toY, mode);
  }
  if (smooth(comp, behavior) && info && (toX !== fromX || toY !== fromY)) animate(s, comp, toX, toY, EASE);
  else {
    s.animations.delete(comp);
    comp.scrollX = toX;
    comp.scrollY = toY;
  }
}

/** Ease `comp` from where it is to `toX`, `toY` over `duration`, else 0.2–0.5 s (longer for further). */
function animate(s: Scrolling, comp: UIScrollable, toX: number, toY: number, curve: typeof EASE, duration?: number): void {
  const fromX = comp.scrollX, fromY = comp.scrollY;
  const distance = Math.hypot(toX - fromX, toY - fromY);
  s.animations.set(comp, { fromX, fromY, toX, toY, elapsed: 0, duration: duration ?? Math.min(0.5, 0.2 + distance / 3000), wroteX: fromX, wroteY: fromY, curve });
}

/**
 * Scroll `comp` by `dx`, `dy` from where it is (or, mid-animation, from where that's going). ADR 0428: a directional
 * scroll on a snapping scroller (it moves on to a snap position past where it is), unless `snap` says otherwise.
 */
export function uiScrollBy(world: World, comp: UIScrollable, dx: number, dy: number, behavior: UIScrollBehaviorOption = "auto", snap: UIScrollSnapKind = "directional"): void {
  const running = stateOf(world).animations.get(comp);
  const x = (running?.toX ?? comp.scrollX) + (Number.isFinite(dx) ? dx : 0);
  const y = (running?.toY ?? comp.scrollY) + (Number.isFinite(dy) ? dy : 0);
  uiScrollTo(world, comp, dx !== 0 ? x : null, dy !== 0 ? y : null, behavior, { snap });
}

/**
 * ADR 0423/0428: the wheel's default action: scroll `comp` by `dx`, `dy` at once. A snapping scroller then snaps,
 * smoothly, once the wheel has been still for `WHEEL_SETTLE` (a directional snap from where the gesture started).
 */
export function uiWheelScroll(world: World, comp: UIScrollable, dx: number, dy: number): void {
  const s = stateOf(world);
  const info = uiScrollInfo(world, comp);
  const from = s.wheel.get(comp) ?? { fromX: comp.scrollX, fromY: comp.scrollY, idle: 0 };
  uiScrollBy(world, comp, dx, dy, "instant", "none");
  if (info?.snap) s.wheel.set(comp, { ...from, idle: 0 });
}

/**
 * A touch or pen drag (or a scrollbar thumb, at 0 speed) let go: keep it going at `vx`, `vy` UI pixels a second (ADR
 * 0423: momentum). ADR 0428: on a snapping scroller it eases instead to the snap position nearest where the momentum
 * would end (`fromX`, `fromY`: where the gesture started, for `scroll-snap-stop`).
 */
export function uiEndScrollGesture(world: World, comp: UIScrollable, vx: number, vy: number, fromX: number, fromY: number): void {
  const s = stateOf(world);
  const info = uiScrollInfo(world, comp);
  const snap = info?.snap;
  if (info && snap) {
    const coast = (v: number) => (Math.abs(v) < MOMENTUM_STOP ? 0 : v / MOMENTUM_DECAY);
    const endX = clamp(comp.scrollX + coast(vx), info.minX, info.maxX);
    const endY = clamp(comp.scrollY + coast(vy), info.minY, info.maxY);
    const toX = snap.x ? snapped(s, comp, info, snap, "x", fromX, endX, "end") : endX;
    const toY = snap.y ? snapped(s, comp, info, snap, "y", fromY, endY, "end") : endY;
    s.momentum.delete(comp);
    if (toX === comp.scrollX && toY === comp.scrollY) return;
    const speed = Math.hypot(vx, vy);
    const duration = speed > MOMENTUM_STOP ? Math.min(1, Math.max(0.25, Math.log(speed / MOMENTUM_STOP) / MOMENTUM_DECAY)) : undefined;
    animate(s, comp, toX, toY, EASE_OUT, duration);
    return;
  }
  if (Math.hypot(vx, vy) < MOMENTUM_STOP) return;
  s.momentum.set(comp, { vx, vy, wroteX: comp.scrollX, wroteY: comp.scrollY });
}

/** Stop `comp`'s momentum and smooth scrolling (a press on it, or a drag taking it). */
export function uiStopScrolling(world: World, comp: UIScrollable): void {
  const s = stateOf(world);
  s.momentum.delete(comp);
  s.animations.delete(comp);
  s.wheel.delete(comp);
}

/** True while `comp` scrolls smoothly or with momentum, or (ADR 0428) waits to snap after the wheel. */
export function uiScrollMoving(world: World, comp: UIScrollable): boolean {
  const s = states.get(world);
  return !!s && (s.animations.has(comp) || s.momentum.has(comp) || s.wheel.has(comp));
}

/**
 * ADR 0428: at the routing core's layout, a scroller's offsets `x`, `y` (clamped) snapped again, unless something moves
 * it (the core leaves out one a gesture holds). An axis resting on a snap area follows it where the layout moved it;
 * otherwise a `mandatory` axis goes to the nearest position.
 */
export function uiResnap(world: World, comp: UIScrollable, info: UIScrollInfo, x: number, y: number): { x: number; y: number } {
  const snap = info.snap;
  if (!snap) {
    states.get(world)?.snapped.delete(comp);
    return { x, y };
  }
  if (uiScrollMoving(world, comp)) return { x, y };
  const st = stateOf(world);
  const axis = (a: "x" | "y", cur: number): number => {
    if (!snap[a]) {
      noteSnap(st, comp, a, null, cur);
      return cur;
    }
    const min = a === "x" ? info.minX : info.minY, max = a === "x" ? info.maxX : info.maxY;
    const r = st.snapped.get(comp)?.[a];
    if (r && Math.abs(r.at - cur) <= 0.5) {
      const area = snap.areas.find((e) => e.comp === r.area && e[a] !== null);
      if (area) return (r.at = clamp(area[a]!, min, max));
    }
    if (!snap.mandatory) {
      noteSnap(st, comp, a, null, cur);
      return cur;
    }
    return snapped(st, comp, info, snap, a, cur, cur, "explicit");
  };
  return { x: axis("x", x), y: axis("y", y) };
}

/** The routing core, each frame before laying out: move smooth scrolls and momentum on by `dt` seconds. */
export function advanceUIScrolling(world: World, dt: number): void {
  const s = states.get(world);
  if (!s) return;
  // ADR 0428: a wheel gesture on a snapping scroller, still for long enough, snaps (smoothly).
  for (const [comp, w] of s.wheel) {
    if (!comp.node.isValid) {
      s.wheel.delete(comp);
      continue;
    }
    w.idle += Math.max(0, dt);
    if (w.idle < WHEEL_SETTLE) continue;
    s.wheel.delete(comp);
    const info = uiScrollInfo(world, comp);
    if (!info?.snap) continue;
    const toX = snapped(s, comp, info, info.snap, "x", w.fromX, comp.scrollX, "directional");
    const toY = snapped(s, comp, info, info.snap, "y", w.fromY, comp.scrollY, "directional");
    if (toX !== comp.scrollX || toY !== comp.scrollY) animate(s, comp, toX, toY, EASE);
  }
  for (const [comp, a] of s.animations) {
    if (!comp.node.isValid || comp.scrollX !== a.wroteX || comp.scrollY !== a.wroteY) {
      s.animations.delete(comp); // removed, or a script wrote the field
      continue;
    }
    a.elapsed += Math.max(0, dt);
    const p = a.elapsed >= a.duration ? 1 : evalCurve(a.curve, a.elapsed / a.duration);
    comp.scrollX = a.wroteX = a.fromX + (a.toX - a.fromX) * p;
    comp.scrollY = a.wroteY = a.fromY + (a.toY - a.fromY) * p;
    if (a.elapsed >= a.duration) s.animations.delete(comp);
  }
  for (const [comp, m] of s.momentum) {
    if (!comp.node.isValid || comp.scrollX !== m.wroteX || comp.scrollY !== m.wroteY) {
      s.momentum.delete(comp);
      continue;
    }
    const info = uiScrollInfo(world, comp);
    const t = Math.max(0, dt);
    const x = clamp(comp.scrollX + m.vx * t, info?.minX, info?.maxX);
    const y = clamp(comp.scrollY + m.vy * t, info?.minY, info?.maxY);
    const decay = Math.exp(-MOMENTUM_DECAY * t);
    m.vx = x === comp.scrollX && m.vx !== 0 && t > 0 ? 0 : m.vx * decay;
    m.vy = y === comp.scrollY && m.vy !== 0 && t > 0 ? 0 : m.vy * decay;
    comp.scrollX = m.wroteX = x;
    comp.scrollY = m.wroteY = y;
    if (Math.hypot(m.vx, m.vy) < MOMENTUM_STOP) s.momentum.delete(comp);
  }
}

/** Where along one axis `[start, start + size]` (relative to the viewport) should go for `align` in a viewport `client` long: the scroll change. */
function alignDelta(start: number, size: number, client: number, align: UIScrollAlignment): number {
  const end = start + size;
  switch (align) {
    case "start":
      return start;
    case "end":
      return end - client;
    case "center":
      return start + size / 2 - client / 2;
    case "nearest":
      if (start < 0 && end > client) return 0; // already covers the viewport
      if (start < 0) return size > client ? end - client : start;
      if (end > client) return size > client ? start : end - client;
      return 0;
  }
}

/**
 * Scroll each of `comp`'s scrolling ancestors (innermost first) so it shows, as the DOM's `scrollIntoView`: `block`
 * (vertical, default `start`) and `inline` (horizontal, default `nearest`) say where in each. Uses its laid-out box
 * (transforms aside).
 */
export function uiScrollIntoView(world: World, comp: UIComponentType, options: UIScrollIntoViewOptions = {}): void {
  const layout = uiInteractions(world).layout;
  if (!layout) return;
  const byNode = new Map<GameObject, UILaidOutElement>();
  let target: UILaidOutElement | null = null;
  for (const e of layout.elements()) {
    byNode.set(e.comp.owner, e);
    if (e.comp === comp) target = e;
  }
  if (!target) return;
  const block = options.block ?? "start";
  const inline = options.inline ?? "nearest";
  const behavior = options.behavior ?? "auto";
  let x = target.x, y = target.y;
  const w = target.width, h = target.height;
  for (let n = comp.owner.parent; n?.isValid; n = n.parent) {
    const e = byNode.get(n);
    if (!e) continue;
    const s = e.scroll;
    if (!s) continue;
    // ADR 0428: in `rtl` the inline start is the right edge.
    const along = rtlAt(n, byNode) ? (inline === "start" ? "end" : inline === "end" ? "start" : inline) : inline;
    let toX = clamp(s.x + alignDelta(x - s.client.x, w, s.clientWidth, along), s.minX, s.maxX);
    let toY = clamp(s.y + alignDelta(y - s.client.y, h, s.clientHeight, block), s.minY, s.maxY);
    if (s.snap) {
      // ADR 0428: rest on a snap position, one that keeps the element in view where one does.
      const st = stateOf(world), sc = e.comp as UIScrollable;
      toX = snapped(st, sc, s, s.snap, "x", s.x, toX, "explicit", { start: x - s.client.x + s.x, size: w });
      toY = snapped(st, sc, s, s.snap, "y", s.y, toY, "explicit", { start: y - s.client.y + s.y, size: h });
    }
    x -= toX - s.x;
    y -= toY - s.y;
    if (toX !== s.x || toY !== s.y) uiScrollTo(world, e.comp as UIScrollable, toX, toY, behavior, { snap: "none" });
  }
}

/** ADR 0428: whether the element on `node` is `rtl`: its own `direction`, else its nearest laid-out ancestor's (else `ltr`). */
function rtlAt(node: GameObject | null, byNode: ReadonlyMap<GameObject, UILaidOutElement>): boolean {
  for (let n = node; n?.isValid; n = n.parent) {
    const comp = byNode.get(n)?.comp;
    if (!comp || !isScrollable(comp)) continue;
    if (comp.direction) return comp.direction === "rtl";
  }
  return false;
}

/** Whether a scroller can move by `d` along an axis from `at` within `[min, max]`. */
export function canMove(at: number, min: number, max: number, d: number): boolean {
  return (d < 0 && at > min + 0.01) || (d > 0 && at < max - 0.01);
}

// --- The DOM's scrolling members, as hosted elements and renderer nodes offer them ---------------

/** `scrollTo`/`scrollBy`'s arguments: `(x, y)` or `({ left, top, behavior })`. */
export type UIScrollToArgs = [x?: number | { readonly left?: number; readonly top?: number; readonly behavior?: UIScrollBehaviorOption }, y?: number];

/** `element.scrollTo(…)` (`by`: `scrollBy`) on `comp`: canvases and elements that don't clip ignore it, as the DOM's do. */
export function uiScrollToArgs(world: World, comp: UIComponentType, args: UIScrollToArgs, by: boolean): void {
  if (!isScrollable(comp)) return;
  const [a, b] = args;
  let x: number | null = null, y: number | null = null, behavior: UIScrollBehaviorOption = "auto";
  if (typeof a === "object" && a !== null) {
    x = typeof a.left === "number" ? a.left : null;
    y = typeof a.top === "number" ? a.top : null;
    behavior = a.behavior ?? "auto";
  } else {
    x = typeof a === "number" ? a : null;
    y = typeof b === "number" ? b : null;
  }
  if (by) uiScrollBy(world, comp, x ?? 0, y ?? 0, behavior);
  else uiScrollTo(world, comp, x, y, behavior);
}

/** `element.scrollIntoView(arg)`: `true` or nothing aligns to the start, `false` to the end, or the options. */
export function uiScrollIntoViewArg(world: World, comp: UIComponentType, arg?: boolean | UIScrollIntoViewOptions): void {
  const options: UIScrollIntoViewOptions = arg === false ? { block: "end", inline: "nearest" } : typeof arg === "object" && arg !== null ? arg : { block: "start", inline: "nearest" };
  uiScrollIntoView(world, comp, options);
}

/** `scrollWidth`, `scrollHeight`, `clientWidth`, `clientHeight` (UI pixels) from the last layout: the padding box and the content's extent; zero before a layout. */
export function uiScrollSizes(world: World, comp: UIComponentType): { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } {
  const e = uiLaidOut(world, comp);
  if (!e) return { scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0 };
  const s = e.scroll;
  if (s) return { scrollWidth: s.scrollWidth, scrollHeight: s.scrollHeight, clientWidth: s.clientWidth, clientHeight: s.clientHeight };
  // Not clipping: its padding box, and content no larger than it (borders aren't known here: its box).
  return { scrollWidth: e.width, scrollHeight: e.height, clientWidth: e.width, clientHeight: e.height };
}

/** True for a component with scroll fields (any element; a canvas has none). */
export function isScrollable(comp: UIComponentType): comp is UIScrollable {
  return "scrollX" in comp;
}
