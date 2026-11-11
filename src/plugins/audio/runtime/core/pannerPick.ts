// The panner kind per voice (ADR 0162; api-and-models §3.2 `panner`, `pannerSince`; architecture §3.1; S14, R13). Runs
// after selection (replacing H3's `hrtfPick.ts`): kind 1 (HRTF) for the top `voices.hrtf` mixed spatial voices by
// audibility (1.2x hysteresis, ADR 0157 H3), kind 2 (bed) for the other mixed spatial voices whose bus has a bed, kind 0
// (equal-power) otherwise. Changes go out as SET_PARAMS `flags` (C1); the core crossfades 45 ms.
//
// - HRTF candidates: mixed (PLAYING) spatial voices at or above `MIN_AUDIBILITY`. Virtual, stopping and paused (forced
//   virtual) voices lose the flag at once (the core drops a virtual voice's HRTF state anyway). Unflags go first, so the
//   core never holds more than `limit` HRTF voices from one frame's changes.
// - **The 500 ms kind dwell (R13, S14), in game time** (`PannerLimits.nowMs`): a voice that left HRTF for the bed stays
//   HRTF until 500 ms after its last kind change, on top of the hysteresis and selection's 3-frame dwell. A promotion
//   from bed to HRTF is exempt (a near source should sharpen), and so is a voice's first kind. The dwell guards the
//   bed switch only: with no bed on the voice's bus the 0<->1 change is M2's, instant (its goldens stand). A voice held
//   in HRTF still counts against `limit`, so a louder voice takes its slot once the hold ends, never beyond the limit.
// - A voice whose bus has no bed (or whose bed a replan removed) is equal-power: the core already resolves kind 2
//   through the bus's slot, so that change is a plain message with no dwell.
// - `flag[i]` is 1 while slot `i` is HRTF, and `panner(i)` is the kind the core holds, which a rebuild's replayed PLAY
//   carries (`replay.ts`); a freed slot is forgotten (`forget`), so a new voice in the slot starts equal-power.
// - A limit of 0 (`voices.hrtf: 0` or `audio.spatial: "equalPower"`, beds kept) flags no HRTF voice; `clear` puts every
//   voice back to equal-power.
//
// The ordering is A3.1's `rankTop` (quickselect, O(n), no sort). Nothing here allocates after construction.
import type { AudioPanner } from "../backend";
import { HYSTERESIS, MIN_AUDIBILITY, rankTop } from "./selection";
import { VoiceFlag, VoiceState, type VoiceTable } from "./voiceTable";

/** @internal `voices.hrtf`'s range (api-and-models §2): the core's bank holds this many HRTF panners. */
export const MAX_HRTF_VOICES = 32;

/** @internal R13: a voice keeps a kind this long (game time, ms) before it may leave HRTF for the bed. */
export const KIND_DWELL_MS = 500;

/** @internal The panner kinds (C1, PLAY/SET_PARAMS `flags` bits 5–6). */
export const PannerKind = {
  EQUAL_POWER: 0,
  HRTF: 1,
  /** Mixed into the voice's bus's bed (the core pans equal-power when the bus has none). */
  BED: 2,
} as const;
export type PannerKindCode = (typeof PannerKind)[keyof typeof PannerKind];

/** @internal Where `PannerPick` sends its changes (the backend: SET_PARAMS `flags`). */
export interface PannerSink {
  setPanner(i: number, kind: PannerKindCode): void;
}

/** @internal What a frame's pick needs beyond the table. */
export interface PannerLimits {
  /** `voices.hrtf` (0..32): 0 when HRTF is off (`audio.spatial: "equalPower"`, or the table failed to load). */
  readonly hrtf: number;
  /** Per bus index, its bed slot (`BED_SLOT_NONE` 0xFF: none), from the bed planner (`beds.ts`). */
  readonly bedSlot: ArrayLike<number>;
  /** Game time now, milliseconds (the 500 ms kind dwell, R13). */
  readonly nowMs: number;
}

/**
 * @internal ADR 0162 §1.1: the public name of a voice's panner. "ambisonic" for a B-format clip, "flat" for a voice
 * that isn't spatial, else the kind the pick holds ("equalPower", "hrtf", "bed").
 */
export function pannerName(kind: number, spatial: boolean, ambisonic: boolean): AudioPanner {
  if (ambisonic) return "ambisonic";
  if (!spatial) return "flat";
  return kind === PannerKind.HRTF ? "hrtf" : kind === PannerKind.BED ? "bed" : "equalPower";
}

const NO_BED = 0xff;
const S_PLAYING = VoiceState.PLAYING;
const S_VIRTUAL = VoiceState.VIRTUAL;
const S_STOPPING = VoiceState.STOPPING;
const F_SPATIAL = VoiceFlag.SPATIAL;
const F_PAUSED = VoiceFlag.PAUSED;
const EQ = PannerKind.EQUAL_POWER;
const HR = PannerKind.HRTF;
const BD = PannerKind.BED;

/** @internal The per-frame panner pick over one voice table (see the header). */
export class PannerPick {
  /** 1 while slot `i` is HRTF (what the core was last told). */
  readonly flag: Uint8Array;
  /** The kind the core holds for slot `i` (0 with no record). */
  private readonly kind: Uint8Array;
  /** The recorded voice's generation + 1 (0: no record), so a slot reused without `forget` isn't taken for it. */
  private readonly tag: Uint32Array;
  /** `nowMs` of the last `run`. */
  private lastNowMs = 0;
  /** Game time of the voice's last kind change, ms. */
  private readonly since: Float64Array;
  /** Voices HRTF after the last `run` (at most its limit) and voices on the bed. */
  count = 0;
  bedCount = 0;
  /** Cumulative kind changes that involved the bed (S8's `bedSwitches`, per voice-second). */
  bedSwitches = 0;
  /** What the last `run` did. */
  readonly stats = { candidates: 0, flagged: 0, unflagged: 0, held: 0 };
  /** Scratch: this frame's HRTF candidates (keys with the hysteresis, slot indices) and the picked mark. */
  private readonly keys: Float32Array;
  private readonly items: Uint16Array;
  private readonly picked: Uint8Array;
  private sink: PannerSink | null = null;

  constructor(readonly table: VoiceTable) {
    const n = table.capacity;
    this.flag = new Uint8Array(n);
    this.kind = new Uint8Array(n);
    this.tag = new Uint32Array(n);
    this.since = new Float64Array(n).fill(-Infinity);
    this.keys = new Float32Array(n);
    this.items = new Uint16Array(n);
    this.picked = new Uint8Array(n);
  }

  /** The panner kind the core holds for slot `i`, for a replayed PLAY. */
  panner(i: number): PannerKindCode {
    return this.tag[i] === this.table.gen[i]! + 1 ? (this.kind[i] as PannerKindCode) : EQ;
  }

  /** Slot `i`'s time in its current kind at the last `run`, game milliseconds (0 before it has changed kind; `Audio.debug()` `kindDwellMs`). */
  dwellMs(i: number): number {
    const since = this.since[i]!;
    return since === -Infinity || this.tag[i] !== this.table.gen[i]! + 1 ? 0 : Math.max(0, this.lastNowMs - since);
  }

  /** Slot `i`'s kind, for the backend's snapshot low-pass (a voice on the bed). */
  kindOf(i: number): PannerKindCode {
    return this.panner(i);
  }

  /** The frame step: each spatial voice's kind, changes to `sink`. Returns the voices flagged HRTF. */
  run(limits: PannerLimits, sink: PannerSink): number {
    const n0 = Math.floor(limits.hrtf);
    const cap = n0 > MAX_HRTF_VOICES ? MAX_HRTF_VOICES : n0 > 0 ? n0 : 0;
    const now = limits.nowMs;
    this.lastNowMs = now;
    const bedSlot = limits.bedSlot;
    let bedsOn = false;
    for (let b = 0; b < bedSlot.length; b++) {
      if (bedSlot[b] !== NO_BED) {
        bedsOn = true;
        break;
      }
    }
    const stats = this.stats;
    stats.flagged = 0;
    stats.unflagged = 0;
    stats.held = 0;
    this.sink = sink;
    const t = this.table;
    const state = t.state;
    const flags = t.flags;
    const gen = t.gen;
    const bus = t.bus;
    const audibility = t.audibility;
    const kind = this.kind;
    const keys = this.keys;
    const items = this.items;
    const picked = this.picked;
    const cap0 = t.capacity;
    const target = (i: number): PannerKindCode => ((bedSlot[bus[i]!] ?? NO_BED) !== NO_BED ? BD : EQ);

    let count = 0;
    for (let i = 0; i < cap0; i++) {
      if (this.tag[i] !== 0 && this.tag[i] !== gen[i]! + 1) this.drop(i);
      if (cap === 0 || state[i] !== S_PLAYING || (flags[i]! & F_SPATIAL) === 0 || (flags[i]! & F_PAUSED) !== 0) continue;
      const a = audibility[i]!;
      if (!(a >= MIN_AUDIBILITY)) continue;
      keys[count] = kind[i] === HR ? a * HYSTERESIS : a;
      items[count] = i;
      count++;
    }
    stats.candidates = count;
    const top = cap > 0 ? rankTop(keys, items, count, cap) : 0;
    let keptTop = 0;
    for (let j = 0; j < top; j++) {
      const i = items[j]!;
      picked[i] = 1;
      if (kind[i] === HR) keptTop++;
    }

    // Demotions first: an HRTF voice outside the top goes to the bed or equal-power, unless the dwell still holds it.
    let held = 0;
    if (this.count > 0) {
      for (let i = 0; i < cap0; i++) {
        if (kind[i] !== HR || picked[i] === 1) continue;
        const eligible = state[i] === S_PLAYING && (flags[i]! & F_SPATIAL) !== 0 && (flags[i]! & F_PAUSED) === 0;
        const to = target(i);
        if (eligible && to === BD && now - this.since[i]! < KIND_DWELL_MS && keptTop + held < cap) {
          held++;
          continue;
        }
        this.change(i, to, now);
        stats.unflagged++;
      }
    }
    stats.held = held;

    // Promotions: the top voices that aren't HRTF yet, best first, into the slots the limit leaves.
    let free = cap - keptTop - held;
    const need = top - keptTop;
    if (need > 0 && free > 0) {
      if (free >= need) {
        for (let j = 0; j < top; j++) {
          const i = items[j]!;
          if (kind[i] !== HR) this.promote(i, now);
        }
      } else {
        for (; free > 0; free--) {
          let best = -1;
          for (let j = 0; j < top; j++) {
            const i = items[j]!;
            if (kind[i] !== HR && (best < 0 || keys[j]! > keys[best]!)) best = j;
          }
          if (best < 0) break;
          this.promote(items[best]!, now);
        }
      }
    }
    for (let j = 0; j < top; j++) picked[items[j]!] = 0;

    // The rest of the mixed spatial voices: the bed where their bus has one, else equal-power.
    if (bedsOn || this.bedCount > 0) {
      for (let i = 0; i < cap0; i++) {
        if (kind[i] === HR || state[i] !== S_PLAYING || (flags[i]! & F_SPATIAL) === 0 || (flags[i]! & F_PAUSED) !== 0) continue;
        const to = target(i);
        if (kind[i] !== to) this.change(i, to, now);
      }
    }
    this.sink = null;
    return this.count;
  }

  /** Every voice back to equal-power (HRTF turned off, no beds), changes to `sink`. */
  clear(sink: PannerSink): void {
    if (this.count === 0 && this.bedCount === 0) return;
    this.sink = sink;
    for (let i = 0; i < this.kind.length; i++) if (this.kind[i] !== EQ) this.change(i, EQ, -Infinity);
    this.sink = null;
  }

  /** Slot `i` was freed: its voice left the core, so its record goes without a message. */
  forget(i: number): void {
    if (this.tag[i] !== 0) this.drop(i);
  }

  private promote(i: number, now: number): void {
    this.change(i, HR, now);
    this.stats.flagged++;
  }

  /** The slot's record goes, no message. */
  private drop(i: number): void {
    if (this.kind[i] === HR && this.count > 0) this.count--;
    else if (this.kind[i] === BD && this.bedCount > 0) this.bedCount--;
    this.kind[i] = EQ;
    this.flag[i] = 0;
    this.tag[i] = 0;
    this.since[i] = -Infinity;
  }

  /** Slot `i`'s kind becomes `to` (differs from now): recorded, counted, and told to the sink while the voice is on the core. */
  private change(i: number, to: PannerKindCode, now: number): void {
    const from = this.kind[i] as PannerKindCode;
    if (from === to) return;
    if (from === HR) this.count--;
    else if (from === BD) this.bedCount--;
    if (to === HR) this.count++;
    else if (to === BD) this.bedCount++;
    if (from === BD || to === BD) this.bedSwitches++;
    this.kind[i] = to;
    this.flag[i] = to === HR ? 1 : 0;
    this.tag[i] = this.table.gen[i]! + 1;
    this.since[i] = now;
    const s = this.table.state[i]!;
    if (s === S_PLAYING || s === S_VIRTUAL || s === S_STOPPING) this.sink?.setPanner(i, to);
  }
}
