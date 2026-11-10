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
import { MAX_BUSES as MAX_BUSESImport } from "../../../../engine/audio/settings";

// M2 F1: module-local copies of imported values the per-voice play path reads. Under Vitest's module runner (where
// the M2 bench measures) every read of an imported binding is a getter call on the exporting module, about 10 ns; a
// bundle reads either directly.
const MAX_BUSES = MAX_BUSESImport;

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
    this.startFrame[i] = 0;
    this.playhead[i] = 0;
    this.epoch[i] = 0;
    this.owner[i] = -1;
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
