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
 */
import { evalCurve } from "../core/curve";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { timingCurve } from "./animation/timingCurves";
import type { UICanvas, UIComponentType } from "./components";
import { uiInteractions } from "./interactions";
import type { UILaidOutElement, UIScrollInfo } from "./uiCoreTypes";

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

const EASE = timingCurve({ kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })!;

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
}

interface Momentum {
  vx: number;
  vy: number;
  wroteX: number;
  wroteY: number;
}

class Scrolling {
  readonly animations = new Map<UIScrollable, Animation>();
  readonly momentum = new Map<UIScrollable, Momentum>();
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

function clamp(v: number, max: number | undefined): number {
  if (!Number.isFinite(v)) return 0;
  return max === undefined ? Math.max(0, v) : Math.min(Math.max(0, v), max);
}

/** Whether `comp` scrolls smoothly for `behavior`. */
function smooth(comp: UIScrollable, behavior: UIScrollBehaviorOption): boolean {
  return behavior === "smooth" || (behavior === "auto" && comp.scrollBehavior === "smooth");
}

/** Scroll `comp` to `x`, `y` (UI pixels; null keeps an axis), clamped to its range when it's laid out. */
export function uiScrollTo(world: World, comp: UIScrollable, x: number | null, y: number | null, behavior: UIScrollBehaviorOption = "auto"): void {
  const info = uiScrollInfo(world, comp);
  const s = stateOf(world);
  s.momentum.delete(comp);
  const running = s.animations.get(comp);
  const fromX = comp.scrollX, fromY = comp.scrollY;
  const toX = x === null ? (running?.toX ?? fromX) : clamp(x, info?.maxX);
  const toY = y === null ? (running?.toY ?? fromY) : clamp(y, info?.maxY);
  if (smooth(comp, behavior) && info && (toX !== fromX || toY !== fromY)) {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    s.animations.set(comp, { fromX, fromY, toX, toY, elapsed: 0, duration: Math.min(0.5, 0.2 + distance / 3000), wroteX: fromX, wroteY: fromY });
    return;
  }
  s.animations.delete(comp);
  comp.scrollX = toX;
  comp.scrollY = toY;
}

/** Scroll `comp` by `dx`, `dy` from where it is (or, mid-animation, from where that's going). */
export function uiScrollBy(world: World, comp: UIScrollable, dx: number, dy: number, behavior: UIScrollBehaviorOption = "auto"): void {
  const running = stateOf(world).animations.get(comp);
  const x = (running?.toX ?? comp.scrollX) + (Number.isFinite(dx) ? dx : 0);
  const y = (running?.toY ?? comp.scrollY) + (Number.isFinite(dy) ? dy : 0);
  uiScrollTo(world, comp, x, y, behavior);
}

/** Keep a touch or pen drag's scroll going at `vx`, `vy` UI pixels a second (ADR 0423: momentum). */
export function uiStartMomentum(world: World, comp: UIScrollable, vx: number, vy: number): void {
  if (Math.hypot(vx, vy) < MOMENTUM_STOP) return;
  stateOf(world).momentum.set(comp, { vx, vy, wroteX: comp.scrollX, wroteY: comp.scrollY });
}

/** Stop `comp`'s momentum and smooth scrolling (a press on it, or a drag taking it). */
export function uiStopScrolling(world: World, comp: UIScrollable): void {
  const s = stateOf(world);
  s.momentum.delete(comp);
  s.animations.delete(comp);
}

/** True while `comp` scrolls smoothly or with momentum. */
export function uiScrollMoving(world: World, comp: UIScrollable): boolean {
  const s = states.get(world);
  return !!s && (s.animations.has(comp) || s.momentum.has(comp));
}

/** The routing core, each frame before laying out: move smooth scrolls and momentum on by `dt` seconds. */
export function advanceUIScrolling(world: World, dt: number): void {
  const s = states.get(world);
  if (!s) return;
  for (const [comp, a] of s.animations) {
    if (!comp.node.isValid || comp.scrollX !== a.wroteX || comp.scrollY !== a.wroteY) {
      s.animations.delete(comp); // removed, or a script wrote the field
      continue;
    }
    a.elapsed += Math.max(0, dt);
    const p = a.elapsed >= a.duration ? 1 : evalCurve(EASE, a.elapsed / a.duration);
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
    const x = clamp(comp.scrollX + m.vx * t, info?.maxX);
    const y = clamp(comp.scrollY + m.vy * t, info?.maxY);
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
    const toX = clamp(s.x + alignDelta(x - s.client.x, w, s.clientWidth, inline), s.maxX);
    const toY = clamp(s.y + alignDelta(y - s.client.y, h, s.clientHeight, block), s.maxY);
    x -= toX - s.x;
    y -= toY - s.y;
    if (toX !== s.x || toY !== s.y) uiScrollTo(world, e.comp as UIScrollable, toX, toY, behavior);
  }
}

/** Whether a scroller can move by `d` along an axis from `at` within `[0, max]`. */
export function canMove(at: number, max: number, d: number): boolean {
  return (d < 0 && at > 0.01) || (d > 0 && at < max - 0.01);
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
