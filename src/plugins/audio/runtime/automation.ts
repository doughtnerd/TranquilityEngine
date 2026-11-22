/**
 * ADR 0158 §3–§4: what an audio backend does with event automation and sustain loops.
 *
 * Main decides things when they happen (a play, a parameter set, a release) and hands them to the backend through
 * `AutomationSink`. The core backend writes them to the core (CURVES, PARAM, AUTOMATE, BUS_AUTOMATE, SET_LOOP), which
 * smooths parameters and evaluates curves every quantum. Backends without the core (the Babylon fallback, tests) use
 * `TsAutomation`, the same semantics evaluated once per frame on main; that is the only case where events cost main
 * per-frame work.
 */

import { evalCurve, type Curve } from "../../../engine/core/curve";
import { VOICE_LOOPS_MAX } from "./wire.generated";
import { mixer } from "../../../engine/audio/mixer";
import type { AudioVoice } from "./backend";
import { warnOnce } from "./core/handle";

/**
 * What a curve drives. The numbers are the core's `target` values. `Highpass` (a cut-off floor in Hz, the highest curve
 * wins) and `Pan` (−1..1, curves summed and clamped) are voice-only (ABI 4.4); buses ignore them.
 */
export const enum AutoTarget { Volume = 0, Pitch = 1, Lowpass = 2, Highpass = 3, Pan = 4 }

/**
 * ADR 0332: the time parameters a voice binding can read instead of a parameter slot, in seconds. The numbers are the
 * wire's `TIME_*`. `Voice`: since the voice started (paused time counts); `Clip`: the voice's playhead in its clip;
 * `Sequence`: the voice's instance group's sequence clock, which `AutomationSink.setSequenceTime` re-anchors.
 */
export const enum TimeParam { Voice = 0, Clip = 1, Sequence = 2 }

/**
 * A parameter slot: one of the project's global parameters, or one of the voice's instance's local ones; or, with
 * `time` set (ADR 0332), a time parameter (then `global` and `slot` are unused). Bus bindings ignore time parameters.
 */
export interface ParamRef {
  global: boolean;
  slot: number;
  time?: TimeParam;
}

/** ADR 0328: the loops a voice's loop program keeps (the core's bound, declared once on the wire). */
export const MAX_VOICE_LOOPS = VOICE_LOOPS_MAX;

/**
 * ADR 0328: one loop of a voice's loop program (`AutomationSink.setLoops`), in seconds of the clip. `start === end` is a
 * hold point (the playhead parks there while the loop is active). See `native/audio/crates/audio-core/src/voice_loops.rs`.
 */
export interface VoiceLoop {
  start: number;
  end: number;
  direction: "forward" | "pingPong" | "backward";
  /** The seam's equal-power crossfade (and a hold point's fades), seconds. */
  crossfade: number;
  /** 0 endless; else passes in all, the first included. */
  count: number;
  /** `held`: until the voice's key-off (`setLoop(voice, 0, 0, false)`); `parameter`: while `param` is `op` `threshold`. */
  active: "always" | "held" | "parameter";
  param?: ParamRef;
  op?: ">" | "<";
  threshold?: number;
  exit: "finish" | "jump" | "crossfade";
  /** The exit crossfade (`exit: "crossfade"`), seconds. */
  exitFade: number;
  reentry: "ignore" | "reenter";
}

/** A `ParamRef` to the time parameter `which` (ADR 0332). */
export function timeParam(which: TimeParam): ParamRef {
  return { global: false, slot: 0, time: which };
}

/** One curve applied to one property, read from one parameter. */
export interface Binding {
  param: ParamRef;
  /** A curve id given to `defineCurve`. */
  curve: number;
  target: AutoTarget;
  /**
   * ADR 0166 §2.3 (R6): a music stem's binding that moves only at the next `beat` or `bar` line. The core evaluates its
   * bindings continuously, so a quantised binding is never given to `bindVoice`: the music player evaluates it on main at
   * the grid point (`evaluateQuantized`) and stamps an in-voice ramp (`music/stems.ts` `quantizedRamp`).
   */
  quantize?: "beat" | "bar";
}

/** R6: the seconds of the stamped in-voice ramp a quantised binding makes (api-and-models §2.3: 20 ms). */
export const QUANTIZED_RAMP_SECONDS = 0.02;

/** R6: the bindings that follow their parameter continuously (what a sink's `bindVoice` takes). */
export function continuousBindings(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((b) => b.quantize === undefined);
}

/** R6: the quantised bindings, which the music player evaluates at grid points. */
export function quantizedBindings(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((b) => b.quantize !== undefined);
}

/** Global parameter slots, local slots per instance, instance ids, curves and bindings per voice or bus: the core's capacities (ADR 0158, E2). */
export const MAX_GLOBAL_SLOTS = 64;
export const MAX_LOCAL_SLOTS = 16;
export const MAX_GROUPS = 1024;
export const MAX_CURVES = 1024;
export const MAX_BINDINGS = 8;
/** The cutoff that means "no low-pass". */
export const LOWPASS_OFF = 24000;
/** The high-pass floor with no highpass binding (at or below 20 Hz the core runs none). */
export const HIGHPASS_OFF = 0;

export interface AutomationSink {
  /** Define or replace curve `id` (0..MAX_CURVES-1). */
  defineCurve(id: number, curve: Curve): void;
  /** Set a parameter's target: `group` 0 is global (slots 0..63), else an instance (1..1024; slots 0..15). `seekPerSecond` 0 jumps. */
  setParam(group: number, slot: number, value: number, seekPerSecond: number): void;
  /**
   * Bind a voice just played (replacing any earlier bindings): its instance `group` (as in its `PlayRequest`) and up to
   * `MAX_BINDINGS` curves. `base` is the volume and pitch it was played with (the evaluator multiplies onto them).
   * `startAt` is its `PlayRequest.at` (heard seconds), where its voice time starts; the core knows it from the PLAY, a
   * sink without the core uses it (omitted: now). A re-bind keeps the voice's start.
   */
  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }, startAt?: number): void;
  /**
   * ADR 0332: re-anchor instance `group`'s sequence clock (0: the global one) at heard time `at` (omitted: as soon as
   * possible): from there it reads `value` seconds, moving `rate` seconds per second (0 parks it at a hold point). Main
   * calls it when a sequence starts, wraps a loop, parks or leaves; bindings on `TimeParam.Sequence` follow it.
   */
  setSequenceTime(group: number, value: number, rate: number, at?: number): void;
  /** Bind a bus to global parameters (replacing its earlier bindings); pitch bindings are ignored. */
  bindBus(bus: string, bindings: readonly Binding[]): void;
  /**
   * Loop a region of a playing clip (seconds; `end` 0 is the clip's end) or, with `looping` false, release it: the voice
   * finishes its current pass and plays on to the clip's end. On a voice with a loop program (`setLoops`), `looping`
   * false is its key-off (held loops let go by their exit settings) and `looping` true replaces the program.
   */
  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void;
  /**
   * ADR 0328: give a clip voice of instance `group` (whose local parameters its parameter loops read) a loop program of
   * up to `MAX_VOICE_LOOPS` loops (replacing any loop or program; an empty list clears it). The core runs directions,
   * counts, crossfades, hold points, activations, exits and re-entry; `TsAutomation` approximates at control rate.
   */
  setLoops(voice: AudioVoice, group: number, loops: readonly VoiceLoop[]): void;
}

/** A parameter being smoothed toward its target. */
export class ParamState {
  value: number;
  target: number;
  seek = 0;
  constructor(v = 0) { this.value = v; this.target = v; }
  set(target: number, seekPerSecond: number): void {
    this.target = target;
    this.seek = seekPerSecond;
    if (!(seekPerSecond > 0)) this.value = target;
  }
  /** Move toward the target by `seek × dt`, never past it. Returns whether the value changed. */
  advance(dt: number): boolean {
    if (this.value === this.target) return false;
    const step = this.seek * dt;
    if (!(step > 0) || Math.abs(this.target - this.value) <= step) this.value = this.target;
    else this.value += this.target > this.value ? step : -step;
    return true;
  }
}

/**
 * The product of volume curves, product of pitch curves, the lowest low-pass, the highest high-pass floor and the summed
 * pan (clamped to −1..1) among `bindings`, as the core's `automation.rs` `evaluate`.
 */
export function evaluate(bindings: readonly Binding[], curves: ReadonlyMap<number, Curve>, read: (p: ParamRef) => number): AutoResult {
  let gain = 1, pitch = 1, lowpass = LOWPASS_OFF, highpass = HIGHPASS_OFF, pan = 0;
  for (const b of bindings) {
    // A curve id that was never defined is the empty curve (0), as in the core's table.
    const y = evalCurve(curves.get(b.curve) ?? [], read(b.param));
    if (b.target === AutoTarget.Volume) gain *= Math.max(0, y);
    else if (b.target === AutoTarget.Pitch) pitch *= y > 0 ? y : 1;
    else if (b.target === AutoTarget.Lowpass) lowpass = Math.min(lowpass, Math.max(10, y));
    else if (b.target === AutoTarget.Highpass) highpass = Math.max(highpass, y);
    else if (b.target === AutoTarget.Pan) pan += y;
  }
  return { gain, pitch, lowpass, highpass: finiteHighpass(highpass), pan: clampPan(pan) };
}

/** The core's clamp of a summed pan: −1..1, NaN 0. */
function clampPan(pan: number): number {
  return pan !== pan ? 0 : Math.min(1, Math.max(-1, pan));
}

/** The core's clamp of a high-pass floor: 0..24,000 (NaN or negative 0). */
function finiteHighpass(hp: number): number {
  return hp >= 0 ? Math.min(hp, LOWPASS_OFF) : 0;
}

/**
 * R6: the volume gain and low-pass of the quantised `bindings` at the parameter values `read` gives now: the same rules
 * as `evaluate`, over only the bindings with `quantize`. `grid` is the coarsest grid among them that applies (`bar`
 * beats `beat` when both are present: the stem moves when the slower grid arrives, so one ramp carries every binding).
 * `grid` is null when none is quantised.
 */
export function evaluateQuantized(bindings: readonly Binding[], curves: ReadonlyMap<number, Curve>, read: (p: ParamRef) => number): { gain: number; lowpass: number; grid: "beat" | "bar" | null } {
  const q = quantizedBindings(bindings);
  if (q.length === 0) return { gain: 1, lowpass: LOWPASS_OFF, grid: null };
  const r = evaluate(q, curves, read);
  return { gain: r.gain, lowpass: r.lowpass, grid: q.some((b) => b.quantize === "bar") ? "bar" : "beat" };
}

/** What `evaluate` returns and `evaluateInto` writes. */
export interface AutoResult {
  gain: number;
  pitch: number;
  lowpass: number;
  /** ABI 4.4: the high-pass floor in Hz (0: none). */
  highpass: number;
  /** ABI 4.4: pan −1..1. */
  pan: number;
}

const NO_CURVE: Curve = [];

/**
 * `evaluate` without a callback or a result object (E5.3c: the core backend's play path): `n` bindings as parallel
 * arrays (curve ids, `AutoTarget`s, and the parameter value each reads), written into `out`. The same rules and the
 * same order of multiplication as `evaluate`, so the numbers are identical.
 */
export function evaluateInto(n: number, curveIds: ArrayLike<number>, targets: ArrayLike<number>, x: ArrayLike<number>, curves: ReadonlyMap<number, Curve>, out: AutoResult): AutoResult {
  let gain = 1, pitch = 1, lowpass = LOWPASS_OFF, highpass = HIGHPASS_OFF, pan = 0;
  for (let j = 0; j < n; j++) {
    const y = evalCurve(curves.get(curveIds[j]!) ?? NO_CURVE, x[j]!);
    const target = targets[j];
    if (target === AutoTarget.Volume) gain *= Math.max(0, y);
    else if (target === AutoTarget.Pitch) pitch *= y > 0 ? y : 1;
    else if (target === AutoTarget.Lowpass) lowpass = Math.min(lowpass, Math.max(10, y));
    else if (target === AutoTarget.Highpass) highpass = Math.max(highpass, y);
    else if (target === AutoTarget.Pan) pan += y;
  }
  out.gain = gain;
  out.pitch = pitch;
  out.lowpass = lowpass;
  out.highpass = finiteHighpass(highpass);
  out.pan = clampPan(pan);
  return out;
}

interface BoundVoice {
  voice: AudioVoice;
  group: number;
  bindings: readonly Binding[];
  base: { volume: number; pitch: number };
  gain: number;
  pitch: number;
  /** ADR 0332: where its voice time starts (the sink's clock), and whether a binding reads a time parameter. */
  start: number;
  timed: boolean;
}

/** A voice's loop program on `TsAutomation`: its first region, looping or not, and whether it was left. */
interface TsProgram {
  voice: AudioVoice;
  group: number;
  loop: VoiceLoop;
  looping: boolean;
  left: boolean;
}

/** One re-anchor of a sequence clock: `value` seconds at `at`, moving `rate` seconds per second. */
interface ClockAnchor {
  value: number;
  rate: number;
  at: number;
}

/**
 * The evaluator for backends without the core: the same smoothing and curves as the core, once per frame (`update`),
 * applied through the voice setters (`setVolume`, `setPitch`) and the mixer's bus automation. Per-voice low-pass isn't
 * available here (warns once); loops use the voice's own `setLoop`.
 *
 * ADR 0332's time parameters run on `clock` (the backend's heard clock in seconds; without one, the sum of `update`'s
 * `dt`): voice time from the voice's `startAt` (or its first bind), sequence time from the group's anchors, and clip
 * time estimated as voice time × the voice's pitch (this sink can't read a playhead, so a seek or a loop wrap isn't
 * seen). A voice with a time binding is re-evaluated every frame.
 */
export class TsAutomation implements AutomationSink {
  private readonly curves = new Map<number, Curve>();
  private readonly globals: ParamState[] = Array.from({ length: MAX_GLOBAL_SLOTS }, () => new ParamState());
  private readonly locals = new Map<number, ParamState[]>();
  private readonly voices: BoundVoice[] = [];
  private readonly buses = new Map<string, readonly Binding[]>();
  /** ADR 0328: voices with a loop program: its first region, run at control rate (activation, key-off, exit jump). */
  private readonly programs = new Map<AudioVoice, TsProgram>();
  /** ADR 0332: each group's sequence clock anchors, oldest first (only the newest at or before now matters). */
  private readonly clocks = new Map<number, ClockAnchor[]>();
  private dirty = true;
  private elapsed = 0;

  constructor(private readonly clock?: () => number) {}

  defineCurve(id: number, curve: Curve): void {
    if (id >= 0 && id < MAX_CURVES) { this.curves.set(id, curve); this.dirty = true; }
  }

  setParam(group: number, slot: number, value: number, seekPerSecond: number): void {
    const p = this.param(group, slot);
    if (!p) return;
    p.set(value, seekPerSecond);
    this.dirty = true;
    if (this.programs.size > 0) this.followLoops();
  }

  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }, startAt?: number): void {
    const i = this.voices.findIndex((v) => v.voice === voice);
    const start = i >= 0 ? this.voices[i]!.start : startAt !== undefined && Number.isFinite(startAt) ? startAt : this.now();
    if (i >= 0) this.voices.splice(i, 1);
    bindings = continuousBindings(bindings); // R6: a quantised binding is the music player's, never followed per frame
    if (bindings.length === 0) return;
    if (bindings.some((b) => b.target === AutoTarget.Lowpass)) warnOnce("events:lowpass-fallback", "Audio events: low-pass automation needs the audio core; it is ignored on the Babylon fallback.");
    if (bindings.some((b) => b.target === AutoTarget.Highpass || b.target === AutoTarget.Pan)) warnOnce("events:pan-highpass-fallback", "Audio: pan and high-pass automation need the audio core; they are ignored on the Babylon fallback.");
    const kept = bindings.slice(0, MAX_BINDINGS);
    const v: BoundVoice = { voice, group, bindings: kept, base: { ...base }, gain: NaN, pitch: NaN, start, timed: kept.some((b) => b.param.time !== undefined) };
    this.voices.push(v);
    this.apply(v);
  }

  setSequenceTime(group: number, value: number, rate: number, at?: number): void {
    if (!Number.isInteger(group) || group < 0 || group > MAX_GROUPS || !Number.isFinite(value) || !Number.isFinite(rate)) return;
    const now = this.now();
    const t = at !== undefined && Number.isFinite(at) ? at : now;
    const list = this.clocks.get(group) ?? [];
    let k = list.length;
    while (k > 0 && list[k - 1]!.at > t) k--;
    list.splice(k, 0, { value, rate, at: t });
    this.clocks.set(group, list);
    this.dirty = true;
  }

  bindBus(bus: string, bindings: readonly Binding[]): void {
    const global = bindings.filter((b) => b.param.global && (b.target === AutoTarget.Volume || b.target === AutoTarget.Lowpass)).slice(0, MAX_BINDINGS);
    if (global.length === 0) { this.buses.delete(bus); mixer._setAutomation(bus, 1, LOWPASS_OFF); }
    else this.buses.set(bus, global);
    this.dirty = true;
  }

  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void {
    const prog = this.programs.get(voice);
    if (prog && !looping) {
      // The program's key-off: a held loop lets go by its exit (a jump seeks to its end; finish and crossfade play the pass out).
      this.programs.delete(voice);
      if (prog.looping && prog.loop.active === "held") {
        voice.setLoop(prog.loop.start, prog.loop.end, false);
        if (prog.loop.exit === "jump") voice.seek(prog.loop.end);
      }
      return;
    }
    if (looping) this.programs.delete(voice);
    voice.setLoop(start, end, looping);
  }

  setLoops(voice: AudioVoice, group: number, loops: readonly VoiceLoop[]): void {
    this.programs.delete(voice);
    const first = loops.find((l) => l.end > l.start);
    if (loops.some((l) => l.end <= l.start || l.direction !== "forward" || l.count > 0) || loops.filter((l) => l.end > l.start).length > 1) {
      warnOnce("events:loop-modes-fallback", "Audio: loop modes (hold points, several loops, ping-pong and backward loops, repeat counts) need the audio core; the Babylon fallback loops the first region forward.");
    }
    if (!first) return;
    const prog: TsProgram = { voice, group, loop: first, looping: this.loopActive(group, first), left: false };
    this.programs.set(voice, prog);
    if (prog.looping) voice.setLoop(first.start, first.end, true);
  }

  /** Once per frame: smooth parameters, then re-apply every bound voice and bus whose inputs moved. */
  update(dt: number): void {
    if (dt > 0) this.elapsed += dt;
    for (const v of this.voices) if (v.timed) { this.dirty = true; break; }
    for (const p of this.globals) if (p.advance(dt)) this.dirty = true;
    for (const ps of this.locals.values()) for (const p of ps) if (p.advance(dt)) this.dirty = true;
    if (!this.dirty) return;
    if (this.programs.size > 0) this.followLoops();
    this.dirty = false;
    let w = 0;
    for (const v of this.voices) {
      if (!v.voice.playing) continue;
      this.voices[w++] = v;
      this.apply(v);
    }
    this.voices.length = w;
    for (const [bus, bindings] of this.buses) {
      const r = evaluate(bindings, this.curves, (p) => this.read(0, p));
      mixer._setAutomation(bus, r.gain, r.lowpass);
    }
  }

  /** Forget an instance's local parameters and sequence clock (its group id is free again). */
  releaseGroup(group: number): void {
    this.locals.delete(group);
    this.clocks.delete(group);
  }

  /** ADR 0332: group `group`'s sequence clock now (seconds; 0 before any anchor). */
  sequenceTime(group: number): number {
    const list = this.clocks.get(group);
    if (!list) return 0;
    const now = this.now();
    let k = list.length - 1;
    while (k >= 0 && list[k]!.at > now) k--;
    if (k < 0) return 0;
    if (k > 0) list.splice(0, k); // older anchors are superseded
    const a = list[0]!;
    return a.value + a.rate * (now - a.at);
  }

  /** The current (smoothed) value of a parameter, for tests and debugging. */
  valueOf(group: number, slot: number): number {
    return this.param(group, slot)?.value ?? 0;
  }

  /**
   * Only the voice setters carry the automated gain and pitch; the `PlayRequest` keeps the base values (the request's
   * volume is `base.volume`). A voice still waiting for the core (`PendingCoreBackend`) stores setter values in its
   * request, so `EventInstance.resend` sets the base values back before the core's own automation binds.
   */
  private apply(v: BoundVoice): void {
    const r = evaluate(v.bindings, this.curves, (p) => (p.time !== undefined ? this.timeOf(v, p.time) : this.read(v.group, p)));
    if (r.gain !== v.gain) { v.gain = r.gain; v.voice.setVolume(v.base.volume * r.gain); }
    if (r.pitch !== v.pitch) { v.pitch = r.pitch; v.voice.setPitch(v.base.pitch * r.pitch); }
  }

  private read(group: number, p: ParamRef): number {
    if (p.time !== undefined) return 0; // a bus reads no time
    return (p.global ? this.globals[p.slot] : this.locals.get(group)?.[p.slot])?.value ?? 0;
  }

  /** A loop's activation now (`held` and `always`: on; `parameter`: its test of the parameter). */
  private loopActive(group: number, l: VoiceLoop): boolean {
    if (l.active !== "parameter") return true;
    if (!l.param) return false;
    const v = this.read(group, l.param);
    return l.op === "<" ? v < (l.threshold ?? 0) : v > (l.threshold ?? 0);
  }

  /** Parameter loops follow their parameter: off exits (a jump seeks to the end), on re-enters only with `reenter`. */
  private followLoops(): void {
    for (const [voice, prog] of this.programs) {
      if (!voice.playing) { this.programs.delete(voice); continue; }
      if (prog.loop.active !== "parameter") continue;
      const on = this.loopActive(prog.group, prog.loop);
      if (on === prog.looping) continue;
      if (!on) {
        prog.looping = false;
        prog.left = true;
        voice.setLoop(prog.loop.start, prog.loop.end, false);
        if (prog.loop.exit === "jump") voice.seek(prog.loop.end);
      } else if (!prog.left || prog.loop.reentry === "reenter") {
        prog.looping = true;
        voice.setLoop(prog.loop.start, prog.loop.end, true);
      }
    }
  }

  private now(): number {
    return this.clock ? this.clock() : this.elapsed;
  }

  private timeOf(v: BoundVoice, which: TimeParam): number {
    if (which === TimeParam.Sequence) return this.sequenceTime(v.group);
    const voiceTime = Math.max(0, this.now() - v.start);
    if (which === TimeParam.Voice) return voiceTime;
    return voiceTime * v.base.pitch * (v.pitch === v.pitch ? v.pitch : 1);
  }

  private param(group: number, slot: number): ParamState | null {
    if (group === 0) return slot >= 0 && slot < MAX_GLOBAL_SLOTS ? this.globals[slot] : null;
    if (group < 1 || group > MAX_GROUPS || slot < 0 || slot >= MAX_LOCAL_SLOTS) return null;
    let ps = this.locals.get(group);
    if (!ps) { ps = Array.from({ length: MAX_LOCAL_SLOTS }, () => new ParamState()); this.locals.set(group, ps); }
    return ps[slot];
  }
}
