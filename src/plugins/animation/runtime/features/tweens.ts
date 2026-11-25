// Tweens, sequences and parallel groups (ADR 0371, 0372; T22t). A tween is a one-track clip in the core's tween table;
// the target's entity gets the `animation.Tweens` data component while it has tweens. Sequences and parallel groups
// compile to a small timeline (the core's sequence programs, `SEQ_CREATE` + `SEQ_MEMBER`). Starts and completions run
// in the stages (`stages/gather/tweens.ts`, `stages/apply/tweens.ts`).
//
// - **Start (D95):** `tween()` resolves its target at once (`tweens/target.ts`; a target it can't drive gives one warning
//   and a tween already ended `stopped`) and starts the World's animation core if it isn't running
//   (`startAnimationCore`). It starts at the next animation update (`animation.Gather`), reading the field's value
//   then as its start (`from` overrides); until then `sequence()` and `parallel()` can take it. The host resolves
//   `relative` (vectors: start + by; quaternions: start × by) and the start values, so the core gets plain from/to.
// - **Easing:** a Penner name becomes the core's easing id (`EASE_*`, default `outQuad`). An engine `Curve` (over 0–1)
//   is a core asset (T70, D142): the World loads it once per distinct curve (`AnimationWorldCore.acquireCurve`), the
//   tween passes its handle as `ease`, and the core eases with the shared `myco-curve` evaluator. The tween gives its
//   reference back when it ends, and the World's close frees what is left.
// - **Values:** each frame the core's tween rows (column = the tween's host id) and the sequence blocks (weight > 0)
//   are written through the target's write, after `animation.Evaluate`.
// - **End:** the promise resolves `finished` from the core's completion records; `stop()` kills it in the core and
//   resolves `stopped` at once (the field stays where it is); a destroyed target node or removed component is noticed
//   in the gather step, marked destroyed in the core, and resolves `destroyed`. It never rejects.
// - **Groups:** a group takes tweens and groups that haven't started. `sequence(a, b)` puts `b` after `a`'s whole length
//   (delay + duration × loops, over speed), `parallel(a, b)` starts both together; nested groups flatten into one
//   program with offsets. A member's start value is read when the group starts, except that a member following an
//   earlier member on the same field (and target) starts from that member's end value, so `sequence(tween(t,
//   "position", a), tween(t, "position", b))` goes to `a` then from `a` to `b`, as DOTween's and PrimeTween's sequences do.
//   Each member's promise resolves when the member ends; a group's when all its members have: `finished` if any
//   played to its end, `stopped` if all were stopped (or the group was), `destroyed` if every target was destroyed.
//   `pause`/`resume` on a member act on its whole group; `stop` on a member stops only that member writing. A group
//   follows its first member's clock (`time`); members' `speed` scales their own length.
import type { Curve } from "../../../../engine/core/curve";
import { Quaternion } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import { Transform } from "../../../../engine/scene/Transform";
import { Tweens } from "../components/Tweens";
import type { AnimationWorldCore } from "../core/AnimationWorldCore";
import { encodeRecord, type RecordFields } from "../core/records";
import { animationCoreOf, startAnimationCore } from "../core/service";
import type { AnimationFrame } from "../stages/frame";
import { CHANGE_FINISHED, CHANGE_MEMBER_DONE, FLAG_PLAY, OP_KILL as TL_KILL, OP_PAUSE as TL_PAUSE, OP_PLAY as TL_PLAY, SEQ_CREATE, SEQ_MEMBER, WRAP_ONCE } from "../wasm/wire/timeline";
import {
  CHANGE_COMPLETED,
  EASE_LINEAR,
  EASE_OUT_QUAD,
  FLAG_YOYO,
  KIND_QUAT_SLERP,
  KIND_VALUE,
  LOOPS_INFINITE,
  OP_DESTROYED,
  OP_KILL,
  OP_PAUSE,
  OP_RESUME,
  TIME_FIXED,
  TIME_SCALED,
  TIME_UNSCALED,
  TWEEN_CHANGE,
} from "../wasm/wire/tween";
import type { Tween, TweenEase, TweenEndReason, TweenOptions, TweenResult, TweenTarget, TweenValue } from "../types";
import { resolveTweenTarget, tweenNumbers, type TweenBinding } from "./tweens/target";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// ------------------------------------------------------------------------------------------------ easing

const FAMILIES = ["Quad", "Cubic", "Quart", "Quint", "Sine", "Expo", "Circ", "Back", "Elastic", "Bounce"];
const MODES = ["in", "out", "inOut"];

/** The core's easing id of a Penner name (`EASE_*` = 1 + 3·family + mode), or -1. */
function easeId(name: string): number {
  if (name === "linear") return EASE_LINEAR;
  const m = /^(inOut|in|out)([A-Z][a-z]+)$/.exec(name);
  if (!m) return -1;
  const family = FAMILIES.indexOf(m[2]!);
  return family < 0 ? -1 : 1 + 3 * family + MODES.indexOf(m[1]!);
}

// ------------------------------------------------------------------------------------------------ ids and stores

/** Host ids (and tween columns): unique on the page, so records of another World or a closed one are never mistaken. */
let nextId = 1;
const newId = (): number => {
  const id = nextId;
  nextId = nextId >= 0xfffffffe ? 1 : nextId + 1;
  return id;
};

/** A started group's core program. */
interface Run {
  readonly root: Group;
  readonly ns: AnimationWorldCore;
  /** The program's host id (its key in `Store.runs`, and the id its change records carry). */
  readonly hostId: number;
  /** The core timeline. */
  readonly handle: number;
  readonly valueOffset: number;
  readonly weightOffset: number;
  /** Block `i`: its first word (relative to `valueOffset`), words and leaf. */
  readonly blocks: readonly { readonly index: number; readonly offset: number; readonly words: number; readonly leaf: Leaf }[];
}

/** One World's tweens. */
interface Store {
  /** Created, not grouped, not started: started by the next gather. */
  readonly pending: Item[];
  /** Running leaves (standalone and group members), for the destroyed-target check. */
  readonly running: Set<Leaf>;
  /** Standalone running tweens by host id (= column). */
  readonly byHost: Map<number, Leaf>;
  /** Running group programs by their host id. */
  readonly runs: Map<number, Run>;
}

const stores = new WeakMap<World, Store>();
function storeOf(world: World): Store {
  let s = stores.get(world);
  if (!s) stores.set(world, (s = { pending: [], running: new Set(), byHost: new Map(), runs: new Map() }));
  return s;
}

function ensureCore(world: World): void {
  if (animationCoreOf(world)) return;
  startAnimationCore(world).catch((err: unknown) => console.error("[myco] animation: the core failed to load; tweens wait for it:", err));
}

// ------------------------------------------------------------------------------------------------ handles

abstract class Item implements Tween {
  state: "pending" | "grouped" | "running" | "done" = "pending";
  parent: Group | null = null;
  reason: TweenEndReason | null = null;
  /** Paused before it started (applied when it starts). */
  pausedEarly = false;
  private settle!: (r: TweenResult) => void;
  private readonly promise: Promise<TweenResult>;

  constructor(readonly world: World | null) {
    this.promise = new Promise((resolve) => (this.settle = resolve));
  }

  get isPlaying(): boolean {
    return this.state !== "done";
  }

  then<A = TweenResult, B = never>(onfulfilled?: ((value: TweenResult) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.promise.then(onfulfilled, onrejected);
  }

  /** Seconds from its start to its end (delay + cycles), over speed; Infinity when it loops forever. */
  abstract total(): number;

  /** Ends it with `reason` (once); the parent group is told. */
  end(reason: TweenEndReason): void {
    if (this.state === "done") return;
    this.state = "done";
    this.reason = reason;
    this.onEnd();
    this.settle({ reason });
    this.parent?.childEnded();
  }

  protected abstract onEnd(): void;

  /** The outermost group it belongs to (itself when ungrouped). */
  root(): Item {
    let r: Item = this;
    while (r.parent) r = r.parent;
    return r;
  }

  abstract pause(): void;
  abstract resume(): void;
  abstract stop(): void;
}

class Leaf extends Item {
  /** Resolved start and end values (set when it starts). */
  from: number[] = [];
  to: number[] = [];
  /** The core tween (standalone) and its host id / column (standalone or member). */
  handle = 0;
  hostId = 0;
  ns: AnimationWorldCore | null = null;
  /** A group member's program, while it runs in one. */
  run: Run | null = null;
  counted = false;
  /** The core's `ease` (`loadEase`), once resolved. */
  private ease: number | null = null;
  /** The curve asset it holds a reference to (0: none), and the World's namespace that gave it. */
  private curveHandle = 0;
  private curveNs: AnimationWorldCore | null = null;

  constructor(
    world: World | null,
    readonly binding: TweenBinding | null,
    readonly to0: TweenValue,
    readonly options: TweenOptions,
  ) {
    super(world);
  }

  get speed(): number {
    const s = this.options.speed ?? 1;
    return Number.isFinite(s) && s > 0 ? s : 1;
  }
  get loops(): number {
    const n = this.options.loops ?? 1;
    return n < 0 || n === Infinity ? LOOPS_INFINITE : Math.max(1, Math.floor(n) || 1);
  }
  get duration(): number {
    const d = this.options.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  get delay(): number {
    const d = this.options.delay ?? 0;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  get curve(): Curve | null {
    return Array.isArray(this.options.ease) ? (this.options.ease as Curve) : null;
  }
  get yoyo(): boolean {
    return this.options.loopMode === "yoyo";
  }

  total(): number {
    if (this.loops === LOOPS_INFINITE) return Infinity;
    return (this.delay + this.duration * this.loops) / this.speed;
  }

  /**
   * The value it ends on (`to`, or `from` after an even number of yoyo cycles); null when it never ends. A curve tween
   * ends on its curve's value at 0 or 1, read from the core (`loadEase` first).
   */
  endValue(): number[] | null {
    if (this.loops === LOOPS_INFINITE) return null;
    const back = this.yoyo && (this.loops - 1) % 2 === 1;
    const ends = this.curveHandle ? this.curveNs!.core.sampleCurve(this.curveHandle, 1, 1, 2) : null;
    if (!ends) return back ? this.from : this.to;
    return this.mix(ends[back ? 0 : 1]!);
  }

  /**
   * Resolves the core's `ease` (once): a curve's handle (a reference taken from `ns`, given back when it ends), else
   * the Penner id of its name, warning about unknown names.
   */
  loadEase(ns: AnimationWorldCore): void {
    if (this.ease !== null) return;
    const c = this.curve;
    if (c) {
      this.curveHandle = ns.acquireCurve(c);
      if (this.curveHandle) {
        this.curveNs = ns;
        this.ease = this.curveHandle;
      } else {
        warnOnce("ease:curve", `[myco] tween: the animation core refused an easing curve (keys must be finite and sorted by x); using "linear".`);
        this.ease = EASE_LINEAR;
      }
      return;
    }
    const e = this.options.ease as TweenEase | undefined;
    if (e === undefined) this.ease = EASE_OUT_QUAD;
    else {
      const id = easeId(e);
      if (id < 0) warnOnce(`ease:${String(e)}`, `[myco] tween: "${String(e)}" isn't an easing; using "outQuad".`);
      this.ease = id >= 0 ? id : EASE_OUT_QUAD;
    }
  }

  /** Resolves `from` and `to` against `start` (the field's value now, or a preceding member's end). False: no start value. */
  resolve(start: number[] | null): boolean {
    const b = this.binding!;
    const w = b.width;
    const given = tweenNumbers(this.options.from, w);
    const base = start ?? b.read();
    if (!base && (!given || given.some((x) => x === null))) return false;
    const from = Array.from({ length: w }, (_, i) => given?.[i] ?? base![i] ?? 0);
    const t = tweenNumbers(this.to0, w) ?? [];
    let to: number[];
    if (this.options.relative) {
      if (b.quat) {
        const q = new Quaternion(from[0]!, from[1]!, from[2]!, from[3]!).multiply({ x: t[0] ?? 0, y: t[1] ?? 0, z: t[2] ?? 0, w: t[3] ?? 1 }).normalize();
        to = [q.x, q.y, q.z, q.w];
      } else to = from.map((f, i) => f + (t[i] ?? 0));
    } else to = from.map((f, i) => t[i] ?? f);
    if (b.bool) {
      from[0] = from[0]! >= 0.5 ? 1 : 0;
      to[0] = to[0]! >= 0.5 ? 1 : 0;
    }
    this.from = from;
    this.to = to;
    return true;
  }

  /** from → to at eased progress `e` (the core's rule: quaternions slerp). */
  mix(e: number): number[] {
    if (this.binding!.quat) {
      const f = this.from, t = this.to;
      const q = Quaternion.slerp({ x: f[0]!, y: f[1]!, z: f[2]!, w: f[3]! }, { x: t[0]!, y: t[1]!, z: t[2]!, w: t[3]! }, e);
      return [q.x, q.y, q.z, q.w];
    }
    return this.from.map((f, i) => f + (this.to[i]! - f) * e);
  }

  /** The fields the core takes (`TWEEN_CREATE` / `SEQ_MEMBER` share them); `loadEase` first. */
  spec(): Record<string, number> {
    const b = this.binding!;
    const from = this.from, to = this.to;
    return {
      valueKind: b.quat ? KIND_QUAT_SLERP : KIND_VALUE,
      width: b.width,
      ease: this.ease!,
      flags: this.yoyo ? FLAG_YOYO : 0,
      loops: this.loops,
      from0: from[0] ?? 0, from1: from[1] ?? 0, from2: from[2] ?? 0, from3: from[3] ?? 0,
      to0: to[0] ?? 0, to1: to[1] ?? 0, to2: to[2] ?? 0, to3: to[3] ?? 0,
    };
  }

  /** Writes one core row (`width` floats from `v[at]` on); a destroyed target writes nothing (`binding.write` checks). */
  writeRow(v: ArrayLike<number>, at = 0): void {
    const b = this.binding!;
    if (b.bool) b.write([Math.abs(v[at]! - this.to[0]!) < 1e-6 ? this.to[0]! : this.from[0]!]);
    else b.write(v, at);
  }

  /** Counts it on its node's `animation.Tweens` (once). */
  count(head: number): void {
    const node = this.binding!.node;
    if (!node.isValid) return;
    const data = node.getData(Tweens);
    if (data) {
      data.count++;
      data.head = head;
    } else node.addData(Tweens, { count: 1, head });
    this.counted = true;
  }

  protected onEnd(): void {
    const store = this.world ? stores.get(this.world) : undefined;
    if (store) {
      const i = store.pending.indexOf(this);
      if (i >= 0) store.pending.splice(i, 1);
      store.running.delete(this);
      if (this.handle) store.byHost.delete(this.hostId);
    }
    if (this.handle) this.ns?.forgetTween(this.handle);
    if (this.curveHandle) {
      this.curveNs?.releaseCurve(this.curveHandle);
      this.curveHandle = 0;
      this.curveNs = null;
    }
    if (this.counted) {
      this.counted = false;
      const node = this.binding!.node;
      if (node.isValid) {
        const data = node.getData(Tweens);
        if (data && --data.count <= 0) node.removeData(Tweens);
      }
    }
  }

  pause(): void {
    this.control(true);
  }
  resume(): void {
    this.control(false);
  }

  private control(pause: boolean): void {
    if (this.parent) return pause ? this.root().pause() : this.root().resume();
    if (this.state === "pending") this.pausedEarly = pause;
    else if (this.state === "running" && this.ns) this.ns.core.tweenControl(this.handle, pause ? OP_PAUSE : OP_RESUME);
  }

  stop(): void {
    if (this.state === "done") return;
    if (this.state === "running" && this.handle && this.ns) this.ns.core.tweenControl(this.handle, OP_KILL);
    this.end("stopped");
  }
}

class Group extends Item {
  run: Run | null = null;

  constructor(
    world: World | null,
    readonly kind: "sequence" | "parallel",
    readonly items: readonly Item[],
  ) {
    super(world);
  }

  total(): number {
    if (this.kind === "parallel") return this.items.reduce((m, i) => Math.max(m, i.total()), 0);
    return this.items.reduce((s, i) => s + i.total(), 0);
  }

  childEnded(): void {
    if (this.state === "done" || this.items.some((i) => i.state !== "done")) return;
    const reasons = this.items.map((i) => i.reason);
    const reason: TweenEndReason = reasons.some((r) => r === "finished") ? "finished" : reasons.length && reasons.every((r) => r === "destroyed") ? "destroyed" : reasons.length ? "stopped" : "finished";
    this.end(reason);
  }

  protected onEnd(): void {
    const store = this.world ? stores.get(this.world) : undefined;
    if (store) {
      const i = store.pending.indexOf(this);
      if (i >= 0) store.pending.splice(i, 1);
    }
    const run = this.run;
    if (run && run.root === this) {
      if (store) store.runs.delete(run.hostId);
      run.ns.core.timelineControl(run.handle, TL_KILL);
      run.ns.forgetTimeline(run.handle);
    }
  }

  pause(): void {
    this.control(true);
  }
  resume(): void {
    this.control(false);
  }

  private control(pause: boolean): void {
    if (this.parent) return pause ? this.root().pause() : this.root().resume();
    if (this.state === "pending") this.pausedEarly = pause;
    else if (this.state === "running" && this.run) this.run.ns.core.timelineControl(this.run.handle, pause ? TL_PAUSE : TL_PLAY);
  }

  stop(): void {
    if (this.state === "done") return;
    for (const i of this.items) i.stop();
    this.end("stopped"); // a group with no members, or whose members had ended
  }
}

/** A tween that never runs (a target it can't drive). */
function refused(message: string): Tween {
  warnOnce(message, message);
  const l = new Leaf(null, null, 0, { duration: 0 });
  l.end("stopped");
  return l;
}

// ------------------------------------------------------------------------------------------------ the API

/** @internal `tween()`. */
export function startTween(target: TweenTarget, field: string, to: TweenValue, options: TweenOptions): Tween {
  const where = `${target instanceof Transform ? "Transform" : (target?.constructor?.name ?? "?")}.${field}`;
  if (!target) return refused(`[myco] tween: no target for "${field}".`);
  const binding = resolveTweenTarget(target, field, to);
  if (typeof binding === "string") return refused(`[myco] tween: can't tween ${where}: ${binding}.`);
  if (!binding.read() && (options.from === undefined || tweenNumbers(options.from, binding.width)?.some((x) => x === null))) {
    return refused(`[myco] tween: can't tween ${where}: its value can't be read; give \`from\`.`);
  }
  const world = binding.node.world;
  const leaf = new Leaf(world, binding, to, options ?? { duration: 0 });
  storeOf(world).pending.push(leaf);
  ensureCore(world);
  return leaf;
}

function group(kind: "sequence" | "parallel", items: readonly Tween[]): Tween {
  const members: Item[] = [];
  for (const t of items) {
    if (!(t instanceof Item)) {
      warnOnce(`${kind}:foreign`, `[myco] ${kind}(): pass tweens made by tween(), sequence() or parallel().`);
      continue;
    }
    if (t.state === "done") {
      members.push(t); // ended already (refused or stopped): it takes no time
      continue;
    }
    if (t.state !== "pending" || t.parent) {
      warnOnce(`${kind}:started`, `[myco] ${kind}(): a tween that has started (or is in another group) can't join a group; it plays on its own.`);
      continue;
    }
    members.push(t);
  }
  const world = members.find((m) => m.world)?.world ?? null;
  const g = new Group(world, kind, members);
  for (const m of members) {
    m.parent = g;
    if (m.state === "pending") {
      m.state = "grouped";
      if (m.world) {
        const p = storeOf(m.world).pending;
        const i = p.indexOf(m);
        if (i >= 0) p.splice(i, 1);
      }
    }
  }
  if (!world) {
    g.childEnded();
    if (g.state !== "done") g.end("stopped");
    return g;
  }
  storeOf(world).pending.push(g);
  ensureCore(world);
  return g;
}

/** @internal `sequence()`. */
export function sequence(items: readonly Tween[]): Tween {
  return group("sequence", items);
}

/** @internal `parallel()`. */
export function parallel(items: readonly Tween[]): Tween {
  return group("parallel", items);
}

// ------------------------------------------------------------------------------------------------ the stages

const timeMode = (o: TweenOptions): number => (o.time === "unscaled" ? TIME_UNSCALED : o.time === "fixed" ? TIME_FIXED : TIME_SCALED);

function startLeaf(store: Store, ns: AnimationWorldCore, leaf: Leaf): void {
  if (!leaf.binding!.alive()) return leaf.end("destroyed");
  if (!leaf.resolve(null)) return leaf.end("stopped");
  leaf.loadEase(ns);
  const id = newId();
  const handle = ns.createTween({
    ...leaf.spec(),
    hostId: id,
    column: id,
    timeMode: timeMode(leaf.options),
    duration: leaf.duration,
    delay: leaf.delay,
    speed: leaf.speed,
  });
  if (handle === 0) {
    warnOnce(`create:${ns.core.lastStatus()}`, `[myco] tween: the animation core refused a tween (status ${ns.core.lastStatus()}); it ends "stopped".`);
    return leaf.end("stopped");
  }
  leaf.state = "running";
  leaf.handle = handle;
  leaf.hostId = id;
  leaf.ns = ns;
  store.byHost.set(id, leaf);
  store.running.add(leaf);
  leaf.count(handle);
  if (leaf.pausedEarly) ns.core.tweenControl(handle, OP_PAUSE);
}

/** The leaves of `item` with their offsets in the group, in order. */
function flatten(item: Item, offset: number, out: { leaf: Leaf; offset: number }[]): void {
  if (item instanceof Leaf) out.push({ leaf: item, offset });
  else if (item instanceof Group) {
    let t = offset;
    for (const child of item.items) {
      flatten(child, t, out);
      if (item.kind === "sequence") t += child.total();
    }
  }
}

function markRunning(item: Item, run: Run): void {
  if (item.state === "grouped" || item.state === "pending") item.state = "running";
  if (item instanceof Group) {
    item.run = run;
    for (const c of item.items) markRunning(c, run);
  }
}

const MAX_OFFSET = 3.4e38;

function startGroup(store: Store, ns: AnimationWorldCore, g: Group): void {
  const all: { leaf: Leaf; offset: number }[] = [];
  flatten(g, 0, all);
  const live = all.filter((m) => m.leaf.state !== "done");
  for (const m of live) if (!m.leaf.binding!.alive()) m.leaf.end("destroyed");
  const members = live.filter((m) => m.leaf.state !== "done").sort((a, b) => a.offset - b.offset);
  // Chained starts: a member after an earlier member on the same field starts where that one ended.
  const ends = new Map<object, Map<string, { end: number; value: number[] }>>();
  const compiled: { leaf: Leaf; offset: number }[] = [];
  for (const m of members) {
    const b = m.leaf.binding!;
    const prior = ends.get(b.target)?.get(b.field);
    if (!m.leaf.resolve(prior && prior.end <= m.offset + 1e-9 ? prior.value.slice() : null)) {
      m.leaf.end("stopped");
      continue;
    }
    compiled.push(m);
    m.leaf.loadEase(ns);
    const value = m.leaf.endValue();
    if (value) {
      let byField = ends.get(b.target);
      if (!byField) ends.set(b.target, (byField = new Map()));
      byField.set(b.field, { end: m.offset + m.leaf.total(), value });
    }
  }
  if (g.state === "done") return; // every member ended
  if (compiled.length === 0) return g.childEnded();
  const id = newId();
  const first = compiled[0]!.leaf;
  const records: Uint8Array[] = [
    encodeRecord(SEQ_CREATE, { world: ns.id, hostId: id, timeMode: timeMode(first.options), wrap: WRAP_ONCE, flags: FLAG_PLAY, speed: 1, members: compiled.length }),
  ];
  for (const m of compiled) {
    const leaf = m.leaf;
    leaf.hostId = newId();
    records.push(
      encodeRecord(SEQ_MEMBER, {
        ...leaf.spec(),
        hostId: leaf.hostId,
        column: leaf.hostId,
        offset: Math.min(m.offset, MAX_OFFSET),
        duration: leaf.duration / leaf.speed,
        delay: leaf.delay / leaf.speed,
      }),
    );
  }
  const bytes = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
  let at = 0;
  for (const r of records) {
    bytes.set(r, at);
    at += r.length;
  }
  const handle = ns.createSequence(bytes);
  const info = handle ? ns.core.timelineInfo(handle) : null;
  if (!handle || !info) {
    warnOnce(`seq:${ns.core.lastStatus()}`, `[myco] ${g.kind}(): the animation core refused the group (status ${ns.core.lastStatus()}); it ends "stopped".`);
    return g.stop();
  }
  const byHost = new Map(compiled.map((m) => [m.leaf.hostId, m.leaf]));
  const blocks = ns.core
    .timelineBlocks(handle)
    .map((b) => ({ index: b.index, offset: b.offset, words: b.words, leaf: byHost.get(b.hostId)! }))
    .filter((b) => b.leaf);
  const run: Run = { root: g, ns, hostId: id, handle, valueOffset: info.valueOffset, weightOffset: info.weightOffset, blocks };
  store.runs.set(id, run);
  markRunning(g, run);
  for (const m of compiled) {
    m.leaf.ns = ns;
    m.leaf.run = run;
    store.running.add(m.leaf);
    m.leaf.count(handle);
  }
  if (g.pausedEarly) ns.core.timelineControl(handle, TL_PAUSE);
}

/** Running leaves whose target is gone, found by `gatherTweens` (reused). */
const deadLeaves: (Leaf | null)[] = [];

/** @internal `animation.Gather`'s tween step: start what was created since the last update; destroyed targets end. */
export function gatherTweens(frame: AnimationFrame): void {
  const store = stores.get(frame.world);
  if (!store) return;
  // Targets gone since the last frame (whether a target lives doesn't change as tweens end, so they are found first,
  // then ended in order: no copy of the running set each frame).
  let dead = 0;
  for (const leaf of store.running) if (!leaf.binding!.alive()) deadLeaves[dead++] = leaf;
  for (let i = 0; i < dead; i++) {
    const leaf = deadLeaves[i]!;
    deadLeaves[i] = null;
    if (leaf.handle && leaf.ns) leaf.ns.core.tweenControl(leaf.handle, OP_DESTROYED);
    leaf.end("destroyed");
  }
  if (store.pending.length === 0) return;
  const ns = frame.core;
  for (const item of store.pending.splice(0)) {
    if (item.state !== "pending") continue;
    if (item instanceof Leaf) startLeaf(store, ns, item);
    else if (item instanceof Group) startGroup(store, ns, item);
  }
}


/**
 * The rows `applyTweens` reads before writing any (a setter may call into the core, which can move its memory), reused
 * every frame so a steady frame allocates nothing: `rowLeaves[i]` writes the 4 floats at `rowValues[4i]`.
 */
let rowValues = new Float32Array(1024);
const rowLeaves: (Leaf | null)[] = [];
/** Leaves whose completion record came this frame (ended after the writes), reused likewise. */
const completedLeaves: (Leaf | null)[] = [];
const tweenChangeOut = {} as RecordFields<typeof TWEEN_CHANGE>;

/** `rowValues` with room for `n` rows (grown by doubling, never shrunk). */
function rowRoom(n: number): Float32Array {
  if (rowValues.length < n * 4) {
    let size = rowValues.length;
    while (size < n * 4) size *= 2;
    const grown = new Float32Array(size);
    grown.set(rowValues);
    rowValues = grown;
  }
  return rowValues;
}

/** Writes the `n` rows gathered in `rowLeaves`/`rowValues`, letting go of each leaf. */
function writeRows(n: number): void {
  const values = rowValues;
  for (let i = 0; i < n; i++) {
    const leaf = rowLeaves[i]!;
    rowLeaves[i] = null;
    leaf.writeRow(values, i * 4);
  }
}

/** @internal `animation.Apply`'s tween step: values into fields, then completions. */
export function applyTweens(frame: AnimationFrame): void {
  const store = stores.get(frame.world);
  if (!store || (store.byHost.size === 0 && store.runs.size === 0)) return;
  const core = frame.core.core;
  if (store.byHost.size) {
    const rows = core.tweenRows();
    const columns = rows.columns, src = rows.values;
    const values = rowRoom(rows.count);
    let n = 0;
    for (let i = 0; i < rows.count; i++) {
      const leaf = store.byHost.get(columns[i]!);
      if (!leaf) continue;
      rowLeaves[n] = leaf;
      const from = i * 4, to = n * 4;
      values[to] = src[from]!;
      values[to + 1] = src[from + 1]!;
      values[to + 2] = src[from + 2]!;
      values[to + 3] = src[from + 3]!;
      n++;
    }
    writeRows(n); // setters may call into the core: read first
    const changes = core.tweenChangeCount();
    let done = 0;
    for (let i = 0; i < changes; i++) {
      const c = core.tweenChange(i, tweenChangeOut);
      const leaf = store.byHost.get(c.hostId);
      if (leaf && c.kind === CHANGE_COMPLETED) completedLeaves[done++] = leaf;
    }
    for (let i = 0; i < done; i++) {
      const leaf = completedLeaves[i]!;
      completedLeaves[i] = null;
      leaf.end("finished");
    }
  }
  if (store.runs.size) {
    const active = new Set(core.timelineActive());
    for (const run of store.runs.values()) {
      if (!active.has(run.handle)) continue;
      const out = core.timelineOutputs();
      let n = 0;
      for (const b of run.blocks) {
        if (b.leaf.state !== "running" || !(out.weights[run.weightOffset + b.index]! > 0)) continue;
        const at = run.valueOffset + b.offset;
        const values = rowRoom(n + 1);
        rowLeaves[n] = b.leaf;
        // A block is one tween value: 1–4 words (a member's width).
        for (let k = 0; k < 4; k++) values[n * 4 + k] = k < b.words ? out.f32[at + k]! : 0;
        n++;
      }
      writeRows(n);
    }
    const n = core.timelineChangeCount();
    const changes: { hostId: number; kind: number; member: number }[] = [];
    for (let i = 0; i < n; i++) {
      const c = core.timelineChange(i);
      if (store.runs.has(c.hostId)) changes.push({ hostId: c.hostId, kind: c.kind, member: c.member });
    }
    for (const c of changes) {
      const run = store.runs.get(c.hostId);
      if (!run) continue;
      if (c.kind === CHANGE_MEMBER_DONE) run.blocks.find((b) => b.leaf.hostId === c.member)?.leaf.end("finished");
      else if (c.kind === CHANGE_FINISHED) {
        store.runs.delete(c.hostId);
        run.ns.forgetTimeline(run.handle);
        for (const b of run.blocks) b.leaf.end("finished");
        run.root.end("finished");
      }
    }
  }
}
