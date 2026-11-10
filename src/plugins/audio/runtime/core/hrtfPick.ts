// HRTF for the nearest voices (ADR 0157 H3, leaf L1; api-and-models §2 `voices.hrtf`, §3 "Selection", §4.2 SET_PARAMS
// `flags`; architecture §2.4 "Who gets HRTF"): once per frame, after the mixed/virtual selection, the top `voices.hrtf`
// mixed spatial voices by audibility get panner kind 1 (HRTF), with the same 1.2x hysteresis as mixing: a flagged
// voice's key is its audibility times 1.2, so another voice takes its place only when more than 1.2x louder.
//
// - Candidates: mixed (PLAYING) spatial voices at or above `MIN_AUDIBILITY`. Virtual, stopping and paused (forced
//   virtual) voices lose the flag; the core drops a virtual voice's HRTF state anyway, and a voice promoted back is
//   flagged again here and crossfades in from equal-power.
// - Changes go to an `HrtfSink` (the backend sends a SET_PARAMS with only the `flags` bit). Unflags go first, so the
//   core never holds more than `limit` flagged voices from one frame's changes.
// - `flag[i]` is what the core was last told for slot `i`; a rebuild's replay PLAY carries it (`replay.ts`), and a freed
//   slot is forgotten (`forget`), so a new voice in the slot starts equal-power.
// - A limit of 0 (`voices.hrtf: 0` or `audio.spatial: "equalPower"`) unflags everything (`clear`).
//
// The ordering is A3.1's `rankTop` (quickselect, O(n), no sort). Nothing here allocates after construction.
import { HYSTERESIS, MIN_AUDIBILITY, rankTop } from "./selection";
import { VoiceFlag, VoiceState, type VoiceTable } from "./voiceTable";

/** @internal `voices.hrtf`'s range (api-and-models §2): the core's bank holds this many HRTF panners. */
export const MAX_HRTF_VOICES = 32;

/** @internal Where `HrtfPick` sends its changes (the backend: SET_PARAMS `flags`). */
export interface HrtfSink {
  /** Slot `i`'s panner kind becomes HRTF (`true`) or equal-power. */
  setPanner(i: number, hrtf: boolean): void;
}

const S_PLAYING = VoiceState.PLAYING;
const S_VIRTUAL = VoiceState.VIRTUAL;
const S_STOPPING = VoiceState.STOPPING;
const F_SPATIAL = VoiceFlag.SPATIAL;
const F_PAUSED = VoiceFlag.PAUSED;

/** @internal The per-frame HRTF assignment over one voice table (see the header). */
export class HrtfPick {
  /** 1 while slot `i` is flagged HRTF (what the core was last told). */
  readonly flag: Uint8Array;
  /** Voices flagged after the last `run` (at most its limit). */
  count = 0;
  /** What the last `run` did. */
  readonly stats = { candidates: 0, flagged: 0, unflagged: 0 };
  /** The flagged voice's generation + 1 (0: none), so a slot reused without `forget` isn't taken for it. */
  private readonly tag: Uint32Array;
  /** Scratch: this frame's candidates (keys with the hysteresis, slot indices) and the picked mark. */
  private readonly keys: Float32Array;
  private readonly items: Uint16Array;
  private readonly picked: Uint8Array;

  constructor(readonly table: VoiceTable) {
    const n = table.capacity;
    this.flag = new Uint8Array(n);
    this.tag = new Uint32Array(n);
    this.keys = new Float32Array(n);
    this.items = new Uint16Array(n);
    this.picked = new Uint8Array(n);
  }

  /** The panner kind the core holds for slot `i` (0 equal-power, 1 HRTF), for a replayed PLAY. */
  panner(i: number): number {
    return this.flag[i] === 1 && this.tag[i] === this.table.gen[i]! + 1 ? 1 : 0;
  }

  /**
   * The frame step: flags the top `limit` (clamped to 0..32) candidates by audibility with 1.2x hysteresis and
   * unflags the rest, telling `sink` about each change. Reads `table.audibility`, so it runs after selection's `run`.
   * Returns the voices flagged.
   */
  run(limit: number, sink: HrtfSink): number {
    const n0 = Math.floor(limit);
    const cap = n0 > MAX_HRTF_VOICES ? MAX_HRTF_VOICES : n0 > 0 ? n0 : 0;
    const stats = this.stats;
    stats.flagged = 0;
    stats.unflagged = 0;
    if (cap === 0) {
      stats.candidates = 0;
      this.clear(sink);
      return 0;
    }
    const t = this.table;
    const state = t.state;
    const flags = t.flags;
    const gen = t.gen;
    const audibility = t.audibility;
    const flag = this.flag;
    const tag = this.tag;
    const keys = this.keys;
    const items = this.items;
    const picked = this.picked;
    const n = t.capacity;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (flag[i] === 1 && tag[i] !== gen[i]! + 1) {
        // The slot was reused (its old voice is gone from the core): forget the flag, nothing to send.
        flag[i] = 0;
        tag[i] = 0;
      }
      if (state[i] !== S_PLAYING || (flags[i]! & F_SPATIAL) === 0 || (flags[i]! & F_PAUSED) !== 0) continue;
      const a = audibility[i]!;
      if (!(a >= MIN_AUDIBILITY)) continue;
      keys[count] = flag[i] === 1 ? a * HYSTERESIS : a;
      items[count] = i;
      count++;
    }
    stats.candidates = count;
    const top = rankTop(keys, items, count, cap);
    for (let j = 0; j < top; j++) picked[items[j]!] = 1;
    // Unflag first, so one frame's changes never ask the core for more than `cap` at once.
    let flagged = 0;
    for (let i = 0; i < n; i++) {
      if (flag[i] !== 1) continue;
      if (picked[i] === 1) {
        flagged++;
        continue;
      }
      this.unflag(i, sink);
      stats.unflagged++;
    }
    for (let j = 0; j < top; j++) {
      const i = items[j]!;
      picked[i] = 0;
      if (flag[i] === 1) continue;
      flag[i] = 1;
      tag[i] = gen[i]! + 1;
      sink.setPanner(i, true);
      stats.flagged++;
      flagged++;
    }
    this.count = flagged;
    return flagged;
  }

  /** Unflags every flagged voice (HRTF turned off), telling `sink` for those still on the core. */
  clear(sink: HrtfSink): void {
    if (this.count === 0 && !this.anyFlag()) return;
    for (let i = 0; i < this.flag.length; i++) if (this.flag[i] === 1) this.unflag(i, sink);
    this.count = 0;
  }

  /** Slot `i` was freed: its voice left the core, so its flag goes without a message. */
  forget(i: number): void {
    if (this.flag[i] === 1) {
      this.flag[i] = 0;
      this.tag[i] = 0;
      if (this.count > 0) this.count--;
    }
  }

  private unflag(i: number, sink: HrtfSink): void {
    this.flag[i] = 0;
    this.tag[i] = 0;
    const s = this.table.state[i]!;
    if (s === S_PLAYING || s === S_VIRTUAL || s === S_STOPPING) sink.setPanner(i, false);
  }

  private anyFlag(): boolean {
    for (let i = 0; i < this.flag.length; i++) if (this.flag[i] === 1) return true;
    return false;
  }
}
