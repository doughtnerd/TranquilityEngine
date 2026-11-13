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
//
// ADR 0162 K1 adds the spatial records (`setVoiceFx`, `bedConfig`, `zoneConfig`, `listener`; layouts in
// docs/design/0162-audio-spatial/api-and-models.md §4.2 and contracts C2-C5) and PLAY's bit 7 (`PLAY_FLAGS_AMBISONIC`,
// passed in `PlayArgs.flags`). Like the others they write what they are given, from preallocated scratch records;
// K4 and the feature tasks decide when to send them.
//
// ADR 0166 M4 (Z4, leaf L-Z4b; api-and-models §4.1, §4.2, §3.2): PLAY's `gate` (`playGated`, `PlayArgs.gate`) and bit 8
// `fadeZero` (`PlayArgs.fadeZero`); the `shape` word on FADE, SET_PARAMS and STOP, which makes them 28, 60 and 24 B
// (`fadeShaped`, `stopShaped`, `setParams`' `shape`), each stampable; and a gate group's records stay in one BATCH.
import {
  ASAP,
  AUTOMATE_BINDINGS_FIXED_END,
  BATCH_HEADER_FLAGS_OVERFLOWED,
  BATCH_MAX_BYTES,
  BUS_SLOT_FLAGS_FRESH,
  BUS_SLOT_FLAGS_STRUCTURAL,
  BUS_SLOT_MAX_EFFECTS,
  ErrorCode,
  FadeLaw,
  MAX_DUCK_RULES,
  MAX_LOUDNESS_BUSES,
  packRampShape,
  WireError,
  writeBusDuck,
  writeBusPresence,
  writeBusRamp,
  writeBusSlot,
  writeLoudConfig,
  FADE_FLAGS_STOP_AT_END,
  PLAY_FLAGS_FADE_ZERO,
  packGate,
  gateGroupId,
  packShape,
  SET_PARAMS_MASK_SCORE,
  SET_PARAMS_MASK_FLAGS,
  SET_PARAMS_FLAGS_PANNER_SHIFT,
  Kind,
  LISTENER_FLAGS_SNAP,
  MAX_BEDS,
  MAX_ZONE_SLOTS,
  Op,
  SET_LOOP_FLAGS_LOOPING,
  SET_VOICE_FX_FIXED_END,
  writeAutomate,
  writeBatchHeader,
  writeBedConfig,
  writeBusAutomate,
  writeBusConfig,
  writeBusMix,
  writeEnvelope,
  writeFade,
  writeListener,
  writeMaster,
  writeParam,
  writePlay,
  writeReset,
  writeSeek,
  writeSetParams,
  writeSetMixed,
  writeSetPaused,
  writeSetLoop,
  writeSetVoiceFx,
  writeStop,
  writeZoneConfig,
  type Automate,
  type AutomateBindings,
  type BusAutomate,
  type BusDuck,
  type BusDuckRules,
  type BusPresence,
  type BusRamp,
  type BusSlot,
  type BusSlotEffects,
  type LoudConfig,
  type LoudConfigMeters,
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
  type BedConfig,
  type Listener,
  type SetVoiceFx,
  type ZoneConfig,
  type ZoneConfigSlots,
} from "../wire.generated";
import { CURVE_INTERPS, type Curve } from "../../../../engine/core/curve";
import type { BufferPool } from "./bufferPool";
import type { VoiceCommandSink } from "./voiceTable";


/** ADR 0171 §4.2 `BUS_SLOT`, minus the head and the reserved words: one slot's configuration, as on the wire. */
export interface BusSlotArgs {
  slot: number;
  /** Parent slot; `BUS_ROOT` (0xFFFF) for a root. */
  parent: number;
  /** In wire form (`type`, 7 parameters: a shorter `p` is zero-padded); at most `BUS_SLOT_MAX_EFFECTS` are written. */
  effects: readonly { type: number; p: readonly number[] }[];
  /** `BUS_SLOT_FLAGS_STRUCTURAL`: applies at quantum granularity under the gate (a dip's middle record). */
  structural?: boolean;
  /** `BUS_SLOT_FLAGS_FRESH`: the slot starts zeroed with unity lanes (a re-add after recycling). */
  fresh?: boolean;
  /** The structural sequence this record belongs to (13 bits, 0 none, C27). */
  sequenceId?: number;
}

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
  /**
   * `PLAY_FLAGS_*` from wire.generated (loop, stream, wantsPlayhead, mixed, spatial, panner, ambisonic). ADR 0162 C1:
   * panner 2 (`PANNER_BED`) is the bus's bed; bit 7 (`PLAY_FLAGS_AMBISONIC`, `AMBI_FLAG`) a B-format voice of 4, 9 or 16
   * channels, whose spatial, panner and dir the core ignores.
   */
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
  /**
   * ADR 0166 §4.1: the PLAY `gate` word as `packGate(groupId, groupSize)` makes it (0 = ungated). Optional: absent is 0.
   * Prefer `playGated`, which packs it and keeps the group in one BATCH.
   */
  gate?: number;
  /** ADR 0166 §4.1: start with the `fade` ramp at 0 (sets `PLAY_FLAGS_FADE_ZERO`, bit 8, on top of `flags`). */
  fadeZero?: boolean;
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
/** The BUS_SLOT, BUS_DUCK and LOUD_CONFIG scratch lists between records (never written to). */
const NO_SLOT_EFFECTS: BusSlotEffects[] = [];
const NO_DUCK_RULES: BusDuckRules[] = [];
const NO_LOUD_METERS: LoudConfigMeters[] = [];
/** The BED_CONFIG and ZONE_CONFIG scratch arrays between records (never written to). */
const NO_NUMBERS: number[] = [];
const NO_ZONE_SLOTS: ZoneSlotArgs[] = [];
/** Pads a byte count to a multiple of 4 (the record and list padding of the M3 records). */
const pad4 = (n: number): number => Math.ceil(n / 4) * 4;
/** A ramp's start phase, 0..1, as the u0.16 the shape word carries (clamped). */
const phase16 = (p: number): number => Math.min(65535, Math.max(0, Math.round(p * 65536)));

/**
 * ADR 0162 C3: SET_VOICE_FX, minus the head. `mask` is `SET_VOICE_FX_MASK_*` (hpHz, sends, yaw, aux); fields outside
 * the mask are written as given and ignored by the core.
 */
export interface VoiceFxArgs {
  voiceId: number;
  /** `SET_VOICE_FX_MASK_HP_HZ | _SENDS | _YAW | _AUX`. */
  mask: number;
  rampFrames: number;
  /** High-pass cutoff in Hz; `HP_BOTTOM` (20) or less is off. */
  hpHz: number;
  /** Linear send level into zone slots 0..3 (pre-distance; main folds volume, curve, weight and wet factor). Exactly 4 read. */
  send: ArrayLike<number>;
  /** Radians, ambisonic voices. */
  yaw: number;
  auxLevel: number;
  /** The aux send's bus; `AUX_BUS_NONE` (0xFFFF) is none. */
  auxBus: number;
}

/** ADR 0162 C5: one ZONE_CONFIG slot, as on the wire (`kernelId` 0 is off; `state` is `ZoneSlotState`). */
export type ZoneSlotArgs = ZoneConfigSlots;

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
  /** Per record: its gate group id (`playGated`), 0 for every other record; a group's run stays in one BATCH (`flush`). */
  private groupOf = new Uint16Array(MAX_RECORDS);
  /** The group id `end` stamps on the record being written (set by `playGated` around its write). */
  private curGroup = 0;
  /** Record indices in send order (sorted lazily). */
  private order = new Uint32Array(MAX_RECORDS);
  private sorted = true;
  private lastStamp = Number.NEGATIVE_INFINITY;

  private readonly playRec: Play = { voiceId: 0, frameOffset: ASAP, clip: 0, bus: 0, flags: 0, group: 0, gate: 0, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, startOffsetFrames: 0 };
  private readonly stopRec: Stop = { voiceId: 0, frameOffset: ASAP, fadeFrames: 0, reason: 0, shape: 0 };
  private readonly fadeRec: Fade = { voiceId: 0, frameOffset: ASAP, target: 0, frames: 0, flags: 0, shape: 0 };
  private readonly paramsRec: SetParams = { voiceId: 0, frameOffset: ASAP, mask: 0, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, bus: 0, rampFrames: 0, flags: 0, shape: 0 };
  private readonly mixedRec: SetMixed = { voiceId: 0, frameOffset: ASAP, mixed: 0, gain: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 0 };
  private readonly pausedRec: SetPaused = { voiceId: 0, frameOffset: ASAP, paused: 0 };
  private readonly seekRec: Seek = { voiceId: 0, frameOffset: ASAP, clipFrame: 0, epoch: 0 };
  private readonly rampRec: BusRamp = { voiceId: 0, frameOffset: ASAP, lane: 0, mask: 0, gain: 1, lpHz: 0, frames: 0, shape: 0 };
  private readonly slotRec: BusSlot = { voiceId: 0, frameOffset: ASAP, slot: 0, flags: 0, sequenceId: 0, reserved: 0, reserved2: 0, parent: 0xffff, effects: [] };
  /** `BUS_SLOT`'s effect scratch: `BUS_SLOT_MAX_EFFECTS` records with 7-entry parameter arrays, reused by every record. */
  private readonly slotEffects: BusSlotEffects[] = Array.from({ length: BUS_SLOT_MAX_EFFECTS }, () => ({ type: 0, p: [0, 0, 0, 0, 0, 0, 0] }));
  /** `slotEffects` cut to each length 0..4, made once, so a record sets its list without slicing. */
  private readonly slotEffectViews: BusSlotEffects[][] = Array.from({ length: BUS_SLOT_MAX_EFFECTS + 1 }, (_, n) => this.slotEffects.slice(0, n));
  private readonly duckRec: BusDuck = { voiceId: 0, frameOffset: ASAP, rules: [] };
  private readonly presenceRec: BusPresence = { voiceId: 0, frameOffset: ASAP, mask: 0 };
  private readonly loudRec: LoudConfig = { voiceId: 0, frameOffset: ASAP, tpGateDbfs: 0, meters: [] };
  /** `LOUD_CONFIG`'s meter scratch: `MAX_LOUDNESS_BUSES` records, reused by every record. */
  private readonly loudMeters: LoudConfigMeters[] = Array.from({ length: MAX_LOUDNESS_BUSES }, () => ({ slot: 0, reserved: 0 }));
  private readonly loudMeterViews: LoudConfigMeters[][] = Array.from({ length: MAX_LOUDNESS_BUSES + 1 }, (_, n) => this.loudMeters.slice(0, n));
  private readonly masterRec: Master = { voiceId: 0, frameOffset: ASAP, volume: 1, muted: 0, rampFrames: 0 };
  private readonly resetRec: Reset = { voiceId: 0, frameOffset: ASAP, keepClips: 0 } as Reset;
  private readonly loopRec: SetLoop = { voiceId: 0, frameOffset: ASAP, loopStartFrame: 0, loopEndFrame: 0, flags: 0 };
  private readonly paramRec: Param = { voiceId: 0, frameOffset: ASAP, group: 0, slot: 0, value: 0, seekPerSecond: 0 };
  private readonly automateRec: Automate = { voiceId: 0, frameOffset: ASAP, bindings: [] };
  private readonly busAutomateRec: BusAutomate = { voiceId: 0, frameOffset: ASAP, bindings: [] };
  private readonly voiceFxRec: SetVoiceFx = { voiceId: 0, frameOffset: ASAP, mask: 0, rampFrames: 0, hpHz: 0, send: [0, 0, 0, 0], yaw: 0, auxLevel: 0, auxBus: 0xffff, reserved: 0 };
  private readonly bedConfigRec: BedConfig = { voiceId: 0, frameOffset: ASAP, bedSlot: [], hostBus: [] };
  private readonly zoneConfigRec: ZoneConfig = { voiceId: 0, frameOffset: ASAP, sharedReturnGain: 1, rampFrames: 0, slots: [] };
  private readonly listenerRec: Listener = { voiceId: 0, frameOffset: ASAP, qx: 0, qy: 0, qz: 0, qw: 1, rampFrames: 0, flags: 0 };

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
    // A gated PLAY joins its group's run so `flush` never splits the group across two BATCHes (P1).
    const gate = args.gate ?? 0;
    this.curGroup = gateGroupId(gate);
    this.playWith(args, gate, atFrame);
    this.curGroup = 0;
  }

  /** Writes a PLAY with the given `gate` word (the scratch record; `args.gate` is not read here). */
  private playWith(args: PlayArgs, gate: number, atFrame?: number): void {
    const r = this.playRec;
    r.voiceId = args.voiceId;
    r.clip = args.clip;
    r.bus = args.bus;
    r.flags = args.fadeZero ? args.flags | PLAY_FLAGS_FADE_ZERO : args.flags;
    r.group = args.group;
    r.gate = gate;
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
    r.shape = 0;
    const at = this.begin(24);
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
    r.shape = 0;
    const at = this.begin(28);
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
    r.shape = 0;
    const at = this.begin(28);
    if (at < 0) return;
    this.end(at, writeFade(this.view, at, r));
  }

  /** SET_PARAMS with only the `score` bit (A3.3): the core's ranking for its own lowest-score demote. Asap. */
  setScore(id: number, score: number): void {
    const r = this.paramsRec;
    r.voiceId = id;
    r.mask = SET_PARAMS_MASK_SCORE;
    r.score = score;
    r.shape = 0;
    const at = this.begin(60);
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
    r.shape = 0;
    const at = this.begin(60);
    if (at < 0) return;
    this.end(at, writeSetParams(this.view, at, r));
    r.flags = 0;
  }

  /**
   * SET_PARAMS (§4.2); `mask` is `SET_PARAMS_MASK_*`, other fields only matter where the mask says. `bus` only with the bus bit.
   * `shape` (ADR 0166 §4.2) is the ramp's `packShape` word, read with the mask's gain ramp; stamped at `atFrame` when given.
   */
  setParams(id: number, mask: number, gain: number, pitch: number, dirX: number, dirY: number, dirZ: number, lpHz: number, rampFrames: number, bus = 0, shape = 0, atFrame?: number): void {
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
    r.shape = shape;
    const at = this.begin(60);
    if (at < 0) return;
    this.end(at, writeSetParams(this.view, at, r), atFrame);
  }

  /**
   * ADR 0166 §4.1 (L-Z4b): PLAY as one member of gate group `groupId` (1..1023) of `groupSize` members (1..64, clamped by
   * `packGate`): `args.gate` becomes `packGate(groupId, groupSize)`. Stamped at `atFrame` like `play`. Every member of a
   * group must be written with the same `atFrame` and the same `groupSize`; `flush` keeps the records of one `groupId`
   * together in one BATCH (a group never straddles two).
   */
  playGated(args: PlayArgs, groupId: number, groupSize: number, atFrame?: number): void {
    const gate = packGate(groupId, groupSize);
    this.curGroup = gateGroupId(gate);
    this.playWith(args, gate, atFrame);
    this.curGroup = 0;
  }

  /**
   * ADR 0166 §4.2 (L-Z4b): FADE `id`'s `fade` ramp to `to` over `seconds` with `law` (`FadeLaw`) starting at phase
   * `startPhase` (0..1, packed u0.16 by `packShape`), stamped at `atFrame` (absolute audio frame) or asap when omitted;
   * `stopAtEnd` sets `FADE_FLAGS_STOP_AT_END`. A 28-byte FADE.
   */
  fadeShaped(id: number, to: number, seconds: number, law: number, startPhase: number, atFrame?: number, stopAtEnd = false): void {
    const r = this.fadeRec;
    r.voiceId = id;
    r.target = to;
    r.frames = this.frames(seconds);
    r.flags = stopAtEnd ? FADE_FLAGS_STOP_AT_END : 0;
    r.shape = packShape(law, phase16(startPhase));
    const at = this.begin(28);
    if (at < 0) return;
    this.end(at, writeFade(this.view, at, r), atFrame);
  }

  /** ADR 0166 §4.2 (L-Z4b): STOP `id` with a `fadeSeconds` fade of `law` from `startPhase`, stamped at `atFrame` or asap. A 24-byte STOP. */
  stopShaped(id: number, fadeSeconds: number, law: number, startPhase: number, atFrame?: number): void {
    const r = this.stopRec;
    r.voiceId = id;
    r.fadeFrames = this.frames(fadeSeconds);
    r.shape = packShape(law, phase16(startPhase));
    const at = this.begin(24);
    if (at < 0) return;
    this.end(at, writeStop(this.view, at, r), atFrame);
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

  /**
   * ADR 0171 §4.2 BUS_RAMP: ramp `lane` (`LANE_*`) of bus slot `bus` (`BUS_MASTER_OUT`: the output gain) to `gain` (when
   * `mask` has `BUS_RAMP_MASK_GAIN`) and/or `lpHz` (`BUS_RAMP_MASK_LP_HZ`, lane 2 only) over `seconds`, linear, stamped at
   * `atFrame` (absolute) or asap when omitted. `seconds` 0 is a literal step (replay and RESET only, R2). `sequenceId`
   * (13 bits, 0 none) tags a dip's records (C27). A 32-byte record; allocates nothing.
   */
  busRamp(bus: number, lane: number, mask: number, gain: number, lpHz: number, seconds: number, sequenceId = 0, atFrame?: number): void {
    this.busRampFrames(bus, lane, mask, gain, lpHz, this.frames(seconds), sequenceId, atFrame);
  }

  /** `busRamp` with the length already in frames (the lane writer's `ClockMap.rampFrames()`; replay's 0). */
  busRampFrames(bus: number, lane: number, mask: number, gain: number, lpHz: number, frames: number, sequenceId = 0, atFrame?: number): void {
    const r = this.rampRec;
    r.voiceId = bus;
    r.lane = lane;
    r.mask = mask;
    r.gain = gain;
    r.lpHz = lpHz;
    r.frames = frames;
    r.shape = packRampShape(FadeLaw.Linear, sequenceId, 0);
    const at = this.begin(32);
    if (at < 0) return;
    this.end(at, writeBusRamp(this.view, at, r), atFrame);
  }

  /**
   * ADR 0171 §4.2 BUS_SLOT: one slot's configuration (R7), stamped at `atFrame` or asap. A tombstone is a silent root
   * (R9). The record's size is 28 B + 32 B per effect (at most `BUS_SLOT_MAX_EFFECTS`; more are not written).
   */
  busSlot(args: BusSlotArgs, atFrame?: number): void {
    const r = this.slotRec;
    const n = args.effects.length < BUS_SLOT_MAX_EFFECTS ? args.effects.length : BUS_SLOT_MAX_EFFECTS;
    for (let i = 0; i < n; i++) {
      const src = args.effects[i]!;
      const dst = this.slotEffects[i]!;
      dst.type = src.type;
      for (let k = 0; k < 7; k++) dst.p[k] = src.p[k] ?? 0;
    }
    r.slot = args.slot;
    r.parent = args.parent;
    r.flags = (args.structural ? BUS_SLOT_FLAGS_STRUCTURAL : 0) | (args.fresh ? BUS_SLOT_FLAGS_FRESH : 0);
    r.sequenceId = (args.sequenceId ?? 0) & 0x1fff;
    r.effects = this.slotEffectViews[n]!;
    const at = this.begin(28 + 32 * n);
    if (at >= 0) this.end(at, writeBusSlot(this.view, at, r), atFrame);
    r.effects = NO_SLOT_EFFECTS;
  }

  /**
   * ADR 0171 §4.2 BUS_DUCK: replaces every ducking rule (at most `MAX_DUCK_RULES`; more throw `WireError(OVERSIZE)`, as
   * the generated writer does). Asap only: it carries no frame. An empty list clears the rules.
   */
  busDuck(rules: readonly BusDuckRules[]): void {
    if (rules.length > MAX_DUCK_RULES) throw new WireError(ErrorCode.OVERSIZE, "BusDuck: rules over its cap " + MAX_DUCK_RULES);
    const r = this.duckRec;
    r.rules = rules as BusDuckRules[];
    const at = this.begin(16 + 24 * rules.length);
    if (at >= 0) this.end(at, writeBusDuck(this.view, at, r));
    r.rules = NO_DUCK_RULES; // drops the caller's list without a new array per record
  }

  /**
   * ADR 0171 §4.2 BUS_PRESENCE: bit b of `mask` is set while bus slot b has a voice (virtual and locked included),
   * stamped at `atFrame` (the voice's start or explicit stop) or asap; the core applies it at the start of the quantum
   * holding the frame.
   */
  busPresence(mask: number, atFrame?: number): void {
    const r = this.presenceRec;
    r.mask = mask >>> 0;
    const at = this.begin(16);
    if (at < 0) return;
    this.end(at, writeBusPresence(this.view, at, r), atFrame);
  }

  /**
   * ADR 0171 §4.2 LOUD_CONFIG: replaces the loudness meters' configuration: the true-peak gate (the selected ceiling
   * minus 6 dB) and the metered bus slots (at most `MAX_LOUDNESS_BUSES`; master is implicit, more throw
   * `WireError(OVERSIZE)`). Asap only. A target change re-sends it and is not a reset.
   */
  loudConfig(tpGateDbfs: number, slots: ArrayLike<number>): void {
    if (slots.length > MAX_LOUDNESS_BUSES) throw new WireError(ErrorCode.OVERSIZE, "LoudConfig: meters over its cap " + MAX_LOUDNESS_BUSES);
    const r = this.loudRec;
    for (let i = 0; i < slots.length; i++) this.loudMeters[i]!.slot = slots[i]!;
    r.tpGateDbfs = tpGateDbfs;
    r.meters = this.loudMeterViews[slots.length]!;
    const at = this.begin(20 + 4 * slots.length);
    if (at >= 0) this.end(at, writeLoudConfig(this.view, at, r));
    r.meters = NO_LOUD_METERS;
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

  /**
   * SET_VOICE_FX (ADR 0162 C3, 52 B) for `args.voiceId` at `atFrame` (absolute, stamped) or asap (omitted): stamped like
   * SET_PARAMS, so send it after the voice's PLAY with the same frame. Copies `args` into the scratch record (`send`
   * element by element, no new array); drops and flags like every record when the staging area is full.
   */
  setVoiceFx(args: VoiceFxArgs, atFrame?: number): void {
    const r = this.voiceFxRec;
    r.voiceId = args.voiceId;
    r.mask = args.mask;
    r.rampFrames = args.rampFrames;
    r.hpHz = args.hpHz;
    for (let i = 0; i < 4; i++) r.send[i] = args.send[i]!;
    r.yaw = args.yaw;
    r.auxLevel = args.auxLevel;
    r.auxBus = args.auxBus;
    const at = this.begin(SET_VOICE_FX_FIXED_END);
    if (at < 0) return;
    this.end(at, writeSetVoiceFx(this.view, at, r), atFrame);
  }

  /**
   * BED_CONFIG (ADR 0162 C2): `bedSlot[b]` per bus, root first (`BED_SLOT_NONE` 0xFF for none), and `hostBus[s]` per
   * slot (`BED_HOST_NONE` 0xFFFF for unused; at most `MAX_BEDS`). Size `20 + pad4(buses) + pad4(2 x slots)`. Asap; send
   * after BUS_CONFIG. More than `MAX_BEDS` slots is dropped and flagged (the record is never written).
   */
  bedConfig(bedSlot: ArrayLike<number>, hostBus: ArrayLike<number>): void {
    if (hostBus.length > MAX_BEDS) {
      this.stats.dropped++;
      this.overflowed = true;
      return;
    }
    const r = this.bedConfigRec;
    const at = this.begin(20 + pad4(bedSlot.length) + pad4(2 * hostBus.length));
    if (at >= 0) {
      r.bedSlot = bedSlot;
      r.hostBus = hostBus;
      this.end(at, writeBedConfig(this.view, at, r));
    }
    r.bedSlot = NO_NUMBERS; // the caller's lists are not kept (as `automate`)
    r.hostBus = NO_NUMBERS;
  }

  /**
   * ZONE_CONFIG (ADR 0162 C5, `24 + 16n` B): the shared reverb's return gain, the ramp, and up to `MAX_ZONE_SLOTS` slots
   * (each `kernelId`, `returnBus`, `state`, `wet`, `irFrames`; `reserved` 0). Asap; idempotent in the core. More than
   * `MAX_ZONE_SLOTS` slots is dropped and flagged.
   */
  zoneConfig(sharedReturnGain: number, rampFrames: number, slots: readonly ZoneSlotArgs[]): void {
    if (slots.length > MAX_ZONE_SLOTS) {
      this.stats.dropped++;
      this.overflowed = true;
      return;
    }
    const r = this.zoneConfigRec;
    const at = this.begin(24 + 16 * slots.length);
    if (at >= 0) {
      r.sharedReturnGain = sharedReturnGain;
      r.rampFrames = rampFrames;
      r.slots = slots as ZoneSlotArgs[];
      this.end(at, writeZoneConfig(this.view, at, r));
    }
    r.slots = NO_ZONE_SLOTS;
  }

  /**
   * LISTENER (ADR 0162 C4, 36 B): the world-to-listener rotation `(qx, qy, qz, qw)`, slerped by the core over
   * `rampFrames`, or jumped to with `snap` (flags bit0, a camera cut). Asap.
   */
  listener(qx: number, qy: number, qz: number, qw: number, rampFrames: number, snap: boolean): void {
    const r = this.listenerRec;
    r.qx = qx;
    r.qy = qy;
    r.qz = qz;
    r.qw = qw;
    r.rampFrames = rampFrames;
    r.flags = snap ? LISTENER_FLAGS_SNAP : 0;
    const at = this.begin(36);
    if (at < 0) return;
    this.end(at, writeListener(this.view, at, r));
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
      // ADR 0166 §3.2: a gate group never straddles two BATCHes. A run of one group id cut by the limit moves whole to
      // the next batch (the records keep their absolute frames); a run that is itself the whole batch and still
      // does not fit (a group is at most 64 x 56 B, so this cannot happen) is dropped like an oversize record.
      if (end < this.count && end > next) {
        const g = this.groupOf[this.order[end]!]!;
        if (g !== 0 && this.groupOf[this.order[end - 1]!] === g) {
          while (end > next && this.groupOf[this.order[end - 1]!] === g) end--;
          if (end === next) {
            let run = next;
            while (run < this.count && this.groupOf[this.order[run]!] === g) run++;
            this.stats.dropped += run - next;
            this.overflowed = true;
            next = run;
            continue;
          }
        }
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
    this.groupOf[i] = this.curGroup;
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
    const groups = new Uint16Array(keep);
    let used = 0;
    for (let k = 0; k < keep; k++) {
      const idx = this.order[from + k]!;
      const o = this.offset[idx]!;
      const len = this.length[idx]!;
      spare.set(this.stage.subarray(o, o + len), used);
      offset[k] = used;
      length[k] = len;
      frame[k] = this.frame[idx]!;
      groups[k] = this.groupOf[idx]!;
      used += len;
    }
    const old = this.stage;
    this.stage = spare;
    this.spare = old;
    this.view = new DataView(this.stage.buffer);
    this.offset.set(offset);
    this.length.set(length);
    this.frame.set(frame);
    this.groupOf.set(groups);
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
