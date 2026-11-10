// Voice selection (ADR 0157 A3.1; api-and-models §3 "Selection", §1 `priority` and `Bus.maxVoices`; architecture §2.2,
// §3.9, §6.3, §6.4): once per frame, on main, over every logical voice in the table, decide which voices the core mixes
// and which stay virtual (in time, silent).
//
// - **Audibility** per live voice: `gain` (volume times the distance gain, computed by the backend) times `fadeGain`
//   (the handle's fade) times its bus's effective gain (volume, mute, solo, snapshot and ducking down the tree) times
//   the priority weight `1 + priority/255` (at most 2x, +6 dB: §1 "it only mildly raises audibility"). Stored in the
//   table's `audibility`, which stealing (`VoiceTable.allocate`) and `Audio.debug()` read.
// - **Forced virtual**: voices of an inaudible World (§3.9: the World lost the view) and paused voices are virtual
//   whatever the room, at once (no dwell). A voice below `MIN_AUDIBILITY` (-100 dB) is never promoted.
// - **Top N**: `selectTopK` (O(L), no sort, no allocation) keeps the `cap` best of the candidates mixed, where cap is
//   `min(voices.mixed, mixedCap)` (the backend's `mixedCap()`, A3.3's seam).
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
// once. The nearest-N ordering (`rankTop`) is kept separate so H3's HRTF assignment (the top `voices.hrtf` spatial
// voices by audibility, with the same 1.2x hysteresis) can reuse it with its own flag.
//
// Nothing here allocates after construction (architecture §6.4).
import { MAX_BUSES } from "../../../../engine/audio/settings";
import type { WorldKey } from "./context";
import { selectTopK } from "./quickselect";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

/** @internal §3: hysteresis 1.2x (a virtual voice must beat a mixed one by this factor). */
export const HYSTERESIS = 1.2;
/** @internal §3 (API §10 issue 9): a voice keeps a new state for at least 3 selection frames. */
export const DWELL_FRAMES = 3;
/** @internal Audibility below this (-100 dB) is never promoted (it would cost a mixed voice and be inaudible). */
export const MIN_AUDIBILITY = 1e-5;
/** @internal §1: priority raises audibility by at most 2x (+6 dB). */
export const priorityWeight = (priority: number): number => 1 + priority / 255;

/** Keys above every audibility: a mixed voice inside its dwell ranks first (`DWELL_KEY + audibility`). */
const DWELL_KEY = 1e30;
/** A candidate that may not be promoted this frame (virtual inside its dwell, or below `MIN_AUDIBILITY`). */
const NO_KEY = -1;
const UNKNOWN = 2;

/** @internal Where `Selection.run` sends its decisions (the backend: SET_MIXED, STOP). One long-lived object. */
export interface SelectionSink {
  /** Slot `i` changes to mixed (`true`) or virtual; the table's `state` and `reason` are already updated. */
  setMixed(i: number, mixed: boolean): void;
  /** Slot `i` is stolen (its bus is over `maxVoices`): stop it on the core and free it with reason STOLEN. */
  steal(i: number): void;
}

/** @internal What one `run` did (for tests, the bench and `Audio.debug()`). */
export interface SelectionStats {
  /** Voices on the core considered this frame (PLAYING or VIRTUAL). */
  candidates: number;
  /** Mixed voices after the run. */
  mixed: number;
  promoted: number;
  demoted: number;
  stolen: number;
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
  readonly stats: SelectionStats = { candidates: 0, mixed: 0, promoted: 0, demoted: 0, stolen: 0 };

  /** Frames since slot `i` last changed between mixed and virtual (saturates at 255). */
  private readonly dwell: Uint8Array;
  /** What selection last saw slot `i` as: 0 virtual, 1 mixed, `UNKNOWN`. A difference means someone else changed it. */
  private readonly seen: Uint8Array;
  /** The slot generation `seen` and `dwell` describe; another generation is a new voice. */
  private readonly seenGen: Uint16Array;
  /** Scratch for `selectTopK`: keys and slot indices of this frame's candidates. */
  private readonly keys: Float32Array;
  private readonly items: Uint16Array;

  constructor(readonly table: VoiceTable) {
    const n = table.capacity;
    this.dwell = new Uint8Array(n);
    this.seen = new Uint8Array(n).fill(UNKNOWN);
    this.seenGen = new Uint16Array(n);
    this.keys = new Float32Array(n);
    this.items = new Uint16Array(n);
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
    const a = forced ? 0 : t.gain[i]! * t.fadeGain[i]! * this.busGain[t.bus[i]!]! * priorityWeight(t.priority[i]!);
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
    this.seen[i] = mixed ? 1 : 0;
    this.seenGen[i] = this.table.gen[i]!;
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
    this.frame++;
    t.frame = this.frame;
    this.enforceBusLimits(sink);

    const state = t.state;
    const dwell = this.dwell;
    const seen = this.seen;
    const seenGen = this.seenGen;
    const gen = t.gen;
    const keys = this.keys;
    const items = this.items;
    const n = t.capacity;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const s = state[i]!;
      if (s === VoiceState.FREE) continue;
      const a = this.audibilityOf(i);
      if (s !== VoiceState.PLAYING && s !== VoiceState.VIRTUAL) continue;
      const mixed = s === VoiceState.PLAYING;
      let was = seen[i]!;
      if (seenGen[i] !== gen[i]) {
        was = UNKNOWN;
        seenGen[i] = gen[i]!;
      }
      const d = dwell[i]!;
      if (was !== (mixed ? 1 : 0)) {
        // A new voice, or the core demoted it: its dwell starts now.
        seen[i] = mixed ? 1 : 0;
        dwell[i] = was === UNKNOWN && !mixed ? DWELL_FRAMES : 0;
      } else if (d < 255) {
        dwell[i] = d + 1;
      }
      if (a === 0 && (this.worldAudible[t.world[i]!] === 0 || (t.flags[i]! & VoiceFlag.PAUSED) !== 0)) {
        // Forced virtual: an inaudible World or a paused voice, whatever the dwell.
        if (mixed) this.change(i, false, sink);
        else this.setVirtualReason(i);
        continue;
      }
      const settled = dwell[i]! >= DWELL_FRAMES;
      let key: number;
      if (mixed) key = settled ? a * HYSTERESIS : DWELL_KEY + a;
      else key = settled && a >= MIN_AUDIBILITY ? a : NO_KEY;
      keys[count] = key;
      items[count] = i;
      count++;
    }
    stats.candidates = count;

    const top = rankTop(keys, items, count, cap);
    let mixedNow = 0;
    for (let j = 0; j < count; j++) {
      const i = items[j]!;
      const mixed = state[i] === VoiceState.PLAYING;
      if (j < top) {
        const key = keys[j]!;
        if (!mixed && key !== NO_KEY) {
          this.change(i, true, sink);
          mixedNow++;
        } else if (mixed && key < DWELL_KEY && t.audibility[i]! < MIN_AUDIBILITY) {
          this.change(i, false, sink); // silent and settled: not worth a mixed voice
        } else if (mixed) {
          mixedNow++;
          if (t.reason[i] !== VoiceReason.WAITING_FOR_DATA) t.reason[i] = VoiceReason.NONE;
        } else {
          this.setVirtualReason(i);
        }
      } else if (mixed) {
        this.change(i, false, sink);
      } else {
        this.setVirtualReason(i);
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
    this.seen[i] = mixed ? 1 : 0;
    this.seenGen[i] = t.gen[i]!;
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
 * `mixedCap`, 0 until the core reports one (A3.3's adaptive cap).
 */
export function effectiveMixedCap(configured: number, reported: number): number {
  return reported > 0 && reported < configured ? reported : configured;
}
