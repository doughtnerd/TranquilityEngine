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

  /**
   * Called on every free, whatever the cause (natural end, immediate stop, steal, failure, World release), with the
   * freed id and its bus, before the generation bumps. A1.4's `coreBackend` sets it once to call
   * `mixer.voiceEnded(bus)` (§3 "Mixer counting"). Must not allocate per call.
   */
  onFree: ((id: number, bus: number) => void) | null = null;

  /** The reason each slot's previous voice was freed with (see `endedReason`). */
  private readonly freedReason: Uint8Array;
  /** Slots that went ENDING since the last `freeEnded` (`endedTop` valid). */
  private readonly endedList: Uint16Array;
  private endedTop = 0;
  /** Queued commands per slot: bit 0 stop, bit 1 fade; slots with any bit set are listed once in `dirtyList`. */
  private readonly dirty: Uint8Array;
  private readonly dirtyList: Uint16Array;
  private dirtyTop = 0;
  private readonly stopSeconds: Float32Array;
  private readonly fadeTo: Float32Array;
  private readonly fadeSeconds: Float32Array;

  /** Allocates every array once (`capacity` = `voices.logical`, 1..65536) and fills the free list so slot 0 goes first. */
  constructor(capacity: number) {
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
    this.startFrame = new Float64Array(capacity);
    this.playhead = new Uint32Array(capacity);
    this.epoch = new Uint32Array(capacity);
    this.owner = new Int32Array(capacity);
    this.freeStack = new Uint16Array(capacity);
    this.busLive = new Uint16Array(MAX_BUSES);
    this.busMax = new Uint16Array(MAX_BUSES);
    this.freedReason = new Uint8Array(capacity);
    this.endedList = new Uint16Array(capacity);
    this.dirty = new Uint8Array(capacity);
    this.dirtyList = new Uint16Array(capacity);
    this.stopSeconds = new Float32Array(capacity);
    this.fadeTo = new Float32Array(capacity);
    this.fadeSeconds = new Float32Array(capacity);
    this.reset();
  }

  /** Every slot FREE at generation 1, the free list full (slot 0 on top), counts and queues empty. */
  reset(): void {
    throw new Error("not implemented: A1.1");
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
   * volume, pitch and fadeGain 1, minDist 1, maxDist 100, owner -1, the rest 0.
   */
  allocate(bus: number, priority: number, world: WorldKey, state: VoiceStateCode): number {
    throw new Error("not implemented: A1.1");
  }

  /** Whether `id` names a live voice: valid, its slot's generation matches and the slot isn't FREE. */
  isLive(id: number): boolean {
    throw new Error("not implemented: A1.1");
  }

  /**
   * Frees `id`'s slot now with `reason` (FAILED for a refused or failed load, NONE otherwise): calls `onFree`, keeps
   * `reason` for `endedReason`, clears its queued commands, bumps its generation (skipping 0) and pushes it on the
   * free list. A stale or invalid id does nothing. Returns whether it freed.
   */
  free(id: number, reason: VoiceReasonCode): boolean {
    throw new Error("not implemented: A1.1");
  }

  /** See `VoiceTableHandleApi.endedReason`. */
  endedReason(id: number): VoiceReasonCode {
    throw new Error("not implemented: A1.1");
  }

  // --- Commands (`AudioHandle`, World release) ---

  /** See `VoiceTableHandleApi.requestStop`. */
  requestStop(id: number, fadeSeconds: number): void {
    throw new Error("not implemented: A1.1");
  }

  /** See `VoiceTableHandleApi.requestFade`. */
  requestFade(id: number, to: number, seconds: number): void {
    throw new Error("not implemented: A1.1");
  }

  /**
   * The frame's queued commands, in the order slots were first queued: for each queued slot still live, `sink.stop`
   * and/or `sink.fade` (a stop after its fade). Empties the queue. A1.4's command writer calls it once per frame.
   */
  drainCommands(sink: VoiceCommandSink): void {
    throw new Error("not implemented: A1.1");
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
    throw new Error("not implemented: A1.1");
  }

  /** STATUS `demoted` (the core's adaptive cap): a live PLAYING voice becomes VIRTUAL with reason VIRTUAL. Stale ids are ignored. */
  markDemoted(id: number): boolean {
    throw new Error("not implemented: A1.1");
  }

  /** STATUS `starved`: a live voice on the core gets reason WAITING_FOR_DATA (its state stays). Stale ids are ignored. */
  markStarved(id: number): boolean {
    throw new Error("not implemented: A1.1");
  }

  /** STATUS `playheads`: `playhead[index] = clipFrame` for a live id. Stale ids are ignored. */
  setPlayhead(id: number, clipFrame: number): boolean {
    throw new Error("not implemented: A1.1");
  }

  /**
   * Frees every slot `markEnded` listed (with reason NONE, so `onFree` runs for each). The per-frame system calls
   * it; `onmessage` calls it itself while the page is hidden (architecture §3.8). Returns how many it freed.
   */
  freeEnded(): number {
    throw new Error("not implemented: A1.1");
  }

  // --- Lifecycle (A0.8's host listener) ---

  /** `maxVoices` per bus index from the resolved buses (0 or absent = unlimited); indices past `limits.length` become unlimited. */
  setBusLimits(limits: ArrayLike<number>): void {
    throw new Error("not implemented: A1.1");
  }

  /**
   * Api §3 "Bus state serialisation": the bus tree changed, so `bus[i] = map[bus[i]]` for every live voice (an index
   * past `map.length` goes to the root, 0), and `busLive` is recounted.
   */
  remapBuses(map: Uint8Array): void {
    throw new Error("not implemented: A1.1");
  }

  /**
   * Architecture §3.9: World `key` was released. Its voices never sent to the core (LOCKED, WAITING_FOR_DATA) are
   * freed at once; every other live voice of that World that isn't STOPPING or ENDING becomes STOPPING with a queued
   * STOP of `WORLD_RELEASE_FADE_SECONDS`. The STOP record itself is A1.4's command writer's (`drainCommands`).
   * Returns how many voices it stopped or freed.
   */
  releaseWorld(key: WorldKey): number {
    throw new Error("not implemented: A1.1");
  }
}

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
