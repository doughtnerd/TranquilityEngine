// The replay half of the hard rebuild (ADR 0157; architecture §3.6, §7 "Replay order"; api-and-models §4.2 REPLAY):
// what the core backend sends a fresh core so the voices it had carry on. `recovery.ts` replaces the node and calls
// the backend's lifecycle hooks; the backend owns a `Replayer` and a `PlayheadTracker` from this file.
//
// Order (§7): one REPLAY with RESET 0, BUS_CONFIG, BUS_MIX and MASTER; then every clip the old core had is sent again
// by the registry (`ClipRegistry.resend`), the HRIR first, then by the priority of the live voices using each clip;
// then, as each clip becomes resident on the new core, its voices go in a stamped REPLAY (chunked at the inbox size):
// a PLAY at frame F with `startOffsetFrames` = where the voice would be at F (the tracker's estimate, wrapped for
// loops), FADE to its fade gain and SET_PAUSED for paused voices. One-shots that would have ended by F are dropped, and
// so are one-shots under 1 s whose replay comes more than 250 ms after the trap (§3.6's note). Voices stopped while
// the rebuild ran are freed (no core will report their end).
//
// ADR 0158 (E3.1): the core backend's automation mirror (`coreAutomation.ts`) rides along: the header REPLAY carries
// every curve, parameter and bus binding after MASTER, and each replayed PLAY is followed by the voice's AUTOMATE and
// SET_LOOP. A voice looping a region resumes inside it (`wrapPosition`); a released one plays on from where it was.
//
// ADR 0162 (K4; S10, architecture §3.4): the header REPLAY restores the M3 state in this order: RESET 0, BUS_CONFIG,
// BED_CONFIG (`beds.ts`), BUS_MIX, MASTER, LISTENER (`listener.ts`, the last rotation, snapped), ZONE_CONFIG (`zones.ts`,
// every wanted slot; the core holds each until its kernel is resident), then the automation mirror. Each replayed PLAY
// carries the dry gain with occlusion (`gain × occGain`), the pitch with Doppler (`pitch × dopplerFactor`) and the
// voice's `lpHz`, and is followed by its SET_VOICE_FX (`voiceFx.ts`) when non-default. Each hook writes nothing while its
// feature is inert, so an M2 replay is byte-identical.
import type { Mixer } from "../../../../engine/audio/mixer";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  Kind,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_PANNER_SHIFT,
  PLAY_FLAGS_SPATIAL,
  REPLAY_CHUNK_MAX_BYTES,
  REPLAY_FLAGS_FIRST_CHUNK,
  REPLAY_FLAGS_LAST_CHUNK,
  writeBatchHeader,
  writeBusConfig,
  writeBusMix,
  writeEnvelope,
  writeFade,
  writeMaster,
  writePlay,
  writeReset,
  writeSetPaused,
  type BusConfigBuses,
  type BusMixBuses,
} from "../wire.generated";
import type { ClipInfo, ClipRegistry } from "./clipRegistry";
import type { ClockMap } from "./clock";
import type { StatusMirror } from "./mirror";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";
import { wrapPosition } from "./coreAutomation";


/** @internal §3.6: one-shots shorter than this (seconds)... */
export const REPLAY_SHORT_ONE_SHOT_SECONDS = 1;
/** @internal ...whose replay waited longer than this (seconds) after the trap are dropped rather than replayed late. */
export const REPLAY_SHORT_ONE_SHOT_MAX_WAIT_SECONDS = 0.25;

const MAX_BUS = 32;
/** Envelope (16) plus batch header (16). */
const PREFIX_BYTES = 32;

// --- Where each voice is ----------------------------------------------------------------------------------------

/**
 * @internal Main's estimate of each voice's playhead (clip frames), so a replay can resume a voice where it would be
 * (architecture §7: "the last playhead + elapsed frames × pitch"). The core reports playheads only for `wantsPlayhead`
 * voices, so the backend anchors each voice when its PLAY goes out (`start`) and again whenever its rate changes
 * (`retime`, after a pitch change or a pause): position = anchor + (frame − anchor frame) × pitch × clip rate / context
 * rate, frozen while paused. Errors are bounded by the asap latency of each change (a few quanta). Allocates only in
 * the constructor.
 */
export class PlayheadTracker {
  /** Per slot: the context frame of the last anchor, the clip frame there (unwrapped), and clip frames per context frame since. */
  readonly anchorFrame: Float64Array;
  readonly anchorPos: Float64Array;
  readonly rate: Float64Array;
  /** Per slot: the clip's rate when it was anchored (a clip decoded again at another rate scales its position, A3.4c). */
  readonly clipRate: Float64Array;
  /** Per slot: 1 while `anchorFrame` holds `Audio.time` seconds instead of frames (between `toTimeline` and `fromTimeline`). */
  private readonly inSeconds: Uint8Array;
  private secondsCount = 0;

  constructor(
    private readonly table: VoiceTable,
    private readonly clips: Pick<ClipRegistry, "info">,
    /** The context's rate, Hz; `fromTimeline` changes it when the context is replaced. */
    private sampleRate: number,
  ) {
    this.anchorFrame = new Float64Array(table.capacity);
    this.anchorPos = new Float64Array(table.capacity);
    this.rate = new Float64Array(table.capacity);
    this.clipRate = new Float64Array(table.capacity);
    this.inSeconds = new Uint8Array(table.capacity);
  }

  /** The clip rate of slot `i`'s clip now (the context rate when unknown). */
  private clipRateOf(i: number): number {
    const clipRate = this.clips.info(this.table.clip[i]!)?.sampleRate ?? 0;
    return clipRate > 0 ? clipRate : this.sampleRate;
  }

  /**
   * Clip frames per context frame for slot `i` now: pitch × clip rate / context rate, 0 while paused. ADR 0158: times
   * the voice's automated pitch at its parameters' targets (`autoPitch`, 1 without bindings; the core's smoothing
   * trails it by at most the seek time).
   */
  private rateOf(i: number): number {
    const t = this.table;
    if ((t.flags[i]! & VoiceFlag.PAUSED) !== 0) return 0;
    // ADR 0162 (K4): times the Doppler factor folded into the pitch sent (1 without Doppler).
    return (t.pitch[i]! * t.autoPitch[i]! * t.dopplerFactor[i]! * this.clipRateOf(i)) / this.sampleRate;
  }

  /** The voice in slot `i` starts at clip frame `pos` on context frame `frame` (its PLAY, or its replay). */
  start(i: number, frame: number, pos: number): void {
    this.dropSeconds(i);
    this.anchorFrame[i] = frame;
    this.anchorPos[i] = pos;
    this.rate[i] = this.rateOf(i);
    this.clipRate[i] = this.clipRateOf(i);
  }

  /**
   * Slot `i`'s rate changed at `frame` (call after the table has the new pitch or pause): integrate, then re-anchor.
   * Ignored for a slot carried across a context swap until `fromTimeline` (it integrates at its old rate until then).
   */
  retime(i: number, frame: number): void {
    if (this.inSeconds[i]) return;
    this.anchorPos[i] = this.at(i, frame);
    this.anchorFrame[i] = Math.max(frame, this.anchorFrame[i]!);
    this.rate[i] = this.rateOf(i);
  }

  /**
   * E4.4: where an unwrapped playhead is in the voice's sound (the core backend's: a stream by its map of regions,
   * splices and seeks, a clip in its SET_LOOP region or whole loop; `wrapPosition` underneath). Absent: unwrapped.
   */
  wrap: ((i: number, pos: number) => number) | null = null;

  /** E4.4: slot `i`'s frame in its sound at context `frame`: `positionNow`, wrapped by `wrap` (inside a loop region while it loops). */
  wrappedNow(i: number, frame: number): number {
    const pos = this.positionNow(i, frame);
    return this.wrap ? this.wrap(i, pos) : pos;
  }

  /** Slot `i`'s clip frame (unwrapped) at context `frame`. */
  at(i: number, frame: number): number {
    const elapsed = frame - this.anchorFrame[i]!;
    return this.anchorPos[i]! + (elapsed > 0 ? elapsed * this.rate[i]! : 0);
  }

  /** `at`, in frames of the clip as it is now: scaled when the clip came back at another rate than it was anchored at. */
  positionNow(i: number, frame: number): number {
    const pos = this.at(i, frame);
    const was = this.clipRate[i]!;
    const now = this.clipRateOf(i);
    return was > 0 && Math.abs(now - was) > 0.5 ? (pos * now) / was : pos;
  }

  /**
   * A3.4c, a context swap: every live slot's anchor moves from the old context's frames to `Audio.time` seconds
   * (frame / old rate + `offset`, the old clock's `timeOffset`), so it survives the new context's frames starting at 0.
   */
  toTimeline(offset: number): void {
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      const s = t.state[i]!;
      if (this.inSeconds[i] || (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL && s !== VoiceState.STOPPING)) continue;
      this.anchorFrame[i] = this.anchorFrame[i]! / this.sampleRate + offset;
      this.inSeconds[i] = 1;
      this.secondsCount++;
    }
  }

  /**
   * A3.4c: the new context's clock is known: the anchors carried by `toTimeline` go to its frames (seconds less
   * `offset`, its `timeOffset`, times `sampleRate`), and their rates to clip frames per new context frame.
   */
  fromTimeline(sampleRate: number, offset: number): void {
    const was = this.sampleRate;
    this.sampleRate = sampleRate;
    if (this.secondsCount === 0) return;
    for (let i = 0; i < this.inSeconds.length; i++) {
      if (!this.inSeconds[i]) continue;
      this.anchorFrame[i] = (this.anchorFrame[i]! - offset) * sampleRate;
      this.rate[i] = (this.rate[i]! * was) / sampleRate;
      this.inSeconds[i] = 0;
    }
    this.secondsCount = 0;
  }

  private dropSeconds(i: number): void {
    if (!this.inSeconds[i]) return;
    this.inSeconds[i] = 0;
    this.secondsCount--;
  }
}

// --- REPLAY messages ---------------------------------------------------------------------------------------------

/** @internal What a `ReplayBuilder` posts through: the link's `post` and its envelope counter. */
export interface ReplayPort {
  post(buffer: ArrayBuffer): void;
  nextSeq(): number;
}

/**
 * @internal Records for one REPLAY (api-and-models §4.2: the BATCH body, never truncated or carried over), split into
 * messages of at most `maxRecordBytes` of records (1 MiB minus the 32-byte prefix, the inbox), in order. The first
 * message of a wave that begins with RESET carries bit1 (first chunk); the last message of every wave carries bit2.
 */
export class ReplayBuilder {
  private buffer = new ArrayBuffer(4096);
  private view = new DataView(this.buffer);
  private used = 0;
  private readonly ends: number[] = [];

  constructor(readonly maxRecordBytes = REPLAY_CHUNK_MAX_BYTES) {}

  /** Records staged. */
  get count(): number {
    return this.ends.length;
  }

  /** Appends one record of at most `bytes` bytes, written by `write(view, offset)` (a generated writer; returns its length). */
  record(bytes: number, write: (view: DataView, offset: number) => number): void {
    if (this.used + bytes > this.buffer.byteLength) {
      let size = this.buffer.byteLength * 2;
      while (size < this.used + bytes) size *= 2;
      const next = new ArrayBuffer(size);
      new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.used));
      this.buffer = next;
      this.view = new DataView(next);
    }
    this.used += write(this.view, this.used);
    this.ends.push(this.used);
  }

  /** Posts the staged records as REPLAY messages with header `firstFrame` and empties the builder; returns how many messages. */
  post(port: ReplayPort, firstFrame: number, beginsWithReset: boolean): number {
    const n = this.ends.length;
    let messages = 0;
    let k = 0;
    let start = 0;
    while (k < n) {
      let end = k;
      while (end < n && this.ends[end]! - start <= this.maxRecordBytes) end++;
      if (end === k) end = k + 1; // a record larger than a message can't happen (the largest is BUS_CONFIG, < 16 KB)
      const stop = this.ends[end - 1]!;
      const bytes = stop - start;
      const out = new ArrayBuffer(PREFIX_BYTES + bytes);
      const view = new DataView(out);
      writeEnvelope(view, 0, { kind: Kind.REPLAY, seq: port.nextSeq() >>> 0, bodyBytes: 16 + bytes });
      const flags = (messages === 0 && beginsWithReset ? REPLAY_FLAGS_FIRST_CHUNK : 0) | (end === n ? REPLAY_FLAGS_LAST_CHUNK : 0);
      writeBatchHeader(view, 0, { firstFrame, count: end - k, flags });
      new Uint8Array(out, PREFIX_BYTES).set(new Uint8Array(this.buffer, start, bytes));
      port.post(out);
      messages++;
      start = stop;
      k = end;
    }
    this.used = 0;
    this.ends.length = 0;
    return messages;
  }
}

// --- The replay ---------------------------------------------------------------------------------------------------

/** @internal What the replay reads and drives of the core backend (`CoreBackend` satisfies it). */
export interface ReplaySource {
  readonly table: VoiceTable;
  readonly clips: ClipRegistry;
  readonly clockMap: ClockMap;
  readonly mirror: StatusMirror;
  readonly mixer: Pick<Mixer, "resolveAll">;
  readonly writer: { clear(): void };
  readonly playheads: PlayheadTracker;
  readonly masterVolume: number;
  readonly muted: boolean;
  /** MASTER is held at 0 by the hidden-page policy (`background.ts`); the replayed MASTER keeps it so. */
  readonly hiddenMuted?: boolean;
  readonly host: { readonly sampleRate: number };
  /** H3: the panner kind main holds for slot `i` (1 HRTF), so the replayed PLAY keeps it; absent: equal-power. */
  hrtfPanner?(i: number): number;
  /** BUS_CONFIG's buses for the current tree, root first. */
  busConfigWire(): BusConfigBuses[];
  /** B3: the live stream voices reopen on the new core (new stream ids, from their playheads), after the header. */
  reopenStreams?(ids: readonly number[]): void;
  /** ADR 0158 (E3.1): the automation mirror the replay restores; absent: nothing to restore. */
  readonly automation?: ReplayAutomation;
  /** ADR 0162 (K4): the M3 state the replay restores; absent: nothing to restore. */
  readonly spatial?: ReplaySpatial;
}

/**
 * @internal ADR 0162 (K4): the M3 replay hooks (`CoreBackend` provides them from `beds.ts`, `listener.ts`, `zones.ts` and
 * `voiceFx.ts`). The order of the calls is the replay's (S10); each appends nothing while its feature is inert.
 */
export interface ReplaySpatial {
  /** BED_CONFIG, right after BUS_CONFIG. */
  replayBeds(b: ReplayBuilder): void;
  /** LISTENER (the last rotation, snapped), after MASTER. */
  replayListener(b: ReplayBuilder): void;
  /** ZONE_CONFIG, after LISTENER. */
  replayZones(b: ReplayBuilder): void;
  /** Voice `id`'s SET_VOICE_FX, right after its replayed PLAY (a mixed, non-default voice). */
  replayVoiceFx(b: ReplayBuilder, id: number, i: number): void;
}

/** @internal What the replay asks of the automation mirror (`CoreAutomation` satisfies it). */
export interface ReplayAutomation {
  /** Curves, parameters and bus bindings, appended to the header REPLAY after MASTER. */
  replayHeader(b: ReplayBuilder): void;
  /** Voice `id`'s bindings and loop, appended right after its replayed PLAY. */
  replayVoice(b: ReplayBuilder, id: number, i: number): void;
  /** Slot `i`'s loop region in clip frames (`end` 0 = the clip's end), or null without one. */
  loopOf(i: number): { readonly start: number; readonly end: number; readonly looping: boolean } | null;
}

/** @internal Counts for `Audio.debug()` and the tests. */
export interface ReplayStats {
  /** Rebuilds restored (`restore` calls). */
  restores: number;
  /** REPLAY messages posted. */
  messages: number;
  /** Voices replayed onto a new core. */
  replayed: number;
  /** Voices dropped instead (would have ended, a short one-shot replayed too late, or stopped during the rebuild). */
  dropped: number;
  /** Voices whose clip failed to come back (freed with reason "failed"). */
  failed: number;
}

/**
 * @internal The backend's half of a hard rebuild. `begin` when the old core is gone (`onRebuildStart`), `restore` once
 * the new core answered (`onRebuilt`), `flush` once per frame after the clip events were applied: it replays the
 * voices whose clips came back since the last frame, in one stamped REPLAY.
 */
export class Replayer {
  readonly stats: ReplayStats = { restores: 0, messages: 0, replayed: 0, dropped: 0, failed: 0 };
  /** Voices of a clip not yet back, by clip id (filled by `restore`). */
  private readonly waiting = new Map<number, number[]>();
  /** Voices whose clip is back, replayed at the next `flush`. */
  private readonly back: number[] = [];
  /** B3: live stream voices, reopened at the next `flush` (once the clock, and a new context's timeline, is known). */
  private streams: number[] = [];
  private readonly builder: ReplayBuilder;
  private trapFrame = 0;
  /** Bumped by each `restore`, so clip listeners from an earlier rebuild do nothing. */
  private epoch = 0;
  private readonly busMix: BusMixBuses[] = [];

  constructor(
    private readonly src: ReplaySource,
    private readonly port: ReplayPort,
    options: { maxRecordBytes?: number } = {},
  ) {
    this.builder = new ReplayBuilder(options.maxRecordBytes);
  }

  /** Voices waiting for their clip, or for the next `flush`. */
  get pending(): number {
    let n = this.back.length + this.streams.length;
    for (const ids of this.waiting.values()) n += ids.length;
    return n;
  }

  /** The old core is gone: note the frame it died at (for §3.6's late one-shot rule). */
  begin(): void {
    const now = this.src.clockMap.framesNow();
    this.trapFrame = now > 0 ? now : this.src.mirror.frameAudio;
  }

  /** A3.4c: set by `newContext` until the new clock is known: `trapFrame` then holds `Audio.time` seconds. */
  private timelinePending = false;

  /**
   * A3.4c, the rebuild moved to a new context whose frames start at 0 (call before the clock map's `rebase`, with the
   * old rate and `timeOffset`): the trap frame and every live voice's playhead anchor are carried as `Audio.time`
   * seconds until the new context's clock is known (`flush` converts them back to its frames).
   */
  newContext(oldRate: number, oldOffset: number): void {
    if (!this.timelinePending) this.trapFrame = this.trapFrame / oldRate + oldOffset;
    this.timelinePending = true;
    this.src.playheads.toTimeline(oldOffset);
  }

  /** True while voices wait for the new context's clock (A3.4c). */
  get waitingForClock(): boolean {
    return this.timelinePending;
  }

  /** The carried anchors go to the new context's frames once its clock is known; false while it isn't yet. */
  private settleTimeline(): boolean {
    if (!this.timelinePending) return true;
    const clock = this.src.clockMap;
    if (clock.carryPending) return false;
    this.trapFrame = (this.trapFrame - clock.timeOffset) * clock.sampleRate;
    this.src.playheads.fromTimeline(clock.sampleRate, clock.timeOffset);
    this.timelinePending = false;
    return true;
  }

  /**
   * The new core answered: drop what was staged for the old one, re-anchor the clock, send the header REPLAY (RESET 0,
   * BUS_CONFIG, BUS_MIX, MASTER), have the registry send every clip again by priority, and wait for each clip's voices.
   */
  restore(): void {
    const { table: t, clips } = this.src;
    this.stats.restores++;
    const epoch = ++this.epoch;
    this.waiting.clear();
    this.back.length = 0;
    this.streams = [];
    this.src.writer.clear();
    // §3.7/A3.2: a new core is a new STATUS stream; the clock map takes its next sample as it is.
    this.src.clockMap.reset();

    // Live voices: those the old core had (PLAYING, VIRTUAL) wait for their clip; STOPPING ones would have been ended
    // by the old core, which can't report it now.
    const priorityOf = new Map<number, number>();
    const streams: number[] = [];
    for (let i = 0; i < t.capacity; i++) {
      const s = t.state[i]!;
      if (s === VoiceState.STOPPING) {
        t.free(this.idOf(i), VoiceReason.NONE);
        this.stats.dropped++;
        continue;
      }
      if (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL) continue;
      if ((t.flags[i]! & VoiceFlag.STREAM) !== 0) {
        // B3: no clip to wait for; reopened from its playhead once the header is out.
        streams.push(this.idOf(i));
        continue;
      }
      const clip = t.clip[i]!;
      const ids = this.waiting.get(clip);
      if (ids) ids.push(this.idOf(i));
      else this.waiting.set(clip, [this.idOf(i)]);
      priorityOf.set(clip, Math.max(priorityOf.get(clip) ?? 0, t.priority[i]!));
    }

    this.postHeader();
    this.streams = streams;

    // §3.6: resident clips go back ordered by their live voices' priority (the registry puts the HRIR first).
    const order = [...priorityOf.keys()].sort((a, b) => priorityOf.get(b)! - priorityOf.get(a)!);
    clips.resend?.(order);
    for (const clip of order) {
      clips.onResident(clip, (info: ClipInfo) => {
        if (epoch !== this.epoch) return;
        const ids = this.waiting.get(clip);
        if (!ids) return;
        this.waiting.delete(clip);
        if (info.state === "ready") {
          for (const id of ids) this.back.push(id);
          return;
        }
        for (const id of ids) {
          if (t.free(id, VoiceReason.FAILED)) this.stats.failed++;
        }
      });
    }
  }

  /** RESET 0, BUS_CONFIG, (BED_CONFIG,) BUS_MIX, MASTER(, LISTENER, ZONE_CONFIG) in one REPLAY (§7's replay order, S10), every record asap. */
  private postHeader(): void {
    const b = this.builder;
    b.record(16, (view, off) => writeReset(view, off, { voiceId: 0, frameOffset: ASAP, keepClips: 0 }));
    const buses = this.src.busConfigWire();
    let size = 16;
    for (const bus of buses) size += 4 + 32 * bus.effects.length;
    b.record(size, (view, off) => writeBusConfig(view, off, { voiceId: 0, frameOffset: ASAP, buses }));
    this.src.spatial?.replayBeds(b);
    const resolved = this.src.mixer.resolveAll();
    const n = Math.min(resolved.length, MAX_BUS);
    const mix = this.busMix;
    mix.length = 0;
    for (let i = 0; i < n; i++) mix.push({ gain: resolved[i]!.gain, lpHz: resolved[i]!.snapshotLowpass ?? BUS_LP_OFF_HZ });
    b.record(20 + 8 * n, (view, off) => writeBusMix(view, off, { voiceId: 0, frameOffset: ASAP, rampFrames: 0, buses: mix }));
    const { masterVolume } = this.src;
    const muted = this.src.muted || this.src.hiddenMuted === true;
    b.record(24, (view, off) => writeMaster(view, off, { voiceId: 0, frameOffset: ASAP, volume: masterVolume, muted: muted ? 1 : 0, rampFrames: 0 }));
    this.src.spatial?.replayListener(b);
    this.src.spatial?.replayZones(b);
    this.src.automation?.replayHeader(b);
    this.stats.messages += b.post(this.port, this.src.mirror.frameAudio, true);
  }

  /**
   * Per frame, after the clip events were applied: the voices whose clip came back go out in one stamped REPLAY at
   * F = *F*_now + L, each PLAY starting where the voice would be at F. Returns how many voices it replayed.
   */
  flush(): number {
    if (this.streams.length > 0 && this.settleTimeline()) {
      const streams = this.streams;
      this.streams = [];
      this.src.reopenStreams?.(streams);
      this.stats.replayed += streams.length;
    }
    if (this.back.length === 0 || !this.settleTimeline()) return 0;
    const { table: t, clips, clockMap, playheads } = this.src;
    const rate = clockMap.sampleRate;
    const frame = Math.round(clockMap.framesNow() + clockMap.lookaheadFrames());
    const waited = (frame - this.trapFrame) / rate;
    const b = this.builder;
    let replayed = 0;
    for (const id of this.back) {
      if (!t.isLive(id)) continue;
      const i = id & 0xffff;
      const s = t.state[i]!;
      if (s === VoiceState.STOPPING) {
        // Stopped while it waited: never on this core, so nothing would report its end.
        t.free(id, VoiceReason.NONE);
        this.stats.dropped++;
        continue;
      }
      if (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL) continue;
      const info = clips.info(t.clip[i]!);
      const frames = info?.frames ?? 0;
      const clipRate = info && info.sampleRate > 0 ? info.sampleRate : rate;
      const flags = t.flags[i]!;
      // ADR 0158: a SET_LOOP region (looping, or released) decides instead of PLAY's whole-clip flag.
      const region = this.src.automation?.loopOf(i) ?? null;
      const loop = region ? region.looping : (flags & VoiceFlag.LOOP) !== 0;
      let pos = playheads.positionNow(i, frame);
      const shortOneShot = (flags & VoiceFlag.ONE_SHOT) !== 0 && frames / clipRate < REPLAY_SHORT_ONE_SHOT_SECONDS;
      if ((!loop && pos >= frames) || (shortOneShot && !loop && waited > REPLAY_SHORT_ONE_SHOT_MAX_WAIT_SECONDS)) {
        t.free(id, VoiceReason.NONE);
        this.stats.dropped++;
        continue;
      }
      if (region && loop) pos = wrapPosition(pos, region.start, region.end, frames);
      else if (loop && frames > 0) pos %= frames;
      playheads.start(i, frame, pos);
      const spatial = (flags & VoiceFlag.SPATIAL) !== 0;
      const panner = spatial ? (this.src.hrtfPanner?.(i) ?? 0) << PLAY_FLAGS_PANNER_SHIFT : 0;
      const playFlags = (s === VoiceState.PLAYING ? PLAY_FLAGS_MIXED : 0) | (loop ? PLAY_FLAGS_LOOP : 0) | (spatial ? PLAY_FLAGS_SPATIAL : 0) | panner;
      b.record(56, (view, off) =>
        writePlay(view, off, {
          voiceId: id,
          frameOffset: 0,
          clip: t.clip[i]!,
          bus: t.bus[i]!,
          flags: playFlags,
          group: t.group[i]!,
          reserved: 0,
          gain: t.gain[i]! * t.occGain[i]!,
          pitch: t.pitch[i]! * t.dopplerFactor[i]!,
          dirX: t.dirX[i]!,
          dirY: t.dirY[i]!,
          dirZ: t.dirZ[i]!,
          lpHz: t.lpHz[i]!,
          score: t.audibility[i]!,
          startOffsetFrames: Math.floor(pos),
        }),
      );
      this.src.automation?.replayVoice(b, id, i);
      if (s === VoiceState.PLAYING) this.src.spatial?.replayVoiceFx(b, id, i);
      const fade = t.fadeGain[i]!;
      if (fade !== 1) b.record(24, (view, off) => writeFade(view, off, { voiceId: id, frameOffset: ASAP, target: fade, frames: 0, flags: 0 }));
      if ((flags & VoiceFlag.PAUSED) !== 0) b.record(16, (view, off) => writeSetPaused(view, off, { voiceId: id, frameOffset: ASAP, paused: 1 }));
      replayed++;
    }
    this.back.length = 0;
    if (b.count > 0) this.stats.messages += b.post(this.port, frame, false);
    this.stats.replayed += replayed;
    return replayed;
  }

  private idOf(i: number): number {
    return ((this.src.table.gen[i]! << 16) | i) >>> 0;
  }
}
