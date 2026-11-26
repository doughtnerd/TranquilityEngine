// One World's namespace in the page's animation core (ADR 0370: "Worlds, the editor viewport and play mode are
// namespaces in it"): a World id, the instances created in it, the asset references it holds, its command writer and
// the frame its stages share. Made by the `AnimationCore` World service (`service.ts`) the first time the World needs
// animation, closed when the World is torn down: its instances are destroyed and its asset references and curves dropped (assets
// no other World holds go idle, and are released when the Engine is disposed: see `AnimationCore`).
import type { Curve } from "../../../../engine/core/curve";
import type { World } from "../../../../engine/core/World";
import { Assets, fetchAssetBytes } from "../../../../engine/scene/Assets";
import { PASS_FIXED, PASS_NORMAL, STATUS_STALE_HANDLE } from "../wasm/wire/core";
import { OP_KILL as TIMELINE_KILL, type TIMELINE_CREATE } from "../wasm/wire/timeline";
import { OP_KILL as TWEEN_KILL, type TWEEN_CREATE } from "../wasm/wire/tween";
import type { RecordValues } from "./records";
import type { AnimationFrame } from "../stages/frame";
import type { AnimationAssetKind, AnimationAssetSource, AnimationCore } from "./AnimationCore";
import { CommandWriter, type CommandSink } from "./commands";
import { FrameMeter, takeNodeFuel } from "./frameMeter";

/** Asset kinds made from one file's bytes, which `acquireFile` can fetch. */
export type AnimationFileKind = "skeleton" | "clip" | "graph" | "posedb" | "profile" | "plugin";

/** File fetches in flight, by URL, shared by every World. */
const fetching = new Map<string, Promise<Uint8Array | null>>();

/**
 * @internal What watches a World's evaluates (`AnimationWorldCore.taps`): the live debugger's recorder (T52), which
 * keeps an Animator's inputs to re-evaluate past frames.
 */
export interface EvaluateTap {
  /**
   * The World's commands are in the core's command buffer (its first `len` bytes) and the input, blackboard and rig
   * views are written for the evaluate of `pass`; nothing is applied yet. A tap may read the views and snapshot instances; it never writes them.
   */
  applying(ns: AnimationWorldCore, len: number, pass: number, dtScaled: number, dtUnscaled: number): void;
  /** The evaluate of `pass` ran (its outputs are in the views; the state-change records are unread). */
  evaluated(ns: AnimationWorldCore, pass: number): void;
}

/** @internal A World's animation namespace. */
export class AnimationWorldCore {
  /** The World id the core knows this World by. */
  readonly id: number;
  /** Commands the gather sub-steps queue for this World's next evaluate. */
  readonly commands = new CommandWriter();
  private readonly instances = new Set<number>();
  /** Tween and timeline handles created in this World and not known to have ended (killed at teardown). */
  private readonly tweens = new Set<number>();
  private readonly timelines = new Set<number>();
  /** Asset handle → references this World holds. */
  private readonly refs = new Map<number, number>();
  /** Curve assets this World holds (T70): by content, with their references, and the content of each handle. */
  private readonly curves = new Map<string, { readonly handle: number; refs: number }>();
  private readonly curveByHandle = new Map<number, string>();
  private readonly sink: CommandSink;
  private readonly frame: { world: World; core: AnimationWorldCore; dt: number; unscaledDt: number; fixed: boolean; pass: number };
  private closed = false;
  /** What watches this World's evaluates (the live debugger's recorder, T52). */
  readonly taps = new Set<EvaluateTap>();
  /** This World's frame numbers for the profiler's Animation table (stage times, counters). */
  readonly meter = new FrameMeter();
  /** The evaluate in progress (for the taps): rewritten in place each evaluate. */
  private readonly evaluating = { pass: PASS_NORMAL, dtScaled: 0, dtUnscaled: 0 };

  constructor(
    readonly world: World,
    readonly core: AnimationCore,
  ) {
    this.id = core.openWorld();
    this.sink = {
      memory: () => core.buffer(),
      commandsPtr: () => core.commandsPtr(),
      writeInputs: (len) => {
        if (this.taps.size) {
          const e = this.evaluating;
          for (const t of this.taps) t.applying(this, len, e.pass, e.dtScaled, e.dtUnscaled);
        }
        return core.writeInputs(len);
      },
    };
    this.frame = { world, core: this, dt: 0, unscaledDt: 0, fixed: false, pass: PASS_NORMAL };
  }

  /** False once the World was torn down: every call is then a no-op answering 0. */
  get open(): boolean {
    return !this.closed;
  }

  /**
   * @internal The stage frame for this World (one object, reused: valid for the stage run it was made for). In a fixed
   * step `dt` is `fixedDeltaTime` for scaled and unscaled Animators alike.
   */
  frameFor(dt: number, fixed: boolean): AnimationFrame {
    const f = this.frame;
    f.dt = dt;
    f.fixed = fixed;
    f.pass = fixed ? PASS_FIXED : PASS_NORMAL;
    f.unscaledDt = fixed ? dt : this.world.time.unscaledDeltaTime;
    return f;
  }

  // --- Assets ---------------------------------------------------------------------------------------------------

  /** One reference to an asset for this World (see `AnimationCore.acquire`). Returns its handle, or 0. */
  acquire(key: string, kind: AnimationAssetKind, source: AnimationAssetSource | (() => AnimationAssetSource)): number {
    if (this.closed) return 0;
    return this.counted(this.core.acquire(key, kind, source));
  }

  private counted(handle: number): number {
    if (handle !== 0) this.refs.set(handle, (this.refs.get(handle) ?? 0) + 1);
    return handle;
  }

  /**
   * One reference to the project file `path` loaded as `kind`, keyed by its URL: fetched through `Assets` (read from
   * disk on the dedicated server) unless some World already holds it. Resolves to its handle, or 0 when the file is
   * missing, the core refused it, or this World closed meanwhile.
   */
  async acquireFile(path: string, kind: AnimationFileKind): Promise<number> {
    let url: string;
    try {
      url = Assets.url(path);
    } catch (err) {
      console.error(`[myco] animation: couldn't load "${path}":`, err);
      return 0;
    }
    if (this.closed) return 0;
    const loaded = this.core.acquireLoaded(url, kind);
    if (loaded !== 0) return this.counted(loaded);
    return this.fileHandle(url, path, kind);
  }

  private async fileHandle(url: string, path: string, kind: AnimationFileKind): Promise<number> {
    let pending = fetching.get(url);
    if (!pending) {
      pending = fetchAssetBytes(url).catch((err: unknown) => {
        console.error(`[myco] animation: couldn't load "${path}":`, err);
        return null;
      });
      fetching.set(url, pending);
      const clear = () => void (fetching.get(url) === pending && fetching.delete(url));
      pending.then(clear, clear);
    }
    const bytes = await pending;
    if (!bytes || this.closed) return 0;
    return this.acquire(url, kind, { kind, bytes });
  }

  /** Drops one of this World's references to an asset. Returns false when it held none. */
  release(handle: number): boolean {
    const n = this.refs.get(handle);
    if (!n) return false;
    if (n === 1) this.refs.delete(handle);
    else this.refs.set(handle, n - 1);
    return this.core.release(handle);
  }

  // --- Instances --------------------------------------------------------------------------------------------------

  /** Creates an instance in this World (graph 0: the implicit graph). Returns its handle, or 0 (`core.lastStatus()`). */
  createInstance(skeleton: number, graph = 0): number {
    if (this.closed) return 0;
    const h = this.core.createInstance(this.id, skeleton, graph);
    if (h !== 0) this.instances.add(h);
    return h;
  }

  /** Destroys one of this World's instances. Returns a status (`STATUS_STALE_HANDLE` when it isn't one). */
  destroyInstance(handle: number): number {
    if (!this.instances.delete(handle)) return STATUS_STALE_HANDLE;
    return this.core.destroyInstance(handle);
  }

  /** Instances alive in this World. */
  get instanceCount(): number {
    return this.instances.size;
  }

  // --- Tweens and timelines ----------------------------------------------------------------------------------------

  /** Creates a tween in this World (`world` filled in). Returns its handle, or 0 (`core.lastStatus()`). */
  createTween(values: Omit<RecordValues<typeof TWEEN_CREATE>, "world">): number {
    if (this.closed) return 0;
    const h = this.core.tweenCreate({ ...values, world: this.id });
    if (h !== 0) this.tweens.add(h);
    return h;
  }

  /** Creates a timeline instance of a clip in this World. Returns its handle, or 0. */
  createTimeline(values: Omit<RecordValues<typeof TIMELINE_CREATE>, "world">): number {
    if (this.closed) return 0;
    const h = this.core.timelineCreate({ ...values, world: this.id });
    if (h !== 0) this.timelines.add(h);
    return h;
  }

  /** Creates a sequence in this World from `SEQ_CREATE` + `SEQ_MEMBER` bytes whose `world` is this World's id. Returns its handle, or 0. */
  createSequence(bytes: Uint8Array): number {
    if (this.closed) return 0;
    const h = this.core.timelineCreateSequence(bytes);
    if (h !== 0) this.timelines.add(h);
    return h;
  }

  // --- Curves -----------------------------------------------------------------------------------------------------

  /**
   * One reference to the core asset of `curve` for this World (T70): loaded on the first reference of its content, shared
   * by later ones. Returns its handle (a tween's `ease`), or 0 when the core refused it (keys out of order, a non-finite
   * number) or this World closed. Give it back with `releaseCurve`.
   */
  acquireCurve(curve: Curve): number {
    if (this.closed) return 0;
    const key = JSON.stringify(curve);
    const known = this.curves.get(key);
    if (known) {
      known.refs++;
      return known.handle;
    }
    const handle = this.core.loadCurve(curve);
    if (handle === 0) return 0;
    const entry = { handle, refs: 1 };
    this.curves.set(key, entry);
    this.curveByHandle.set(handle, key);
    return handle;
  }

  /** Drops one reference to a curve `acquireCurve` gave; the core's asset is freed with the last. */
  releaseCurve(handle: number): void {
    const key = this.curveByHandle.get(handle);
    const entry = key === undefined ? undefined : this.curves.get(key);
    if (key === undefined || !entry || --entry.refs > 0) return;
    this.curves.delete(key);
    this.curveByHandle.delete(handle);
    this.core.releaseCurve(handle);
  }

  /** Forgets a tween or timeline handle that has ended (its change record was read). */
  forgetTween(handle: number): void {
    this.tweens.delete(handle);
  }

  /** Forgets a timeline handle that has ended or was killed. */
  forgetTimeline(handle: number): void {
    this.timelines.delete(handle);
  }

  // --- The frame --------------------------------------------------------------------------------------------------

  /**
   * Applies this World's queued commands (one `write_inputs`), then evaluates its instances of `pass`. Returns the
   * state-change records waiting (read them with `core.stateChange` before another World's evaluate).
   */
  evaluate(pass: number, dtScaled: number, dtUnscaled: number): number {
    if (this.closed) return 0;
    const e = this.evaluating;
    e.pass = pass;
    e.dtScaled = dtScaled;
    e.dtUnscaled = dtUnscaled;
    this.commands.flush(this.sink);
    const meter = this.meter;
    const t = meter.start();
    let changes = 0;
    try {
      changes = this.core.evaluate(this.id, pass, dtScaled, dtUnscaled);
    } finally {
      meter.stop("evaluate", t);
    }
    meter.evaluated(this.core.evaluateCounts(), takeNodeFuel(), this.core.pluginFaultCount(), pass === PASS_NORMAL);
    // No tap (the usual case: the live debugger's recorder isn't attached): nothing to call.
    if (this.taps.size) for (const tap of this.taps) tap.evaluated(this, pass);
    return changes;
  }

  /** @internal World teardown: destroys the instances, drops the asset references and gives the World id back. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.taps.clear();
    for (const h of this.instances) this.core.destroyInstance(h);
    this.instances.clear();
    for (const h of this.tweens) this.core.tweenControl(h, TWEEN_KILL);
    this.tweens.clear();
    for (const h of this.timelines) this.core.timelineControl(h, TIMELINE_KILL);
    this.timelines.clear();
    for (const [handle, n] of this.refs) for (let i = 0; i < n; i++) this.core.release(handle);
    this.refs.clear();
    for (const { handle } of this.curves.values()) this.core.releaseCurve(handle);
    this.curves.clear();
    this.curveByHandle.clear();
    this.commands.clear();
    this.core.closeWorld(this.id);
  }
}
