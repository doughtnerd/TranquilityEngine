/**
 * The UI animator (ADR 0422 wave 4): runs the transitions and keyframe animations the cascade declares on UI
 * elements and on the UI host's elements (Svelte views), on the tween backend (ADR 0424: the animation core's tween
 * table when the animation plugin is on, else the standalone tween module), on the World's unscaled clock.
 *
 * - **Starting.** After restyling an element, its owner (a hosted tree's styled tree, ADR 0438) hands over what changed
 *   (`styled`): each field written, with the value it showed before. A changed field its `transition-property` covers
 *   starts a transition from the value shown (mid-transition values included) to the new one. A name new to
 *   `animation-name`, or an element appearing with one, starts that animation; a name gone stops it.
 * - **Running.** One World's animator owns one backend (a World id in its module). Each frame, in `engine.UIAnimation`
 *   (late update, right after the UI host's sync, so a class change starts its transition the same frame,
 *   and outside any World's animation evaluate-to-apply span, as the core-backed backend's update needs, 0424 as built)
 *   it advances its runs, creates the tweens due, updates the backend once (`PASS_NORMAL`, tweens on `TIME_UNSCALED`)
 *   and writes the values back to the fields.
 * - **Segments.** A transition is one segment; an animation's track (one field) is its keyframes' segments, iteration
 *   after iteration, backwards in reversed iterations. The track's current segment is a tween created on the frame the
 *   segment starts, with a delay placing its start exactly (`start − last frame's time`), easing through the timing
 *   function's engine curve (cached per distinct function and direction). A segment entered part-way (a negative delay,
 *   a resumed animation, the backend still loading, a last iteration cut short) is evaluated here from the same curve.
 * - **Time.** The animator keeps each run's time itself (seconds since it started, unscaled), so delays, iterations,
 *   fill modes, play state and ends are decided here, and the backend only eases values.
 * - **Reversing** (ADR 0432, CSS's reversing shortening): a transition whose element changes back to the value it
 *   started from, part-way, runs back over the share of its duration it had covered (its eased progress, carried
 *   through repeated reversals), not the whole duration.
 * - **Discrete values** (ADR 0432): with `transition-behavior: allow-discrete`, a field whose values don't interpolate
 *   transitions too, flipping half way (`display` shows its value that isn't `none` throughout, as CSS's does).
 * - **Inheritance** (ADR 0432): each value written to a field children inherit goes to the owner's `_animatedWrite`,
 *   so the children that inherit it show it in the same frame.
 * - **Scripts win.** A field a script writes directly (its value isn't what the animator last wrote) stops that field's
 *   transition, or that field of an animation, as an inline style would.
 * - **Events** (`transitionend`, `animationstart`, `animationiteration`, `animationend`) are queued for their owner,
 *   which delivers them in the next frame's event step, like other UI events.
 * - **Played keyframes** (`play`, ADR 0423: a Svelte transition's or `animate:`'s keyframes, through the renderer's
 *   `animate` hook) run as an animation of the element's own, kept across restyles and drawn over its stylesheet
 *   animations: one iteration, linear between keyframes (Svelte samples its easing into them), its last values held
 *   until it's stopped, no CSS events. Its hooks run after the frame's values are written: `onFrame` while it runs,
 *   `onEnd` once at its end. One played in those hooks (the next keyframes, after a delay's) starts in that frame.
 *
 * Internal: the owners call it; games see only the CSS.
 */
import { evalCurve, type Curve } from "../../core/curve";
import { Color, Vector2 } from "../../core/math";
import type { FieldInfo } from "../../core/registry";
import { defineBuiltinSystem } from "../../core/systems";
import type { World } from "../../core/World";
import { openTweenBackend, type TweenBackend } from "../../tween/backend";
import { PASS_NORMAL } from "../../tween/wasm/wire/core";
import { EASE_LINEAR, KIND_VALUE, OP_KILL, OP_PAUSE, OP_RESUME, TIME_UNSCALED } from "../../tween/wasm/wire/tween";
import type { UIAnimationSpec, UITimingFunction, UITransitionSpec } from "../document/animationValues";
import type { UIComponentType } from "../components";
import { animatedKind, animatedPair, type AnimatedKind, type AnimatedPair } from "./animatedValues";
import { timingCurve, timingKey } from "./timingCurves";

// --- What owners hand over -------------------------------------------------------------------------

/** A UI animation event, delivered by the element's owner one frame after it happened. */
export interface UIAnimationEvent {
  readonly type: "transitionend" | "animationstart" | "animationiteration" | "animationend";
  /** `transitionend`: the property that finished (kebab-case, `background-color`); "" for animations. */
  readonly propertyName: string;
  /** Animation events: the animation's name; "" for transitions. */
  readonly animationName: string;
  /** Seconds the transition or animation had run when it happened, delays not counted. */
  readonly elapsedTime: number;
}

/** What an owner may also do: hear every value the animator writes (ADR 0432: so inherited values reach children per frame). */
export interface UIAnimationOwner {
  _animatedWrite?(element: object, field: string, value: unknown): void;
}

/** An element just restyled, as its owner describes it. */
export interface UIStyledElement {
  /** The document or hosted tree: its events go back to it (`takeUIAnimationEvents`). */
  readonly owner: object;
  /** Its element object, handed back with its events. */
  readonly element: object;
  readonly comp: UIComponentType;
  readonly fields: ReadonlyMap<string, FieldInfo>;
  /** False in a scene being edited: nothing animates there, values are set at once. */
  readonly animate: boolean;
  /**
   * ADR 0432: fields of `fields` the component doesn't have, which it only passes on to its children (a panel's
   * `color`): their animated values go to the owner's `_animatedWrite`, never to the component.
   */
  readonly virtual?: ReadonlySet<string>;
}

/** One field the restyle wrote: the value shown before and the cascade's new value. */
export interface UIStyleWrite {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** A transition the element declares, with the fields its property covers. */
export interface UIResolvedTransition {
  readonly spec: UITransitionSpec;
  readonly fields: readonly string[];
}

/** One stop of a keyframe track (`cascade.ts`'s `UIKeyframeStop`). */
export interface UIAnimationStop {
  readonly offset: number;
  readonly value: unknown;
  readonly timing: UITimingFunction | null;
}

/** An animation the element declares, with its keyframe tracks (read only when it starts; null: no such `@keyframes`). */
export interface UIResolvedAnimation {
  readonly spec: UIAnimationSpec;
  tracks(): ReadonlyMap<string, readonly UIAnimationStop[]> | null;
}

// --- Runs --------------------------------------------------------------------------------------------

interface Stop {
  readonly offset: number;
  readonly value: unknown;
  readonly timing: UITimingFunction;
}

interface Track {
  readonly field: string;
  readonly kind: AnimatedKind;
  readonly stops: readonly Stop[];
  /** The current segment's id (iteration × stops + index), or -1. */
  seg: number;
  /** How the current segment runs: a tween on the backend, or evaluated here. */
  mode: "none" | "tween" | "js";
  handle: number;
  column: number;
  segStart: number;
  segEnd: number;
  pair: AnimatedPair | null;
  /** The value the backend output for it this frame, or undefined. */
  out: unknown;
  /** A script wrote the field: the track no longer writes it. */
  overridden: boolean;
  /** The restyle wrote the field: write it again even if the value didn't change. */
  dirty: boolean;
  /** Its value once its animation ended with `fill: forwards`/`both`. */
  held: unknown;
}

/** What a played animation (`play`) calls: `onFrame` each frame it runs, `onEnd` when it ends. Read at each call. */
export interface UIPlayHooks {
  onFrame?: (() => void) | null;
  onEnd?: (() => void) | null;
}

/** A played animation (`play`). */
export interface UIPlayback {
  /** Seconds since it started (unscaled), up to its duration. */
  readonly time: number;
  /** It reached its end (its last values held) or was stopped. */
  readonly ended: boolean;
  /** Stops it: its fields go back to the values the cascade gives them. */
  stop(): void;
}

const LINEAR_TIMING: UITimingFunction = { kind: "linear" };
const NO_FIELDS: ReadonlySet<string> = new Set();

interface Run {
  readonly kind: "transition" | "animation";
  /** The animation's name, or the transitioned property (kebab-case). */
  readonly name: string;
  readonly tracks: Track[];
  readonly duration: number;
  readonly delay: number;
  readonly iterations: number;
  readonly direction: UIAnimationSpec["direction"];
  readonly fill: UIAnimationSpec["fill"];
  readonly timing: UITimingFunction;
  paused: boolean;
  /** Seconds since it started (its delay included), unscaled. */
  time: number;
  /** `time` at the last frame. */
  prev: number;
  /** Past its delay (`animationstart` queued). */
  started: boolean;
  /** Not advanced yet: its first frame shows its start. */
  fresh: boolean;
  tweensPaused: boolean;
  /** Ended and holding its last values (`fill: forwards`/`both`). */
  held: boolean;
  /** A played animation's hooks (`play`); null for the stylesheet's. */
  readonly played: UIPlayHooks | null;
  /** A transition's reversing-adjusted start value and reversing shortening factor (ADR 0432, CSS Transitions 1 §3). */
  reversingStart?: unknown;
  shortening?: number;
}

interface ElementState {
  owner: object;
  element: object;
  readonly comp: UIComponentType;
  fields: ReadonlyMap<string, FieldInfo>;
  /** Running transitions by field. */
  readonly transitions: Map<string, Run>;
  /** Animations in `animation-name` order. */
  animations: Run[];
  /** The cascade's value of each animated field (what shows when its animations stop). */
  readonly base: Map<string, unknown>;
  /** What the animator last wrote to each field, to tell a script's write. */
  readonly written: Map<string, unknown>;
  /** ADR 0432: fields it only passes on (`UIStyledElement.virtual`), and the values shown for them. */
  virtual: ReadonlySet<string>;
  readonly values: Map<string, unknown>;
}

interface QueuedEvent {
  readonly owner: object;
  readonly element: object;
  readonly event: UIAnimationEvent;
}

function clone(value: unknown): unknown {
  if (value instanceof Color) return new Color(value.r, value.g, value.b, value.a);
  if (value instanceof Vector2) return new Vector2(value.x, value.y);
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Color && b instanceof Color) return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  if (a instanceof Vector2 && b instanceof Vector2) return a.x === b.x && a.y === b.y;
  return a === b;
}

const kebab = (field: string) => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Engine curves of timing functions (pure data), shared by every animator. */
const curves = new Map<string, Curve | null>();
function curveOf(tf: UITimingFunction, reversed: boolean): Curve | null {
  const key = timingKey(tf, reversed);
  let c = curves.get(key);
  if (c === undefined) curves.set(key, (c = timingCurve(tf, reversed)));
  return c;
}

const isBackward = (direction: Run["direction"], iteration: number) =>
  direction === "reverse" || (direction === "alternate" && iteration % 2 === 1) || (direction === "alternate-reverse" && iteration % 2 === 0);

/** When a run's active phase ends, in its local time (after its delay). */
const endOf = (run: Run) => (run.duration > 0 ? run.iterations * run.duration : 0);

/** A segment of a track at a local time: where it starts and ends, what it eases between and how. */
interface Segment {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  /** Its end was cut short by the run's end (a fractional iteration count). */
  readonly clipped: boolean;
  readonly from: unknown;
  readonly to: unknown;
  readonly timing: UITimingFunction;
  readonly reversed: boolean;
}

/** The index of the segment holding keyframe position `q` (forward: [o_i, o_i+1); backward: (o_i, o_i+1]). */
function segmentIndex(stops: readonly Stop[], q: number, backward: boolean): number {
  const last = stops.length - 2;
  if (!backward) {
    let i = 0;
    while (i < last && stops[i + 1].offset <= q) i++;
    return i;
  }
  let i = 0;
  while (i < last && stops[i + 1].offset < q) i++;
  return i;
}

/** The iteration and progress through it (0–1) at local time `t` (0 ≤ t ≤ the end). */
function iterationAt(run: Run, t: number): { k: number; p: number } {
  const n = run.iterations;
  if (run.duration <= 0) {
    if (n <= 0) return { k: 0, p: 0 };
    const k = Math.ceil(n) - 1;
    return { k, p: n - k };
  }
  let k = Math.floor(t / run.duration);
  if (k >= n) k = Math.ceil(n) - 1; // exactly at the end of a whole iteration count
  if (k < 0) k = 0;
  return { k, p: Math.min(1, t / run.duration - k) };
}

function segmentAt(run: Run, track: Track, t: number): Segment {
  const { k, p } = iterationAt(run, t);
  const backward = isBackward(run.direction, k);
  const stops = track.stops;
  const i = segmentIndex(stops, backward ? 1 - p : p, backward);
  const a = stops[i], b = stops[i + 1];
  const D = run.duration;
  const start = backward ? (k + 1 - b.offset) * D : (k + a.offset) * D;
  const fullEnd = backward ? (k + 1 - a.offset) * D : (k + b.offset) * D;
  const end = Math.min(fullEnd, endOf(run));
  return {
    id: k * stops.length + i,
    start,
    end,
    clipped: end < fullEnd,
    from: backward ? b.value : a.value,
    to: backward ? a.value : b.value,
    timing: a.timing,
    reversed: backward,
  };
}

/** A track's value at iteration `k`, progress `p`, evaluated here (exact at keyframes). */
function valueAt(run: Run, track: Track, k: number, p: number, others: (field: string) => unknown): unknown {
  const backward = isBackward(run.direction, k);
  const q = backward ? 1 - p : p;
  const stops = track.stops;
  const i = segmentIndex(stops, q, false);
  const a = stops[i], b = stops[i + 1];
  const span = b.offset - a.offset;
  if (span <= 0) return q >= b.offset ? b.value : a.value;
  const u = Math.min(1, Math.max(0, (q - a.offset) / span));
  const curve = curveOf(a.timing, false);
  const e = curve ? evalCurve(curve, u) : u;
  if (track.kind !== "discrete") {
    if (e === 0) return a.value;
    if (e === 1) return b.value;
  }
  const pair = animatedPair(track.field, track.kind, a.value, b.value, others);
  const f = pair.from.map((x, j) => x * (1 - e) + pair.to[j] * e);
  return pair.decode(f, 0);
}

/** ADR 0432: a transition's eased progress now (its timing function's output; 0 in its delay), for reversing shortening. */
function easedProgress(run: Run): number {
  const local = run.time - run.delay;
  if (local <= 0) return 0;
  const p = run.duration > 0 ? Math.min(1, local / run.duration) : 1;
  const curve = curveOf(run.timing, false);
  return curve ? evalCurve(curve, p) : p;
}

/** The value a track shows at local time `t` of its active phase, evaluated here. */
function valueAtTime(run: Run, track: Track, t: number, others: (field: string) => unknown): unknown {
  const { k, p } = iterationAt(run, Math.min(t, endOf(run)));
  return valueAt(run, track, k, p, others);
}

/** What a track shows before its run starts (fill backwards): its first keyframe in the first iteration's direction. */
function startValue(run: Run, track: Track): unknown {
  return isBackward(run.direction, 0) ? track.stops[track.stops.length - 1].value : track.stops[0].value;
}

function newTrack(field: string, kind: AnimatedKind, stops: readonly Stop[]): Track {
  return { field, kind, stops, seg: -1, mode: "none", handle: 0, column: 0, segStart: 0, segEnd: 0, pair: null, out: undefined, overridden: false, dirty: false, held: undefined };
}

// --- The animator ------------------------------------------------------------------------------------

const animators = new WeakMap<World, UIAnimator>();

/** @internal A World's animator, made the first time it's asked for. */
export function uiAnimator(world: World): UIAnimator {
  let a = animators.get(world);
  if (!a) animators.set(world, (a = new UIAnimator(world)));
  return a;
}

/** @internal True when `comp` has transitions or animations running (or held) in its World. */
export function uiAnimating(world: World, comp: UIComponentType): boolean {
  return animators.get(world)?.has(comp) ?? false;
}

/**
 * @internal Editor (the Inspector's value sources): what is animating `field` of `comp` right now, a transition (named
 * by its property) or a keyframe animation (by its name; a held `fill: forwards` value too), or null.
 */
export function uiAnimatedField(world: World, comp: UIComponentType, field: string): { readonly kind: "transition" | "animation"; readonly name: string } | null {
  return animators.get(world)?.animatedBy(comp, field) ?? null;
}

/**
 * Resolves once `world`'s UI animations can run on the tween backend (the backend opened, or it can't open here and
 * values are eased without it). Documents whose stylesheets animate wait for this in `ready`.
 */
export function uiAnimationReady(world: World): Promise<void> {
  return uiAnimator(world).open();
}

/** @internal The animation events queued for `owner` (in the order they happened), taken: the owner delivers them. */
export function takeUIAnimationEvents(world: World, owner: object): { element: object; event: UIAnimationEvent }[] {
  return animators.get(world)?.take(owner) ?? [];
}

/** @internal `owner` (a document or tree) is gone: its elements stop animating; with no owners left, the backend closes. */
export function uiAnimationOwnerGone(world: World, owner: object): void {
  animators.get(world)?.ownerGone(owner);
}

/** @internal */
export class UIAnimator {
  private backend: TweenBackend | null = null;
  private opening: Promise<void> | null = null;
  private disposed = false;
  private readonly elements = new Map<UIComponentType, ElementState>();
  private readonly owners = new Set<object>();
  private readonly loaded = new Map<string, number>();
  private readonly byColumn = new Map<number, Track>();
  private nextColumn = 1;
  private events: QueuedEvent[] = [];
  /** Played animations' hooks due after this frame's values: frames, then ends. */
  private framed: UIPlayHooks[] = [];
  private ending: UIPlayHooks[] = [];
  /** In the frame's played-animation hooks: what they play starts this frame. */
  private inHooks = false;

  constructor(private readonly world: World) {}

  /** Opens the backend (once). */
  open(): Promise<void> {
    this.opening ??= openTweenBackend().then(
      (b) => {
        if (this.disposed) b?.dispose();
        else this.backend = b;
      },
      (err: unknown) => console.error("[myco] couldn't open the tween backend for UI animation:", err),
    );
    return this.opening;
  }

  has(comp: UIComponentType): boolean {
    const s = this.elements.get(comp);
    return !!s && (s.transitions.size > 0 || s.animations.length > 0);
  }

  animatedBy(comp: UIComponentType, field: string): { kind: "transition" | "animation"; name: string } | null {
    const s = this.elements.get(comp);
    if (!s) return null;
    const tr = s.transitions.get(field);
    if (tr && !tr.tracks[0].overridden) return { kind: "transition", name: tr.name };
    for (let i = s.animations.length - 1; i >= 0; i--) {
      const r = s.animations[i];
      if (r.tracks.some((t) => t.field === field && !t.overridden)) return { kind: "animation", name: r.name };
    }
    return null;
  }

  take(owner: object): { element: object; event: UIAnimationEvent }[] {
    if (!this.events.length) return [];
    const mine: { element: object; event: UIAnimationEvent }[] = [];
    const rest: QueuedEvent[] = [];
    for (const e of this.events) (e.owner === owner ? mine.push({ element: e.element, event: e.event }) : rest.push(e));
    this.events = rest;
    return mine;
  }

  ownerGone(owner: object): void {
    this.owners.delete(owner);
    for (const [comp, s] of this.elements) if (s.owner === owner) this.drop(comp, s);
    this.events = this.events.filter((e) => e.owner !== owner);
    if (this.owners.size === 0) {
      this.disposed = true;
      this.backend?.dispose();
      this.backend = null;
      animators.delete(this.world);
    }
  }

  // --- Starting and stopping ---------------------------------------------------------------------

  /** An element was restyled: see the module docs. `first` for its first style (nothing transitions then). */
  styled(el: UIStyledElement, writes: readonly UIStyleWrite[], first: boolean, transitions: readonly UIResolvedTransition[] | null, animations: readonly UIResolvedAnimation[] | null): void {
    let s = this.elements.get(el.comp);
    if (!s) {
      if (!el.animate || (!transitions?.length && !animations?.length)) return;
      s = { owner: el.owner, element: el.element, comp: el.comp, fields: el.fields, transitions: new Map(), animations: [], base: new Map(), written: new Map(), virtual: el.virtual ?? NO_FIELDS, values: new Map() };
      this.elements.set(el.comp, s);
    }
    this.owners.add(el.owner);
    s.owner = el.owner;
    s.element = el.element;
    s.fields = el.fields;
    s.virtual = el.virtual ?? NO_FIELDS;
    // A field it only passes on shows what the animator last gave it, not what the owner last resolved.
    if (s.values.size) {
      const values = s.values;
      writes = writes.map((w) => (values.has(w.field) ? { ...w, before: values.get(w.field) } : w));
    }
    if (!el.animate) {
      this.drop(el.comp, s); // the restyle already wrote the cascade's values
      return;
    }
    const comp = s.comp as unknown as Record<string, unknown>;

    // What the cascade wrote is each field's new base; a running track writes it again over it this frame.
    for (const w of writes) {
      if (!this.animated(s, w.field)) continue;
      s.base.set(w.field, clone(w.after));
      this.show(s, w.field, w.after);
      this.forTracks(s, w.field, (t) => (t.dirty = true));
    }

    // Transitions (`transition-property` of the new style): a changed field starts one from what it showed.
    const covered = new Map<string, UITransitionSpec>();
    for (const t of transitions ?? []) for (const f of t.fields) covered.set(f, t.spec);
    for (const [field, run] of [...s.transitions]) {
      // No longer covered: it stops at its end value, unless this restyle wrote the field a new one.
      if (!covered.has(field)) this.stopTransition(s, field, run, !writes.some((w) => w.field === field));
    }
    if (!first) {
      for (const w of writes) {
        const spec = covered.get(w.field);
        const running = s.transitions.get(w.field);
        // ADR 0432: CSS's reversing shortening: a change back to where a running transition started (its
        // reversing-adjusted start value) runs back over the share of the duration it had covered.
        let shortening = 1;
        let reversingStart: unknown = w.before;
        if (running) {
          const to = running.tracks[0].stops[1].value;
          if (same(to, w.after)) {
            // Keeps running to the same end: the field shows the transition's value, not the end.
            this.show(s, w.field, w.before);
            continue;
          }
          if (same(running.reversingStart ?? running.tracks[0].stops[0].value, w.after)) {
            const old = running.shortening ?? 1;
            shortening = Math.min(1, Math.abs(easedProgress(running) * old + 1 - old));
            reversingStart = to;
          }
          this.stopTransition(s, w.field, running, false);
        }
        if (!spec) continue;
        const duration = Math.max(spec.duration, 0) * shortening;
        const delay = spec.delay < 0 ? spec.delay * shortening : spec.delay;
        if (duration + delay <= 0) continue;
        const info = s.fields.get(w.field);
        if (!info || same(w.before, w.after)) continue;
        const kind = animatedKind(w.field, info.type);
        const pair = animatedPair(w.field, kind, w.before, w.after, (f) => comp[f]);
        // Only a mixed pair of lengths jumps at the midpoint (0422), or any discrete pair with `allow-discrete` (0432).
        if (pair.discrete && kind !== "length" && !spec.allowDiscrete) continue;
        const track = newTrack(w.field, kind, [
          { offset: 0, value: clone(w.before), timing: spec.timing },
          { offset: 1, value: clone(w.after), timing: spec.timing },
        ]);
        s.base.set(w.field, clone(w.after));
        s.transitions.set(w.field, {
          kind: "transition",
          name: kebab(w.field),
          tracks: [track],
          duration,
          delay,
          iterations: 1,
          direction: "normal",
          fill: "backwards",
          timing: spec.timing,
          paused: false,
          time: 0,
          prev: 0,
          started: false,
          fresh: true,
          tweensPaused: false,
          held: false,
          played: null,
          reversingStart,
          shortening,
        });
        // Until the frame's update, the field shows where it was.
        this.show(s, w.field, w.before);
      }
    }

    // Animations: kept by name; a new name starts, a name gone stops.
    const old = new Map<string, Run>();
    for (const r of s.animations) if (!r.played && !old.has(r.name)) old.set(r.name, r);
    const next: Run[] = [];
    for (const a of animations ?? []) {
      const kept = old.get(a.spec.name);
      if (kept) {
        old.delete(a.spec.name);
        kept.paused = a.spec.playState === "paused";
        next.push(kept);
        continue;
      }
      const run = this.startAnimation(s, a);
      if (run) next.push(run);
    }
    // Played animations (`play`) aren't the stylesheet's: they stay, drawn over its animations.
    for (const r of s.animations) if (r.played) next.push(r);
    s.animations = next;
    for (const run of old.values()) this.stopRun(s, run, true);
    if (s.transitions.size || s.animations.length) void this.open();
    else this.forget(s);
  }

  private startAnimation(s: ElementState, a: UIResolvedAnimation): Run | null {
    const spec = a.spec;
    const declared = a.tracks();
    if (!declared) return null;
    const comp = s.comp as unknown as Record<string, unknown>;
    const tracks: Track[] = [];
    for (const [field, stops] of declared) {
      const info = s.fields.get(field);
      if (!info || stops.length === 0) continue;
      // A keyframe missing at 0% or 100% takes the element's own value (its base, while something animates it).
      const base = this.animated(s, field) ? s.base.get(field) : this.read(s, field);
      const list: Stop[] = stops.map((x) => ({ offset: x.offset, value: x.value, timing: x.timing ?? spec.timing }));
      if (list[0].offset > 0) list.unshift({ offset: 0, value: clone(base), timing: spec.timing });
      if (list[list.length - 1].offset < 1) list.push({ offset: 1, value: clone(base), timing: spec.timing });
      if (!s.base.has(field)) s.base.set(field, clone(base));
      tracks.push(newTrack(field, animatedKind(field, info.type), list));
    }
    return {
      kind: "animation",
      name: spec.name,
      tracks,
      duration: spec.duration,
      delay: spec.delay,
      iterations: spec.iterations,
      direction: spec.direction,
      fill: spec.fill,
      timing: spec.timing,
      paused: spec.playState === "paused",
      time: 0,
      prev: 0,
      started: false,
      fresh: true,
      tweensPaused: false,
      held: false,
      played: null,
    };
  }

  /**
   * Plays keyframe tracks on an element (see the module docs): per field, its stops (offsets 0-1, values as the field
   * stores them), over `duration` seconds. A track missing its 0% or 100% stop takes the element's own value there.
   * `name` is what the editor shows as animating its fields. In a scene being edited nothing plays: it ends at once.
   */
  play(el: UIStyledElement, name: string, tracks: ReadonlyMap<string, readonly UIAnimationStop[]>, duration: number, hooks: UIPlayHooks): UIPlayback {
    if (!el.animate || !el.comp.node.isValid || el.comp._destroyed) return endedPlayback(duration, hooks);
    let s = this.elements.get(el.comp);
    if (!s) {
      s = { owner: el.owner, element: el.element, comp: el.comp, fields: el.fields, transitions: new Map(), animations: [], base: new Map(), written: new Map(), virtual: el.virtual ?? NO_FIELDS, values: new Map() };
      this.elements.set(el.comp, s);
    }
    this.owners.add(el.owner);
    const state = s;
    const comp = s.comp as unknown as Record<string, unknown>;
    const list: Track[] = [];
    for (const [field, declared] of tracks) {
      const info = s.fields.get(field);
      if (!info || declared.length === 0) continue;
      const base = this.animated(s, field) ? s.base.get(field) : this.read(s, field);
      const stops: Stop[] = [...declared].sort((a, b) => a.offset - b.offset).map((x) => ({ offset: x.offset, value: x.value, timing: x.timing ?? LINEAR_TIMING }));
      if (stops[0].offset > 0) stops.unshift({ offset: 0, value: clone(base), timing: LINEAR_TIMING });
      if (stops[stops.length - 1].offset < 1) stops.push({ offset: 1, value: clone(stops.length === 1 ? stops[0].value : base), timing: LINEAR_TIMING });
      // Sampled keyframes repeat values (a constant field, a held stretch): only where a value changes is there a segment.
      const kept = stops.filter((x, i) => i === 0 || i === stops.length - 1 || !same(x.value, stops[i - 1].value) || !same(x.value, stops[i + 1].value));
      if (!s.base.has(field)) s.base.set(field, clone(base));
      list.push(newTrack(field, animatedKind(field, info.type), kept));
    }
    const run: Run = {
      kind: "animation",
      name,
      tracks: list,
      duration: Math.max(0, duration),
      delay: 0,
      iterations: 1,
      direction: "normal",
      fill: "forwards",
      timing: LINEAR_TIMING,
      paused: false,
      time: 0,
      prev: 0,
      started: false,
      // Played in this frame's hooks: this frame already shows its start, so its clock runs from the next frame.
      fresh: !this.inHooks,
      tweensPaused: false,
      held: false,
      played: hooks,
    };
    s.animations = [...s.animations, run];
    // Its first keyframe shows now, not after the next update (no frame of the cascade's values between keyframes).
    for (const t of list) this.write(s, t.field, t.stops[0].value);
    void this.open();
    let stopped = false;
    return {
      get time() {
        return Math.min(run.time, run.duration);
      },
      get ended() {
        return stopped || run.held;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (!state.animations.includes(run)) return;
        state.animations = state.animations.filter((r) => r !== run);
        this.stopRun(state, run, true);
        this.forget(state);
      },
    };
  }

  /** Stops a transition: `restore` writes its end value (the cascade's) at once. */
  private stopTransition(s: ElementState, field: string, run: Run, restore: boolean): void {
    s.transitions.delete(field);
    this.release(run.tracks[0]);
    if (restore && !run.tracks[0].overridden) this.write(s, field, run.tracks[0].stops[1].value);
    if (!this.animated(s, field)) this.unwatch(s, field);
  }

  /** Stops an animation: `restore` puts its fields back to their base values. */
  private stopRun(s: ElementState, run: Run, restore: boolean): void {
    for (const t of run.tracks) {
      this.release(t);
      if (restore && !t.overridden && s.base.has(t.field)) this.write(s, t.field, s.base.get(t.field));
    }
    for (const t of run.tracks) if (!this.animated(s, t.field)) this.unwatch(s, t.field);
  }

  /** True while a transition or an animation (running or held) has a live track on `field`. */
  private animated(s: ElementState, field: string): boolean {
    if (s.transitions.has(field)) return true;
    return s.animations.some((r) => r.tracks.some((t) => t.field === field && !t.overridden));
  }

  private forTracks(s: ElementState, field: string, fn: (t: Track) => void): void {
    const tr = s.transitions.get(field);
    if (tr) fn(tr.tracks[0]);
    for (const r of s.animations) for (const t of r.tracks) if (t.field === field) fn(t);
  }

  private unwatch(s: ElementState, field: string): void {
    s.base.delete(field);
    s.written.delete(field);
    s.values.delete(field);
  }

  private release(t: Track): void {
    if (t.mode === "tween" && t.handle && this.backend) this.backend.control(t.handle, OP_KILL);
    if (t.column) this.byColumn.delete(t.column);
    t.mode = "none";
    t.handle = 0;
    t.column = 0;
    t.seg = -1;
  }

  private drop(comp: UIComponentType, s: ElementState): void {
    for (const run of s.transitions.values()) this.release(run.tracks[0]);
    for (const run of s.animations) for (const t of run.tracks) this.release(t);
    s.transitions.clear();
    s.animations = [];
    this.elements.delete(comp);
  }

  private forget(s: ElementState): void {
    if (!s.transitions.size && !s.animations.length) this.elements.delete(s.comp);
  }

  /** Writes a field and remembers it; `fresh` for a value made for this write (an eased value), stored as it is. */
  private write(s: ElementState, field: string, value: unknown, fresh = false): void {
    const v = fresh ? value : clone(value);
    if (s.virtual.has(field)) s.values.set(field, v);
    else {
      const comp = s.comp as unknown as Record<string, unknown>;
      if (!same(comp[field], v)) comp[field] = v;
      s.written.set(field, comp[field] === v ? v : clone(v));
    }
    (s.owner as UIAnimationOwner)._animatedWrite?.(s.element, field, this.read(s, field));
  }

  /** Shows a value at once without telling the owner (a restyle's, before the frame's update writes the animated one). */
  private show(s: ElementState, field: string, value: unknown): void {
    if (s.virtual.has(field)) {
      s.values.set(field, clone(value));
      return;
    }
    (s.comp as unknown as Record<string, unknown>)[field] = clone(value);
    s.written.set(field, clone(value));
  }

  /** A field's value as shown: the component's, or for one it only passes on, the animator's. */
  private read(s: ElementState, field: string): unknown {
    return s.virtual.has(field) ? s.values.get(field) : (s.comp as unknown as Record<string, unknown>)[field];
  }

  private queue(s: ElementState, event: UIAnimationEvent): void {
    this.events.push({ owner: s.owner, element: s.element, event });
  }

  /** The tween easing of a timing function in a direction: linear, or its loaded curve (0 when it can't load). */
  private ease(tf: UITimingFunction, reversed: boolean): number {
    const curve = curveOf(tf, reversed);
    if (!curve) return EASE_LINEAR;
    const key = timingKey(tf, reversed);
    let h = this.loaded.get(key);
    if (h === undefined) {
      h = this.backend!.loadCurve(curve);
      this.loaded.set(key, h);
    }
    return h;
  }

  // --- The frame -----------------------------------------------------------------------------------

  /** @internal `engine.UIAnimation`: advance, tween, write back. */
  update(): void {
    if (this.elements.size === 0) return;
    const world = this.world;
    const dt = world.time.unscaledDeltaTime;
    const backend = this.backend;
    let tweens = 0;

    // Before the backend's update: drop what's gone, notice scripts' writes, advance runs, create the tweens due.
    // (forEach, not for…of over entries: no entry arrays per element per frame.)
    this.elements.forEach((s, comp) => {
      if (!comp.node.isValid || comp._destroyed) {
        this.drop(comp, s);
        return;
      }
      s.written.forEach((value, field) => this.noticeScript(s, field, value));
      for (const run of s.animations) tweens += this.advance(s, run, dt, backend);
      s.transitions.forEach((run) => (tweens += this.advance(s, run, dt, backend)));
    });

    if (backend && tweens > 0) {
      backend.update(PASS_NORMAL, world.time.deltaTime, dt);
      const rows = backend.rows();
      for (let i = 0; i < rows.count; i++) {
        const track = this.byColumn.get(rows.columns[i]);
        if (track && track.mode === "tween" && track.column === rows.columns[i] && track.pair) track.out = track.pair.decode(rows.values, i * 4);
      }
    }

    // After it: write values, decide ends, queue events.
    // (Deleting from a Map while iterating it is safe; the animations array is replaced, never spliced, as runs end.)
    for (const s of this.elements.values()) {
      const animations = s.animations;
      for (let i = 0; i < animations.length; i++) this.finish(s, animations[i], null);
      s.transitions.forEach((run, field) => this.finish(s, run, field));
      this.forget(s);
    }

    // Played animations' hooks, once this frame's values are written (they may play and stop animations).
    if (this.framed.length || this.ending.length) {
      const framed = this.framed, ending = this.ending;
      this.framed = [];
      this.ending = [];
      this.inHooks = true;
      try {
        for (const h of framed) call(h.onFrame);
        for (const h of ending) call(h.onEnd);
      } finally {
        this.inHooks = false;
      }
    }
  }

  /** A field whose value isn't what the animator last wrote: a script wrote it, and wins over its transition or animation. */
  private noticeScript(s: ElementState, field: string, value: unknown): void {
    const comp = s.comp as unknown as Record<string, unknown>;
    if (same(comp[field], value)) return;
    const tr = s.transitions.get(field);
    if (tr) {
      tr.tracks[0].overridden = true;
      this.release(tr.tracks[0]);
      s.transitions.delete(field);
    }
    for (const r of s.animations) {
      for (const t of r.tracks) {
        if (t.field !== field || t.overridden) continue;
        t.overridden = true;
        this.release(t);
      }
    }
    if (!this.animated(s, field)) this.unwatch(s, field);
    else s.written.set(field, clone(comp[field]));
  }

  /** Moves a run's clock and creates the tweens due before the update. Returns how many tracks run on tweens. */
  private advance(s: ElementState, run: Run, dt: number, backend: TweenBackend | null): number {
    if (run.held) return 0;
    let prev: number;
    if (run.fresh) {
      run.fresh = false;
      prev = run.time - dt;
    } else {
      prev = run.time;
      if (!run.paused) run.time += dt;
    }
    run.prev = prev;
    const local = run.time - run.delay, localPrev = prev - run.delay;
    const end = endOf(run);
    if (run.paused !== run.tweensPaused) {
      for (const t of run.tracks) if (t.mode === "tween" && backend) backend.control(t.handle, run.paused ? OP_PAUSE : OP_RESUME);
      run.tweensPaused = run.paused;
    }
    for (const t of run.tracks) t.out = undefined;
    let live = 0;
    if (local < 0 || local >= end) return live; // its delay, or its end (written exactly after the update)
    const at = local;
    const comp = s.comp as unknown as Record<string, unknown>;
    for (const t of run.tracks) {
      if (t.overridden) continue;
      if (t.seg >= 0 && at >= t.segStart && at < t.segEnd) {
        if (t.mode === "tween") live++; // still in its segment
        continue;
      }
      const seg = segmentAt(run, t, at);
      if (seg.id !== t.seg) {
        if (t.mode === "tween" && t.segEnd > at) this.release(t); // left before its end (a jump)
        else if (t.column) this.byColumn.delete(t.column);
        t.seg = seg.id;
        t.segStart = seg.start;
        t.segEnd = seg.end;
        t.pair = animatedPair(t.field, t.kind, seg.from, seg.to, (f) => comp[f]);
        t.handle = 0;
        t.column = 0;
        t.mode = "js";
        // A segment starting this frame runs on the backend, its start placed by the delay; one entered part-way here.
        if (backend && !run.paused && !seg.clipped && seg.start >= localPrev - 1e-9 && seg.end > seg.start) {
          const column = this.nextColumn;
          this.nextColumn = this.nextColumn >= 0xfffffff0 ? 1 : this.nextColumn + 1;
          const p = t.pair;
          const handle = backend.create({
            hostId: column,
            column,
            valueKind: KIND_VALUE,
            width: p.width,
            ease: this.ease(seg.timing, seg.reversed),
            flags: 0,
            timeMode: TIME_UNSCALED,
            loops: 1,
            duration: seg.end - seg.start,
            delay: Math.max(0, seg.start - localPrev),
            speed: 1,
            from0: p.from[0], from1: p.from[1] ?? 0, from2: p.from[2] ?? 0, from3: p.from[3] ?? 0,
            to0: p.to[0], to1: p.to[1] ?? 0, to2: p.to[2] ?? 0, to3: p.to[3] ?? 0,
          });
          if (handle) {
            t.mode = "tween";
            t.handle = handle;
            t.column = column;
            this.byColumn.set(column, t);
          }
        }
      }
      if (t.mode === "tween") live++;
    }
    return live;
  }

  /** After the update: the values a run shows, its events and its end. `field` names a transition's field. */
  private finish(s: ElementState, run: Run, field: string | null): void {
    if (run.held) {
      for (const t of run.tracks) if (t.dirty && !t.overridden) {
        t.dirty = false;
        this.write(s, t.field, t.held);
      }
      return;
    }
    const comp = s.comp as unknown as Record<string, unknown>;
    const others = (f: string) => comp[f]; // read only on the paths evaluated here
    const local = run.time - run.delay, localPrev = run.prev - run.delay;
    const end = endOf(run);
    const animation = run.kind === "animation";
    if (local < 0) {
      // In its delay: fill backwards shows the first keyframe; otherwise the field keeps its base.
      if (run.fill === "backwards" || run.fill === "both") for (const t of run.tracks) if (!t.overridden) this.write(s, t.field, startValue(run, t));
      for (const t of run.tracks) t.dirty = false;
      return;
    }
    const wasStarted = run.started;
    run.started = true;
    if (animation && !wasStarted && !run.played) this.queue(s, { type: "animationstart", propertyName: "", animationName: run.name, elapsedTime: Math.max(0, -run.delay) });
    if (local < end) {
      for (const t of run.tracks) {
        if (t.overridden) continue;
        const tweened = t.mode === "tween" && t.out !== undefined;
        this.write(s, t.field, tweened ? t.out : valueAtTime(run, t, local, others), tweened);
        t.dirty = false;
      }
      if (run.played) {
        if (run.played.onFrame) this.framed.push(run.played);
        return;
      }
      if (animation && run.duration > 0 && wasStarted && localPrev >= 0) {
        const k = Math.floor(local / run.duration);
        if (k > Math.floor(localPrev / run.duration)) this.queue(s, { type: "animationiteration", propertyName: "", animationName: run.name, elapsedTime: k * run.duration });
      }
      return;
    }
    // Ended.
    if (!animation) {
      const t = run.tracks[0];
      this.release(t);
      s.transitions.delete(field!);
      if (!t.overridden) this.write(s, t.field, t.stops[1].value);
      if (!this.animated(s, t.field)) this.unwatch(s, t.field);
      this.queue(s, { type: "transitionend", propertyName: run.name, animationName: "", elapsedTime: run.duration });
      return;
    }
    const forwards = run.fill === "forwards" || run.fill === "both";
    for (const t of run.tracks) {
      this.release(t);
      if (t.overridden) continue;
      if (forwards) {
        const value = valueAtTime(run, t, end, others);
        t.held = clone(value);
        this.write(s, t.field, value);
      } else if (s.base.has(t.field)) this.write(s, t.field, s.base.get(t.field));
      t.dirty = false;
    }
    if (run.played) this.ending.push(run.played);
    else this.queue(s, { type: "animationend", propertyName: "", animationName: run.name, elapsedTime: end });
    if (forwards) run.held = true;
    else {
      s.animations = s.animations.filter((r) => r !== run);
      for (const t of run.tracks) if (!this.animated(s, t.field)) this.unwatch(s, t.field);
    }
  }
}

/** Runs a played animation's hook; one that throws is reported and the rest still run. */
function call(fn: (() => void) | null | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (err) {
    console.error("[myco] a UI animation's hook threw:", err);
  }
}

/** A played animation that ends at once (nothing plays in a scene being edited): `onEnd` in a microtask. */
function endedPlayback(duration: number, hooks: UIPlayHooks): UIPlayback {
  let ended = false;
  queueMicrotask(() => {
    if (ended) return;
    ended = true;
    hooks.onEnd?.();
  });
  return {
    get time() {
      return Math.max(0, duration);
    },
    get ended() {
      return ended;
    },
    stop: () => void (ended = true),
  };
}

// Late update, after the UI host's sync (its restyles start transitions): this frame's values.
defineBuiltinSystem({
  name: "engine.UIAnimation",
  phase: "lateUpdate",
  after: ["engine.UIHostSync"],
  run: (w) => animators.get(w)?.update(),
});
