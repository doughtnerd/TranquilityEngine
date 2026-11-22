/**
 * The sequence playhead (ADR 0329 "Sequence"; the prototype's state machine, SQ:1283–1353), made exact: instead of
 * stepping by frames it moves from event to event (a loop's end, a loop's or hold point's start, an exit point, the
 * sequence's end), so a wrap lands on the loop's end to the sample and its heard time is known ahead.
 *
 * Its loops are the sequence's own loops and the loops of sync clips that drive it (a sync clip's loop moves the
 * playhead: the region of its passes, wrapping back one pass; see `sequence.ts`). The rules, in order:
 *
 * 1. **Re-entry:** a loop that turns active again after the playhead left it, with `reentry: "reenter"`, while the
 *    playhead is at or past its end, jumps back to its `wrapTo`.
 * 2. **Inside a loop** (`[start, end)`, or exactly at `start` for a hold point; the innermost when loops nest):
 *    - active hold point: the playhead **parks** there;
 *    - active region: it plays to `end` and **wraps** to `wrapTo`;
 *    - inactive: the loop is marked left, then `jump` and `crossfade` go to `end` now (a crossfade lasts `exitFadeMs`),
 *      and `finish` plays on to the loop's next exit point (`exitAfter`, by default its end) and goes to `end` from there.
 * 3. **Crossing** a loop's or hold point's start enters it (rule 2 then applies); the sequence's `length` ends it.
 *
 * A loop's "left" mark clears when the playhead goes back before the loop. Heard time runs 1:1 with sequence time.
 *
 * Pure: the caller says which loops are active (`advance`'s `active`) and acts on the moves.
 */
import type { LoopBehaviour } from "../../../../engine/audio/playlist/types";

/** Float noise allowed comparing seconds. */
const EPS = 1e-9;
/** The shortest region that wraps (a shorter one is a hold point). */
const MIN_REGION = 1e-3;
/** A seamless jump: a wrap lands where the loop's start continues the audio. */
export const SPLICE = 0;

export interface PlayheadLoop {
  /** Sequence seconds; `start == end` (or a region under 1 ms) is a hold point. */
  readonly start: number;
  readonly end: number;
  /** Where an active wrap (and a re-entry) goes. */
  readonly wrapTo: number;
  readonly behaviour: LoopBehaviour;
  /** The next point at or after `from` (inside the region) where an inactive `finish` loop leaves; absent: its end. */
  readonly exitAfter?: (from: number) => number;
  /** A hold point only: where the playhead goes when it is left (absent: it plays on from the hold). */
  readonly leaveTo?: number;
}

/** What the playhead did, in order. Heard times are seconds of the heard clock. */
export type PlayheadMove =
  /** It played sequence time `from → to` linearly over heard `at → at + (to - from)`. */
  | { kind: "run"; from: number; to: number; at: number }
  /** It jumped from `from` to `to` at heard `at`; `fadeMs` 0 is a splice. */
  | { kind: "jump"; from: number; to: number; at: number; loop: number; why: "wrap" | "exit" | "reenter" | "seek"; fadeMs: number }
  /** It parked at a hold point (reported once per arrival). */
  | { kind: "park"; position: number; at: number; loop: number }
  /** It reached the sequence's end. */
  | { kind: "end"; position: number; at: number };

interface LoopState {
  left: boolean;
  wasActive: boolean;
}

/** A cut's fade for a jump out of a loop, ms (no click). */
const EXIT_JUMP_FADE_MS = 5;

export class Playhead {
  /** Sequence seconds. */
  position: number;
  /** Heard seconds the position is at (how far the playhead has been planned). */
  time: number;
  ended = false;
  private readonly states: LoopState[];
  private parkedOn = -1;
  /** Heard time the playhead arrived at the hold point it is parked on. */
  parkedSince = Number.NaN;

  constructor(readonly loops: readonly PlayheadLoop[], readonly length: number, position: number, time: number) {
    this.position = position;
    this.time = time;
    this.states = loops.map(() => ({ left: false, wasActive: true }));
  }

  /** A copy that advances on its own (predictions: the next beat, bar or exit ahead of the plan). */
  clone(): Playhead {
    const p = new Playhead(this.loops, this.length, this.position, this.time);
    p.ended = this.ended;
    p.parkedOn = this.parkedOn;
    p.parkedSince = this.parkedSince;
    this.states.forEach((s, i) => { p.states[i]!.left = s.left; p.states[i]!.wasActive = s.wasActive; });
    return p;
  }

  /** Whether the playhead is parked at a hold point now. */
  get parked(): boolean { return this.parkedOn >= 0; }

  private isHold(l: PlayheadLoop): boolean { return l.end - l.start < MIN_REGION; }

  /** The innermost loop holding the position (-1: none). */
  private inside(active: (i: number) => boolean): number {
    let best = -1;
    const p = this.position;
    for (let i = 0; i < this.loops.length; i++) {
      const l = this.loops[i]!;
      const hit = this.isHold(l) ? Math.abs(p - l.start) <= EPS && (!this.states[i]!.left || active(i)) : p >= l.start - EPS && p < l.end - EPS;
      if (!hit) continue;
      if (best < 0 || l.start > this.loops[best]!.start || (l.start === this.loops[best]!.start && l.end < this.loops[best]!.end)) best = i;
    }
    return best;
  }

  /** Clears the "left" mark of every loop after the position (it went back before them). */
  private rewound(): void {
    for (let i = 0; i < this.loops.length; i++) if (this.loops[i]!.start > this.position + EPS) this.states[i]!.left = false;
  }

  private jump(to: number, loop: number, why: "wrap" | "exit" | "reenter" | "seek", fadeMs: number, out: PlayheadMove[]): void {
    out.push({ kind: "jump", from: this.position, to, at: this.time, loop, why, fadeMs });
    this.position = to;
    this.parkedOn = -1;
    this.rewound();
  }

  private run(to: number, out: PlayheadMove[]): void {
    if (to <= this.position + EPS) { this.position = Math.max(this.position, to); return; }
    out.push({ kind: "run", from: this.position, to, at: this.time });
    this.time += to - this.position;
    this.position = to;
    this.parkedOn = -1;
  }

  /** Jumps to sequence seconds `to` at the planned time (`handle.music.seek`); a seek past the end ends the sequence there. */
  seek(to: number, out: PlayheadMove[]): void {
    if (this.ended) return;
    this.jump(Math.max(0, Math.min(to, this.length)), -1, "seek", EXIT_JUMP_FADE_MS, out);
  }

  /** Plans the playhead up to heard time `until`, appending what it did to `out`. `active(i)` says whether loop `i` is active now. */
  advance(until: number, active: (i: number) => boolean, out: PlayheadMove[]): void {
    if (this.ended) { this.time = Math.max(this.time, until); return; }
    // 1. Re-entry (activation changes between calls).
    for (let i = 0; i < this.loops.length; i++) {
      const l = this.loops[i]!;
      const st = this.states[i]!;
      const a = active(i);
      if (a && !st.wasActive && st.left && l.behaviour.reentry === "reenter" && this.position >= l.end - EPS) {
        st.left = false;
        this.jump(l.wrapTo, i, "reenter", EXIT_JUMP_FADE_MS, out);
      }
      st.wasActive = a;
    }
    for (let guard = 0; guard < 10_000 && this.time < until - EPS; guard++) {
      const i = this.inside(active);
      const l = i >= 0 ? this.loops[i]! : null;
      const on = i >= 0 && active(i);
      if (l && this.isHold(l)) {
        if (on) {
          if (this.parkedOn !== i) { out.push({ kind: "park", position: this.position, at: this.time, loop: i }); this.parkedSince = this.time; }
          this.parkedOn = i;
          this.time = until;
          return;
        }
        this.states[i]!.left = true;
        this.parkedOn = -1;
        if (l.leaveTo !== undefined && l.leaveTo > this.position + EPS) this.jump(l.leaveTo, i, "exit", SPLICE, out);
        continue;
      }
      if (l && !on) {
        this.states[i]!.left = true;
        if (l.behaviour.exit !== "finish") {
          this.jump(l.end, i, "exit", l.behaviour.exit === "crossfade" ? l.behaviour.exitFadeMs : EXIT_JUMP_FADE_MS, out);
          continue;
        }
      }
      // Where the playhead next has something to decide.
      let target = this.length;
      for (const o of this.loops) if (o.start > this.position + EPS && o.start < target) target = o.start;
      let exitPoint = Number.NaN;
      if (l && on) target = Math.min(target, l.end);
      else if (l) {
        exitPoint = Math.min(l.end, Math.max(this.position, l.exitAfter ? l.exitAfter(this.position) : l.end));
        target = Math.min(target, exitPoint);
      }
      const room = until - this.time;
      if (target - this.position > room) { this.run(this.position + room, out); return; }
      this.run(target, out);
      if (l && on && Math.abs(this.position - l.end) <= EPS) this.jump(l.wrapTo, i, "wrap", SPLICE, out);
      else if (l && !on && Math.abs(this.position - exitPoint) <= EPS && exitPoint < l.end - EPS) this.jump(l.end, i, "exit", SPLICE, out);
      else if (this.position >= this.length - EPS) {
        this.ended = true;
        out.push({ kind: "end", position: this.position, at: this.time });
        this.time = Math.max(this.time, until);
        return;
      }
    }
  }
}
