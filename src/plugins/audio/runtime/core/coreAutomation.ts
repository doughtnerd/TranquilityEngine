// ADR 0158 §3, §4, §6 on the core backend (M2 build plan E3.1, contract C6): the event runtime's `AutomationSink` over
// the command writer, so an event's parameters, curves, bindings and sustain loops run in the Rust core, not on main.
//
// - `defineCurve` → CURVES, `setParam` → PARAM, `bindVoice` → AUTOMATE (after the voice's PLAY, with the PLAY's stamp
//   so it stays behind it in the batch), `bindBus` → BUS_AUTOMATE (by bus name; re-sent when the bus tree is
//   reconfigured), `setLoop` → SET_LOOP (stamped behind the voice's PLAY while that is still ahead, else asap, like the
//   other voice commands), `setLoops` → LOOPS (ADR 0342: a clip voice's loop program, behind its PLAY like AUTOMATE; a
//   later `setLoop(…, false)` is its key-off), `setSequenceTime` → TIME (ADR 0346: stamped at its heard time, or asap).
// - **Time parameters** (ADR 0346): a binding on `TimeParam.Voice`, `Clip` or `Sequence` goes out as `AUTOMATION_TIME |
//   which`; the core advances the times itself. Main can't follow them without a per-frame cost, so selection sees a
//   time-bound volume curve at its loudest key (a voice fading in by voice time is never culled as silent) and a
//   time-bound pitch curve at its first key; the playhead estimate is re-anchored by STATUS as usual.
// - Voices are found by `voice.id` in the voice table, never by class: after the hand-over from the pending backend,
//   the runtime re-sends voices it holds as `PendingVoice`s, whose `id` is the core voice's (C6).
// - A voice whose PLAY hasn't gone out yet (its clip still loading, or the context locked) keeps its bindings and loop
//   here; `onPlaySent` (from `CoreBackend.sendPlay`) sends them right after its PLAY.
// - **The mirror.** Everything sent is kept (curves, parameter targets, voice bindings and loops, bus bindings), so a
//   hard rebuild's REPLAY restores it (`replayHeader` after MASTER: curves, parameters, bus bindings; `replayVoice`
//   after each voice's replayed PLAY: its bindings and loop), and the idle `RESET 0` (which clears the core's tables)
//   is followed by a re-send. The writer's staging area is 256 KB (about 145 full 64-key curves) while the core takes 1,024
//   curves, so bulk uploads are spread over frames: at most `RESYNC_BYTES_PER_FRAME` of curves, parameters and bus
//   bindings a frame; whatever a binding needs (its curves and parameters) goes out at once, ahead of its AUTOMATE.
//   REPLAY has no staging limit (the builder grows and chunks at the inbox size), so the replay sends it all at once,
//   CURVES split into records of at most 32 KB.
// - **Selection** (0158 §3 "Selection still sees it"): when a parameter changes, the affected bound voices' curves are
//   evaluated once at the target (`automation.ts` `evaluate`, over `engine/core/curve.ts`) into the table's
//   `autoGain` (audibility) and `autoPitch` (the playhead estimate); smoothing in the core trails by at most the seek
//   time, which selection's hysteresis absorbs. Nothing here runs per frame for a steady instance.
//
// Seams for later tasks (C6): `onPlay` (E4.5 sends SET_LOOP for plain looping clips with file loop points),
// `routeStreamLoop` (E4.4: stream voices loop and release through the decoder worker, `deps.streamLoop`; the core
// ignores SET_LOOP for them, E2), and `wrapPosition` (E4.4 calls it from seek, `reopenStreams` and `PlayheadTracker`).
//
// **E4.4's release mechanism for streams** (the choice the plan asked for first): the worker loops a stream's region
// up to a ring (32,768 frames, 0.68 s) ahead of the voice, so a release can't simply tell it to stop wrapping (that
// lands up to a ring late). Neither an epoch seek (a 5 ms fade out, silence while the new epoch decodes, a fade in: an
// audible hole in a sustain's tail) nor teaching the core's stream path SET_LOOP (the core would still need the tail's
// audio, which only the worker has, and nothing tells the worker where) is enough. Instead the release lands at the
// end of the voice's **current pass**, which main predicts from the voice's playhead (re-anchored on every STATUS) at
// the frame the release was asked for, exactly as a SET_LOOP would land; the worker gets that stream frame
// (`streams.ts` `setLoop` → `decoderClient.loopStream`) and stops wrapping there, or, when it already sent past it,
// **splices** the core's ring there with a new epoch that carries the tail (`decoder/streams.ts`, `stream.rs`): gapless
// and on that exact frame. A region change goes the same way. The prediction is exact unless the voice starves or its
// pitch moves between the last STATUS and the end of the pass; a splice the voice has already read past restarts the
// ring there (a seek's fade).
//
// The edge E3.1 left (a stamped PLAY held back by an empty buffer pool, its stamp then behind *F*_now: a later
// SET_LOOP/AUTOMATE went asap and sorted ahead of it) is fixed: while no batch has gone out since the PLAY was written
// (`deps.writerBatches`), records keep the PLAY's stamp.
import type { Curve } from "../../../../engine/core/curve";
import {
  ASAP,
  AUTO_TARGET_FX,
  AUTO_TARGET_LOG,
  AUTO_TARGET_PARAM_SHIFT,
  AUTO_TARGET_SEND,
  AUTO_TARGET_SLOT_SHIFT,
  AUTOMATE_BINDINGS_FIXED_END,
  CURVES_FIXED_END,
  PARAM_FIXED_END,
  SET_LOOP_FIXED_END,
  TIME_FIXED_END,
  SET_LOOP_FLAGS_LOOPING,
  writeAutomate,
  writeBusAutomate,
  writeCurves,
  writeParam,
  writeSetLoop,
  writeTime,
  writeLoops,
  writeRoute,
  ROUTE_FIXED_END,
  LOOPS_LOOPS_FIXED_END,
  LOOP_ACTIVE_SHIFT,
  LOOP_BELOW,
  LOOP_EXIT_SHIFT,
  LOOP_REENTER,
  LOOP_SEAM_SHAPE_SHIFT,
  LOOP_EXIT_SHAPE_SHIFT,
  FADE_SHAPE_EQUAL_POWER,
  FADE_SHAPE_LINEAR,
  FADE_SHAPE_S_CURVE,
  FADE_SHAPE_INV_S_CURVE,
  FADE_SHAPE_LOG1,
  FADE_SHAPE_LOG2,
  FADE_SHAPE_LOG3,
  FADE_SHAPE_EXP1,
  FADE_SHAPE_EXP2,
  FADE_SHAPE_EXP3,
  TIME_SEQUENCE,
  type LoopsLoops,
  type AutomateBindings,
  type CurvesCurves,
} from "../wire.generated";
import type { AudioVoice, PlayRequest } from "../backend";
import type { FadeShape } from "../../../../engine/audio/playlist/types";
import { AutoTarget, evaluateInto, MAX_BINDINGS, MAX_BUS_BINDINGS, MAX_CURVES, MAX_GLOBAL_SLOTS, MAX_GROUPS, MAX_LOCAL_SLOTS, MAX_VOICE_LOOPS, type AutomationSink, type AutoResult, type Binding, type VoiceLoop } from "../automation";
import { evalCurve } from "../../../../engine/core/curve";
import { onLoopPoints } from "../loopPoints";
import type { ClipInfo } from "./clipRegistry";
import type { ClockMap } from "./clock";
import { AUTOMATION_GLOBAL, AUTOMATION_TIME, CORE_CURVE_KEYS, curveBytes, CURVES_RECORD_BUDGET, wireCurveKey, type AutomationBinding, type BusAutomationBinding, type CommandWriter } from "./commandWriter";
import type { PlayheadTracker, ReplayBuilder } from "./replay";
import type { SendGate } from "./session";
import { warnOnce } from "./handle";
import { VoiceFlag, VoiceFlag2, VoiceState, type VoiceTable } from "./voiceTable";


/** Most bytes of resync (curves, parameters, bus bindings) written per frame outside what a binding needs at once. */
const RESYNC_BYTES_PER_FRAME = 48 * 1024;
/** Every parameter slot, laid out as the core's table: the globals, then each group's locals. */
const PARAM_SLOTS = MAX_GLOBAL_SLOTS + MAX_GROUPS * MAX_LOCAL_SLOTS;
const bindingBytes = (n: number): number => 16 + AUTOMATE_BINDINGS_FIXED_END * n;

/** A loop region in seconds (`end` 0 = the clip's end); `looping` false is a release. */
export interface LoopRecord {
  readonly start: number;
  readonly end: number;
  readonly looping: boolean;
  /**
   * ADR 0342 (loops on stream voices): a stream voice's loop program beyond the region, seconds. `crossfade` the seam's
   * crossfade (0 none) in `shape` (`FADE_SHAPE_*`, equal power by default), `count` the passes in all (0 endless; then
   * the stream plays on), `held` whether a key-off (`looping: false`) ends it, `then` the program's later loops in
   * order, each looped once the stream reaches it. Absent: an endless region with no crossfade (ADR 0158 §4).
   */
  readonly crossfade?: number;
  readonly shape?: number;
  readonly count?: number;
  readonly held?: boolean;
  readonly then?: readonly StreamLoopPart[];
}

/** @internal ADR 0342: one later loop of a stream voice's program (`LoopRecord.then`), seconds. */
export interface StreamLoopPart {
  readonly start: number;
  readonly end: number;
  readonly crossfade: number;
  readonly shape: number;
  readonly count: number;
  readonly held: boolean;
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
  readonly writer: Pick<CommandWriter, "automate" | "param" | "curves" | "busAutomate" | "setLoop"> & Partial<Pick<CommandWriter, "time" | "loops">>;
  /** `frameOfTime` and `stampFor` turn a heard time into a stamp (TIME, ADR 0346); without them TIME goes asap. */
  readonly clockMap: Pick<ClockMap, "framesNow" | "lookaheadFrames"> & Partial<Pick<ClockMap, "sampleRate" | "frameOfTime" | "stampFor">>;
  readonly playheads: Pick<PlayheadTracker, "positionNow" | "start" | "retime">;
  /** A voice's clip (a stream voice's stream) info: frames and rate, null while unknown. */
  clipInfo(i: number): ClipInfo | null;
  /** The bus index of `name` in the tree last configured, or -1 when there is no such bus. */
  busIndex(name: string): number;
  /**
   * ADR 0291: the core session. Automation writes whenever a core will keep it (`mayQueue`), locked included: curves,
   * parameters and bus bindings then reach the core with the frame's BATCH and are current when the voices the unlock
   * starts read them. While it may not (a rebuild, failed, disposed) only the mirror moves, and the REPLAY sends it.
   */
  readonly session: Pick<SendGate, "mayQueue">;
  /** E4.4: a stream voice's loop or release, asked for at context frame `at` (the backend's stream manager); absent: kept in the mirror only. */
  readonly streamLoop?: (i: number, loop: LoopRecord, at: number) => void;
  /** Batches the writer has posted (`CommandWriter.stats.batches`): a PLAY written since the last one is still staged. */
  readonly writerBatches?: () => number;
  /** M2 F2: where main's estimate of a bus's automated gain goes (`Mixer._setAutomationView`), so `Bus.effectiveGain` includes it. */
  readonly busView?: (name: string, gain: number) => void;
  /** M2 F3: where a bus's automated gain for voice selection goes (the no-gap rule: larger of target and smoothed while a seek runs). */
  readonly busSelection?: (name: string, gain: number) => void;
}

/**
 * One voice's mirror: its bindings (as parallel arrays, and on the wire) and its loop. E5.3c: one per table slot,
 * made the first time the slot is bound and reused by every later voice there, so binding a voice allocates nothing.
 */
interface VoiceEntry {
  id: number;
  group: number;
  /** Bindings in use (0..MAX_BINDINGS). */
  n: number;
  /** Per binding: the parameter's index in the core's table for this voice (`paramKey`), or -1 (reads 0). */
  readonly keys: Int32Array;
  /** Per binding: the `TimeParam` it reads (ADR 0346), or -1 for a parameter slot. */
  readonly times: Int8Array;
  readonly curveIds: Int32Array;
  readonly targets: Uint8Array;
  /** The first `n` of `wirePool`, as the writer takes them. */
  readonly wire: AutomationBinding[];
  readonly wirePool: AutomationBinding[];
  loop: LoopRecord | null;
  /** ADR 0342: its loop program (`loop`, when set beside it, is the program's key-off). */
  program: readonly VoiceLoop[] | null;
}

const newEntry = (): VoiceEntry => ({
  id: 0,
  group: 0,
  n: 0,
  keys: new Int32Array(MAX_BINDINGS),
  times: new Int8Array(MAX_BINDINGS).fill(-1),
  curveIds: new Int32Array(MAX_BINDINGS),
  targets: new Uint8Array(MAX_BINDINGS),
  wire: [],
  wirePool: Array.from({ length: MAX_BINDINGS }, () => ({ param: 0, curve: 0, target: 0, offset: 0 })),
  loop: null,
  program: null,
});

/** Counts for `Audio.debug()` and the tests. */
export interface CoreAutomationStats {
  /** Curve uploads, parameter sets, voice bindings, bus bindings and loop records written (not replays). */
  curves: number;
  params: number;
  automates: number;
  busAutomates: number;
  loops: number;
  /** ADR 0346: TIME records (sequence clock re-anchors). */
  times: number;
  /** Hard rebuilds and idle resets whose state was restored. */
  replays: number;
  resyncs: number;
  /** E5.3c: voice evaluations for selection (a bind, a parameter or curve that moved, a frame of a running seek). */
  evaluations: number;
}

export class CoreAutomation implements AutomationSink {
  readonly stats: CoreAutomationStats = { curves: 0, params: 0, automates: 0, busAutomates: 0, loops: 0, times: 0, replays: 0, resyncs: 0, evaluations: 0 };
  private readonly curves = new Map<number, Curve>();
  private readonly paramValue = new Float64Array(PARAM_SLOTS);
  private readonly paramSeek = new Float32Array(PARAM_SLOTS);
  /** E4.5: where a parameter's smoothing started (its estimated value then, the frame), for selection's view of a fade. */
  private readonly paramFrom = new Float64Array(PARAM_SLOTS);
  private readonly paramAt = new Float64Array(PARAM_SLOTS);
  /** Parameters whose seek is still running (selection reads the larger of the smoothed value and the target). */
  private readonly fading = new Set<number>();
  /** 1 for every slot the runtime has set (only those are re-sent). */
  private readonly paramSet = new Uint8Array(PARAM_SLOTS);
  private readonly voices: (VoiceEntry | null)[];
  /** Per slot: its reusable entry (E5.3c), made on first use. */
  private readonly entries: (VoiceEntry | null)[];
  /** Per slot: the voice id whose PLAY last went out and its stamp (NaN: asap), so later records can sort behind it. */
  private readonly playIds: Uint32Array;
  private readonly playStamps: Float64Array;
  /** Per slot: the writer's batch count when its PLAY was written (it is still staged while that hasn't moved). */
  private readonly playBatches: Float64Array;
  /**
   * Bound voices by the group whose locals they read, and voices reading a global parameter (E5.3c: intrusive lists
   * over the slots, in the order they were bound, so indexing a voice allocates nothing). -1 ends a list.
   */
  private readonly groupHead = new Int32Array(MAX_GROUPS + 1).fill(-1);
  private readonly groupTail = new Int32Array(MAX_GROUPS + 1).fill(-1);
  private readonly groupNext: Int32Array;
  private readonly groupPrev: Int32Array;
  /** Per slot: the group whose list it is on, 0 for none. */
  private readonly groupOf: Int32Array;
  private globalHead = -1;
  private globalTail = -1;
  private readonly globalNext: Int32Array;
  private readonly globalPrev: Int32Array;
  private readonly onGlobal: Uint8Array;
  /** Slots on any list (the curve re-evaluation's early out). */
  private listed = 0;
  /** Scratch for `reevaluate`: the bindings' parameter values, and two results. */
  private readonly xs = new Float64Array(MAX_BINDINGS);
  private readonly atTarget: AutoResult = { gain: 1, pitch: 1, lowpass: 0, highpass: 0, pan: 0 };
  private readonly atNow: AutoResult = { gain: 1, pitch: 1, lowpass: 0, highpass: 0, pan: 0 };
  /** Per slot: the unsubscribe of a plain looping voice's wait for its clip's loop points (E4.5). */
  private readonly plainUnsub: ((() => void) | null)[];
  /** Each bound bus's bindings (global volume, low-pass, effect and send; ABI 4.8), as bound: a send names its return, resolved to a slot at each write. */
  private readonly buses = new Map<string, Binding[]>();
  /** What each bound bus's bindings were last written as (`wireKey`), so a remap that moves a send's return re-sends them. */
  private readonly busSentKey = new Map<string, string>();
  /** The bus index each bound bus's bindings were last sent to. */
  private readonly busSentTo = new Map<string, number>();
  private readonly dirtyCurves = new Set<number>();
  private readonly dirtyParams = new Set<number>();
  private readonly dirtyBuses = new Set<string>();
  /** The automated gain last handed to `deps.busView` per bound bus (absent: 1), so it is only written when it moves. */
  private readonly viewSent = new Map<string, number>();
  /** The selection factor last handed to `deps.busSelection` per bus (absent: 1). */
  private readonly selSent = new Map<string, number>();
  private readonly busIds = new Int32Array(MAX_BINDINGS);
  private readonly busTargets = new Uint8Array(MAX_BINDINGS);
  private readonly busAuto: AutoResult = { gain: 1, pitch: 1, lowpass: 0, highpass: 0, pan: 0 };
  /** ADR 0346: each group's sequence clock as last sent: `value` seconds at context frame `frame`, moving at `rate`. */
  private readonly clocks = new Map<number, { value: number; rate: number; frame: number }>();
  private readonly dirtyClocks = new Set<number>();
  private budget = RESYNC_BYTES_PER_FRAME;

  constructor(private readonly deps: CoreAutomationDeps) {
    const cap = deps.table.capacity;
    this.voices = new Array<VoiceEntry | null>(cap).fill(null);
    this.entries = new Array<VoiceEntry | null>(cap).fill(null);
    this.groupNext = new Int32Array(cap).fill(-1);
    this.groupPrev = new Int32Array(cap).fill(-1);
    this.groupOf = new Int32Array(cap);
    this.globalNext = new Int32Array(cap).fill(-1);
    this.globalPrev = new Int32Array(cap).fill(-1);
    this.onGlobal = new Uint8Array(cap);
    this.plainUnsub = new Array<(() => void) | null>(deps.table.capacity).fill(null);
    this.playIds = new Uint32Array(deps.table.capacity);
    this.playStamps = new Float64Array(deps.table.capacity).fill(Number.NaN);
    this.playBatches = new Float64Array(deps.table.capacity).fill(Number.NaN);
  }

  // --- AutomationSink ---------------------------------------------------------------------------------------------

  defineCurve(id: number, curve: Curve): void {
    if (!(id >= 0 && id < MAX_CURVES) || !Number.isInteger(id)) return;
    this.curves.set(id, curve);
    const bytes = curveBytes(curve) + CURVES_FIXED_END;
    if (this.budget >= bytes && this.deps.session.mayQueue) this.sendCurve(id);
    else this.dirtyCurves.add(id);
    this.reevaluateCurve(id);
    if (this.buses.size > 0) this.publishBuses();
  }

  setParam(group: number, slot: number, value: number, seekPerSecond: number): void {
    const k = paramKey(group, slot);
    if (k < 0 || !Number.isFinite(value)) return;
    const seek = seekPerSecond > 0 && Number.isFinite(seekPerSecond) ? seekPerSecond : 0;
    // E5.3c: the target it already had, and not on its way there (so its smoothed value is that target too).
    const same = this.paramValue[k] === value && !this.fading.has(k);
    // The smoothed value now (what the core is at), where this seek starts from.
    this.paramFrom[k] = this.paramSet[k] ? this.smoothed(k) : value;
    this.paramAt[k] = this.deps.clockMap.framesNow();
    this.paramValue[k] = value;
    this.paramSeek[k] = seek;
    this.paramSet[k] = 1;
    if (seek > 0 && this.paramFrom[k] !== value) this.fading.add(k);
    else this.fading.delete(k);
    this.dirtyParams.delete(k);
    if (group === 0) this.publishBuses();
    if (this.deps.session.mayQueue) {
      this.deps.writer.param(group, slot, value, this.paramSeek[k]!);
      this.stats.params++;
    }
    // Selection: the bound voices reading it, evaluated at the target. Skipped when nothing they read moved: with no
    // seek running anywhere an evaluation reads only targets and curves, and each reader was evaluated when those last
    // changed (`bindVoice`, `defineCurve`, here), so it would write the same numbers (an event's start sets every local
    // to its default; a reused group's earlier voices, still stopping, already read it).
    if (same && this.fading.size === 0) return;
    this.reevaluateReaders(group);
  }

  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }): void {
    void base; // the core multiplies onto the voice's own volume and pitch (the table's), which `base` repeats
    const i = this.resolve(voice);
    if (i < 0) return;
    const e = this.entry(i);
    this.unindex(i);
    const hadBindings = e.n > 0;
    e.group = group;
    const n = Math.min(bindings.length, MAX_BINDINGS);
    const wire = e.wire;
    let global = false;
    let local = false;
    for (let j = 0; j < n; j++) {
      const b = bindings[j]!;
      const p = b.param;
      const time = p.time !== undefined && p.time >= 0 && p.time <= 2 ? p.time : -1;
      // As the parameters are read: a global slot, or the group's local one (none without a group); a time reads none.
      e.keys[j] = time >= 0 ? -1 : p.global ? paramKey(0, p.slot) : group > 0 ? paramKey(group, p.slot) : -1;
      e.times[j] = time;
      e.curveIds[j] = b.curve;
      e.targets[j] = b.target;
      const w = e.wirePool[j]!;
      w.param = time >= 0 ? AUTOMATION_TIME | time : p.global ? AUTOMATION_GLOBAL | p.slot : p.slot;
      w.curve = b.curve;
      w.target = b.target;
      w.offset = time >= 0 && b.offset !== undefined && Number.isFinite(b.offset) ? b.offset : 0;
      wire[j] = w;
      if (time >= 0) continue;
      if (p.global) global = true;
      else local = true;
    }
    // M2 F1: rebuilt in place; the length is set (a slow path) only when it changes.
    if (wire.length !== n) wire.length = n;
    e.n = n;
    this.index(i, group, global, local);
    this.reevaluate(i);
    if (this.onCore(i) && (hadBindings || e.wire.length > 0)) this.sendBindings(i, e, this.stampBehindPlay(i, e.id));
    this.dropIfEmpty(i);
  }

  bindBus(bus: string, bindings: readonly Binding[]): void {
    const wire = bindings.filter((b) => b.param.global && BUS_TARGETS.has(b.target)).slice(0, MAX_BUS_BINDINGS).map((b) => ({ ...b, param: { ...b.param } }));
    const had = this.buses.has(bus);
    if (wire.length === 0) {
      this.buses.delete(bus);
      if (!had && !this.busSentTo.has(bus)) return;
    } else this.buses.set(bus, wire);
    this.dirtyBuses.delete(bus);
    this.publishBuses();
    if (this.deps.session.mayQueue) this.sendBus(bus);
    else this.dirtyBuses.add(bus);
  }

  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void {
    const i = this.resolve(voice);
    if (i < 0) return;
    const e = this.entry(i);
    if (looping) e.program = null; // a region replaces a program; a release is the program's key-off
    e.loop = { start: Math.max(0, Number.isFinite(start) ? start : 0), end: Math.max(0, Number.isFinite(end) ? end : 0), looping };
    if ((this.deps.table.flags[i]! & VoiceFlag.STREAM) !== 0) {
      this.routeStreamLoop(i, e.loop);
      return;
    }
    if (this.onCore(i)) this.sendLoop(i, e, this.stampBehindPlay(i, e.id), true);
  }

  setLoops(voice: AudioVoice, group: number, loops: readonly VoiceLoop[]): void {
    void group; // the core reads the voice's group from its PLAY
    const i = this.resolve(voice);
    if (i < 0) return;
    const e = this.entry(i);
    e.loop = null;
    e.program = loops.length > 0 ? loops.slice(0, MAX_VOICE_LOOPS) : null;
    if ((this.deps.table.flags[i]! & VoiceFlag.STREAM) !== 0) {
      // ADR 0342: streams loop through the decoder worker (`decoder/streams.ts`): the program's regions forward, in
      // order, each with its seam crossfade (in its shape) and repeat count; held loops end at the key-off.
      const record = streamLoopRecord(loops);
      if (record) {
        e.loop = record;
        this.routeStreamLoop(i, e.loop);
      }
      return;
    }
    if (this.onCore(i)) this.sendProgram(i, e, this.stampBehindPlay(i, e.id));
    this.dropIfEmpty(i);
  }

  setSequenceTime(group: number, value: number, rate: number, at?: number): void {
    if (!Number.isInteger(group) || group < 0 || group > MAX_GROUPS || !Number.isFinite(value) || !Number.isFinite(rate)) return;
    const clock = this.deps.clockMap;
    const stamp = at !== undefined && Number.isFinite(at) && clock.frameOfTime && clock.stampFor ? clock.stampFor(clock.frameOfTime(at)) : undefined;
    this.clocks.set(group, { value, rate, frame: stamp ?? clock.framesNow() + clock.lookaheadFrames() });
    if (this.deps.session.mayQueue && this.deps.writer.time) {
      this.dirtyClocks.delete(group);
      this.deps.writer.time(group, value, rate, stamp);
      this.stats.times++;
    } else this.dirtyClocks.add(group);
  }

  // --- Seams (C6) -------------------------------------------------------------------------------------------------

  /**
   * C6: every voice the core backend starts, right after `play` made it (before its PLAY may have gone out). E4.5
   * (ADR 0158 §4): a plain looping clip or stream (not an event's voice: those send their own loops) loops its
   * sidecar's or file's loop points through `setLoop`; the points usually arrive after PLAY (the decoder reports them
   * with the clip's info), and a voice that ended by then is left alone. No points: it loops the whole clip, as before.
   */
  onPlay(voice: AudioVoice, req: PlayRequest): void {
    if (req.loop !== true || (req.group !== undefined && req.group > 0)) return;
    const i = this.resolve(voice);
    if (i < 0) return;
    const id = voice.id;
    this.clearPlain(i);
    let called = false;
    const unsub = onLoopPoints(req.path, (points) => {
      called = true;
      this.plainUnsub[i] = null;
      if (!points || !this.deps.table.isLive(id) || (id & 0xffff) !== i) return;
      // A loop record already on the voice (an event's own) wins over the clip's points.
      const e = this.voices[i];
      if (e && e.id === id && e.loop) return;
      this.setLoop(voice, points.start, points.end, true);
    });
    // Called back at once when the points were known; otherwise held until they arrive or the voice ends.
    if (!called) this.plainUnsub[i] = unsub;
  }

  /**
   * C6: a loop or release for a stream voice. The core ignores SET_LOOP for streams (E2); E4.4 routes it through the
   * decoder worker's gapless-loop path (and the release mechanism it picks). Today the record is only kept in the
   * mirror, so E4.4's replay and re-open can read it.
   */
  routeStreamLoop(i: number, loop: LoopRecord): void {
    const stream = this.deps.streamLoop;
    if (!stream) return;
    const clock = this.deps.clockMap;
    const id = this.idOf(i);
    // Asked for where a SET_LOOP would land: behind the voice's PLAY while that is ahead, else the next batch's frame.
    stream(i, loop, this.stampBehindPlay(i, id) ?? clock.framesNow() + clock.lookaheadFrames());
  }

  // --- The core backend's hooks -----------------------------------------------------------------------------------

  /** `CoreBackend.sendPlay` wrote slot `i`'s PLAY (stamped at `stamp`, or asap): its bindings and loop follow it. */
  onPlaySent(id: number, i: number, stamp: number | undefined): void {
    this.playIds[i] = id;
    this.playStamps[i] = stamp ?? Number.NaN;
    this.playBatches[i] = this.deps.writerBatches?.() ?? Number.NaN;
    const e = this.voices[i];
    if (!e) return;
    if (e.id !== id) {
      this.dropMirror(i);
      return;
    }
    if (e.n > 0) this.sendBindings(i, e, stamp);
    if (e.program && (this.deps.table.flags[i]! & VoiceFlag.STREAM) === 0) this.sendProgram(i, e, stamp);
    if (e.loop && (this.deps.table.flags[i]! & VoiceFlag.STREAM) === 0) this.sendLoop(i, e, stamp, false);
    else if (e.loop) this.routeStreamLoop(i, e.loop);
  }

  /** The table freed slot `i` (`onFree`): its mirror goes. */
  forget(i: number): void {
    this.clearPlain(i);
    this.dropMirror(i);
  }

  private clearPlain(i: number): void {
    const u = this.plainUnsub[i];
    if (u) {
      this.plainUnsub[i] = null;
      u();
    }
  }

  private dropMirror(i: number): void {
    const e = this.voices[i];
    if (!e) return;
    this.unindex(i);
    this.voices[i] = null;
    const t = this.deps.table;
    t.autoGain[i] = 1;
    t.autoPitch[i] = 1;
  }

  /** Once per frame, before the writer flushes: a new budget, and as much of the pending resync as fits it. */
  beginFrame(): void {
    this.budget = RESYNC_BYTES_PER_FRAME;
    if (this.fading.size > 0) this.stepFades();
    if (!this.deps.session.mayQueue || (this.dirtyCurves.size === 0 && this.dirtyParams.size === 0 && this.dirtyBuses.size === 0 && this.dirtyClocks.size === 0)) return;
    for (const g of this.dirtyClocks) {
      if (this.budget < TIME_FIXED_END) return;
      this.sendClock(g);
    }
    if (this.dirtyCurves.size > 0) {
      const ids = [...this.dirtyCurves].sort((a, b) => a - b);
      for (const id of ids) {
        const c = this.curves.get(id);
        if (!c) {
          this.dirtyCurves.delete(id);
          continue;
        }
        if (this.budget < curveBytes(c) + CURVES_FIXED_END) return;
        this.sendCurve(id);
      }
    }
    for (const k of this.dirtyParams) {
      if (this.budget < PARAM_FIXED_END) return;
      this.sendParamKey(k);
    }
    for (const bus of this.dirtyBuses) {
      if (this.budget < bindingBytes(MAX_BUS_BINDINGS)) return;
      this.sendBus(bus);
    }
  }

  /** The idle `RESET 0` cleared the core's tables: curves, parameters and bus bindings go again, spread over frames. */
  afterReset(): void {
    this.stats.resyncs++;
    for (let k = 0; k < PARAM_SLOTS; k++) this.jumped(k); // the resync jumps every parameter to its target
    for (const id of this.curves.keys()) this.dirtyCurves.add(id);
    for (let k = 0; k < PARAM_SLOTS; k++) if (this.paramSet[k]) this.dirtyParams.add(k);
    this.busSentTo.clear();
    for (const bus of this.buses.keys()) this.dirtyBuses.add(bus);
    for (const g of this.clocks.keys()) this.dirtyClocks.add(g);
    this.budget = 0;
    this.publishBuses();
  }

  /** BUS_CONFIG went out (a remap may have moved buses): bus bindings go to their buses' new indices. */
  onBusesConfigured(): void {
    // The mixer's reconfigure reset its view gains to 1: publish them again.
    this.viewSent.clear();
    this.selSent.clear();
    this.publishBuses();
    if (this.buses.size === 0 && this.busSentTo.size === 0) return;
    if (!this.deps.session.mayQueue) {
      for (const bus of this.buses.keys()) this.dirtyBuses.add(bus);
      return;
    }
    for (const [bus, index] of this.busSentTo) {
      if (this.deps.busIndex(bus) !== index || !this.buses.has(bus)) {
        this.deps.writer.busAutomate(index, []);
        this.busSentTo.delete(bus);
      }
    }
    // ABI 4.8: a send binding names its return by slot, so a remap that moved the return re-sends the bindings too.
    for (const bus of this.buses.keys()) if (this.busSentTo.get(bus) !== this.deps.busIndex(bus) || this.busSentKey.get(bus) !== wireKey(this.busWire(bus))) this.sendBus(bus);
  }

  /**
   * ADR 0171 (Ma1, architecture §4.7): a live rename keeps the bus's slot and sends nothing. Its bindings, the slot they
   * were sent to and main's published gains move to the new name, so the event runtime's next bind of the new name, a
   * later configure and the hard rebuild's replay see one binding per slot (left under the old name, a removed binding
   * would come back at the next replay). Bindings the new name already has win.
   */
  renameBus(from: string, to: string): void {
    if (from === to) return;
    const move = <V>(m: Map<string, V>): void => {
      if (!m.has(from)) return;
      const v = m.get(from)!;
      m.delete(from);
      if (!m.has(to)) m.set(to, v);
    };
    move(this.buses);
    move(this.busSentTo);
    move(this.busSentKey);
    move(this.viewSent);
    move(this.selSent);
    if (this.dirtyBuses.delete(from)) this.dirtyBuses.add(to);
  }

  /**
   * A hard rebuild's header REPLAY, after MASTER: every curve (in records of at most 32 KB), every parameter set (at
   * its target, jumping: the old core's smoothing state is gone) and every bus's bindings. Clears the pending resync.
   */
  replayHeader(b: ReplayBuilder): void {
    this.stats.replays++;
    for (let k = 0; k < PARAM_SLOTS; k++) this.jumped(k); // the replay jumps every parameter to its target
    this.dirtyCurves.clear();
    this.dirtyParams.clear();
    this.dirtyBuses.clear();
    this.dirtyClocks.clear();
    this.publishBuses();
    for (const g of this.clocks.keys()) {
      const { value, rate } = this.clockNow(g);
      b.record(TIME_FIXED_END, (view, off) => writeTime(view, off, { voiceId: 0, frameOffset: ASAP, group: g, which: TIME_SEQUENCE, value, rate }));
    }
    const ids = [...this.curves.keys()].sort((x, y) => x - y);
    let k = 0;
    while (k < ids.length) {
      const first = ids[k]!;
      const run: CurvesCurves[] = [];
      let bytes = CURVES_FIXED_END;
      while (k < ids.length && ids[k] === first + run.length) {
        const c = this.curves.get(ids[k]!)!;
        const size = curveBytes(c);
        if (run.length > 0 && bytes + size > CURVES_RECORD_BUDGET) break;
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
      b.record(PARAM_FIXED_END, (view, off) => writeParam(view, off, { voiceId: 0, frameOffset: ASAP, group, slot, value, seekPerSecond: 0 }));
    }
    this.busSentTo.clear();
    for (const bus of this.buses.keys()) {
      const index = this.deps.busIndex(bus);
      if (index < 0) continue;
      const wire = this.busWire(bus);
      b.record(bindingBytes(wire.length), (view, off) => writeBusAutomate(view, off, { voiceId: index, frameOffset: ASAP, bindings: wire }));
      this.busSentTo.set(bus, index);
      this.busSentKey.set(bus, wireKey(wire));
    }
  }

  /** A hard rebuild replayed slot `i`'s PLAY (voice `id`) into `b`: its bindings and loop follow it (asap, after it). */
  replayVoice(b: ReplayBuilder, id: number, i: number): void {
    // ADR 0345 levels (ABI 4.9): its playlist level's submix route (the slots themselves replay in the header).
    const submix = this.deps.table.submix[i]!;
    if (submix > 0) b.record(ROUTE_FIXED_END, (view, off) => writeRoute(view, off, { voiceId: id, frameOffset: ASAP, submix, reserved: 0 }));
    const e = this.voices[i];
    if (!e || e.id !== id) return;
    this.playIds[i] = id;
    this.playStamps[i] = Number.NaN;
    this.playBatches[i] = Number.NaN;
    if (e.n > 0) {
      const wire = e.wire;
      b.record(bindingBytes(wire.length), (view, off) => writeAutomate(view, off, { voiceId: id, frameOffset: ASAP, bindings: wire }));
    }
    const items = e.program ? this.programItems(i, e.program) : null;
    if (items) b.record(16 + LOOPS_LOOPS_FIXED_END * items.length, (view, off) => writeLoops(view, off, { voiceId: id, frameOffset: ASAP, loops: items }));
    const frames = this.loopFrames(i, e);
    if (frames) b.record(SET_LOOP_FIXED_END, (view, off) => writeSetLoop(view, off, { voiceId: id, frameOffset: ASAP, loopStartFrame: frames.start, loopEndFrame: frames.end, flags: frames.looping ? SET_LOOP_FLAGS_LOOPING : 0 }));
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
    return { curves: this.curves.size, voices, pending: this.dirtyCurves.size + this.dirtyParams.size + this.dirtyBuses.size + this.dirtyClocks.size };
  }

  /**
   * @internal E3.9, `Audio.debug()`: slot `i`'s automated gain and pitch now, at main's estimate of the core's smoothed
   * parameter values (what the core multiplies onto the voice's own gain and pitch), into `out`; false when the voice
   * has no bindings (both 1).
   */
  voiceAutomation(i: number, out: AutoResult): boolean {
    const e = this.voices[i];
    if (!e || e.id !== this.idOf(i) || e.n === 0) return false;
    this.evaluateEntry(e, true, out);
    return true;
  }

  /** @internal E3.9, `Audio.debug()`: bus `name`'s automated gain now (its volume curves at the smoothed globals); 1 when unbound. */
  busAutomationGain(name: string): number {
    return this.busGainNow(name);
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
      this.dropMirror(i);
      e = null;
    }
    if (!e) {
      e = this.entries[i] ??= newEntry();
      e.id = id;
      e.group = this.deps.table.group[i]!;
      e.n = 0;
      // M2 F1: emptied by `pop` (inlined) rather than `length = 0` (a runtime call), once per voice start in a reused slot.
      const wire = e.wire;
      while (wire.length > 0) wire.pop();
      e.loop = null;
      e.program = null;
      this.voices[i] = e;
    }
    return e;
  }

  /**
   * The stamp for a record of voice `id` sent now: its PLAY's while that is still ahead of *F*_now (asap records sort
   * ahead of stamped ones in a batch, and the core needs the PLAY first), else undefined (asap).
   */
  private stampBehindPlay(i: number, id: number): number | undefined {
    if (this.playIds[i] !== id) return undefined;
    const stamp = this.playStamps[i]!;
    if (stamp > this.deps.clockMap.framesNow()) return stamp;
    // Still staged (no batch out since, e.g. the pool was empty): keep its stamp, so the record sorts behind it.
    return stamp === stamp && this.deps.writerBatches?.() === this.playBatches[i] ? stamp : undefined;
  }

  private dropIfEmpty(i: number): void {
    const e = this.voices[i];
    if (e && e.n === 0 && !e.loop && !e.program) this.dropMirror(i);
  }

  private onCore(i: number): boolean {
    const s = this.deps.table.state[i]!;
    return (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING) && this.deps.session.mayQueue;
  }

  private index(i: number, group: number, global: boolean, local: boolean): void {
    if (global) {
      this.onGlobal[i] = 1;
      this.globalPrev[i] = this.globalTail;
      this.globalNext[i] = -1;
      if (this.globalTail >= 0) this.globalNext[this.globalTail] = i;
      else this.globalHead = i;
      this.globalTail = i;
    }
    // Only a group whose locals exist (`paramKey`) can have them set, so only those are listed.
    const grouped = local && Number.isInteger(group) && group >= 1 && group <= MAX_GROUPS;
    if (grouped) {
      this.groupOf[i] = group;
      const tail = this.groupTail[group]!;
      this.groupPrev[i] = tail;
      this.groupNext[i] = -1;
      if (tail >= 0) this.groupNext[tail] = i;
      else this.groupHead[group] = i;
      this.groupTail[group] = i;
    }
    if (global || grouped) this.listed++;
  }

  private unindex(i: number): void {
    const was = this.onGlobal[i] !== 0 || this.groupOf[i] !== 0;
    if (this.onGlobal[i]) {
      this.onGlobal[i] = 0;
      const prev = this.globalPrev[i]!;
      const next = this.globalNext[i]!;
      if (prev >= 0) this.globalNext[prev] = next;
      else this.globalHead = next;
      if (next >= 0) this.globalPrev[next] = prev;
      else this.globalTail = prev;
    }
    const group = this.groupOf[i]!;
    if (group !== 0) {
      this.groupOf[i] = 0;
      const prev = this.groupPrev[i]!;
      const next = this.groupNext[i]!;
      if (prev >= 0) this.groupNext[prev] = next;
      else this.groupHead[group] = next;
      if (next >= 0) this.groupPrev[next] = prev;
      else this.groupTail[group] = prev;
    }
    if (was) this.listed--;
  }

  /** Every bound voice reading a parameter of `group` (0: a global one), re-evaluated. */
  private reevaluateReaders(group: number): void {
    if (group === 0) {
      for (let i = this.globalHead; i >= 0; i = this.globalNext[i]!) this.reevaluate(i);
    } else if (group >= 1 && group <= MAX_GROUPS) {
      for (let i = this.groupHead[group]!; i >= 0; i = this.groupNext[i]!) this.reevaluate(i);
    }
  }

  /**
   * Slot `i`'s automated gain and pitch at the parameters' targets, into the table (audibility, playhead rate). While a
   * parameter's seek runs the core's gain is still on its way, so the audibility is the larger of the gain at the
   * smoothed values and at the targets: a voice fading out to 0 stays audible to selection until its fade ends instead
   * of being demoted (and cut) at once (M2 decision 14). Fades back in count at the target at once.
   * E5.3c: no callback and no result object (`evaluateInto` over the entry's arrays).
   */
  private reevaluate(i: number): void {
    const e = this.voices[i];
    const t = this.deps.table;
    if (!e) return;
    this.stats.evaluations++;
    const r = this.evaluateEntry(e, false, this.atTarget);
    let gain = r.gain;
    if (this.fading.size > 0) {
      const now = this.evaluateEntry(e, true, this.atNow);
      if (now.gain > gain) gain = now.gain;
    }
    t.autoGain[i] = gain;
    if (t.autoPitch[i] !== r.pitch) {
      t.autoPitch[i] = r.pitch;
      if (this.onCore(i)) this.deps.playheads.retime(i, this.deps.clockMap.framesNow());
    }
  }

  /**
   * `e`'s bindings evaluated at the parameters' targets, or (`smoothed`) at the core's smoothed values now. A time-bound
   * binding (ADR 0346) reads its curve's loudest key (volume) or its first key (pitch, low-pass).
   */
  private evaluateEntry(e: VoiceEntry, smoothed: boolean, out: AutoResult): AutoResult {
    const xs = this.xs;
    const n = e.n;
    for (let j = 0; j < n; j++) {
      const k = e.keys[j]!;
      if (e.times[j]! >= 0) xs[j] = e.targets[j] === AutoTarget.Volume ? loudestX(this.curves.get(e.curveIds[j]!)) : -Infinity;
      else xs[j] = k < 0 ? 0 : smoothed ? this.smoothed(k) : this.paramValue[k]!;
    }
    return evaluateInto(n, e.curveIds, e.targets, xs, this.curves, out);
  }

  /** The core jumped parameter `k` to its target (a resync or replay): no seek is running any more. */
  private jumped(k: number): void {
    this.paramSeek[k] = 0;
    this.fading.delete(k);
  }

  /** The core's smoothed value of parameter `k` now: linear from where its seek started at the seek speed. */
  private smoothed(k: number): number {
    const target = this.paramValue[k]!;
    const seek = this.paramSeek[k]!;
    if (!(seek > 0)) return target;
    const rate = this.deps.clockMap.sampleRate ?? 48000;
    const dt = Math.max(0, this.deps.clockMap.framesNow() - this.paramAt[k]!) / rate;
    const from = this.paramFrom[k]!;
    const step = seek * dt;
    return Math.abs(target - from) <= step ? target : from + Math.sign(target - from) * step;
  }

  /** Once per frame while a seek runs: its readers' audibility follows the fade, and drops to the target when it ends. */
  private stepFades(): void {
    for (const k of [...this.fading]) {
      const done = this.smoothed(k) === this.paramValue[k]!;
      if (done) this.fading.delete(k);
      const group = k < MAX_GLOBAL_SLOTS ? 0 : 1 + Math.floor((k - MAX_GLOBAL_SLOTS) / MAX_LOCAL_SLOTS);
      this.reevaluateReaders(group);
    }
    this.publishBuses();
  }

  /**
   * M2 F2: each bound bus's automated gain at main's estimate of the smoothed globals goes to the mixer's view (only
   * where it moved), so `Bus.effectiveGain` includes it. Called where a global, a bus binding or a curve changes and
   * each frame a seek runs; with nothing bound it does nothing.
   */
  private publishBuses(): void {
    const view = this.deps.busView;
    if (!view || (this.buses.size === 0 && this.viewSent.size === 0)) return;
    for (const bus of this.buses.keys()) {
      const g = this.busGainNow(bus);
      if ((this.viewSent.get(bus) ?? 1) !== g) view(bus, g);
      this.viewSent.set(bus, g);
      this.publishSelection(bus);
    }
    for (const bus of this.viewSent.keys()) {
      if (this.buses.has(bus)) continue;
      view(bus, 1); // unbound: back to 1
      this.viewSent.delete(bus);
      this.publishSelection(bus);
    }
  }

  /**
   * M2 F3: bus `bus`'s factor for voice selection, handed to `deps.busSelection` only where it moved. The same no-gap
   * rule as a voice's (`reevaluate`): while a seek runs, the larger of the automated gain at the targets and at the
   * smoothed estimate, so a bus fading out keeps its voices mixed until the fade ends; at rest, the settled gain.
   */
  private publishSelection(bus: string): void {
    const sel = this.deps.busSelection;
    if (!sel) return;
    const bound = this.buses.has(bus);
    let g = bound ? this.busGainNow(bus, false) : 1;
    if (bound && this.fading.size > 0) g = Math.max(g, this.busGainNow(bus));
    if ((this.selSent.get(bus) ?? 1) === g) return;
    sel(bus, g);
    if (g === 1) this.selSent.delete(bus);
    else this.selSent.set(bus, g);
  }

  /** Bus `name`'s volume curves at the smoothed globals, allocation free; 1 when unbound. */
  private busGainNow(name: string, smoothed = true): number {
    const bound = this.buses.get(name);
    if (!bound) return 1;
    const xs = this.xs;
    let n = 0;
    // Only the gain and low-pass bindings shape the bus's gain (effect and send bindings act inside the core).
    for (let j = 0; j < bound.length && n < MAX_BINDINGS; j++) {
      const b = bound[j]!;
      if (b.target !== AutoTarget.Volume && b.target !== AutoTarget.Lowpass) continue;
      const k = paramKey(0, b.param.slot);
      this.busIds[n] = b.curve;
      this.busTargets[n] = b.target;
      xs[n] = k < 0 ? 0 : smoothed ? this.smoothed(k) : this.paramValue[k]!;
      n++;
    }
    return evaluateInto(n, this.busIds, this.busTargets, xs, this.curves, this.busAuto).gain;
  }

  /**
   * Bus `bus`'s bindings as `BUS_AUTOMATE` takes them (ABI 4.8): an effect binding's slot and parameter, and a send
   * binding's return as its slot now, in the target's upper bits. A send whose return has no slot is left out.
   */
  private busWire(bus: string): BusAutomationBinding[] {
    const out: BusAutomationBinding[] = [];
    for (const b of this.buses.get(bus) ?? []) {
      let target: number = b.target;
      if (b.target === AutoTarget.Effect) {
        const fx = b.fx;
        if (!fx || fx.slot < 0 || fx.slot > 0xff || fx.param < 0 || fx.param > 0xff) continue;
        target = (AUTO_TARGET_FX | (fx.slot << AUTO_TARGET_SLOT_SHIFT) | (fx.param << AUTO_TARGET_PARAM_SHIFT) | (fx.log ? AUTO_TARGET_LOG : 0)) >>> 0;
      } else if (b.target === AutoTarget.Send) {
        const to = b.send === undefined ? -1 : this.deps.busIndex(b.send);
        if (to < 0) continue;
        target = (AUTO_TARGET_SEND | (to << AUTO_TARGET_SLOT_SHIFT)) >>> 0;
      }
      out.push({ param: AUTOMATION_GLOBAL | b.param.slot, curve: b.curve, target });
    }
    return out;
  }

  private reevaluateCurve(id: number): void {
    if (this.listed === 0) return;
    for (let i = 0; i < this.voices.length; i++) {
      const e = this.voices[i];
      if (e && e.curveIds.subarray(0, e.n).includes(id)) this.reevaluate(i);
    }
  }

  /** What `bindings` read goes out first (curves and parameters still waiting in the resync). */
  private sendNeeds(group: number, bindings: readonly BusAutomationBinding[]): void {
    if (this.dirtyCurves.size === 0 && this.dirtyParams.size === 0) return;
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

  /** LOOPS for slot `i`'s program (its clip's rate must be known: until then nothing goes, and `onPlaySent` sends it). */
  private sendProgram(i: number, e: VoiceEntry, stamp: number | undefined): void {
    const items = e.program && this.deps.writer.loops ? this.programItems(i, e.program) : null;
    if (!items) return;
    this.deps.writer.loops!(e.id, stamp, items);
    this.stats.loops++;
  }

  /**
   * ADR 0362: slot `i` reads its clip backwards, so its regions count from the clip's end: the clip's frame count, or
   * null for a forward voice (and while the clip's length isn't known, when a reversed voice's regions can't go yet).
   */
  private reversedFrames(i: number): number | null {
    if ((this.deps.table.flags2[i]! & VoiceFlag2.REVERSE) === 0) return null;
    return this.deps.clipInfo(i)?.frames ?? 0;
  }

  /** A program in the clip's frames, as LOOPS carries it; null while the clip's rate isn't known. */
  private programItems(i: number, program: readonly VoiceLoop[]): LoopsLoops[] | null {
    const rate = this.deps.clipInfo(i)?.sampleRate ?? 0;
    if (!(rate > 0)) return null;
    const frames = (s: number): number => Math.max(0, Math.round((Number.isFinite(s) ? s : 0) * rate));
    const n = this.reversedFrames(i);
    if (n !== null) {
      if (!(n > 0)) return null;
      // ADR 0362: a reversed voice's regions mirror into positions from the clip's end (sorted by start again); each
      // loop's direction is the same in those positions, so a forward loop runs backwards in the clip.
      const items = this.forwardItems(program, frames);
      for (const it of items) [it.startFrame, it.endFrame] = [Math.max(0, n - it.endFrame), Math.max(0, n - it.startFrame)];
      return items.reverse();
    }
    return this.forwardItems(program, frames);
  }

  private forwardItems(program: readonly VoiceLoop[], frames: (s: number) => number): LoopsLoops[] {
    return program.map((l) => {
      const dir = l.direction === "pingPong" ? 1 : l.direction === "backward" ? 2 : 0;
      const active = l.active === "held" ? 1 : l.active === "parameter" ? 2 : 0;
      const exit = l.exit === "jump" ? 1 : l.exit === "crossfade" ? 2 : 0;
      const p = l.param;
      return {
        startFrame: frames(l.start),
        endFrame: frames(Math.max(l.start, l.end)),
        crossfadeFrames: frames(l.crossfade),
        exitFadeFrames: frames(l.exitFade),
        count: Math.min(0xffff, Math.max(0, Math.round(l.count) || 0)),
        flags: dir | (active << LOOP_ACTIVE_SHIFT) | (exit << LOOP_EXIT_SHIFT) | (l.reentry === "reenter" ? LOOP_REENTER : 0) | (l.op === "<" ? LOOP_BELOW : 0),
        param: p && p.time === undefined ? (p.global ? AUTOMATION_GLOBAL | p.slot : p.slot) : 0,
        shapes: (loopShape(l.crossfadeShape) << LOOP_SEAM_SHAPE_SHIFT) | (loopShape(l.exitShape) << LOOP_EXIT_SHAPE_SHIFT),
        threshold: Number.isFinite(l.threshold) ? l.threshold! : 0,
      };
    });
  }

  private loopFrames(i: number, e: VoiceEntry): { start: number; end: number; looping: boolean } | null {
    if (!e.loop) return null;
    const info = this.deps.clipInfo(i);
    const rate = info?.sampleRate ?? 0;
    if (!(rate > 0)) return null;
    const start = Math.round(e.loop.start * rate);
    const n = this.reversedFrames(i);
    if (n !== null) {
      // ADR 0362: in a reversed voice's positions (from the clip's end) the region is mirrored.
      if (!(n > 0)) return null;
      const end = e.loop.end > 0 ? Math.min(n, Math.round(e.loop.end * rate)) : n;
      return { start: Math.max(0, n - end), end: Math.max(0, n - start), looping: e.loop.looping };
    }
    return { start, end: e.loop.end > 0 ? Math.round(e.loop.end * rate) : 0, looping: e.loop.looping };
  }

  /** Group `g`'s sequence clock extrapolated to now (`frame` may still be ahead: then its anchor value). */
  private clockNow(g: number): { value: number; rate: number } {
    const c = this.clocks.get(g)!;
    const now = this.deps.clockMap.framesNow();
    const rate = this.deps.clockMap.sampleRate ?? 48000;
    return { value: now > c.frame ? c.value + (c.rate * (now - c.frame)) / rate : c.value, rate: c.rate };
  }

  /** A resync of group `g`'s clock: asap, from where main estimates it is now. */
  private sendClock(g: number): void {
    this.dirtyClocks.delete(g);
    if (!this.clocks.has(g) || !this.deps.writer.time) return;
    const { value, rate } = this.clockNow(g);
    this.deps.writer.time(g, value, rate);
    this.budget -= TIME_FIXED_END;
    this.stats.times++;
  }

  private sendCurve(id: number): void {
    const c = this.curves.get(id);
    this.dirtyCurves.delete(id);
    if (!c) return;
    this.deps.writer.curves(id, [c]);
    this.budget -= curveBytes(c) + CURVES_FIXED_END;
    this.stats.curves++;
  }

  private sendParamKey(k: number): void {
    this.dirtyParams.delete(k);
    if (!this.paramSet[k]) return;
    const group = k < MAX_GLOBAL_SLOTS ? 0 : 1 + Math.floor((k - MAX_GLOBAL_SLOTS) / MAX_LOCAL_SLOTS);
    const slot = k < MAX_GLOBAL_SLOTS ? k : (k - MAX_GLOBAL_SLOTS) % MAX_LOCAL_SLOTS;
    // A resync jumps to the target (the core's smoothing state is gone).
    this.deps.writer.param(group, slot, this.paramValue[k]!, 0);
    this.jumped(k);
    this.budget -= PARAM_FIXED_END;
    this.stats.params++;
  }

  private sendBus(bus: string): void {
    this.dirtyBuses.delete(bus);
    const index = this.deps.busIndex(bus);
    const wire = this.busWire(bus);
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
    this.busSentKey.set(bus, wireKey(wire));
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

/** The x of `curve`'s loudest key (ADR 0346: selection's view of a time-bound volume curve); 0 for an empty one. */
function loudestX(curve: Curve | undefined): number {
  if (!curve || curve.length === 0) return 0;
  let best = 0;
  for (let k = 1; k < curve.length; k++) if (curve[k]![1] > curve[best]![1]) best = k;
  // A Bézier segment can overshoot its keys; selection only needs a loud, not the loudest, point.
  return evalCurve(curve, curve[best]![0]) >= 0 ? curve[best]![0] : 0;
}

/** The targets a bus binding may have (ABI 4.8 adds effect parameters and sends). */
const BUS_TARGETS: ReadonlySet<AutoTarget> = new Set([AutoTarget.Volume, AutoTarget.Lowpass, AutoTarget.Effect, AutoTarget.Send]);

/** A comparable form of bindings as written. */
const wireKey = (wire: readonly BusAutomationBinding[]): string => wire.map((b) => `${b.param}:${b.curve}:${b.target}`).join(",");
/** ADR 0350 (ABI 4.9): a fade shape's LOOPS `shapes` nibble (absent: equal power, the core's default). */
const LOOP_SHAPES: Readonly<Record<FadeShape, number>> = {
  equalPower: FADE_SHAPE_EQUAL_POWER, linear: FADE_SHAPE_LINEAR, sCurve: FADE_SHAPE_S_CURVE, invSCurve: FADE_SHAPE_INV_S_CURVE,
  log1: FADE_SHAPE_LOG1, log2: FADE_SHAPE_LOG2, log3: FADE_SHAPE_LOG3, exp1: FADE_SHAPE_EXP1, exp2: FADE_SHAPE_EXP2, exp3: FADE_SHAPE_EXP3,
};
/**
 * @internal ADR 0342: a voice loop program as a stream voice plays it (`LoopRecord` with `then`): its regions (hold points
 * and empty regions left out) forward, in order of start. A stream is read forward by the decoder worker, so ping-pong
 * and backward loops play forward (warned once); a parameter activation reads as always (the worker can't follow a
 * parameter; FMOD and Wwise streams loop forward between points too). Null without a region.
 */
export function streamLoopRecord(loops: readonly VoiceLoop[]): LoopRecord | null {
  const parts = loops.filter((l) => l.end > l.start).slice().sort((a, b) => a.start - b.start);
  if (parts.length === 0) return null;
  if (parts.some((l) => l.direction !== "forward")) warnOnce("stream:loopDirection", "[myco] a streamed sample's ping-pong or backward loop plays forward (streams are read forward); decode the sample (import setting stream off) to play it as authored.");
  const part = (l: VoiceLoop): StreamLoopPart => ({ start: l.start, end: l.end, crossfade: Math.max(0, Number.isFinite(l.crossfade) ? l.crossfade : 0), shape: loopShape(l.crossfadeShape), count: Math.max(0, Math.round(l.count) || 0), held: l.active === "held" });
  const [first, ...rest] = parts.map(part);
  return { start: first!.start, end: first!.end, looping: true, crossfade: first!.crossfade, shape: first!.shape, count: first!.count, held: first!.held, then: rest };
}

function loopShape(shape: FadeShape | undefined): number {
  return shape === undefined ? FADE_SHAPE_EQUAL_POWER : (LOOP_SHAPES[shape] ?? FADE_SHAPE_EQUAL_POWER);
}

function toWire(b: Binding): AutomateBindings {
  return { param: b.param.global ? AUTOMATION_GLOBAL | b.param.slot : b.param.slot, curve: b.curve, target: b.target, offset: 0 };
}

function wireCurve(c: Curve): CurvesCurves {
  const n = Math.min(c.length, CORE_CURVE_KEYS);
  const keys = new Array(n);
  for (let k = 0; k < n; k++) keys[k] = wireCurveKey(c[k]!);
  return { reserved: 0, keys };
}
