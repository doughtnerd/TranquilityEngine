// The command writer (ADR 0157; api-and-models §4.2 "Sizing and carry-over"; architecture §3.3): records for the
// frame go into a staging area, then `flush` copies them into pooled 64 KB BATCH buffers and posts them. A batch is
// capped at 64 KB; the excess stays staged and goes in the next batch with its absolute frame preserved (the
// next batch's `firstFrame` is its earliest stamp; asap records stay asap). Records are stable-sorted by frame by
// insertion sort (asap first). When the pool is empty `flush` posts nothing and keeps everything staged. A full
// staging area drops the newest record and sets the `overflowed` flag on the next batch (bit0).
//
// Voice commands come from `VoiceTable.drainCommands(writer)` (this class is the `VoiceCommandSink`), so STOP and FADE
// for the frame are queued deduplicated by the table and written here in order.
//
// Steady state allocates nothing: the staging areas, the record index arrays and the scratch record objects are made
// once; the generated writers write straight into the staging area. (`busConfig` and `busMix` write what the caller
// passes; they are not per-frame in steady state.)
//
// ADR 0158 E2 adds the automation records (`setLoop`, `automate`, `param`, `curves`, `busAutomate`; byte layouts in
// api-and-models §4.2). They write what they are given; the event runtime (E3) decides when to send them.
import {
  ASAP,
  AUTOMATE_BINDINGS_FIXED_END,
  BATCH_HEADER_FLAGS_OVERFLOWED,
  BATCH_MAX_BYTES,
  FADE_FLAGS_STOP_AT_END,
  SET_PARAMS_MASK_SCORE,
  SET_PARAMS_MASK_FLAGS,
  SET_PARAMS_FLAGS_PANNER_SHIFT,
  Kind,
  Op,
  SET_LOOP_FLAGS_LOOPING,
  writeAutomate,
  writeBatchHeader,
  writeBusAutomate,
  writeBusConfig,
  writeBusMix,
  writeEnvelope,
  writeFade,
  writeMaster,
  writeParam,
  writePlay,
  writeReset,
  writeSeek,
  writeSetParams,
  writeSetMixed,
  writeSetPaused,
  writeSetLoop,
  writeStop,
  type Automate,
  type AutomateBindings,
  type BusAutomate,
  type BusConfigBuses,
  type BusMixBuses,
  type Fade,
  type Master,
  type Param,
  type Play,
  type Reset,
  type Seek,
  type SetParams,
  type SetMixed,
  type SetPaused,
  type SetLoop,
  type Stop,
} from "../wire.generated";
import { CURVE_INTERPS, type Curve } from "../../../../engine/core/curve";
import type { BufferPool } from "./bufferPool";
import type { VoiceCommandSink } from "./voiceTable";


/** What the writer needs from `CoreLink`. */
export interface BatchPort {
  /** The host's BATCH pool (4 x 64 KB). */
  readonly batchPool: BufferPool;
  /** The envelope's next `seq` (per sender, wraps). */
  nextSeq(): number;
  /** Posts a BATCH buffer, transferring it (the worklet returns it to `batchPool`). */
  post(buffer: ArrayBuffer): void;
}

/** §4.2 PLAY, minus the head. `frameOffset` is the writer's business (see `play`). */
export interface PlayArgs {
  voiceId: number;
  clip: number;
  bus: number;
  /** `PLAY_FLAGS_*` from wire.generated (loop, stream, wantsPlayhead, mixed, spatial, panner). */
  flags: number;
  group: number;
  gain: number;
  pitch: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  lpHz: number;
  score: number;
  startOffsetFrames: number;
}

/**
 * One automation binding of AUTOMATE / BUS_AUTOMATE (ADR 0158 §3), as on the wire: `param` is a parameter slot
 * (`AUTOMATION_GLOBAL | slot` for a global one, else a local slot of the voice's instance `group`), `curve` a curve id
 * from `curves`, `target` one of `AUTOMATION_TARGET`.
 */
export type AutomationBinding = AutomateBindings;

/** `AutomationBinding.param` bit for a global parameter slot (0..63); without it the slot is the instance's local one (0..15). */
export const AUTOMATION_GLOBAL = 0x8000;
/** `AutomationBinding.target`: volume (linear gain multiplier), pitch (ratio multiplier), lowpass (Hz). A bus takes volume and lowpass. */
export const AUTOMATION_TARGET = { volume: 0, pitch: 1, lowpass: 2 } as const;
/** The core keeps at most this many bindings per voice and per bus, curves of at most `CORE_CURVE_KEYS` keys, and curve ids below `CORE_CURVES`. */
export const CORE_BINDINGS = 8;
export const CORE_CURVE_KEYS = 32;
export const CORE_CURVES = 1024;
/** Most bytes of curves in one CURVES record: larger uploads are split into several records (each fits a batch). */
const CURVES_RECORD_BUDGET = 32 * 1024;

/** The staging area's size in bytes: four full batches. */
export const STAGING_BYTES = 4 * BATCH_MAX_BYTES;
/** The smallest record is 16 bytes (SET_PAUSED, RESET). */
const MAX_RECORDS = STAGING_BYTES / 16;
/** Envelope (16) plus batch header (16). */
const BATCH_PREFIX_BYTES = 32;
/** Every batch's records fit here. */
const BATCH_RECORD_BYTES = BATCH_MAX_BYTES - BATCH_PREFIX_BYTES;
const MAX_FRAME_OFFSET = 0xfffffffe;
/** The AUTOMATE record's bindings between records (never written to). */
const NO_AUTOMATE_BINDINGS: AutomateBindings[] = [];

/** Counters for `Audio.debug()` and the tests. */
export interface CommandWriterStats {
  /** BATCH messages posted. */
  batches: number;
  /** Records written into posted batches. */
  records: number;
  /** Records dropped because the staging area was full (or one record was larger than a batch). */
  dropped: number;
  /** Times a flush found the pool empty and posted nothing. */
  poolEmpty: number;
  /** Records that waited for a later batch because a batch was full (carry-over). */
  carried: number;
}

export class CommandWriter implements VoiceCommandSink {
  readonly stats: CommandWriterStats = { batches: 0, records: 0, dropped: 0, poolEmpty: 0, carried: 0 };
  /** True while a dropped record's flag waits for the next posted batch. */
  overflowed = false;

  private stage: Uint8Array<ArrayBuffer> = new Uint8Array(STAGING_BYTES);
  private spare: Uint8Array<ArrayBuffer> | null = null;
  private view = new DataView(this.stage.buffer);
  private used = 0;
  private count = 0;
  /** Per record, in append order: offset and length in `stage`, and the absolute frame (-Infinity = asap). */
  private offset = new Uint32Array(MAX_RECORDS);
  private length = new Uint16Array(MAX_RECORDS);
  private frame = new Float64Array(MAX_RECORDS);
  /** Record indices in send order (sorted lazily). */
  private order = new Uint32Array(MAX_RECORDS);
  private sorted = true;
  private lastStamp = Number.NEGATIVE_INFINITY;

  private readonly playRec: Play = { voiceId: 0, frameOffset: ASAP, clip: 0, bus: 0, flags: 0, group: 0, reserved: 0, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, startOffsetFrames: 0 };
  private readonly stopRec: Stop = { voiceId: 0, frameOffset: ASAP, fadeFrames: 0, reason: 0 };
  private readonly fadeRec: Fade = { voiceId: 0, frameOffset: ASAP, target: 0, frames: 0, flags: 0 };
  private readonly paramsRec: SetParams = { voiceId: 0, frameOffset: ASAP, mask: 0, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, bus: 0, rampFrames: 0, flags: 0 };
  private readonly mixedRec: SetMixed = { voiceId: 0, frameOffset: ASAP, mixed: 0, gain: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 0 };
  private readonly pausedRec: SetPaused = { voiceId: 0, frameOffset: ASAP, paused: 0 };
  private readonly seekRec: Seek = { voiceId: 0, frameOffset: ASAP, clipFrame: 0, epoch: 0 };
  private readonly masterRec: Master = { voiceId: 0, frameOffset: ASAP, volume: 1, muted: 0, rampFrames: 0 };
  private readonly resetRec: Reset = { voiceId: 0, frameOffset: ASAP, keepClips: 0 } as Reset;
  private readonly loopRec: SetLoop = { voiceId: 0, frameOffset: ASAP, loopStartFrame: 0, loopEndFrame: 0, flags: 0 };
  private readonly paramRec: Param = { voiceId: 0, frameOffset: ASAP, group: 0, slot: 0, value: 0, seekPerSecond: 0 };
  private readonly automateRec: Automate = { voiceId: 0, frameOffset: ASAP, bindings: [] };
  private readonly busAutomateRec: BusAutomate = { voiceId: 0, frameOffset: ASAP, bindings: [] };

  /** `sampleRate` converts the table's seconds to frames (STOP and FADE take frames); a context swap sets it again (A3.4c). */
  constructor(
    private readonly port: BatchPort,
    public sampleRate: number,
  ) {}

  /** Records staged and not yet posted. */
  get pending(): number {
    return this.count;
  }

  /** PLAY at `atFrame` (an absolute audio frame, stamped) or asap (omitted). */
  play(args: PlayArgs, atFrame?: number): void {
    const r = this.playRec;
    r.voiceId = args.voiceId;
    r.clip = args.clip;
    r.bus = args.bus;
    r.flags = args.flags;
    r.group = args.group;
    r.gain = args.gain;
    r.pitch = args.pitch;
    r.dirX = args.dirX;
    r.dirY = args.dirY;
    r.dirZ = args.dirZ;
    r.lpHz = args.lpHz;
    r.score = args.score;
    r.startOffsetFrames = args.startOffsetFrames;
    const at = this.begin(56);
    if (at < 0) return;
    this.end(at, writePlay(this.view, at, r), atFrame);
  }

  /** STOP `id`, fading over `fadeSeconds` (0 = now). Always asap. */
  stop(id: number, fadeSeconds: number): void {
    const r = this.stopRec;
    r.voiceId = id;
    r.fadeFrames = this.frames(fadeSeconds);
    const at = this.begin(20);
    if (at < 0) return;
    this.end(at, writeStop(this.view, at, r));
  }

  /** FADE `id`'s gain multiplier to `to` over `seconds`. Always asap. */
  fade(id: number, to: number, seconds: number): void {
    const r = this.fadeRec;
    r.voiceId = id;
    r.target = to;
    r.frames = this.frames(seconds);
    r.flags = 0;
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeFade(this.view, at, r));
  }

  /** FADE `id` to silence and stop at the end (not used by `VoiceTable`, which sends STOP with a fade). */
  fadeAndStop(id: number, seconds: number): void {
    const r = this.fadeRec;
    r.voiceId = id;
    r.target = 0;
    r.frames = this.frames(seconds);
    r.flags = FADE_FLAGS_STOP_AT_END;
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeFade(this.view, at, r));
  }

  /** SET_PARAMS with only the `score` bit (A3.3): the core's ranking for its own lowest-score demote. Asap. */
  setScore(id: number, score: number): void {
    const r = this.paramsRec;
    r.voiceId = id;
    r.mask = SET_PARAMS_MASK_SCORE;
    r.score = score;
    const at = this.begin(56);
    if (at < 0) return;
    this.end(at, writeSetParams(this.view, at, r));
    r.score = 0;
  }

  /** SET_PARAMS with only the `flags` bit (H3): the voice's panner kind (0 equal-power, 1 HRTF). Asap; the core crossfades 45 ms. */
  setPanner(id: number, panner: number): void {
    const r = this.paramsRec;
    r.voiceId = id;
    r.mask = SET_PARAMS_MASK_FLAGS;
    r.flags = (panner & 3) << SET_PARAMS_FLAGS_PANNER_SHIFT;
    const at = this.begin(56);
    if (at < 0) return;
    this.end(at, writeSetParams(this.view, at, r));
    r.flags = 0;
  }

  /** SET_PARAMS (§4.2); `mask` is `SET_PARAMS_MASK_*`, other fields only matter where the mask says. `bus` only with the bus bit. */
  setParams(id: number, mask: number, gain: number, pitch: number, dirX: number, dirY: number, dirZ: number, lpHz: number, rampFrames: number, bus = 0): void {
    const r = this.paramsRec;
    r.voiceId = id;
    r.mask = mask;
    r.gain = gain;
    r.pitch = pitch;
    r.dirX = dirX;
    r.dirY = dirY;
    r.dirZ = dirZ;
    r.lpHz = lpHz;
    r.bus = bus;
    r.rampFrames = rampFrames;
    const at = this.begin(56);
    if (at < 0) return;
    this.end(at, writeSetParams(this.view, at, r));
  }

  /** SET_MIXED `id` (§4.2, A3.1): mixed or virtual; a promote carries the voice's gain, direction and `lpHz`. Always asap. */
  setMixed(id: number, mixed: boolean, gain: number, dirX: number, dirY: number, dirZ: number, lpHz: number): void {
    const r = this.mixedRec;
    r.voiceId = id;
    r.mixed = mixed ? 1 : 0;
    r.gain = gain;
    r.dirX = dirX;
    r.dirY = dirY;
    r.dirZ = dirZ;
    r.lpHz = lpHz;
    const at = this.begin(36);
    if (at < 0) return;
    this.end(at, writeSetMixed(this.view, at, r));
  }

  /** SET_PAUSED `id`. */
  setPaused(id: number, paused: boolean): void {
    const r = this.pausedRec;
    r.voiceId = id;
    r.paused = paused ? 1 : 0;
    const at = this.begin(16);
    if (at < 0) return;
    this.end(at, writeSetPaused(this.view, at, r));
  }

  /** SEEK `id` to `clipFrame` (a stream voice's: its seek `epoch`; a clip voice's: 0). */
  seek(id: number, clipFrame: number, epoch: number): void {
    const r = this.seekRec;
    r.voiceId = id;
    r.clipFrame = clipFrame >>> 0;
    r.epoch = epoch >>> 0;
    const at = this.begin(20);
    if (at < 0) return;
    this.end(at, writeSeek(this.view, at, r));
  }

  /** BUS_CONFIG: the whole tree, root first (`parent` 0xFFFF for the root). */
  busConfig(buses: readonly BusConfigBuses[]): void {
    let size = 16;
    for (const b of buses) size += 4 + 32 * b.effects.length;
    const at = this.begin(size);
    if (at < 0) return;
    this.end(at, writeBusConfig(this.view, at, { voiceId: 0, frameOffset: ASAP, buses: buses as BusConfigBuses[] }));
  }

  /** BUS_MIX: gain and low-pass per bus, root first. */
  busMix(buses: readonly BusMixBuses[], rampFrames: number): void {
    const at = this.begin(20 + 8 * buses.length);
    if (at < 0) return;
    this.end(at, writeBusMix(this.view, at, { voiceId: 0, frameOffset: ASAP, rampFrames, buses: buses as BusMixBuses[] }));
  }

  /** MASTER volume and mute. */
  master(volume: number, muted: boolean, rampFrames: number): void {
    const r = this.masterRec;
    r.volume = volume;
    r.muted = muted ? 1 : 0;
    r.rampFrames = rampFrames;
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeMaster(this.view, at, r));
  }

  /**
   * SET_LOOP `voiceId` (ADR 0158 §4) at `atFrame` (absolute, stamped) or asap (omitted): with `looping`, the clip voice
   * loops clip frames `startFrame..endFrame` (`endFrame` 0 = the clip's end); without, it is released (finishes its
   * pass and plays on to the clip's end). Overrides PLAY's whole-clip loop flag. Clip voices only (E2).
   */
  setLoop(voiceId: number, atFrame: number | undefined, startFrame: number, endFrame: number, looping: boolean): void {
    const r = this.loopRec;
    r.voiceId = voiceId;
    r.loopStartFrame = startFrame >>> 0;
    r.loopEndFrame = endFrame >>> 0;
    r.flags = looping ? SET_LOOP_FLAGS_LOOPING : 0;
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeSetLoop(this.view, at, r), atFrame);
  }

  /**
   * AUTOMATE `voiceId` (ADR 0158 §3): replaces the voice's bindings (an empty list clears them; past `CORE_BINDINGS`
   * are not sent). Send it right after the voice's PLAY with the same `atFrame` (omitted = asap), so it stays after
   * the PLAY in the batch; the core applies it on arrival.
   */
  automate(voiceId: number, atFrame: number | undefined, bindings: readonly AutomationBinding[]): void {
    const r = this.automateRec;
    r.voiceId = voiceId;
    r.bindings = (bindings.length > CORE_BINDINGS ? bindings.slice(0, CORE_BINDINGS) : bindings) as AutomateBindings[];
    const at = this.begin(16 + AUTOMATE_BINDINGS_FIXED_END * r.bindings.length);
    if (at >= 0) this.end(at, writeAutomate(this.view, at, r), atFrame);
    r.bindings = NO_AUTOMATE_BINDINGS; // drops the caller's list without a new array per record (M2 F1)
  }

  /**
   * PARAM (ADR 0158 §3): sets parameter `slot` of `group` (0 global, slots 0..63; else an instance group 1..1024,
   * slots 0..15) toward `value`, moving `seekPerSecond` units a second (0 jumps). Asap.
   */
  param(group: number, slot: number, value: number, seekPerSecond: number): void {
    const r = this.paramRec;
    r.group = group;
    r.slot = slot;
    r.value = value;
    r.seekPerSecond = seekPerSecond > 0 && Number.isFinite(seekPerSecond) ? seekPerSecond : 0;
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeParam(this.view, at, r));
  }

  /**
   * CURVES (ADR 0158 §3): defines curve ids `first`, `first + 1`, … from `curves` (the engine's `Curve`, keys sorted by
   * x; past `CORE_CURVE_KEYS` keys are not sent). A large upload goes as several records of at most 32 KB. Asap. Upload
   * per event asset: like any record, what doesn't fit the staging area (256 KB, about 660 full curves) is dropped.
   */
  curves(first: number, curves: readonly Curve[]): void {
    let i = 0;
    while (i < curves.length) {
      // As many curves as fit the record budget (at least one).
      let end = i;
      let bytes = 20;
      while (end < curves.length) {
        const size = 4 + 12 * Math.min(curves[end]!.length, CORE_CURVE_KEYS);
        if (end > i && bytes + size > CURVES_RECORD_BUDGET) break;
        bytes += size;
        end++;
      }
      const at = this.begin(bytes);
      if (at < 0) return;
      const v = this.view;
      v.setUint16(at, Op.CURVES, true);
      v.setUint16(at + 2, bytes / 4, true);
      v.setUint32(at + 4, 0, true);
      v.setUint32(at + 8, ASAP, true);
      v.setUint32(at + 12, (first + i) >>> 0, true);
      v.setUint32(at + 16, end - i, true);
      let off = at + 20;
      for (let c = i; c < end; c++) {
        const keys = curves[c]!;
        const n = Math.min(keys.length, CORE_CURVE_KEYS);
        v.setUint16(off, n, true);
        v.setUint16(off + 2, 0, true);
        off += 4;
        for (let k = 0; k < n; k++) {
          const key = keys[k]!;
          v.setFloat32(off, key[0], true);
          v.setFloat32(off + 4, key[1], true);
          const interp = key.length > 2 ? CURVE_INTERPS.indexOf(key[2]!) : 0;
          v.setUint32(off + 8, interp < 0 ? 0 : interp, true);
          off += 12;
        }
      }
      this.end(at, bytes);
      i = end;
    }
  }

  /** BUS_AUTOMATE `bus` (ADR 0158 §3): replaces the bus's bindings (global parameters; volume and lowpass). Asap. */
  busAutomate(bus: number, bindings: readonly AutomationBinding[]): void {
    const r = this.busAutomateRec;
    r.voiceId = bus;
    r.bindings = (bindings.length > CORE_BINDINGS ? bindings.slice(0, CORE_BINDINGS) : bindings) as AutomateBindings[];
    const at = this.begin(16 + AUTOMATE_BINDINGS_FIXED_END * r.bindings.length);
    if (at >= 0) this.end(at, writeBusAutomate(this.view, at, r));
    r.bindings = [];
  }

  /** RESET (§4.2): `keepClips` 0 also resets the arena and slab classes. */
  reset(keepClips: boolean): void {
    const r = this.resetRec;
    r.keepClips = keepClips ? 1 : 0;
    const at = this.begin(16);
    if (at < 0) return;
    this.end(at, writeReset(this.view, at, r));
  }

  /**
   * Posts what is staged as one or more BATCHes. `firstFrame` is the frame every asap record would apply at
   * (`ClockMap.nextFirstFrame()`); a batch's header carries its earliest stamp when it has one (else this), and each
   * stamped record's `frameOffset` is its frame minus that. Returns the number of batches posted. Posts nothing, and
   * keeps everything staged, when the pool is empty.
   */
  flush(firstFrame: number): number {
    if (this.count === 0) return 0;
    this.sort();
    const pool = this.port.batchPool;
    let next = 0;
    let posted = 0;
    while (next < this.count) {
      // Pass 1: how many records fit.
      let end = next;
      let bytes = 0;
      while (end < this.count) {
        const len = this.length[this.order[end]!]!;
        if (bytes + len > BATCH_RECORD_BYTES) break;
        bytes += len;
        end++;
      }
      if (end === next) {
        // One record bigger than a whole batch: it can never go out.
        this.stats.dropped++;
        this.overflowed = true;
        next++;
        continue;
      }
      const buffer = pool.acquire();
      if (!buffer) {
        this.stats.poolEmpty++;
        break;
      }
      // The earliest stamp in the batch: stamped records sort after asap ones, so it is the first stamped one.
      let header = firstFrame;
      for (let k = next; k < end; k++) {
        const f = this.frame[this.order[k]!]!;
        if (f !== Number.NEGATIVE_INFINITY) {
          header = f;
          break;
        }
      }
      const out = new Uint8Array(buffer);
      const view = new DataView(buffer);
      let pos = BATCH_PREFIX_BYTES;
      for (let k = next; k < end; k++) {
        const idx = this.order[k]!;
        const o = this.offset[idx]!;
        const len = this.length[idx]!;
        out.set(this.stage.subarray(o, o + len), pos);
        const f = this.frame[idx]!;
        let frameOffset = ASAP;
        if (f !== Number.NEGATIVE_INFINITY) {
          const d = f - header;
          frameOffset = d <= 0 ? 0 : d > MAX_FRAME_OFFSET ? MAX_FRAME_OFFSET : Math.round(d);
        }
        view.setUint32(pos + 8, frameOffset, true);
        pos += len;
      }
      writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.port.nextSeq(), bodyBytes: pos - 16 });
      writeBatchHeader(view, 0, { firstFrame: header, count: end - next, flags: this.overflowed ? BATCH_HEADER_FLAGS_OVERFLOWED : 0 });
      this.overflowed = false;
      this.port.post(buffer);
      this.stats.batches++;
      this.stats.records += end - next;
      posted++;
      next = end;
      if (next < this.count) this.stats.carried += this.count - next;
    }
    this.compact(next);
    return posted;
  }

  /** Drops everything staged (a rebuild, a closed host). */
  clear(): void {
    this.used = 0;
    this.count = 0;
    this.sorted = true;
    this.lastStamp = Number.NEGATIVE_INFINITY;
    this.overflowed = false;
  }

  private frames(seconds: number): number {
    return seconds > 0 && Number.isFinite(seconds) ? Math.round(seconds * this.sampleRate) : 0;
  }

  /** Room for `size` bytes: returns the offset to write at, or -1 (dropped and flagged). */
  private begin(size: number): number {
    if (this.used + size > STAGING_BYTES || this.count >= MAX_RECORDS || size > 0xffff) {
      this.stats.dropped++;
      this.overflowed = true;
      return -1;
    }
    return this.used;
  }

  /** Commits the record just written at `at` (`len` bytes), stamped at `atFrame` or asap. */
  private end(at: number, len: number, atFrame?: number): void {
    const f = atFrame !== undefined && Number.isFinite(atFrame) ? atFrame : Number.NEGATIVE_INFINITY;
    const i = this.count++;
    this.offset[i] = at;
    this.length[i] = len;
    this.frame[i] = f;
    this.order[i] = i;
    this.used = at + len;
    if (f < this.lastStamp) this.sorted = false;
    else this.lastStamp = f;
  }

  /** Stable insertion sort of `order` by frame (a no-op when records arrived in order). */
  private sort(): void {
    if (this.sorted) return;
    const order = this.order;
    const frame = this.frame;
    for (let i = 1; i < this.count; i++) {
      const v = order[i]!;
      const fv = frame[v]!;
      let j = i - 1;
      while (j >= 0 && frame[order[j]!]! > fv) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = v;
    }
    this.sorted = true;
  }

  /** Keeps records `from..count` of the send order, moved to the front of the staging area. */
  private compact(from: number): void {
    if (from >= this.count) {
      this.clear2();
      return;
    }
    if (from === 0) return;
    const spare = (this.spare ??= new Uint8Array(STAGING_BYTES));
    const keep = this.count - from;
    const offset = new Uint32Array(keep);
    const length = new Uint16Array(keep);
    const frame = new Float64Array(keep);
    let used = 0;
    for (let k = 0; k < keep; k++) {
      const idx = this.order[from + k]!;
      const o = this.offset[idx]!;
      const len = this.length[idx]!;
      spare.set(this.stage.subarray(o, o + len), used);
      offset[k] = used;
      length[k] = len;
      frame[k] = this.frame[idx]!;
      used += len;
    }
    const old = this.stage;
    this.stage = spare;
    this.spare = old;
    this.view = new DataView(this.stage.buffer);
    this.offset.set(offset);
    this.length.set(length);
    this.frame.set(frame);
    for (let k = 0; k < keep; k++) this.order[k] = k;
    this.count = keep;
    this.used = used;
    this.sorted = true;
    this.lastStamp = keep > 0 ? this.frame[keep - 1]! : Number.NEGATIVE_INFINITY;
  }

  private clear2(): void {
    this.used = 0;
    this.count = 0;
    this.sorted = true;
    this.lastStamp = Number.NEGATIVE_INFINITY;
  }
}
