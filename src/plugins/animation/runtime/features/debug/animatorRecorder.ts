// The live debugger's recorder (ADR 0373 "A recorder keeps the last N seconds (default 10) … Scrub it to see the pose and
// graph at any frame. Poses are re-evaluated from the recorded inputs, which the deterministic core allows"; T52).
//
// One recorder follows one graph Animator in its World, through the World's evaluate tap (`AnimationWorldCore.taps`):
//
// - **Each evaluate the Animator takes part in** becomes a frame: what the core applied for its instance (its input,
//   blackboard and rig rows, and its command records: parameters, requests, travels, jumps, slot plays and stops,
//   links, layer weights, warp targets, IK targets and grounder hits in the rig row), the debug report after the
//   evaluate, its parameter values and root-motion delta. Commands an evaluate of the other pass applied to the instance
//   (a fixed Animator's commands queued in the frame pass) are kept with the next frame and replayed before it.
// - **Keyframes:** the instance's snapshot (ADR 0370 snapshot/restore) is taken before a frame's inputs apply, on the
//   first frame and then every `keyframeEvery` seconds (1).
// - **The ring** keeps the last `seconds` (10) of the World's unscaled clock, and always starts at a keyframe (frames
//   before the oldest kept keyframe go with it), so every kept frame can be re-evaluated.
// - **Re-evaluation** restores the nearest earlier keyframe into a scratch instance of the same graph and skeleton, in
//   a World id of its own in the page's core (so the play World's instances don't move), and replays the recorded rows
//   and commands frame by frame with their passes and time steps. The core is deterministic, so the scratch instance's
//   matrices equal the recorded frame's bit for bit. Scrubbing on from there continues without restoring.
// - **Showing** a past pose writes the re-evaluated matrices into the live instance's matrix row (the original saved)
//   and bumps its skinning version, so render sync draws it while the session is paused; the next evaluate (resuming,
//   stepping) or `show(null)` puts the saved row back first (the core reuses unchanged rows, D115).
//
// Not replayed: ragdoll physics rows (`physicsRead` changes an instance between frames) and a linked graph released
// since it was recorded; frames whose command buffer held a record this reader doesn't know aren't re-evaluated.
// Re-evaluate and show only between frames (a UI event), never inside a World's step.
import type { Animator } from "../../components/Animator";
import type { AnimationWorldCore, EvaluateTap } from "../../core/AnimationWorldCore";
import { getRecord, recordOpcode, type RecordLayout } from "../../core/records";
import { FLAG_FIXED, HANDLE_INDEX_MASK, INPUT_FLAGS, INPUT_STRIDE, MATRIX_FLOATS, PASS_FIXED, PLAY, ROOT_STRIDE, SET_LAYER, STOP } from "../../wasm/wire/core";
import {
  BLACKBOARD_DIRTY, BLACKBOARD_PARAMS, BLACKBOARD_STRIDE, BLACKBOARD_VALUES, CAPTURE_POSE, DEBUG, JUMP, LAYER_WEIGHT, LINK, REQUEST, SET_PARAM, SET_SEED, SLOT_NEXT_SECTION, SLOT_PLAY,
  SLOT_STOP, TRAVEL,
} from "../../wasm/wire/graph";
import { RIG_INPUT_STRIDE, RIG_RESET, WARP_TARGET } from "../../wasm/wire/rig";
import { DEBUG_BYTES } from "../../wasm/wire/debug";
import type { GraphMeta } from "../graph/asset";
import { decodeParameter } from "../graph/parameters";
import { graphInstanceOf, writtenParameters } from "../graph/runtime";
import { animatorRuntime, type AnimatorRuntime } from "../instances";
import type { AnimatorDebugFrame, DebugInput, DebugParamValue } from "./frame";
import { readDebugReport } from "./report";

/** @internal The recorder's settings. */
export interface RecorderOptions {
  /** Seconds kept (default 10, at least 1). */
  readonly seconds?: number;
  /** Seconds between keyframes (default 1). */
  readonly keyframeEvery?: number;
  /** Called with each entry as it is recorded (before the ring trims): a take writes it out (ADR 0348, `takeRecord.ts`). */
  readonly onEntry?: (entry: RecordedEntry) => void;
}

/** The command records a World's buffer holds (every one names its instance at byte 4). */
const COMMANDS: readonly RecordLayout[] = [PLAY, STOP, SET_LAYER, SET_PARAM, REQUEST, TRAVEL, JUMP, SLOT_PLAY, SLOT_NEXT_SECTION, SLOT_STOP, LINK, LAYER_WEIGHT, SET_SEED, CAPTURE_POSE, DEBUG, WARP_TARGET, RIG_RESET];
const LAYOUTS = new Map(COMMANDS.map((l) => [l.opcode, l]));
const INSTANCE_AT = 4;

/** What one evaluate applied to the instance. */
export interface RawFrame {
  readonly pass: number;
  readonly dt: number;
  readonly du: number;
  readonly input: Uint8Array;
  readonly blackboard: Uint8Array;
  readonly rig: Uint8Array;
  /** The instance's command records, back to back, and where each starts. */
  readonly commands: Uint8Array;
  readonly starts: readonly number[];
  /** False when the buffer held a record this reader doesn't know (it can't tell which were the instance's). */
  readonly complete: boolean;
}

/** @internal One recorded frame with what re-evaluating it takes (a take writes these, ADR 0348). */
export interface RecordedEntry {
  readonly frame: AnimatorDebugFrame;
  readonly raw: RawFrame;
  /** Evaluates of the other pass since the last frame that applied something to the instance (replayed first). */
  readonly before: readonly RawFrame[];
  /** The instance's snapshot before `raw` applied (a keyframe), or null. */
  readonly key: Uint8Array | null;
}

/** @internal The entries the recorder keeps. */
type Entry = RecordedEntry;

const copyOf = (buffer: ArrayBuffer, at: number, n: number): Uint8Array => new Uint8Array(buffer, at, n).slice();

/** @internal A ring of an Animator's recent frames with re-evaluation (see the file header). */
export class AnimatorRecorder {
  private entries: Entry[] = [];
  private carry: RawFrame[] = [];
  private pending: { raw: RawFrame; key: Uint8Array | null; inputs: DebugInput[] } | null = null;
  private target: { ns: AnimationWorldCore; rt: AnimatorRuntime; instance: number; graph: number; skeleton: number; bones: number; meta: GraphMeta } | null = null;
  private clock = 0;
  private lastKey = -Infinity;
  private next = 0;
  private keep: number;
  private readonly every: number;
  private readonly onEntry: ((entry: RecordedEntry) => void) | undefined;
  private scratch: { world: number; instance: number; at: { key: number; index: number } | null } | null = null;
  private shown: { index: number; saved: Float32Array } | null = null;
  private disposed = false;
  private readonly tap: EvaluateTap = {
    applying: (ns, len, pass, dt, du) => this.applying(ns, len, pass, dt, du),
    evaluated: (ns) => this.evaluated(ns),
  };

  constructor(
    readonly animator: Animator,
    options: RecorderOptions = {},
  ) {
    this.keep = Math.max(1, options.seconds ?? 10);
    this.every = Math.max(1e-3, options.keyframeEvery ?? 1);
    this.onEntry = options.onEntry;
    this.attach();
  }

  /** Seconds kept. Lowering it drops older frames at the next frame. */
  get seconds(): number {
    return this.keep;
  }
  set seconds(s: number) {
    if (Number.isFinite(s)) this.keep = Math.max(1, s);
  }

  /** The kept frames, oldest first. */
  get frames(): readonly AnimatorDebugFrame[] {
    return this.entries.map((e) => e.frame);
  }

  /** The newest frame, or null. */
  get latest(): AnimatorDebugFrame | null {
    return this.entries.at(-1)?.frame ?? null;
  }

  /** Whether kept frame `index` holds a keyframe (the scrubber's ticks). */
  isKeyframe(index: number): boolean {
    return this.entryAt(index)?.key != null;
  }

  /** The frame `shown` shows, or null for the live pose. */
  get showing(): number | null {
    return this.shown?.index ?? null;
  }

  /**
   * The pose (model-space skinning matrices, 12 floats per bone) at kept frame `index`, re-evaluated from the nearest
   * earlier keyframe and the recorded inputs; null when the frame isn't kept, can't be replayed, or the core is gone.
   */
  reevaluate(index: number): Float32Array | null {
    const t = this.target;
    const p = this.entries.findIndex((e) => e.frame.index === index);
    if (!t || p < 0 || !t.ns.open || this.disposed) return null;
    let k = p;
    while (k >= 0 && !this.entries[k]!.key) k--;
    if (k < 0) return null;
    for (let i = k; i <= p; i++) {
      const e = this.entries[i]!;
      if (!e.raw.complete || (i > k && e.before.some((b) => !b.complete))) return null;
    }
    const core = t.ns.core;
    const s = this.scratchFor(t);
    if (!s) return null;
    const keyIndex = this.entries[k]!.frame.index;
    let from = k;
    if (s.at && s.at.key === keyIndex && s.at.index <= index) from = this.entries.findIndex((e) => e.frame.index === s.at!.index) + 1;
    else if (core.restore(s.instance, this.entries[k]!.key!) !== 0) return null;
    for (let i = from; i <= p; i++) {
      const e = this.entries[i]!;
      if (i > k) for (const b of e.before) this.replay(s.world, s.instance, b);
      this.replay(s.world, s.instance, e.raw);
    }
    s.at = { key: keyIndex, index };
    const at = core.matrixOffset(s.instance);
    return core.views().matrices.slice(at, at + t.bones * MATRIX_FLOATS);
  }

  /**
   * Shows kept frame `index`'s re-evaluated pose on the live character until the next evaluate or `show(null)` (which
   * puts the live pose back). Returns false when the frame can't be re-evaluated (nothing changes then).
   */
  show(index: number | null): boolean {
    const t = this.target;
    if (index === null) {
      this.unshow();
      return true;
    }
    const pose = this.reevaluate(index);
    if (!t || !pose) return false;
    const core = t.ns.core;
    const at = core.matrixOffset(t.instance);
    const row = core.views().matrices;
    if (!this.shown) this.shown = { index, saved: row.slice(at, at + pose.length) };
    else this.shown.index = index;
    row.set(pose, at);
    t.rt.version++;
    return true;
  }

  /** Stops recording; puts a shown pose back and frees the scratch instance. */
  dispose(): void {
    if (this.disposed) return;
    this.unshow();
    this.target?.ns.taps.delete(this.tap);
    this.dropScratch();
    this.disposed = true;
    this.entries = [];
    this.carry = [];
  }

  // --- recording --------------------------------------------------------------------------------------------------

  /** Follows the Animator's current instance (taps its World); true when it has one. */
  private attach(): boolean {
    const rt = animatorRuntime(this.animator);
    const gi = graphInstanceOf(this.animator);
    if (!rt?.ns || !gi || !rt.ns.open) return false;
    if (this.target && this.target.instance === gi.instance && this.target.ns === rt.ns) return true;
    // A new instance (re-activation, a Skeleton change): start over.
    this.unshow();
    this.target?.ns.taps.delete(this.tap);
    this.dropScratch();
    this.entries = [];
    this.carry = [];
    this.lastKey = -Infinity;
    this.target = { ns: rt.ns, rt, instance: gi.instance, graph: gi.graph, skeleton: rt.skeleton?.handle ?? 0, bones: rt.skeleton?.info?.bones ?? 0, meta: gi.meta };
    rt.ns.taps.add(this.tap);
    return true;
  }

  /** Keeps trying to attach until the Animator has an instance (the graph may still load). */
  poll(): boolean {
    return !this.disposed && this.attach();
  }

  private applying(ns: AnimationWorldCore, len: number, pass: number, dt: number, du: number): void {
    this.pending = null;
    if (this.shown) this.unshow(); // the live pose back before the core evaluates (it may reuse the row)
    const gi = graphInstanceOf(this.animator);
    if (!gi || this.target?.ns !== ns || gi.instance !== this.target.instance) {
      if (!this.attach() || this.target?.ns !== ns) return;
    }
    const t = this.target!;
    const core = ns.core;
    const buffer = core.buffer();
    const v = core.views();
    const row = t.instance & HANDLE_INDEX_MASK;
    const input = copyOf(buffer, v.inputs.byteOffset + row * INPUT_STRIDE, INPUT_STRIDE);
    const blackboard = copyOf(buffer, v.blackboard.byteOffset + row * BLACKBOARD_STRIDE, BLACKBOARD_STRIDE);
    const rig = copyOf(buffer, v.rigInputs.byteOffset + row * RIG_INPUT_STRIDE, RIG_INPUT_STRIDE);
    const { commands, starts, complete } = this.commandsOf(new DataView(buffer, core.commandsPtr(), len), t.instance);
    const raw: RawFrame = { pass, dt, du, input, blackboard, rig, commands, starts, complete };
    const flags = new DataView(input.buffer).getUint32(INPUT_FLAGS, true);
    const takesPart = ((flags & FLAG_FIXED) !== 0) === (pass === PASS_FIXED);
    if (!takesPart) {
      const bb = new DataView(blackboard.buffer);
      if (starts.length || bb.getUint32(BLACKBOARD_DIRTY, true) || bb.getUint32(BLACKBOARD_DIRTY + 4, true)) this.carry.push(raw);
      return;
    }
    const keyDue = this.entries.length === 0 || this.clock - this.lastKey >= this.every - 1e-9;
    const key = keyDue ? core.snapshot(t.instance) : null;
    const inputs = [...this.carry, raw].flatMap((r) => this.describe(t, r));
    const prev = this.entries.at(-1)?.raw.rig;
    if (prev && !sameBytes(prev, rig)) inputs.push({ kind: "ik" });
    this.pending = { raw, key, inputs };
  }

  private evaluated(ns: AnimationWorldCore): void {
    const p = this.pending;
    const t = this.target;
    this.pending = null;
    if (!p || !t || t.ns !== ns) return;
    const core = ns.core;
    const start = this.clock;
    this.clock += p.raw.du;
    const report = core.debugWrite(t.instance) > 0 ? readDebugReport(new DataView(core.buffer(), core.debugPtr(), DEBUG_BYTES), 0) : { instance: t.instance, nodes: [], machines: [], transitions: [], requests: [], dropped: 0 };
    const parameters: (DebugParamValue | null)[] = t.meta.paramTypes.map(() => null);
    for (const [i, value] of writtenParameters(this.animator, () => true)) parameters[i] = value;
    const rootAt = (t.instance & HANDLE_INDEX_MASK) * (ROOT_STRIDE / 4);
    const root = Array.from(core.views().roots.subarray(rootAt, rootAt + ROOT_STRIDE / 4));
    const frame: AnimatorDebugFrame = { index: this.next++, time: this.clock, report, parameters, inputs: p.inputs, root };
    if (p.key) this.lastKey = start;
    const entry: Entry = { frame, raw: p.raw, before: this.carry, key: p.key };
    this.entries.push(entry);
    this.carry = [];
    this.onEntry?.(entry);
    this.trim();
  }

  /** Drops frames older than `seconds`, then up to the oldest kept keyframe. */
  private trim(): void {
    const newest = this.entries.at(-1);
    if (!newest) return;
    let drop = 0;
    while (drop < this.entries.length - 1 && newest.frame.time - this.entries[drop]!.frame.time > this.keep + 1e-9) drop++;
    if (this.entries.slice(drop).some((e) => e.key)) while (drop < this.entries.length - 1 && !this.entries[drop]!.key) drop++;
    if (!drop) return;
    this.entries.splice(0, drop);
    if (this.scratch) this.scratch.at = null; // its keyframe may have gone
  }

  /** The instance's records among a command buffer's, and whether every record was known. */
  private commandsOf(view: DataView, instance: number): { commands: Uint8Array; starts: number[]; complete: boolean } {
    const parts: Uint8Array[] = [];
    const starts: number[] = [];
    let at = 0;
    let size = 0;
    let complete = true;
    while (at + 4 <= view.byteLength) {
      const layout = LAYOUTS.get(recordOpcode(view, at));
      if (!layout || at + layout.stride > view.byteLength) {
        complete = false;
        break;
      }
      if (view.getUint32(at + INSTANCE_AT, true) === instance) {
        starts.push(size);
        parts.push(new Uint8Array(view.buffer, view.byteOffset + at, layout.stride).slice());
        size += layout.stride;
      }
      at += layout.stride;
    }
    const commands = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      commands.set(p, o);
      o += p.length;
    }
    return { commands, starts, complete };
  }

  /** A raw frame's inputs, named by the graph's tables. */
  private describe(t: NonNullable<AnimatorRecorder["target"]>, raw: RawFrame): DebugInput[] {
    const out: DebugInput[] = [];
    const meta = t.meta;
    const c = meta.compiled;
    const bb = new DataView(raw.blackboard.buffer);
    const words = new Uint32Array(4);
    const param = (i: number, w: (k: number) => number): DebugInput => {
      for (let k = 0; k < 4; k++) words[k] = w(k);
      const type = meta.paramTypes[i];
      return { kind: "param", name: c.parameters[i] ?? `#${i}`, value: type ? decodeParameter(type, words, 0) : null };
    };
    const lo = bb.getUint32(BLACKBOARD_DIRTY, true), hi = bb.getUint32(BLACKBOARD_DIRTY + 4, true);
    for (let i = 0; i < Math.min(BLACKBOARD_PARAMS, meta.paramTypes.length); i++) {
      if (!((i < 32 ? lo >>> i : hi >>> (i - 32)) & 1)) continue;
      out.push(param(i, (k) => bb.getUint32(BLACKBOARD_VALUES + 16 * i + 4 * k, true)));
    }
    const cmds = new DataView(raw.commands.buffer);
    const clipName = (handle: number) => [...t.rt.clips.values()].find((e) => e.handle === handle)?.path ?? `clip ${handle}`;
    const state = (m: number, s: number) => ({ machine: meta.machines[m]?.layer ?? meta.machines[m]?.node ?? `#${m}`, state: meta.machines[m]?.states[s] ?? `#${s}` });
    for (const at of raw.starts) {
      const op = recordOpcode(cmds, at);
      if (op === SET_PARAM.opcode) {
        const r = getRecord(cmds, at, SET_PARAM);
        out.push(param(r.param, (k) => [r.w0, r.w1, r.w2, r.w3][k]!));
      } else if (op === REQUEST.opcode) {
        const r = getRecord(cmds, at, REQUEST);
        out.push({ kind: "request", name: c.strings[r.name] ?? `#${r.name}`, lifetime: r.lifetime });
      } else if (op === TRAVEL.opcode || op === JUMP.opcode) {
        const r = getRecord(cmds, at, TRAVEL);
        out.push({ kind: op === TRAVEL.opcode ? "travel" : "jump", ...state(r.machine, r.state) });
      } else if (op === SLOT_PLAY.opcode) {
        const r = getRecord(cmds, at, SLOT_PLAY);
        out.push({ kind: "slotPlay", slot: c.slots[r.slot] ?? `#${r.slot}`, clip: clipName(r.clip) });
      } else if (op === SLOT_STOP.opcode) {
        const r = getRecord(cmds, at, SLOT_STOP);
        out.push({ kind: "slotStop", slot: c.slots[r.slot] ?? `#${r.slot}` });
      } else if (op === LINK.opcode) {
        const r = getRecord(cmds, at, LINK);
        out.push({ kind: "link", linked: c.linked[r.linked] ?? `#${r.linked}` });
      } else if (op === LAYER_WEIGHT.opcode) {
        const r = getRecord(cmds, at, LAYER_WEIGHT);
        out.push({ kind: "layerWeight", layer: c.layers[r.layer] ?? `#${r.layer}`, weight: r.weight });
      } else if (op !== DEBUG.opcode) {
        out.push({ kind: "other", what: op === WARP_TARGET.opcode ? "warp target" : op === RIG_RESET.opcode ? "rig reset" : op === SLOT_NEXT_SECTION.opcode ? "next section" : "command" });
      }
    }
    return out;
  }

  // --- replay -----------------------------------------------------------------------------------------------------

  private scratchFor(t: NonNullable<AnimatorRecorder["target"]>): NonNullable<AnimatorRecorder["scratch"]> | null {
    if (this.scratch) return this.scratch;
    const core = t.ns.core;
    const world = core.openWorld();
    const instance = core.createInstance(world, t.skeleton, t.graph);
    if (!instance) {
      core.closeWorld(world);
      return null;
    }
    this.scratch = { world, instance, at: null };
    return this.scratch;
  }

  /** Applies one recorded evaluate to the scratch instance: its rows, its commands (renamed to it), then the evaluate. */
  private replay(world: number, instance: number, raw: RawFrame): void {
    replayRows(this.target!.ns.core, world, instance, raw);
  }

  private unshow(): void {
    const s = this.shown;
    const t = this.target;
    this.shown = null;
    if (!s || !t || !t.ns.open) return;
    const core = t.ns.core;
    core.views().matrices.set(s.saved, core.matrixOffset(t.instance));
    t.rt.version++;
  }

  private dropScratch(): void {
    const s = this.scratch;
    this.scratch = null;
    if (!s || !this.target) return;
    try {
      this.target.ns.core.destroyInstance(s.instance);
      this.target.ns.core.closeWorld(s.world);
    } catch {
      // The page's core is gone with its Engine.
    }
  }

  private entryAt(index: number): Entry | undefined {
    return this.entries.find((e) => e.frame.index === index);
  }
}

/**
 * @internal Applies one recorded evaluate to `instance` of `world` in `core`: its input, blackboard and rig rows, its
 * command records renamed to the instance, then the evaluate with the recorded pass and steps (the recorder's replay, and
 * a take's, ADR 0348).
 */
export function replayRows(core: AnimationWorldCore["core"], world: number, instance: number, raw: RawFrame): void {
  const row = instance & HANDLE_INDEX_MASK;
  const v = core.views();
  new Uint8Array(v.buffer, v.inputs.byteOffset + row * INPUT_STRIDE, INPUT_STRIDE).set(raw.input);
  new Uint8Array(v.buffer, v.blackboard.byteOffset + row * BLACKBOARD_STRIDE, BLACKBOARD_STRIDE).set(raw.blackboard);
  new Uint8Array(v.buffer, v.rigInputs.byteOffset + row * RIG_INPUT_STRIDE, RIG_INPUT_STRIDE).set(raw.rig);
  const commands = raw.commands.slice();
  const view = new DataView(commands.buffer);
  for (const at of raw.starts) view.setUint32(at + INSTANCE_AT, instance, true);
  new Uint8Array(core.buffer(), core.commandsPtr(), commands.length).set(commands);
  core.writeInputs(commands.length);
  core.evaluate(world, raw.pass, raw.dt, raw.du);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
