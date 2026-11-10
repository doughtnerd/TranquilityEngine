// Voice selection (ADR 0157 A3.1; api-and-models §3 "Selection", §1 `priority` and `Bus.maxVoices`; architecture §2.2,
// §3.9, §6.3, §6.4): once per frame, on main, over every logical voice in the table, decide which voices the core mixes
// and which stay virtual (in time, silent).
//
// - **Audibility** per live voice: `gain` (volume times the distance gain, computed by the backend) times `fadeGain`
//   (the handle's fade) times `autoGain` (ADR 0158: its automation's gain at the parameters' targets, 1 without
//   bindings, `coreAutomation.ts`) times its bus's effective gain (volume, mute, solo, snapshot and ducking down the tree) times
//   the priority weight `1 + priority/255` (at most 2x, +6 dB: §1 "it only mildly raises audibility"). Stored in the
//   table's `audibility`, which stealing (`VoiceTable.allocate`) and `Audio.debug()` read.
// - **Forced virtual**: voices of an inaudible World (§3.9: the World lost the view) and paused voices are virtual
//   whatever the room, at once (no dwell). A voice below `MIN_AUDIBILITY` (-100 dB) is never promoted.
// - **Top N**: `selectTopK` (O(L), no sort, no allocation) keeps the `cap` best of the candidates mixed, where cap is
//   `min(voices.mixed, mixedCap)` (the backend's `mixedCap()`: STATUS `mixedCap`, A3.3's adaptive cap, through
//   `effectiveMixedCap`). When the cap drops, the core has already demoted the lowest-score voices itself (STATUS
//   `demoted`, which the table follows), and selection at the lower cap never promotes past it.
// - **Score refresh (A3.3)**: the core ranks its own demotes by each voice's `score`, which PLAY carries. A mixed voice
//   whose audibility moved more than `SCORE_RATIO` (3 dB) from the score last sent gets a score-only SET_PARAMS
//   (`SelectionSink.setScore`), at most `SCORE_BUDGET` a frame (the rest go on later frames), so the wire isn't flooded
//   by fades and moving sources.
// - **Hysteresis 1.2x**: a mixed voice's key is its audibility times 1.2, so a virtual voice replaces it only when it
//   is more than 1.2x louder.
// - **Dwell 3 frames**: a voice that changed state (by selection, the core's demote, or a new PLAY) less than 3 frames
//   ago keeps that state: a mixed one ranks above every other candidate (it is cut only if such voices alone exceed
//   the cap, e.g. when the cap drops), a virtual one can't be promoted. A voice just admitted (`admit`) is exempt, so
//   a new loud sound can take a quiet voice's place in its first frame.
// - **Per-bus `maxVoices`**: allocation already steals on a full bus; selection steals the excess when a bus holds
//   more than its limit after a `setBus`, a remap or a lower limit (lowest priority, then lowest audibility).
//
// Changes go to a `SelectionSink` (the backend writes SET_MIXED and STOP); the table's `state` and `reason` follow at
// once. The nearest-N ordering (`rankTop`) is kept separate: H3's HRTF assignment (`hrtfPick.ts`: the top
// `voices.hrtf` mixed spatial voices by audibility, with the same 1.2x hysteresis) reuses it with its own flag, after
// `run`, reading the `audibility` this pass stores.
//
// Nothing here allocates after construction (architecture §6.4).
import { MAX_BUSES as MAX_BUSESImport } from "../../../../engine/audio/settings";
import type { WorldKey } from "./context";
import { selectTopK } from "./quickselect";
import { VoiceFlag as VoiceFlagImport, VoiceReason as VoiceReasonImport, VoiceState as VoiceStateImport, type VoiceTable } from "./voiceTable";

// M2 F1: module-local copies of imported values the per-voice play path reads. Under Vitest's module runner (where
// the M2 bench measures) every read of an imported binding is a getter call on the exporting module, about 10 ns; a
// bundle reads either directly.
const MAX_BUSES = MAX_BUSESImport;
const VoiceFlag = VoiceFlagImport;
const VoiceReason = VoiceReasonImport;
const VoiceState = VoiceStateImport;

/** @internal §3: hysteresis 1.2x (a virtual voice must beat a mixed one by this factor). */
export const HYSTERESIS = 1.2;
/** @internal §3 (API §10 issue 9): a voice keeps a new state for at least 3 selection frames. */
export const DWELL_FRAMES = 3;
/** @internal A3.3: a mixed voice's score is re-sent when its audibility moves more than this factor (3 dB) either way. */
export const SCORE_RATIO = Math.SQRT2;
/** @internal A3.3: at most this many score updates a frame (56 bytes each). */
export const SCORE_BUDGET = 64;
/** @internal Audibility below this (-100 dB) is never promoted (it would cost a mixed voice and be inaudible). */
export const MIN_AUDIBILITY = 1e-5;
/** @internal §1: priority raises audibility by at most 2x (+6 dB). */
export const priorityWeight = (priority: number): number => 1 + priority / 255;

// The codes the hot loop compares with, as plain constants.
const S_FREE = VoiceState.FREE;
const S_PLAYING = VoiceState.PLAYING;
const S_VIRTUAL = VoiceState.VIRTUAL;
const F_PAUSED = VoiceFlag.PAUSED;
const R_NONE = VoiceReason.NONE;
const R_VIRTUAL = VoiceReason.VIRTUAL;
const R_BUS_MUTED = VoiceReason.BUS_MUTED;
const R_WAITING = VoiceReason.WAITING_FOR_DATA;

/** `priorityWeight` for each priority 0..255, so the hot loop reads instead of dividing. */
const PRIORITY_WEIGHTS = Float32Array.from({ length: 256 }, (_, p) => priorityWeight(p));

/** Keys above every audibility: a mixed voice inside its dwell ranks first (`DWELL_KEY + audibility`). */
const DWELL_KEY = 1e30;
/** A candidate that may not be promoted this frame (virtual inside its dwell, or below `MIN_AUDIBILITY`). */
const NO_KEY = -1;
/** A voice forced virtual (inaudible World, paused): ranks last and is demoted wherever it lands. */
const FORCED_KEY = -2;
/**
 * The gather threshold is this fraction of the previous frame's weakest kept key. Any value is exact (a frame whose
 * cut drops below it gathers again with no threshold); 0.9 keeps the ranked set near the cap while the cut drifts.
 */
const THRESHOLD_MARGIN = 0.9;

/** @internal Where `Selection.run` sends its decisions (the backend: SET_MIXED, STOP). One long-lived object. */
export interface SelectionSink {
  /** Slot `i` changes to mixed (`true`) or virtual; the table's `state` and `reason` are already updated. */
  setMixed(i: number, mixed: boolean): void;
  /** Slot `i` is stolen (its bus is over `maxVoices`): stop it on the core and free it with reason STOLEN. */
  steal(i: number): void;
  /** A3.3: slot `i`'s audibility moved enough that the core's copy of its `score` is re-sent (SET_PARAMS score). */
  setScore?(i: number, score: number): void;
}

/** @internal What one `run` did (for tests, the bench and `Audio.debug()`). */
export interface SelectionStats {
  /** Voices on the core considered this frame (PLAYING or VIRTUAL). */
  candidates: number;
  /** Of those, how many were ranked (mixed ones, and virtual ones at or above the gather threshold). */
  ranked: number;
  /** Mixed voices after the run. */
  mixed: number;
  promoted: number;
  demoted: number;
  stolen: number;
  /** Score updates sent (A3.3). */
  scores: number;
}

/**
 * @internal The listener's frame, kept once per change, and the listener-space direction and distance of a point,
 * written into preallocated outputs. The same arithmetic, in the same order, as `spatial.ts`'s
 * `listenerSpaceDirection` (so results are identical), without its per-call arrays.
 */
export class ListenerBasis {
  private px = 0;
  private py = 0;
  private pz = 0;
  private rx = 0;
  private ry = 0;
  private rz = 0;
  private ux = 0;
  private uy = 0;
  private uz = 0;
  private fx = 0;
  private fy = 0;
  private fz = 0;
  private degenerate = true;
  /** Outputs of `locate`: the unit direction (listener space: -Z ahead, +X right, +Y up; zero if coincident or degenerate). */
  dirX = 0;
  dirY = 0;
  dirZ = 0;
  /** Output of `locate`: the distance. */
  distance = 0;

  /** The listener at `pos`, facing `fwd` with `up` (neither need be unit or orthogonal). */
  set(pos: readonly number[], fwd: readonly number[], up: readonly number[]): void {
    this.px = pos[0]!;
    this.py = pos[1]!;
    this.pz = pos[2]!;
    const fl = Math.sqrt(fwd[0]! * fwd[0]! + fwd[1]! * fwd[1]! + fwd[2]! * fwd[2]!);
    if (fl === 0) {
      this.degenerate = true;
      return;
    }
    const s = 1 / fl;
    const fx = fwd[0]! * s;
    const fy = fwd[1]! * s;
    const fz = fwd[2]! * s;
    // right = cross(f, up)
    const rx = fy * up[2]! - fz * up[1]!;
    const ry = fz * up[0]! - fx * up[2]!;
    const rz = fx * up[1]! - fy * up[0]!;
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rl === 0) {
      this.degenerate = true;
      return;
    }
    const k = 1 / rl;
    this.rx = rx * k;
    this.ry = ry * k;
    this.rz = rz * k;
    // localUp = cross(right, f)
    this.ux = this.ry * fz - this.rz * fy;
    this.uy = this.rz * fx - this.rx * fz;
    this.uz = this.rx * fy - this.ry * fx;
    this.fx = fx;
    this.fy = fy;
    this.fz = fz;
    this.degenerate = false;
  }

  /** Sets `dirX/Y/Z` and `distance` for a source at (x, y, z). */
  locate(x: number, y: number, z: number): void {
    const ox = x - this.px;
    const oy = y - this.py;
    const oz = z - this.pz;
    const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
    this.distance = d;
    if (d === 0 || this.degenerate) {
      this.dirX = 0;
      this.dirY = 0;
      this.dirZ = 0;
      return;
    }
    const s = 1 / d;
    const nx = ox * s;
    const ny = oy * s;
    const nz = oz * s;
    this.dirX = nx * this.rx + ny * this.ry + nz * this.rz;
    this.dirY = nx * this.ux + ny * this.uy + nz * this.uz;
    this.dirZ = -(nx * this.fx + ny * this.fy + nz * this.fz);
  }
}

/**
 * @internal The per-frame selection over one voice table (api §3). `busGain` and `worldAudible` are inputs the
 * backend keeps current; `run` is the frame step and `admit` decides a new PLAY's mixed bit.
 */
export class Selection {
  /** Effective gain per bus index (volume, mute, solo, snapshot and ducking down the tree); 1 until set. */
  readonly busGain = new Float32Array(MAX_BUSES).fill(1);
  /** 1 while World key `k` is audible (has the view); key 0 (no World) is always audible. All audible until set. */
  readonly worldAudible = new Uint8Array(256).fill(1);
  /** Mixed voices after the last `run`, plus those `admit` mixed since. */
  mixedCount = 0;
  /** Selection frames run (the table's `frame` follows it, for the debug view's recent steals). */
  frame = 0;
  readonly stats: SelectionStats = { candidates: 0, ranked: 0, mixed: 0, promoted: 0, demoted: 0, stolen: 0, scores: 0 };
  /** The `score` the core holds for slot `i`: what its PLAY or the last score update carried (A3.3). */
  readonly sentScore: Float32Array;
  /** This frame's slots whose score is re-sent (at most `SCORE_BUDGET`). */
  private readonly scoreQueue = new Uint16Array(SCORE_BUDGET);

  /** Frames since slot `i` last changed between mixed and virtual (counts up to `DWELL_FRAMES`, then stays). */
  private readonly dwell: Uint8Array;
  /**
   * What selection last saw slot `i` as: `gen << 1 | mixed` (0: never). Another generation is a new voice; the same
   * generation with the other bit means someone else changed it (the core's demote).
   */
  private readonly seen: Uint32Array;
  /** This frame's ranking key per slot (see `run`). */
  private readonly slotKey: Float32Array;
  /** The gather threshold for the next `run` (`-Infinity`: gather every candidate). */
  private threshold = Number.NEGATIVE_INFINITY;
  /** Scratch for `selectTopK`: keys and slot indices of this frame's candidates. */
  private readonly keys: Float32Array;
  private readonly items: Uint16Array;

  constructor(readonly table: VoiceTable) {
    const n = table.capacity;
    this.dwell = new Uint8Array(n);
    this.seen = new Uint32Array(n);
    this.keys = new Float32Array(n);
    this.slotKey = new Float32Array(n);
    this.items = new Uint16Array(n);
    this.sentScore = new Float32Array(n);
  }

  /** Slot `i`'s PLAY carried `score` (A3.3): the core holds that until a score update. */
  noteScoreSent(i: number, score: number): void {
    this.sentScore[i] = score;
  }

  /** World `key`'s voices are audible or forced virtual (architecture §3.9). Key 0 can't be made inaudible. */
  setWorldAudible(key: WorldKey, audible: boolean): void {
    if (key > 0 && key < 256) this.worldAudible[key] = audible ? 1 : 0;
  }

  /**
   * Slot `i`'s audibility (see the header), also stored in `table.audibility[i]`. 0 for a voice of an inaudible
   * World or a paused voice (forced virtual).
   */
  audibilityOf(i: number): number {
    const t = this.table;
    const forced = this.worldAudible[t.world[i]!] === 0 || (t.flags[i]! & VoiceFlag.PAUSED) !== 0;
    const a = forced ? 0 : t.gain[i]! * t.fadeGain[i]! * t.autoGain[i]! * this.busGain[t.bus[i]!]! * PRIORITY_WEIGHTS[t.priority[i]!]!;
    t.audibility[i] = a;
    return a;
  }

  /**
   * A new voice is about to be sent (its PLAY): returns whether it starts mixed, which is when it is audible enough
   * and fewer than `cap` voices are mixed. A voice admitted virtual may still be promoted by this frame's `run` (it
   * is exempt from the dwell once). Updates `mixedCount`.
   */
  admit(i: number, cap: number): boolean {
    const a = this.audibilityOf(i);
    const mixed = a >= MIN_AUDIBILITY && this.mixedCount < cap;
    if (mixed) this.mixedCount++;
    this.seen[i] = (this.table.gen[i]! << 1) | (mixed ? 1 : 0);
    this.dwell[i] = DWELL_FRAMES;
    return mixed;
  }

  /**
   * The frame step (api §3): bus limits, audibility, forced virtual voices, the top `cap` by key with hysteresis and
   * dwell, then the changes to `sink`. Returns `stats`.
   */
  run(cap: number, sink: SelectionSink): SelectionStats {
    const t = this.table;
    const stats = this.stats;
    stats.promoted = 0;
    stats.demoted = 0;
    stats.stolen = 0;
    stats.scores = 0;
    this.frame++;
    t.frame = this.frame;
    this.enforceBusLimits(sink);

    const state = t.state;
    const dwell = this.dwell;
    const seen = this.seen;
    const gen = t.gen;
    const keys = this.keys;
    const items = this.items;
    const gain = t.gain;
    const fadeGain = t.fadeGain;
    const autoGain = t.autoGain;
    const bus = t.bus;
    const priority = t.priority;
    const world = t.world;
    const flags = t.flags;
    const audibility = t.audibility;
    const busGain = this.busGain;
    const worldAudible = this.worldAudible;
    const weight = PRIORITY_WEIGHTS;
    const n = t.capacity;
    const slotKey = this.slotKey;
    let onCore = 0;
    const reason = t.reason;
    const sentScore = this.sentScore;
    const scoreQueue = this.scoreQueue;
    let scores = 0;
    const scoring = sink.setScore !== undefined;
    for (let i = 0; i < n; i++) {
      const s = state[i]!;
      if (s === S_FREE) continue;
      // `audibilityOf`, inlined (the hot loop: 4,096 voices per frame).
      const forced = worldAudible[world[i]!] === 0 || (flags[i]! & F_PAUSED) !== 0;
      const a = forced ? 0 : gain[i]! * fadeGain[i]! * autoGain[i]! * busGain[bus[i]!]! * weight[priority[i]!]!;
      audibility[i] = a;
      if (s !== S_PLAYING && s !== S_VIRTUAL) continue;
      const mixed = s === S_PLAYING;
      const tag = (gen[i]! << 1) | (mixed ? 1 : 0);
      const was = seen[i]!;
      let d: number;
      if (was !== tag) {
        // A new voice (free to change, if virtual), or the core demoted it: its dwell starts now. (It changed before
        // this frame, so one frame of its dwell has passed.)
        seen[i] = tag;
        d = was >>> 1 !== gen[i] && !mixed ? DWELL_FRAMES : 1;
        dwell[i] = d;
      } else {
        d = dwell[i]!;
        if (d < DWELL_FRAMES) dwell[i] = ++d;
      }
      let key: number;
      if (forced) {
        // Forced virtual: an inaudible World or a paused voice, whatever the dwell (demoted below; no call in this
        // loop, which keeps it fast).
        key = FORCED_KEY;
        if (!mixed && reason[i] !== R_WAITING) reason[i] = R_VIRTUAL;
      } else if (mixed) {
        key = d >= DWELL_FRAMES ? a * HYSTERESIS : DWELL_KEY + a;
        // A3.3: the core's copy of the score drifted (3 dB either way): re-send it, within the frame's budget.
        const sent = sentScore[i]!;
        if (scoring && scores < SCORE_BUDGET && (a > sent * SCORE_RATIO || a * SCORE_RATIO < sent)) scoreQueue[scores++] = i;
      } else {
        key = d >= DWELL_FRAMES && a >= MIN_AUDIBILITY ? a : NO_KEY;
        // A virtual voice's reason (`setVirtualReason`, inlined): busMuted on a silent bus.
        const r = reason[i]!;
        if (r !== R_WAITING) {
          const want = busGain[bus[i]!] === 0 ? R_BUS_MUTED : R_VIRTUAL;
          if (r !== want) reason[i] = want;
        }
      }
      slotKey[i] = key;
      onCore++;
    }
    stats.candidates = onCore;
    for (let k = 0; k < scores; k++) {
      const i = scoreQueue[k]!;
      sentScore[i] = audibility[i]!;
      sink.setScore!(i, audibility[i]!);
    }
    stats.scores = scores;

    // Gather what can matter: every mixed voice (to keep or demote) and the virtual ones whose key reaches the
    // threshold. When at least `cap` gathered keys reach it, the top `cap` of all candidates are among them (every
    // voice left out ranks below them), so ranking the gathered few is exact. Otherwise gather everything.
    let threshold = this.threshold;
    let count = 0;
    for (;;) {
      let above = 0;
      count = 0;
      for (let i = 0; i < n; i++) {
        const s = state[i]!;
        if (s !== S_PLAYING && s !== S_VIRTUAL) continue;
        const key = slotKey[i]!;
        if (key >= threshold) above++;
        else if (s !== S_PLAYING) continue;
        keys[count] = key;
        items[count] = i;
        count++;
      }
      if (above >= cap || threshold === Number.NEGATIVE_INFINITY) break;
      threshold = Number.NEGATIVE_INFINITY;
    }
    stats.ranked = count;

    const top = rankTop(keys, items, count, cap);
    // Next frame's threshold: a little under this frame's weakest kept key (dwell and negative keys don't count).
    let cutoff = Number.POSITIVE_INFINITY;
    for (let j = 0; j < top; j++) {
      const key = keys[j]!;
      if (key < cutoff) cutoff = key;
    }
    this.threshold = top === cap && cutoff > 0 && cutoff < DWELL_KEY ? cutoff * THRESHOLD_MARGIN : Number.NEGATIVE_INFINITY;
    // Outranked mixed voices first, so a batch never asks the core to mix more than the cap at once.
    for (let j = top; j < count; j++) {
      const i = items[j]!;
      if (state[i] === S_PLAYING) this.change(i, false, sink);
    }
    let mixedNow = 0;
    for (let j = 0; j < top; j++) {
      const i = items[j]!;
      const key = keys[j]!;
      if (state[i] === S_PLAYING) {
        if (key === FORCED_KEY || (key < DWELL_KEY && audibility[i]! < MIN_AUDIBILITY)) {
          this.change(i, false, sink); // forced, or silent and settled (not worth a mixed voice)
        } else {
          mixedNow++;
          if (reason[i] !== R_WAITING) reason[i] = R_NONE;
        }
      } else if (key >= 0) {
        this.change(i, true, sink);
        mixedNow++;
      }
    }
    this.mixedCount = mixedNow;
    stats.mixed = mixedNow;
    return stats;
  }

  /** Slot `i` changes state; the table follows and `sink` is told. */
  private change(i: number, mixed: boolean, sink: SelectionSink): void {
    const t = this.table;
    t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
    if (mixed) {
      if (t.reason[i] !== VoiceReason.WAITING_FOR_DATA) t.reason[i] = VoiceReason.NONE;
      this.stats.promoted++;
    } else {
      this.setVirtualReason(i);
      this.stats.demoted++;
    }
    this.seen[i] = (t.gen[i]! << 1) | (mixed ? 1 : 0);
    this.dwell[i] = 0;
    sink.setMixed(i, mixed);
  }

  /** A virtual voice's reason: BUS_MUTED when its bus is silent, else VIRTUAL (a starved stream keeps WAITING_FOR_DATA). */
  private setVirtualReason(i: number): void {
    const t = this.table;
    if (t.reason[i] === VoiceReason.WAITING_FOR_DATA) return;
    t.reason[i] = this.busGain[t.bus[i]!] === 0 ? VoiceReason.BUS_MUTED : VoiceReason.VIRTUAL;
  }

  /**
   * Api §3 / C11: a bus holding more live voices than its `maxVoices` (after a `setBus`, a remap or a lower limit)
   * has the excess stolen, lowest priority first, then lowest audibility. Voices already stopping count towards
   * the excess (they leave on their own). Rare: a quick check of 32 buses when nothing is over.
   */
  private enforceBusLimits(sink: SelectionSink): void {
    const t = this.table;
    for (let b = 0; b < MAX_BUSES; b++) {
      const max = t.busMax[b]!;
      if (max === 0 || t.busLive[b]! <= max) continue;
      let leaving = 0;
      for (let i = 0; i < t.capacity; i++) {
        const s = t.state[i]!;
        if (t.bus[i] === b && (s === VoiceState.STOPPING || s === VoiceState.ENDING)) leaving++;
      }
      let excess = t.busLive[b]! - max - leaving;
      while (excess > 0) {
        let victim = -1;
        let vp = 256;
        let va = Number.POSITIVE_INFINITY;
        for (let i = 0; i < t.capacity; i++) {
          const s = t.state[i]!;
          if (s === VoiceState.FREE || s === VoiceState.STOPPING || s === VoiceState.ENDING || t.bus[i] !== b) continue;
          const p = t.priority[i]!;
          const a = t.audibility[i]!;
          if (p < vp || (p === vp && a < va)) {
            victim = i;
            vp = p;
            va = a;
          }
        }
        if (victim < 0) break;
        sink.steal(victim);
        this.stats.stolen++;
        excess--;
      }
    }
  }
}

/**
 * @internal The nearest-N ordering (api §3; reused by H3 for HRTF): moves the `cap` largest of `keys[0..count)` (and
 * their `items`) to the front and returns how many that is (`min(cap, count)`). Keys carry the caller's hysteresis
 * and dwell weighting.
 */
export function rankTop(keys: Float32Array, items: Uint16Array, count: number, cap: number): number {
  const top = cap < 0 ? 0 : cap < count ? cap : count;
  if (top < count) selectTopK(keys, items, count, top);
  return top;
}

/**
 * @internal The mixed cap selection uses (architecture §6.3): `min(configured, reported)` where `reported` is STATUS
 * `mixedCap` (A3.3's adaptive cap, never above `voices.mixed`), 0 before the core's first STATUS. A reported cap above
 * `configured` (a core started with another preset) is ignored.
 */
export function effectiveMixedCap(configured: number, reported: number): number {
  return reported > 0 && reported < configured ? reported : configured;
}
