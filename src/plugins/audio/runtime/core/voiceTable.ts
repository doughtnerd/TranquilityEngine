// The main-thread voice table (ADR 0157; api-and-models §3 "Voice table", architecture §1, §2.2, §4.1, §6.4): one
// struct of arrays sized `voices.logical`, allocated once. It holds each voice's intent (clip, parameters, priority,
// owner World, start frame) and the mirror of what the core reports (ended, demoted, playheads). Nothing here
// allocates after construction: slots come from a free list, ids are generational (`ids.ts`), and every queue is a
// preallocated typed array.
//
// Writers (§3): main (play, stop, fade: `allocate`, `requestStop`, `requestFade`, and A1.4's `coreBackend` filling
// the intent arrays), sys (the per-frame audio system: gain, direction, audibility, selection, A3.1), status (the
// mirror in the host's `onmessage`, `mirror.ts`). A1.4's command writer drains the queued commands
// (`drainCommands`) into the frame's BATCH.
import type { AudioHost, BusRemap, HostLifecycleListener, WorldKey } from "./context";
import { MAX_BUSES } from "../../../../engine/audio/settings";


/** @internal §3 `state`. */
export const VoiceState = {
  FREE: 0,
  /** Queued before unlock (§2.2 "Queued"); nothing sent to the core. */
  LOCKED: 1,
  /** On the core and mixed. */
  PLAYING: 2,
  /** On the core, not mixed (keeps time). */
  VIRTUAL: 3,
  /** Its clip isn't resident; nothing sent to the core yet (§3 clip registry). */
  WAITING_FOR_DATA: 4,
  /** `stop()` (or a World release) was asked; the core fades it out and reports it ended. */
  STOPPING: 5,
  /** The core reported it ended (mirror); the next frame frees the slot. */
  ENDING: 6,
} as const;
export type VoiceStateCode = (typeof VoiceState)[keyof typeof VoiceState];

/** @internal §3 `reason`: why a voice isn't audible (`AudioReason`, §1), as a code. */
export const VoiceReason = {
  NONE: 0,
  VIRTUAL: 1,
  STOLEN: 2,
  BUS_MUTED: 3,
  LOCKED: 4,
  FAILED: 5,
  WAITING_FOR_DATA: 6,
} as const;
export type VoiceReasonCode = (typeof VoiceReason)[keyof typeof VoiceReason];

/** @internal §3 `flags` bits. */
export const VoiceFlag = {
  LOOP: 1 << 0,
  SPATIAL: 1 << 1,
  STREAM: 1 << 2,
  ONE_SHOT: 1 << 3,
  WANTS_PLAYHEAD: 1 << 4,
  PAUSED: 1 << 5,
  STOP_ON_FADE_END: 1 << 6,
} as const;

/**
 * @internal ADR 0162 (K4, api-and-models §3.2 `flags2`): the M3 per-voice bits, what the voice asks for (set at play
 * from the request, changed by Play edits). OCCLUSION: walls may muffle it (`occlusion` not false; only a positioned,
 * non-ambisonic voice is cast). AMBISONIC: an ambisonic clip (spatial fields, occlusion and Doppler ignored). SENDS:
 * `reverbSend` > 0 (only positioned and ambisonic voices send). AUX: an event aux send.
 */
export const VoiceFlag2 = {
  OCCLUSION: 1 << 0,
  AMBISONIC: 1 << 1,
  SENDS: 1 << 2,
  AUX: 1 << 3,
} as const;

/**
 * @internal ADR 0166 (api-and-models §3.2, Z4): the kinds of stamped, shaped ramp the table logs per voice so a REPLAY
 * can restore them. FADE: a FADE on the `fade` ramp (`flags` bit 0 = stop at the end); STOP: a shaped STOP; GAIN: a
 * SET_PARAMS gain ramp (stem automation).
 */
export const StampedKind = { FADE: 1, STOP: 2, GAIN: 3 } as const;
export type StampedKindCode = (typeof StampedKind)[keyof typeof StampedKind];
/** @internal `stampedFlags` bit 0: the ramp stops the voice when it ends. */
export const STAMPED_FLAG_STOP_AT_END = 1;
/** @internal Most stamped ramps the table keeps per voice (a fifth drops the oldest). */
export const MAX_STAMPED = 4;
/** @internal Most stem-level changes the table keeps waiting for their stamps per voice (a fifth applies the earliest). */
export const MAX_STEM_PENDING = 4;

/** @internal §3 `rolloff`. */
export const VoiceRolloff = { LINEAR: 0, INVERSE: 1, EXPONENTIAL: 2 } as const;

/** @internal Architecture §3.9: a released World's voices stop with 10 ms fades. */
export const WORLD_RELEASE_FADE_SECONDS = 0.01;

/**
 * @internal What `AudioHandle` (`handle.ts`) needs from the table. The handle owns §1's semantics (what `playing` and
 * `reason` mean, clamping, warn-once, idempotent `stop`); the table owns the slots and the command queue.
 */
export interface VoiceTableHandleApi {
  /** §3 `gen` per slot (1..65535). A handle's id is current while `gen[voiceIndex(id)] === voiceGen(id)` and `state` isn't FREE. */
  readonly gen: Uint16Array;
  /** §3 `state` per slot (`VoiceState`). */
  readonly state: Uint8Array;
  /** §3 `reason` per slot (`VoiceReason`). */
  readonly reason: Uint8Array;
  /**
   * The `VoiceReason` a voice whose slot was freed ended with: its stored reason when the slot was freed exactly once
   * since `id` was current (`gen[index] === nextVoiceGen(voiceGen(id))`), else `VoiceReason.NONE` (still current,
   * never valid, or the slot was freed again since). The handle caches what it first reads.
   */
  endedReason(id: number): VoiceReasonCode;
  /**
   * §1 `stop`: the caller has checked that `id` is current and not STOPPING or ENDING, and clamped `fadeSeconds` to
   * a finite value >= 0. A voice never sent to the core (LOCKED, WAITING_FOR_DATA) is freed at once with reason NONE;
   * any other becomes STOPPING (so `playing` reads false at once) and a STOP with that fade is queued.
   */
  requestStop(id: number, fadeSeconds: number): void;
  /**
   * §1 `fade`: the caller has checked that `id` is current and not STOPPING or ENDING, and clamped `to` to 0..4 and
   * `seconds` to a finite value >= 0. Sets `fadeGain` to `to` at once (the mirror) and queues a FADE; a later fade
   * in the same frame replaces an earlier one.
   */
  requestFade(id: number, to: number, seconds: number): void;
}

/** @internal Where `drainCommands` sends the frame's queued commands (A1.4's command writer; one long-lived object). */
export interface VoiceCommandSink {
  /** STOP `id` with a `fadeSeconds` fade (0 = at once). */
  stop(id: number, fadeSeconds: number): void;
  /** FADE `id`'s gain multiplier to `to` over `seconds`. */
  fade(id: number, to: number, seconds: number): void;
}

/**
 * @internal The struct-of-arrays voice table (api §3). Capacity is `voices.logical` (8..8192), fixed at
 * construction. Index `i` of every array is slot `i`; a slot's id is `encodeVoiceId(i, gen[i])`.
 */
export class VoiceTable implements VoiceTableHandleApi {
  readonly capacity: number;

  // --- §3 fields, one entry per slot ---
  readonly gen: Uint16Array;
  readonly state: Uint8Array;
  readonly panner: Uint8Array;
  readonly flags: Uint8Array;
  readonly reason: Uint8Array;
  readonly bus: Uint8Array;
  readonly world: Uint8Array;
  readonly group: Uint16Array;
  readonly clip: Uint32Array;
  readonly priority: Uint8Array;
  readonly volume: Float32Array;
  readonly pitch: Float32Array;
  readonly fadeGain: Float32Array;
  readonly minDist: Float32Array;
  readonly maxDist: Float32Array;
  readonly rolloff: Uint8Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly gain: Float32Array;
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  readonly dirZ: Float32Array;
  readonly lpHz: Float32Array;
  readonly audibility: Float32Array;
  /**
   * ADR 0158 §3 (E3.1): the voice's automation gain and pitch multipliers at its parameters' targets, as main evaluates
   * them when a parameter changes (`coreAutomation.ts`); 1 for a voice without bindings. The core applies the smoothed
   * values itself; main uses these for audibility (`gain`) and the playhead estimate (`pitch`) only.
   */
  readonly autoGain: Float32Array;
  readonly autoPitch: Float32Array;

  // --- ADR 0162 (K4; api-and-models §3.2, C20): the M3 columns. Writers in brackets. ---
  /** Selection's audibility before occlusion [sys, selection]; `audibility` is this × `occGain` (C20). */
  readonly audibility0: Float32Array;
  /** The smoothed dry occlusion gain, 1 open [sys, D2a through `CoreBackend._setOcclusion`]. Default 1. */
  readonly occGain: Float32Array;
  /** The clamped Doppler factor folded into the pitch sent to the core, 1 none [sys, D3 through `_setDopplerRate`]. Default 1. */
  readonly dopplerFactor: Float32Array;
  /** `VoiceFlag2` bits [main, at play: the request's occlusion, ambisonic, sends and aux]. */
  readonly flags2: Uint8Array;
  /** §1.2 `dopplerLevel`, 0..5 [main]. Default 0 (the caller applies the source or one-shot default). */
  readonly dopplerLevel: Float32Array;
  /** §1.2 `reverbSend`, 0..2 [main]. Default 1. */
  readonly reverbSend: Float32Array;
  /** §1.2 `reverbSendCurve`, interned (`SendCurveTable`, 0 = `DEFAULT_SEND_CURVE`) [main]. */
  readonly sendCurve: Uint16Array;
  /** §1.2 `ambisonicYaw` / §1.3 `yaw`, radians [main]. */
  readonly yaw: Float32Array;
  /**
   * ADR 0166 (§3.2, Z4) [main, music]: the music group (1..1023) the voice is a member of, 0 for an ordinary voice. A
   * member of a group is not replayed as a voice: its group is primed and stamped again (architecture §3.7).
   */
  readonly musicGroup: Uint16Array;
  /**
   * ADR 0166 (§3.2, Z4) [main]: the stamped ramps of the voice that have not finished, for REPLAY: up to `MAX_STAMPED`
   * per slot at index `slot * MAX_STAMPED + k`, `k < stampedCount[slot]`, ascending by `stampedFrame`. An entry stays
   * until `stampedEnd` (the frame its ramp finishes) has passed, so a fade under way is still there to replay with its
   * current phase. `from` is the ramp's value when it began, `to` its target, `seconds` its length, `shape` the wire's
   * shape word. While the carried context swap is under way (`stampedToTimeline`), frames hold `Audio.time` seconds.
   */
  readonly stampedCount: Uint8Array;
  readonly stampedFrame: Float64Array;
  readonly stampedEnd: Float64Array;
  readonly stampedKind: Uint8Array;
  readonly stampedFlags: Uint8Array;
  readonly stampedFrom: Float32Array;
  readonly stampedTo: Float32Array;
  readonly stampedSeconds: Float32Array;
  readonly stampedShape: Uint32Array;
  /** Stamped entries across all slots (0 = nothing to replay or convert). */
  stampedTotal = 0;
  /**
   * F-9b [main, `musicOps.paramsShaped`]: a music stem's level, the multiplier its stamped in-voice gain ramp puts on the
   * dry gain (quantised automation × solo, `music/stems.ts`); 1 for every other voice. Two views of one level:
   * - `stemDry` is what the core's gain ramp holds when an asap record sent this frame lands (`resolveStems`' frame):
   *   every dry-gain write (SET_MIXED's promote, `_setVolume`, occlusion, a spatial move) multiplies it in, so it
   *   doesn't wipe the level. A change stamped later is still pending; the core's held SET_PARAMS applies it then.
   * - `stemGain` is audibility's factor (selection, stealing, `Audio.debug()`), R3a's rule (like `fadeGain` in
   *   `fadeShaped`): a rise counts at once, a fall only once its stamp has come, so the voice isn't cut before it is
   *   heard falling. It is `max(stemDry, every pending level)`.
   * The pending changes: up to `MAX_STEM_PENDING` per slot at `slot * MAX_STEM_PENDING + k`, `k < stemCount[slot]`,
   * ascending by `stemAt` (the core frame each lands at; equal frames in arrival order, so the latest wins), with the
   * ramp's length in frames (`stemRamp`) and its `packShape` word (`stemShape`) so a dry-gain write can re-send them.
   */
  readonly stemGain: Float32Array;
  readonly stemDry: Float32Array;
  readonly stemCount: Uint8Array;
  readonly stemAt: Float64Array;
  readonly stemNext: Float32Array;
  readonly stemRamp: Uint32Array;
  readonly stemShape: Uint32Array;
  /** Pending stem-level changes across all slots (0: `resolveStems` has nothing to do). */
  stemPendingTotal = 0;
  /** True between `stampedToTimeline` and `stampedFromTimeline`. */
  private stampedInSeconds = false;
  readonly startFrame: Float64Array;
  readonly playhead: Uint32Array;
  readonly epoch: Uint32Array;
  readonly owner: Int32Array;

  // --- Bookkeeping (no §3 row; all preallocated) ---
  /** §3 free list: slot indices, `freeTop` of them valid. */
  readonly freeStack: Uint16Array;
  freeTop = 0;
  /** Live voices per bus index (every non-FREE state), for `maxVoices` stealing and the mixer's counts. */
  readonly busLive: Uint16Array;
  /** `maxVoices` per bus index, 0 = unlimited (`setBusLimits`). */
  readonly busMax: Uint16Array;
  /** Live (non-FREE) voices. */
  liveCount = 0;
  /** Steals since construction (A3.5's counters may read it). */
  stolenCount = 0;
  /** Plays refused because every candidate had priority at or above the new sound's. */
  refusedCount = 0;
  /** The selection frame (A3.1's `Selection.run` sets it), which stamps the recent steals below. */
  frame = 0;

  // --- Recent steals (A3.1), for `Audio.debug()`'s "stolen" entries: a ring of the last `STOLEN_RING` ---
  /** Ids, clip ids, buses, Worlds, priorities and the `frame` of each recent steal, `stolenSize` valid, newest at `stolenHead - 1`. */
  readonly stolenIds = new Uint32Array(STOLEN_RING);
  readonly stolenClip = new Uint32Array(STOLEN_RING);
  readonly stolenBus = new Uint8Array(STOLEN_RING);
  readonly stolenWorld = new Uint8Array(STOLEN_RING);
  readonly stolenPriority = new Uint8Array(STOLEN_RING);
  readonly stolenFrame = new Float64Array(STOLEN_RING);
  stolenHead = 0;
  stolenSize = 0;

  /**
   * Called on every free, whatever the cause (natural end, immediate stop, steal, failure, World release), with the
   * freed id and its bus, before the generation bumps. A1.4's `coreBackend` sets it once to call
   * `mixer.voiceEnded(bus)` (§3 "Mixer counting"). Must not allocate per call.
   */
  onFree: ((id: number, bus: number) => void) | null = null;

  /** The reason each slot's previous voice was freed with (see `endedReason`). */
  private readonly freedReason: Uint8Array;
  /** Slots that went ENDING since the last `freeEnded` (`endedTop` valid); `endedListed[i]` is 1 while slot `i` is listed. */
  private readonly endedList: Uint16Array;
  private readonly endedListed: Uint8Array;
  private endedTop = 0;
  /** Queued commands per slot (`DIRTY_STOP`, `DIRTY_FADE`); `DIRTY_LISTED` while the slot is in `dirtyList`, so it is listed once. */
  private readonly dirty: Uint8Array;
  private readonly dirtyList: Uint16Array;
  private dirtyTop = 0;
  private readonly stopSeconds: Float32Array;
  private readonly fadeTo: Float32Array;
  private readonly fadeSeconds: Float32Array;

  /** Allocates every array once (`capacity` = `voices.logical`, 1..65536) and fills the free list so slot 0 goes first. */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_VOICE_INDEX + 1) throw new RangeError(`audio core: voice table capacity ${capacity} is outside 1..65536`);
    this.capacity = capacity;
    this.gen = new Uint16Array(capacity);
    this.state = new Uint8Array(capacity);
    this.panner = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.reason = new Uint8Array(capacity);
    this.bus = new Uint8Array(capacity);
    this.world = new Uint8Array(capacity);
    this.group = new Uint16Array(capacity);
    this.clip = new Uint32Array(capacity);
    this.priority = new Uint8Array(capacity);
    this.volume = new Float32Array(capacity);
    this.pitch = new Float32Array(capacity);
    this.fadeGain = new Float32Array(capacity);
    this.minDist = new Float32Array(capacity);
    this.maxDist = new Float32Array(capacity);
    this.rolloff = new Uint8Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.gain = new Float32Array(capacity);
    this.dirX = new Float32Array(capacity);
    this.dirY = new Float32Array(capacity);
    this.dirZ = new Float32Array(capacity);
    this.lpHz = new Float32Array(capacity);
    this.audibility = new Float32Array(capacity);
    this.autoGain = new Float32Array(capacity).fill(1);
    this.autoPitch = new Float32Array(capacity).fill(1);
    this.audibility0 = new Float32Array(capacity);
    this.occGain = new Float32Array(capacity).fill(1);
    this.dopplerFactor = new Float32Array(capacity).fill(1);
    this.flags2 = new Uint8Array(capacity);
    this.dopplerLevel = new Float32Array(capacity);
    this.reverbSend = new Float32Array(capacity).fill(1);
    this.sendCurve = new Uint16Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.musicGroup = new Uint16Array(capacity);
    this.stampedCount = new Uint8Array(capacity);
    this.stampedFrame = new Float64Array(capacity * MAX_STAMPED);
    this.stampedEnd = new Float64Array(capacity * MAX_STAMPED);
    this.stampedKind = new Uint8Array(capacity * MAX_STAMPED);
    this.stampedFlags = new Uint8Array(capacity * MAX_STAMPED);
    this.stampedFrom = new Float32Array(capacity * MAX_STAMPED);
    this.stampedTo = new Float32Array(capacity * MAX_STAMPED);
    this.stampedSeconds = new Float32Array(capacity * MAX_STAMPED);
    this.stampedShape = new Uint32Array(capacity * MAX_STAMPED);
    this.stemGain = new Float32Array(capacity).fill(1);
    this.stemDry = new Float32Array(capacity).fill(1);
    this.stemCount = new Uint8Array(capacity);
    this.stemAt = new Float64Array(capacity * MAX_STEM_PENDING);
    this.stemNext = new Float32Array(capacity * MAX_STEM_PENDING);
    this.stemRamp = new Uint32Array(capacity * MAX_STEM_PENDING);
    this.stemShape = new Uint32Array(capacity * MAX_STEM_PENDING);
    this.startFrame = new Float64Array(capacity);
    this.playhead = new Uint32Array(capacity);
    this.epoch = new Uint32Array(capacity);
    this.owner = new Int32Array(capacity);
    this.freeStack = new Uint16Array(capacity);
    this.busLive = new Uint16Array(MAX_BUSES);
    this.busMax = new Uint16Array(MAX_BUSES);
    this.freedReason = new Uint8Array(capacity);
    this.endedList = new Uint16Array(capacity);
    this.endedListed = new Uint8Array(capacity);
    this.dirty = new Uint8Array(capacity);
    this.dirtyList = new Uint16Array(capacity);
    this.stopSeconds = new Float32Array(capacity);
    this.fadeTo = new Float32Array(capacity);
    this.fadeSeconds = new Float32Array(capacity);
    this.reset();
  }

  /** Every slot FREE at generation 1, the free list full (slot 0 on top), counts, limits and queues empty. */
  reset(): void {
    const n = this.capacity;
    this.gen.fill(MIN_GEN);
    this.state.fill(VoiceState.FREE);
    this.reason.fill(VoiceReason.NONE);
    this.freedReason.fill(VoiceReason.NONE);
    this.endedListed.fill(0);
    this.dirty.fill(0);
    for (let i = 0; i < n; i++) this.freeStack[i] = n - 1 - i;
    this.freeTop = n;
    this.busLive.fill(0);
    this.busMax.fill(0);
    this.liveCount = 0;
    this.stolenCount = 0;
    this.refusedCount = 0;
    this.stolenHead = 0;
    this.stolenSize = 0;
    this.endedTop = 0;
    this.dirtyTop = 0;
    this.musicGroup.fill(0);
    this.stampedCount.fill(0);
    this.stampedTotal = 0;
    this.stampedInSeconds = false;
    this.stemCount.fill(0);
    this.stemPendingTotal = 0;
    this.stemGain.fill(1);
    this.stemDry.fill(1);
  }

  // --- ADR 0166 (Z4): the log of stamped ramps, for REPLAY ---

  /**
   * Logs a stamped ramp of live voice `id` that begins at `frame` (an absolute audio frame; a past or non-finite one
   * is as soon as possible, so pass the frame it will really apply at) and lasts `seconds` at `rate` Hz. First drops
   * the voice's entries that finished by `nowFrame`; a fifth live entry drops the oldest. Entries stay ascending by
   * frame. Returns false (logging nothing) for a stale id, or while a context swap carries the log in seconds.
   * Allocates nothing.
   */
  logStamped(id: number, kind: StampedKindCode, frame: number, rate: number, nowFrame: number, from: number, to: number, seconds: number, shape: number, flags: number): boolean {
    const i = this.slotOf(id);
    if (i < 0 || this.stampedInSeconds) return false;
    this.pruneStamped(i, nowFrame);
    if (this.stampedCount[i]! === MAX_STAMPED) this.removeStamped(i, 0);
    const base = i * MAX_STAMPED;
    let k = this.stampedCount[i]!;
    // Insertion: shift later-frame entries up one.
    while (k > 0 && this.stampedFrame[base + k - 1]! > frame) {
      this.copyStamped(base + k - 1, base + k);
      k--;
    }
    const e = base + k;
    this.stampedFrame[e] = frame;
    this.stampedEnd[e] = frame + (seconds > 0 ? seconds * rate : 0);
    this.stampedKind[e] = kind;
    this.stampedFlags[e] = flags;
    this.stampedFrom[e] = from;
    this.stampedTo[e] = to;
    this.stampedSeconds[e] = seconds;
    this.stampedShape[e] = shape >>> 0;
    this.stampedCount[i]!++;
    this.stampedTotal++;
    return true;
  }

  /** Drops slot `i`'s entries whose ramp finished at or before `nowFrame`. */
  pruneStamped(i: number, nowFrame: number): void {
    const base = i * MAX_STAMPED;
    for (let k = this.stampedCount[i]! - 1; k >= 0; k--) {
      if (this.stampedEnd[base + k]! <= nowFrame) this.removeStamped(i, k);
    }
  }

  // --- F-9b: a music stem's level (`stemGain`, `stemDry`) ---

  /**
   * Slot `i`'s stem level becomes `level` at core frame `at` (`undefined`: with this frame's asap records), ramping over
   * `rampFrames` with `shape`. `nowFrame` is where asap records land (`ClockMap.framesNow()`, `resolveStems`' frame):
   * changes due by then apply first, and a stamp not after it is asap. Allocates nothing.
   */
  setStemLevel(i: number, level: number, at: number | undefined, nowFrame: number, rampFrames = 0, shape = 0): void {
    this.resolveStem(i, nowFrame);
    if (this.stampedInSeconds) at = undefined; // no frames to stamp against during a context swap
    if (at === undefined || !(at > nowFrame)) {
      // Asap: it lands now; later pending changes still land after it.
      this.stemDry[i] = level;
      this.stemAudible(i);
      return;
    }
    const base = i * MAX_STEM_PENDING;
    if (this.stemCount[i]! === MAX_STEM_PENDING) this.popStem(i);
    let k = this.stemCount[i]!;
    while (k > 0 && this.stemAt[base + k - 1]! > at) {
      this.copyStem(base + k - 1, base + k);
      k--;
    }
    this.stemAt[base + k] = at;
    this.stemNext[base + k] = level;
    this.stemRamp[base + k] = rampFrames >>> 0;
    this.stemShape[base + k] = shape >>> 0;
    this.stemCount[i]!++;
    this.stemPendingTotal++;
    this.stemAudible(i);
  }

  /** Slot `i`'s pending stem changes due by `nowFrame` land: `stemDry` and `stemGain` follow. */
  resolveStem(i: number, nowFrame: number): void {
    const base = i * MAX_STEM_PENDING;
    // During a context swap the pending frames are seconds (`stampedToTimeline`): nothing lands until they are frames again.
    if (this.stemCount[i]! === 0 || this.stampedInSeconds || this.stemAt[base]! > nowFrame) return;
    while (this.stemCount[i]! > 0 && this.stemAt[base]! <= nowFrame) this.popStem(i);
    this.stemAudible(i);
  }

  /** Every live slot's due stem changes (once a frame, before selection); nothing to do without pending changes. */
  resolveStems(nowFrame: number): void {
    if (this.stemPendingTotal === 0) return;
    for (let i = 0; i < this.capacity; i++) if (this.stemCount[i]! > 0) this.resolveStem(i, nowFrame);
  }

  /** The earliest pending change lands: it is the level the core holds. */
  private popStem(i: number): void {
    const base = i * MAX_STEM_PENDING;
    const n = this.stemCount[i]!;
    this.stemDry[i] = this.stemNext[base]!;
    for (let k = 1; k < n; k++) this.copyStem(base + k, base + k - 1);
    this.stemCount[i] = n - 1;
    this.stemPendingTotal--;
  }

  private copyStem(from: number, to: number): void {
    this.stemAt[to] = this.stemAt[from]!;
    this.stemNext[to] = this.stemNext[from]!;
    this.stemRamp[to] = this.stemRamp[from]!;
    this.stemShape[to] = this.stemShape[from]!;
  }

  /** R3a: audibility's factor is the highest of the level now and the levels still to come. */
  private stemAudible(i: number): void {
    const base = i * MAX_STEM_PENDING;
    let g = this.stemDry[i]!;
    for (let k = 0; k < this.stemCount[i]!; k++) g = Math.max(g, this.stemNext[base + k]!);
    this.stemGain[i] = g;
  }

  private clearStem(i: number): void {
    this.stemPendingTotal -= this.stemCount[i]!;
    this.stemCount[i] = 0;
    this.stemGain[i] = 1;
    this.stemDry[i] = 1;
  }

  /** Forgets slot `i`'s log. */
  clearStamped(i: number): void {
    this.stampedTotal -= this.stampedCount[i]!;
    this.stampedCount[i] = 0;
  }

  private removeStamped(i: number, k: number): void {
    const base = i * MAX_STAMPED;
    const n = this.stampedCount[i]!;
    for (let j = k; j < n - 1; j++) this.copyStamped(base + j + 1, base + j);
    this.stampedCount[i] = n - 1;
    this.stampedTotal--;
  }

  private copyStamped(from: number, to: number): void {
    this.stampedFrame[to] = this.stampedFrame[from]!;
    this.stampedEnd[to] = this.stampedEnd[from]!;
    this.stampedKind[to] = this.stampedKind[from]!;
    this.stampedFlags[to] = this.stampedFlags[from]!;
    this.stampedFrom[to] = this.stampedFrom[from]!;
    this.stampedTo[to] = this.stampedTo[from]!;
    this.stampedSeconds[to] = this.stampedSeconds[from]!;
    this.stampedShape[to] = this.stampedShape[from]!;
  }

  /**
   * A context swap (architecture §3.7, A3.4c): every entry's frames go from the old context (`rate`, its clock's
   * `timeOffset`) to `Audio.time` seconds, like the playhead anchors, so they survive the new context's frames
   * starting at 0. A second call before `stampedFromTimeline` does nothing.
   */
  stampedToTimeline(rate: number, offset: number): void {
    if (this.stampedInSeconds) return;
    this.stampedInSeconds = true;
    this.convertStems((f) => f / rate + offset);
    if (this.stampedTotal === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const base = i * MAX_STAMPED;
      for (let k = 0; k < this.stampedCount[i]!; k++) {
        this.stampedFrame[base + k] = this.stampedFrame[base + k]! / rate + offset;
        this.stampedEnd[base + k] = this.stampedEnd[base + k]! / rate + offset;
      }
    }
  }

  /** The new context's clock is known: entries go to its frames (`rate`, its `timeOffset`). */
  stampedFromTimeline(rate: number, offset: number): void {
    if (!this.stampedInSeconds) return;
    this.stampedInSeconds = false;
    this.convertStems((f) => (f - offset) * rate);
    if (this.stampedTotal === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const base = i * MAX_STAMPED;
      for (let k = 0; k < this.stampedCount[i]!; k++) {
        this.stampedFrame[base + k] = (this.stampedFrame[base + k]! - offset) * rate;
        this.stampedEnd[base + k] = (this.stampedEnd[base + k]! - offset) * rate;
      }
    }
  }

  /** F-9b: the pending stem changes' frames through `map` (a context swap, like the stamped log). */
  private convertStems(map: (frame: number) => number): void {
    if (this.stemPendingTotal === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const base = i * MAX_STEM_PENDING;
      for (let k = 0; k < this.stemCount[i]!; k++) this.stemAt[base + k] = map(this.stemAt[base + k]!);
    }
  }

  // --- Slots ---

  /**
   * §3 allocation and stealing: takes a free slot for a new voice on `bus` with `priority` (0..255), owned by World
   * `world` (0 = none), starting in `state` (LOCKED, WAITING_FOR_DATA, PLAYING or VIRTUAL). Returns its id, or 0 when
   * refused. Bus limits apply before the global one: if `bus` is at its `maxVoices`, the candidates are that bus's
   * voices, else, if the table is full, every voice. A STOPPING or ENDING candidate goes first; otherwise the victim
   * is the lowest priority, then the lowest `audibility`, unless every candidate's priority is at or above
   * `priority` (then the play is refused and `refusedCount` grows). A victim is freed with reason STOLEN and the new
   * voice takes its slot (a PLAY with the new id replaces it on the core). Every other field is reset to its default:
   * volume, pitch and fadeGain 1, minDist 1, maxDist 100, owner -1, `reason` matching the state (LOCKED, VIRTUAL,
   * WAITING_FOR_DATA, or NONE for PLAYING), the rest 0. A bus index outside 0..31 is taken as the root (0).
   */
  allocate(bus: number, priority: number, world: WorldKey, state: VoiceStateCode): number {
    const b = bus >= 0 && bus < MAX_BUSES ? bus | 0 : 0;
    const p = priority <= 0 ? 0 : priority >= 255 ? 255 : priority | 0;
    const busFull = this.busMax[b]! > 0 && this.busLive[b]! >= this.busMax[b]!;
    if (busFull || this.freeTop === 0) {
      const victim = this.pickVictim(busFull ? b : -1, p);
      if (victim < 0) {
        this.refusedCount++;
        return INVALID_VOICE_ID;
      }
      this.stolenCount++;
      this.freeSlot(victim, VoiceReason.STOLEN); // pushed last, so the pop below takes it
    }
    const i = this.freeStack[--this.freeTop]!;
    this.state[i] = state;
    this.reason[i] =
      state === VoiceState.LOCKED ? VoiceReason.LOCKED : state === VoiceState.VIRTUAL ? VoiceReason.VIRTUAL : state === VoiceState.WAITING_FOR_DATA ? VoiceReason.WAITING_FOR_DATA : VoiceReason.NONE;
    this.panner[i] = 0;
    this.flags[i] = 0;
    this.bus[i] = b;
    this.world[i] = world;
    this.group[i] = 0;
    this.clip[i] = 0;
    this.priority[i] = p;
    this.volume[i] = 1;
    this.pitch[i] = 1;
    this.fadeGain[i] = 1;
    this.minDist[i] = 1;
    this.maxDist[i] = 100;
    this.rolloff[i] = 0;
    this.posX[i] = 0;
    this.posY[i] = 0;
    this.posZ[i] = 0;
    this.gain[i] = 0;
    this.dirX[i] = 0;
    this.dirY[i] = 0;
    this.dirZ[i] = 0;
    this.lpHz[i] = 0;
    this.audibility[i] = 0;
    this.autoGain[i] = 1;
    this.autoPitch[i] = 1;
    this.audibility0[i] = 0;
    this.occGain[i] = 1;
    this.dopplerFactor[i] = 1;
    this.flags2[i] = 0;
    this.dopplerLevel[i] = 0;
    this.reverbSend[i] = 1;
    this.sendCurve[i] = 0;
    this.yaw[i] = 0;
    this.startFrame[i] = 0;
    this.playhead[i] = 0;
    this.epoch[i] = 0;
    this.owner[i] = -1;
    this.musicGroup[i] = 0;
    this.clearStamped(i);
    this.clearStem(i);
    this.busLive[b]!++;
    this.liveCount++;
    return this.idOf(i);
  }

  /** The steal victim among live voices (on `bus`, or all when `bus` is -1) for a play at `priority`, or -1 to refuse. */
  private pickVictim(bus: number, priority: number): number {
    let best = -1;
    let bestPriority = 256;
    let bestAudibility = Number.POSITIVE_INFINITY;
    const state = this.state;
    for (let i = 0; i < this.capacity; i++) {
      const s = state[i]!;
      if (s === VoiceState.FREE || (bus >= 0 && this.bus[i] !== bus)) continue;
      if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return i;
      const p = this.priority[i]!;
      const a = this.audibility[i]!;
      if (p < bestPriority || (p === bestPriority && a < bestAudibility)) {
        best = i;
        bestPriority = p;
        bestAudibility = a;
      }
    }
    return best >= 0 && bestPriority < priority ? best : -1;
  }

  /** Whether `id` names a live voice: valid, its slot's generation matches and the slot isn't FREE. */
  isLive(id: number): boolean {
    return this.slotOf(id) >= 0;
  }

  /**
   * Frees `id`'s slot now with `reason` (FAILED for a refused or failed load, NONE otherwise): calls `onFree`, keeps
   * `reason` for `endedReason`, clears its queued commands, bumps its generation (skipping 0) and pushes it on the
   * free list. A stale or invalid id does nothing. Returns whether it freed.
   */
  free(id: number, reason: VoiceReasonCode): boolean {
    const i = this.slotOf(id);
    if (i < 0) return false;
    this.freeSlot(i, reason);
    return true;
  }

  /** See `VoiceTableHandleApi.endedReason`. */
  endedReason(id: number): VoiceReasonCode {
    if (id >>> 0 !== id || id === 0) return VoiceReason.NONE;
    const i = id & MAX_VOICE_INDEX;
    const g = id >>> 16;
    if (g === 0 || i >= this.capacity) return VoiceReason.NONE;
    const next = g === MAX_GEN ? MIN_GEN : g + 1;
    return this.gen[i] === next ? (this.freedReason[i] as VoiceReasonCode) : VoiceReason.NONE;
  }

  // --- Commands (`AudioHandle`, World release) ---

  /** See `VoiceTableHandleApi.requestStop`. Sets `STOP_ON_FADE_END` on a voice that becomes STOPPING. */
  requestStop(id: number, fadeSeconds: number): void {
    const i = this.slotOf(id);
    if (i < 0) return;
    this.stopSlot(i, fadeSeconds);
  }

  /** See `VoiceTableHandleApi.requestFade`. */
  requestFade(id: number, to: number, seconds: number): void {
    const i = this.slotOf(id);
    if (i < 0) return;
    const s = this.state[i]!;
    if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return;
    this.fadeGain[i] = to;
    this.fadeTo[i] = to;
    this.fadeSeconds[i] = seconds;
    this.queue(i, DIRTY_FADE);
  }

  /**
   * The frame's queued commands, in the order slots were first queued: for each queued slot still live, `sink.stop`
   * and/or `sink.fade` (a stop after its fade). Empties the queue. A1.4's command writer calls it once per frame.
   */
  drainCommands(sink: VoiceCommandSink): void {
    const n = this.dirtyTop;
    this.dirtyTop = 0;
    for (let k = 0; k < n; k++) {
      const i = this.dirtyList[k]!;
      const d = this.dirty[i]!;
      this.dirty[i] = 0;
      if (this.state[i] === VoiceState.FREE) continue;
      const id = this.idOf(i);
      if (d & DIRTY_FADE) sink.fade(id, this.fadeTo[i]!, this.fadeSeconds[i]!);
      if (d & DIRTY_STOP) sink.stop(id, this.stopSeconds[i]!);
    }
  }

  /** How many slots have queued commands. */
  get pendingCommands(): number {
    return this.dirtyTop;
  }

  // --- Mirror (`mirror.ts`, in the host's `onmessage`) ---

  /**
   * STATUS `ended`: if `id` is live and not already ENDING, it becomes ENDING (`playing` reads false) and is listed
   * for `freeEnded`. A stale id (its slot freed or reused since) is ignored. Returns whether it was applied.
   */
  markEnded(id: number): boolean {
    const i = this.slotOf(id);
    if (i < 0 || this.state[i] === VoiceState.ENDING) return false;
    this.state[i] = VoiceState.ENDING;
    if (this.endedListed[i] === 0) {
      this.endedListed[i] = 1;
      this.endedList[this.endedTop++] = i;
    }
    return true;
  }

  /** STATUS `demoted` (the core's adaptive cap): a live PLAYING voice becomes VIRTUAL with reason VIRTUAL. Stale ids are ignored. */
  markDemoted(id: number): boolean {
    const i = this.slotOf(id);
    if (i < 0 || this.state[i] !== VoiceState.PLAYING) return false;
    this.state[i] = VoiceState.VIRTUAL;
    this.reason[i] = VoiceReason.VIRTUAL;
    return true;
  }

  /** STATUS `starved`: a live voice on the core (PLAYING or VIRTUAL) gets reason WAITING_FOR_DATA (its state stays). Stale ids are ignored. */
  markStarved(id: number): boolean {
    const i = this.slotOf(id);
    if (i < 0) return false;
    const s = this.state[i]!;
    if (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL) return false;
    this.reason[i] = VoiceReason.WAITING_FOR_DATA;
    return true;
  }

  /** STATUS `playheads`: `playhead[index] = clipFrame` for a live id. Stale ids are ignored. */
  setPlayhead(id: number, clipFrame: number): boolean {
    const i = this.slotOf(id);
    if (i < 0) return false;
    this.playhead[i] = clipFrame;
    return true;
  }

  /**
   * Frees every slot `markEnded` listed (with reason NONE, or FAILED for a voice that failed while stopping, B4; `onFree` runs for each). The per-frame system calls
   * it; `onmessage` calls it itself while the page is hidden (architecture §3.8). Returns how many it freed.
   */
  freeEnded(): number {
    let freed = 0;
    const n = this.endedTop;
    this.endedTop = 0;
    for (let k = 0; k < n; k++) {
      const i = this.endedList[k]!;
      this.endedListed[i] = 0;
      if (this.state[i] !== VoiceState.ENDING) continue;
      this.freeSlot(i, this.reason[i] === VoiceReason.FAILED ? VoiceReason.FAILED : VoiceReason.NONE);
      freed++;
    }
    return freed;
  }

  // --- Lifecycle (A0.8's host listener) ---

  /**
   * `maxVoices` per bus index from the resolved buses (0 or absent = unlimited); indices past `limits.length` become
   * unlimited. A bus remap doesn't move limits: whoever reconfigures (A1.4) sets the new tree's limits.
   */
  setBusLimits(limits: ArrayLike<number>): void {
    for (let b = 0; b < MAX_BUSES; b++) {
      const v = b < limits.length ? limits[b]! : 0;
      this.busMax[b] = Number.isFinite(v) && v > 0 ? Math.min(v, 0xffff) : 0;
    }
  }

  /**
   * Api §3 "Bus state serialisation": the bus tree changed, so `bus[i] = map[bus[i]]` for every live voice (an index
   * past `map.length` goes to the root, 0), and `busLive` is recounted.
   */
  remapBuses(map: Uint8Array): void {
    this.busLive.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === VoiceState.FREE) continue;
      const old = this.bus[i]!;
      const b = old < map.length ? map[old]! : 0;
      const nb = b < MAX_BUSES ? b : 0;
      this.bus[i] = nb;
      this.busLive[nb]!++;
    }
  }

  /**
   * Architecture §3.9: World `key` was released. Its voices never sent to the core (LOCKED, WAITING_FOR_DATA) are
   * freed at once; every other live voice of that World that isn't STOPPING or ENDING becomes STOPPING with a queued
   * STOP of `WORLD_RELEASE_FADE_SECONDS`. The STOP record itself is A1.4's command writer's (`drainCommands`).
   * Stopped voices' `world` becomes 0, since the key returns to the pool and may go to another World at once. Key 0
   * (no World) does nothing. Returns how many voices it stopped or freed.
   */
  releaseWorld(key: WorldKey): number {
    if (key === 0) return 0;
    let count = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === VoiceState.FREE || this.world[i] !== key) continue;
      const s = this.state[i]!;
      this.world[i] = 0;
      if (s === VoiceState.STOPPING || s === VoiceState.ENDING) continue;
      this.stopSlot(i, WORLD_RELEASE_FADE_SECONDS);
      count++;
    }
    return count;
  }

  // --- Internals ---

  /** Slot `i`'s current id. */
  private idOf(i: number): number {
    return ((this.gen[i]! << 16) | i) >>> 0;
  }

  /** `id`'s slot if it is live (valid, same generation, not FREE), else -1. */
  private slotOf(id: number): number {
    if (id >>> 0 !== id) return -1;
    const g = id >>> 16;
    const i = id & MAX_VOICE_INDEX;
    if (g === 0 || i >= this.capacity || this.gen[i] !== g || this.state[i] === VoiceState.FREE) return -1;
    return i;
  }

  /** `requestStop`'s rule on a live slot. */
  private stopSlot(i: number, fadeSeconds: number): void {
    const s = this.state[i]!;
    if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return;
    if (s === VoiceState.LOCKED || s === VoiceState.WAITING_FOR_DATA) {
      this.freeSlot(i, VoiceReason.NONE);
      return;
    }
    this.state[i] = VoiceState.STOPPING;
    this.flags[i]! |= VoiceFlag.STOP_ON_FADE_END;
    this.stopSeconds[i] = fadeSeconds;
    this.queue(i, DIRTY_STOP);
  }

  /** Records live slot `i` in the recent-steals ring (before it is freed). */
  private noteStolen(i: number): void {
    const k = this.stolenHead;
    this.stolenIds[k] = this.idOf(i);
    this.stolenClip[k] = this.clip[i]!;
    this.stolenBus[k] = this.bus[i]!;
    this.stolenWorld[k] = this.world[i]!;
    this.stolenPriority[k] = this.priority[i]!;
    this.stolenFrame[k] = this.frame;
    this.stolenHead = (k + 1) % STOLEN_RING;
    if (this.stolenSize < STOLEN_RING) this.stolenSize++;
  }

  /** Queues `bit` for slot `i`, listing the slot once. */
  private queue(i: number, bit: number): void {
    const d = this.dirty[i]!;
    if ((d & DIRTY_LISTED) === 0) this.dirtyList[this.dirtyTop++] = i;
    this.dirty[i] = d | DIRTY_LISTED | bit;
  }

  /** Frees live slot `i` (see `free`). Its list memberships stay; the drains skip what no longer applies. */
  private freeSlot(i: number, reason: VoiceReasonCode): void {
    const b = this.bus[i]!;
    if (reason === VoiceReason.STOLEN) this.noteStolen(i);
    this.onFree?.(this.idOf(i), b);
    this.state[i] = VoiceState.FREE;
    this.reason[i] = VoiceReason.NONE;
    this.freedReason[i] = reason;
    this.dirty[i]! &= DIRTY_LISTED;
    this.musicGroup[i] = 0;
    this.clearStamped(i);
    this.clearStem(i);
    if (this.busLive[b]! > 0) this.busLive[b]!--;
    this.liveCount--;
    const g = this.gen[i]!;
    this.gen[i] = g === MAX_GEN ? MIN_GEN : g + 1;
    this.freeStack[this.freeTop++] = i;
  }
}

/** §3: generations run 1..65535 (`ids.ts` names them too; inlined here, where every call is hot). */
const MIN_GEN = 1;
const MAX_GEN = 0xffff;
const MAX_VOICE_INDEX = 0xffff;
const INVALID_VOICE_ID = 0;
const DIRTY_STOP = 1;
const DIRTY_FADE = 2;
const DIRTY_LISTED = 0x80;
/** @internal How many recent steals the table keeps for `Audio.debug()` (A3.1). */
export const STOLEN_RING = 16;

/**
 * @internal Hooks `table` to the host's lifecycle (A0.8, `addLifecycleListener`): `onBusRemap` runs
 * `table.remapBuses(remap.map)`, `onWorldReleased` runs `table.releaseWorld(key)`. Returns the removal.
 */
export function connectVoiceTable(table: VoiceTable, host: Pick<AudioHost, "addLifecycleListener">): () => void {
  const listener: HostLifecycleListener = {
    onBusRemap: (remap: BusRemap) => table.remapBuses(remap.map),
    onWorldReleased: (key: WorldKey) => void table.releaseWorld(key),
  };
  return host.addLifecycleListener(listener);
}
