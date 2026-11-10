// ADR 0158 §3, §4, §6 on the core backend (M2 build plan E3.1, contract C6): the event runtime's `AutomationSink` over
// the command writer, so an event's parameters, curves, bindings and sustain loops run in the Rust core, not on main.
//
// - `defineCurve` → CURVES, `setParam` → PARAM, `bindVoice` → AUTOMATE (after the voice's PLAY, with the PLAY's stamp
//   so it stays behind it in the batch), `bindBus` → BUS_AUTOMATE (by bus name; re-sent when the bus tree is
//   reconfigured), `setLoop` → SET_LOOP (stamped behind the voice's PLAY while that is still ahead, else asap, like the
//   other voice commands).
// - Voices are found by `voice.id` in the voice table, never by class: after the hand-over from the pending backend,
//   the runtime re-sends voices it holds as `PendingVoice`s, whose `id` is the core voice's (C6).
// - A voice whose PLAY hasn't gone out yet (its clip still loading, or the context locked) keeps its bindings and loop
//   here; `onPlaySent` (from `CoreBackend.sendPlay`) sends them right after its PLAY.
// - **The mirror.** Everything sent is kept (curves, parameter targets, voice bindings and loops, bus bindings), so a
//   hard rebuild's REPLAY restores it (`replayHeader` after MASTER: curves, parameters, bus bindings; `replayVoice`
//   after each voice's replayed PLAY: its bindings and loop), and the idle `RESET 0` (which clears the core's tables)
//   is followed by a re-send. The writer's staging area is 256 KB (about 660 full curves) while the core takes 1,024
//   curves, so bulk uploads are spread over frames: at most `RESYNC_BYTES_PER_FRAME` of curves, parameters and bus
//   bindings a frame; whatever a binding needs (its curves and parameters) goes out at once, ahead of its AUTOMATE.
//   REPLAY has no staging limit (the builder grows and chunks at the inbox size), so the replay sends it all at once,
//   CURVES split into records of at most 32 KB.
// - **Selection** (0158 §3 "Selection still sees it"): when a parameter changes, the affected bound voices' curves are
//   evaluated once at the target (`events/automation.ts` `evaluate`, over `engine/core/curve.ts`) into the table's
//   `autoGain` (audibility) and `autoPitch` (the playhead estimate); smoothing in the core trails by at most the seek
//   time, which selection's hysteresis absorbs. Nothing here runs per frame for a steady instance.
//
// Seams for later tasks (C6): `onPlay` (E4.5 sends SET_LOOP for plain looping clips with file loop points),
// `routeStreamLoop` (E4.4 loops and releases stream voices through the decoder worker; the core ignores SET_LOOP for
// them, E2), and `wrapPosition` (E4.4 calls it from seek, `reopenStreams` and `PlayheadTracker`).
import { CURVE_INTERPS, type Curve } from "../../../../engine/core/curve";
import {
  ASAP,
  AUTOMATE_BINDINGS_FIXED_END,
  SET_LOOP_FLAGS_LOOPING,
  writeAutomate,
  writeBusAutomate,
  writeCurves,
  writeParam,
  writeSetLoop,
  type AutomateBindings,
  type CurvesCurves,
} from "../wire.generated";
import type { AudioVoice, PlayRequest } from "../backend";
import { AutoTarget, evaluate, MAX_BINDINGS, MAX_CURVES, MAX_GLOBAL_SLOTS, MAX_GROUPS, MAX_LOCAL_SLOTS, type AutomationSink, type Binding, type ParamRef } from "../events/automation";
import type { ClipInfo } from "./clipRegistry";
import type { ClockMap } from "./clock";
import { AUTOMATION_GLOBAL, CORE_CURVE_KEYS, type AutomationBinding, type CommandWriter } from "./commandWriter";
import type { PlayheadTracker, ReplayBuilder } from "./replay";
import { VoiceFlag, VoiceState, type VoiceTable } from "./voiceTable";

/** Most bytes of resync (curves, parameters, bus bindings) written per frame outside what a binding needs at once. */
export const RESYNC_BYTES_PER_FRAME = 48 * 1024;
/** Most bytes of curves in one CURVES record (as the writer's own split). */
const CURVES_RECORD_BYTES = 32 * 1024;
/** Every parameter slot, laid out as the core's table: the globals, then each group's locals. */
const PARAM_SLOTS = MAX_GLOBAL_SLOTS + MAX_GROUPS * MAX_LOCAL_SLOTS;
const PARAM_BYTES = 24;
const curveBytes = (c: Curve): number => 4 + 12 * Math.min(c.length, CORE_CURVE_KEYS);
const bindingBytes = (n: number): number => 16 + AUTOMATE_BINDINGS_FIXED_END * n;

/** A loop region in seconds (`end` 0 = the clip's end); `looping` false is a release. */
export interface LoopRecord {
  readonly start: number;
  readonly end: number;
  readonly looping: boolean;
}

/**
 * The region-aware wrap (C6, for E4.4: seek, `reopenStreams`, `PlayheadTracker`): where an unwrapped playhead `pos`
 * (frames from the start, never wrapped) is in a clip of `length` frames looping `loopStart..loopEnd` (`loopEnd` 0 or
 * past the clip = its end; an empty region loops the whole clip, as the core does). Before `loopEnd` it is `pos`.
 */
export function wrapPosition(pos: number, loopStart: number, loopEnd: number, length: number): number {
  if (!(length > 0) || !(pos >= 0)) return pos > 0 ? pos : 0;
  let start = loopStart;
  let end = loopEnd > 0 && loopEnd < length ? loopEnd : length;
  if (!(start >= 0 && start < end)) {
    start = 0;
    end = length;
  }
  if (pos < end) return pos;
  return start + ((pos - start) % (end - start));
}

/** What the sink drives and reads of the core backend (`CoreBackend` passes these). */
export interface CoreAutomationDeps {
  readonly table: VoiceTable;
  readonly writer: Pick<CommandWriter, "automate" | "param" | "curves" | "busAutomate" | "setLoop">;
  readonly clockMap: Pick<ClockMap, "framesNow" | "lookaheadFrames">;
  readonly playheads: Pick<PlayheadTracker, "positionNow" | "start" | "retime">;
  /** A voice's clip (a stream voice's stream) info: frames and rate, null while unknown. */
  clipInfo(i: number): ClipInfo | null;
  /** The bus index of `name` in the tree last configured, or -1 when there is no such bus. */
  busIndex(name: string): number;
  /** True while no core keeps what is sent (a hard rebuild): the mirror is updated and the REPLAY sends it. */
  readonly sending: () => boolean;
}

/** One voice's mirror: its bindings (as the runtime gave them and on the wire) and its loop. */
interface VoiceEntry {
  id: number;
  group: number;
  bindings: readonly Binding[];
  wire: AutomationBinding[];
  loop: LoopRecord | null;
  /** The PLAY's stamp on the current core (undefined: asap, or not sent yet). */
  playStamp: number | undefined;
}

/** Counts for `Audio.debug()` and the tests. */
export interface CoreAutomationStats {
  /** Curve uploads, parameter sets, voice bindings, bus bindings and loop records written (not replays). */
  curves: number;
  params: number;
  automates: number;
  busAutomates: number;
  loops: number;
  /** Hard rebuilds and idle resets whose state was restored. */
  replays: number;
  resyncs: number;
}

export class CoreAutomation implements AutomationSink {
  readonly stats: CoreAutomationStats = { curves: 0, params: 0, automates: 0, busAutomates: 0, loops: 0, replays: 0, resyncs: 0 };
  private readonly curves = new Map<number, Curve>();
  private readonly paramValue = new Float64Array(PARAM_SLOTS);
  private readonly paramSeek = new Float32Array(PARAM_SLOTS);
  /** 1 for every slot the runtime has set (only those are re-sent). */
  private readonly paramSet = new Uint8Array(PARAM_SLOTS);
  private readonly voices: (VoiceEntry | null)[];
  /** Bound voices by the group whose locals they read; voices reading a global parameter. */
  private readonly byGroup = new Map<number, Set<number>>();
  private readonly globalReaders = new Set<number>();
  private readonly buses = new Map<string, AutomationBinding[]>();
  /** The bus index each bound bus's bindings were last sent to. */
  private readonly busSentTo = new Map<string, number>();
  private readonly dirtyCurves = new Set<number>();
  private readonly dirtyParams = new Set<number>();
  private readonly dirtyBuses = new Set<string>();
  private budget = RESYNC_BYTES_PER_FRAME;

  constructor(private readonly deps: CoreAutomationDeps) {
    this.voices = new Array<VoiceEntry | null>(deps.table.capacity).fill(null);
  }

  // --- AutomationSink ---------------------------------------------------------------------------------------------

  defineCurve(id: number, curve: Curve): void {
    if (!(id >= 0 && id < MAX_CURVES) || !Number.isInteger(id)) return;
    this.curves.set(id, curve);
    const bytes = curveBytes(curve) + 20;
    if (this.budget >= bytes && this.deps.sending()) this.sendCurve(id);
    else this.dirtyCurves.add(id);
    this.reevaluateCurve(id);
  }

  setParam(group: number, slot: number, value: number, seekPerSecond: number): void {
    const k = paramKey(group, slot);
    if (k < 0 || !Number.isFinite(value)) return;
    this.paramValue[k] = value;
    this.paramSeek[k] = seekPerSecond > 0 && Number.isFinite(seekPerSecond) ? seekPerSecond : 0;
    this.paramSet[k] = 1;
    this.dirtyParams.delete(k);
    if (this.deps.sending()) {
      this.deps.writer.param(group, slot, value, this.paramSeek[k]!);
      this.stats.params++;
    }
    // Selection: the bound voices reading it, evaluated at the target.
    const readers = group === 0 ? this.globalReaders : this.byGroup.get(group);
    if (readers) for (const i of readers) this.reevaluate(i);
  }

  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }): void {
    void base; // the core multiplies onto the voice's own volume and pitch (the table's), which `base` repeats
    const i = this.resolve(voice);
    if (i < 0) return;
    const e = this.entry(i);
    this.unindex(i, e);
    const list = bindings.slice(0, MAX_BINDINGS).map((b) => ({ param: { global: b.param.global, slot: b.param.slot }, curve: b.curve, target: b.target }));
    const hadBindings = e.wire.length > 0;
    e.group = group;
    e.bindings = list;
    e.wire = list.map(toWire);
    this.index(i, e);
    this.reevaluate(i);
    if (this.onCore(i) && (hadBindings || e.wire.length > 0)) this.sendBindings(i, e, e.playStamp !== undefined && e.playStamp > this.deps.clockMap.framesNow() ? e.playStamp : undefined);
    this.dropIfEmpty(i);
  }

  bindBus(bus: string, bindings: readonly Binding[]): void {
    const wire = bindings.filter((b) => b.param.global && b.target !== AutoTarget.Pitch).slice(0, MAX_BINDINGS).map(toWire);
    const had = this.buses.has(bus);
    if (wire.length === 0) {
      this.buses.delete(bus);
      if (!had && !this.busSentTo.has(bus)) return;
    } else this.buses.set(bus, wire);
    this.dirtyBuses.delete(bus);
    if (this.deps.sending()) this.sendBus(bus);
    else this.dirtyBuses.add(bus);
  }

  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void {
    const i = this.resolve(voice);
    if (i < 0) return;
    const e = this.entry(i);
    e.loop = { start: Math.max(0, Number.isFinite(start) ? start : 0), end: Math.max(0, Number.isFinite(end) ? end : 0), looping };
    if ((this.deps.table.flags[i]! & VoiceFlag.STREAM) !== 0) {
      this.routeStreamLoop(i, e.loop);
      return;
    }
    if (this.onCore(i)) this.sendLoop(i, e, e.playStamp !== undefined && e.playStamp > this.deps.clockMap.framesNow() ? e.playStamp : undefined, true);
  }

  // --- Seams (C6) -------------------------------------------------------------------------------------------------

  /**
   * C6: every voice the core backend starts, right after `play` made it (before its PLAY may have gone out). E4.5 will
   * send SET_LOOP here for plain looping clips with file loop points (`loopPoints.ts`, via `setLoop`). Today it does
   * nothing: plain clips ignore loop points until E4.5 (plan rule 3), and events send their own loops.
   */
  onPlay(voice: AudioVoice, req: PlayRequest): void {
    void voice;
    void req;
  }

  /**
   * C6: a loop or release for a stream voice. The core ignores SET_LOOP for streams (E2); E4.4 routes it through the
   * decoder worker's gapless-loop path (and the release mechanism it picks). Today the record is only kept in the
   * mirror, so E4.4's replay and re-open can read it.
   */
  routeStreamLoop(i: number, loop: LoopRecord): void {
    void i;
    void loop;
  }

  // --- The core backend's hooks -----------------------------------------------------------------------------------

  /** `CoreBackend.sendPlay` wrote slot `i`'s PLAY (stamped at `stamp`, or asap): its bindings and loop follow it. */
  onPlaySent(id: number, i: number, stamp: number | undefined): void {
    const e = this.voices[i];
    if (!e) return;
    if (e.id !== id) {
      this.forget(i);
      return;
    }
    e.playStamp = stamp;
    if (e.wire.length > 0) this.sendBindings(i, e, stamp);
    if (e.loop && (this.deps.table.flags[i]! & VoiceFlag.STREAM) === 0) this.sendLoop(i, e, stamp, false);
    else if (e.loop) this.routeStreamLoop(i, e.loop);
  }

  /** The table freed slot `i` (`onFree`): its mirror goes. */
  forget(i: number): void {
    const e = this.voices[i];
    if (!e) return;
    this.unindex(i, e);
    this.voices[i] = null;
    const t = this.deps.table;
    t.autoGain[i] = 1;
    t.autoPitch[i] = 1;
  }

  /** Once per frame, before the writer flushes: a new budget, and as much of the pending resync as fits it. */
  beginFrame(): void {
    this.budget = RESYNC_BYTES_PER_FRAME;
    if (!this.deps.sending() || (this.dirtyCurves.size === 0 && this.dirtyParams.size === 0 && this.dirtyBuses.size === 0)) return;
    if (this.dirtyCurves.size > 0) {
      const ids = [...this.dirtyCurves].sort((a, b) => a - b);
      for (const id of ids) {
        const c = this.curves.get(id);
        if (!c) {
          this.dirtyCurves.delete(id);
          continue;
        }
        if (this.budget < curveBytes(c) + 20) return;
        this.sendCurve(id);
      }
    }
    for (const k of this.dirtyParams) {
      if (this.budget < PARAM_BYTES) return;
      this.sendParamKey(k);
    }
    for (const bus of this.dirtyBuses) {
      if (this.budget < bindingBytes(MAX_BINDINGS)) return;
      this.sendBus(bus);
    }
  }

  /** The idle `RESET 0` cleared the core's tables: curves, parameters and bus bindings go again, spread over frames. */
  afterReset(): void {
    this.stats.resyncs++;
    for (const id of this.curves.keys()) this.dirtyCurves.add(id);
    for (let k = 0; k < PARAM_SLOTS; k++) if (this.paramSet[k]) this.dirtyParams.add(k);
    this.busSentTo.clear();
    for (const bus of this.buses.keys()) this.dirtyBuses.add(bus);
    this.budget = 0;
  }

  /** BUS_CONFIG went out (a remap may have moved buses): bus bindings go to their buses' new indices. */
  onBusesConfigured(): void {
    if (this.buses.size === 0 && this.busSentTo.size === 0) return;
    if (!this.deps.sending()) {
      for (const bus of this.buses.keys()) this.dirtyBuses.add(bus);
      return;
    }
    for (const [bus, index] of this.busSentTo) {
      if (this.deps.busIndex(bus) !== index || !this.buses.has(bus)) {
        this.deps.writer.busAutomate(index, []);
        this.busSentTo.delete(bus);
      }
    }
    for (const bus of this.buses.keys()) if (this.busSentTo.get(bus) !== this.deps.busIndex(bus)) this.sendBus(bus);
  }

  /**
   * A hard rebuild's header REPLAY, after MASTER: every curve (in records of at most 32 KB), every parameter set (at
   * its target, jumping: the old core's smoothing state is gone) and every bus's bindings. Clears the pending resync.
   */
  replayHeader(b: ReplayBuilder): void {
    this.stats.replays++;
    this.dirtyCurves.clear();
    this.dirtyParams.clear();
    this.dirtyBuses.clear();
    const ids = [...this.curves.keys()].sort((x, y) => x - y);
    let k = 0;
    while (k < ids.length) {
      const first = ids[k]!;
      const run: CurvesCurves[] = [];
      let bytes = 20;
      while (k < ids.length && ids[k] === first + run.length) {
        const c = this.curves.get(ids[k]!)!;
        const size = curveBytes(c);
        if (run.length > 0 && bytes + size > CURVES_RECORD_BYTES) break;
        run.push(wireCurve(c));
        bytes += size;
        k++;
      }
      b.record(bytes, (view, off) => writeCurves(view, off, { voiceId: 0, frameOffset: ASAP, firstCurve: first, curves: run }));
    }
    for (let p = 0; p < PARAM_SLOTS; p++) {
      if (!this.paramSet[p]) continue;
      const group = p < MAX_GLOBAL_SLOTS ? 0 : 1 + Math.floor((p - MAX_GLOBAL_SLOTS) / MAX_LOCAL_SLOTS);
      const slot = p < MAX_GLOBAL_SLOTS ? p : (p - MAX_GLOBAL_SLOTS) % MAX_LOCAL_SLOTS;
      const value = this.paramValue[p]!;
      b.record(PARAM_BYTES, (view, off) => writeParam(view, off, { voiceId: 0, frameOffset: ASAP, group, slot, value, seekPerSecond: 0 }));
    }
    this.busSentTo.clear();
    for (const [bus, wire] of this.buses) {
      const index = this.deps.busIndex(bus);
      if (index < 0) continue;
      b.record(bindingBytes(wire.length), (view, off) => writeBusAutomate(view, off, { voiceId: index, frameOffset: ASAP, bindings: wire }));
      this.busSentTo.set(bus, index);
    }
  }

  /** A hard rebuild replayed slot `i`'s PLAY (voice `id`) into `b`: its bindings and loop follow it (asap, after it). */
  replayVoice(b: ReplayBuilder, id: number, i: number): void {
    const e = this.voices[i];
    if (!e || e.id !== id) return;
    e.playStamp = undefined;
    if (e.wire.length > 0) {
      const wire = e.wire;
      b.record(bindingBytes(wire.length), (view, off) => writeAutomate(view, off, { voiceId: id, frameOffset: ASAP, bindings: wire }));
    }
    const frames = this.loopFrames(i, e);
    if (frames) b.record(24, (view, off) => writeSetLoop(view, off, { voiceId: id, frameOffset: ASAP, loopStartFrame: frames.start, loopEndFrame: frames.end, flags: frames.looping ? SET_LOOP_FLAGS_LOOPING : 0 }));
  }

  /**
   * Slot `i`'s loop region in clip frames (`end` 0 = the clip's end), or null when it has none (or its clip's rate isn't
   * known): the replay wraps the voice's playhead with it (`wrapPosition`) and drops a released voice past its end.
   */
  loopOf(i: number): { start: number; end: number; looping: boolean } | null {
    const e = this.voices[i];
    if (!e || e.id !== this.idOf(i)) return null;
    return this.loopFrames(i, e);
  }

  // --- Debugging --------------------------------------------------------------------------------------------------

  /** Curves defined, voices with bindings or a loop, and resync records waiting (for `Audio.debug().core`). */
  get counts(): { curves: number; voices: number; pending: number } {
    let voices = 0;
    for (const e of this.voices) if (e) voices++;
    return { curves: this.curves.size, voices, pending: this.dirtyCurves.size + this.dirtyParams.size + this.dirtyBuses.size };
  }

  /** @internal The parameter target the mirror holds (tests). */
  paramTarget(group: number, slot: number): number | undefined {
    const k = paramKey(group, slot);
    return k >= 0 && this.paramSet[k] ? this.paramValue[k] : undefined;
  }

  // --- Internals --------------------------------------------------------------------------------------------------

  private idOf(i: number): number {
    return ((this.deps.table.gen[i]! << 16) | i) >>> 0;
  }

  /** The table slot of `voice` by its id (C6: a `PendingVoice` forwards its core voice's id), or -1. */
  private resolve(voice: AudioVoice): number {
    const id = voice.id;
    if (typeof id !== "number" || !this.deps.table.isLive(id)) return -1;
    return id & 0xffff;
  }

  private entry(i: number): VoiceEntry {
    const id = this.idOf(i);
    let e = this.voices[i];
    if (e && e.id !== id) {
      this.forget(i);
      e = null;
    }
    if (!e) {
      e = { id, group: this.deps.table.group[i]!, bindings: [], wire: [], loop: null, playStamp: undefined };
      this.voices[i] = e;
    }
    return e;
  }

  private dropIfEmpty(i: number): void {
    const e = this.voices[i];
    if (e && e.wire.length === 0 && !e.loop) this.forget(i);
  }

  private onCore(i: number): boolean {
    const s = this.deps.table.state[i]!;
    return (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING) && this.deps.sending();
  }

  private index(i: number, e: VoiceEntry): void {
    let local = false;
    let global = false;
    for (const b of e.bindings) {
      if (b.param.global) global = true;
      else local = true;
    }
    if (global) this.globalReaders.add(i);
    if (local && e.group > 0) {
      let set = this.byGroup.get(e.group);
      if (!set) this.byGroup.set(e.group, (set = new Set()));
      set.add(i);
    }
  }

  private unindex(i: number, e: VoiceEntry): void {
    this.globalReaders.delete(i);
    const set = this.byGroup.get(e.group);
    if (set) {
      set.delete(i);
      if (set.size === 0) this.byGroup.delete(e.group);
    }
  }

  /** Slot `i`'s automated gain and pitch at the parameters' targets, into the table (audibility, playhead rate). */
  private reevaluate(i: number): void {
    const e = this.voices[i];
    const t = this.deps.table;
    if (!e) return;
    const r = evaluate(e.bindings, this.curves, (p: ParamRef) => this.target(e.group, p));
    t.autoGain[i] = r.gain;
    if (t.autoPitch[i] !== r.pitch) {
      t.autoPitch[i] = r.pitch;
      if (this.onCore(i)) this.deps.playheads.retime(i, this.deps.clockMap.framesNow());
    }
  }

  private reevaluateCurve(id: number): void {
    if (this.globalReaders.size === 0 && this.byGroup.size === 0) return;
    for (let i = 0; i < this.voices.length; i++) {
      const e = this.voices[i];
      if (e && e.bindings.some((b) => b.curve === id)) this.reevaluate(i);
    }
  }

  private target(group: number, p: ParamRef): number {
    const k = p.global ? paramKey(0, p.slot) : group > 0 ? paramKey(group, p.slot) : -1;
    return k >= 0 ? this.paramValue[k]! : 0;
  }

  /** What `bindings` read goes out first (curves and parameters still waiting in the resync). */
  private sendNeeds(group: number, bindings: readonly AutomationBinding[]): void {
    for (const b of bindings) {
      if (this.dirtyCurves.has(b.curve)) this.sendCurve(b.curve);
      const global = (b.param & AUTOMATION_GLOBAL) !== 0;
      const k = global ? paramKey(0, b.param & 0x7fff) : group > 0 ? paramKey(group, b.param) : -1;
      if (k >= 0 && this.dirtyParams.has(k)) this.sendParamKey(k);
    }
  }

  private sendBindings(i: number, e: VoiceEntry, stamp: number | undefined): void {
    this.sendNeeds(e.group, e.wire);
    this.deps.writer.automate(e.id, stamp, e.wire);
    this.stats.automates++;
    void i;
  }

  /**
   * SET_LOOP for slot `i` from its mirror. `reanchor`: the loop changed while the voice plays, so the playhead estimate
   * restarts from where the voice is in its region when the record lands (a released voice then plays on from there).
   */
  private sendLoop(i: number, e: VoiceEntry, stamp: number | undefined, reanchor: boolean): void {
    const frames = this.loopFrames(i, e);
    if (!frames) return;
    this.deps.writer.setLoop(e.id, stamp, frames.start, frames.end, frames.looping);
    this.stats.loops++;
    if (!reanchor) return;
    const clock = this.deps.clockMap;
    const at = stamp ?? clock.framesNow() + clock.lookaheadFrames();
    const length = this.deps.clipInfo(i)?.frames ?? 0;
    const pos = this.deps.playheads.positionNow(i, at);
    this.deps.playheads.start(i, at, wrapPosition(pos, frames.start, frames.end, length));
  }

  private loopFrames(i: number, e: VoiceEntry): { start: number; end: number; looping: boolean } | null {
    if (!e.loop) return null;
    const info = this.deps.clipInfo(i);
    const rate = info?.sampleRate ?? 0;
    if (!(rate > 0)) return null;
    return { start: Math.round(e.loop.start * rate), end: e.loop.end > 0 ? Math.round(e.loop.end * rate) : 0, looping: e.loop.looping };
  }

  private sendCurve(id: number): void {
    const c = this.curves.get(id);
    this.dirtyCurves.delete(id);
    if (!c) return;
    this.deps.writer.curves(id, [c]);
    this.budget -= curveBytes(c) + 20;
    this.stats.curves++;
  }

  private sendParamKey(k: number): void {
    this.dirtyParams.delete(k);
    if (!this.paramSet[k]) return;
    const group = k < MAX_GLOBAL_SLOTS ? 0 : 1 + Math.floor((k - MAX_GLOBAL_SLOTS) / MAX_LOCAL_SLOTS);
    const slot = k < MAX_GLOBAL_SLOTS ? k : (k - MAX_GLOBAL_SLOTS) % MAX_LOCAL_SLOTS;
    // A resync jumps to the target (the core's smoothing state is gone).
    this.deps.writer.param(group, slot, this.paramValue[k]!, 0);
    this.budget -= PARAM_BYTES;
    this.stats.params++;
  }

  private sendBus(bus: string): void {
    this.dirtyBuses.delete(bus);
    const index = this.deps.busIndex(bus);
    const wire = this.buses.get(bus) ?? [];
    const old = this.busSentTo.get(bus);
    if (old !== undefined && old !== index) this.deps.writer.busAutomate(old, []);
    if (index < 0) {
      this.busSentTo.delete(bus);
      return;
    }
    this.sendNeeds(0, wire);
    this.deps.writer.busAutomate(index, wire);
    this.budget -= bindingBytes(wire.length);
    this.stats.busAutomates++;
    if (wire.length > 0) this.busSentTo.set(bus, index);
    else this.busSentTo.delete(bus);
  }
}

/** The core's parameter index of `group`'s `slot` (group 0: global), or -1 out of range. */
function paramKey(group: number, slot: number): number {
  if (!Number.isInteger(group) || !Number.isInteger(slot) || slot < 0) return -1;
  if (group === 0) return slot < MAX_GLOBAL_SLOTS ? slot : -1;
  if (group < 1 || group > MAX_GROUPS || slot >= MAX_LOCAL_SLOTS) return -1;
  return MAX_GLOBAL_SLOTS + (group - 1) * MAX_LOCAL_SLOTS + slot;
}

function toWire(b: Binding): AutomateBindings {
  return { param: b.param.global ? AUTOMATION_GLOBAL | b.param.slot : b.param.slot, curve: b.curve, target: b.target };
}

function wireCurve(c: Curve): CurvesCurves {
  const n = Math.min(c.length, CORE_CURVE_KEYS);
  const keys = new Array(n);
  for (let k = 0; k < n; k++) {
    const key = c[k]!;
    const interp = key.length > 2 ? CURVE_INTERPS.indexOf(key[2]!) : 0;
    keys[k] = { x: key[0], y: key[1], interp: interp < 0 ? 0 : interp };
  }
  return { reserved: 0, keys };
}
