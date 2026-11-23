// ADR 0343: the sequence playhead's state machine (the prototype's SQ:1283–1353), through its own interface.
import { describe, expect, it } from "vitest";
import type { LoopBehaviour } from "../../../../engine/audio/playlist/types";
import { Playhead, type PlayheadLoop, type PlayheadMove } from "./sequencePlayhead";

const B = (b: Partial<LoopBehaviour> = {}): LoopBehaviour => ({ active: "always", exit: "finish", exitFadeMs: 40, reentry: "ignore", ...b });
const loop = (start: number, end: number, b: Partial<LoopBehaviour> = {}, extra: Partial<PlayheadLoop> = {}): PlayheadLoop => ({ start, end, wrapTo: start, behaviour: B(b), ...extra });

/** Advances to `until` and returns the moves, contiguous runs merged, rounded for comparison. */
function step(p: Playhead, until: number, active: (i: number) => boolean): PlayheadMove[] {
  const raw: PlayheadMove[] = [];
  p.advance(until, active, raw);
  const out: PlayheadMove[] = [];
  for (const m of raw) {
    const prev = out[out.length - 1];
    if (prev?.kind === "run" && m.kind === "run" && Math.abs(prev.to - m.from) < 1e-9) { out[out.length - 1] = { ...prev, to: m.to }; continue; }
    out.push(m);
  }
  return out.map((m) => JSON.parse(JSON.stringify(m, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v))));
}

describe("sequence playhead", () => {
  it("plays linearly and ends at the sequence's length", () => {
    const p = new Playhead([], 2, 0, 10);
    expect(step(p, 11, () => true)).toEqual([{ kind: "run", from: 0, to: 1, at: 10 }]);
    expect(step(p, 13, () => true)).toEqual([{ kind: "run", from: 1, to: 2, at: 11 }, { kind: "end", position: 2, at: 12 }]);
    expect(p.ended).toBe(true);
  });

  it("an active loop wraps at its end to its start, exactly (a splice)", () => {
    const p = new Playhead([loop(1, 2)], 4, 0, 0);
    expect(step(p, 2.5, () => true)).toEqual([
      { kind: "run", from: 0, to: 2, at: 0 },
      { kind: "jump", from: 2, to: 1, at: 2, loop: 0, why: "wrap", fadeMs: 0 },
      { kind: "run", from: 1, to: 1.5, at: 2 },
    ]);
  });

  it("a frame that stops within float noise of a loop's end still wraps it (frames of 1/60 s from 0.1 s, the loop ending the sequence)", () => {
    const p = new Playhead([loop(0, 2)], 2, 0, 0.1);
    const moves: PlayheadMove[] = [];
    for (let t = 0.1; t < 3; t += 1 / 60) p.advance(t + 0.1, () => true, moves);
    expect(p.ended).toBe(false);
    expect(moves.filter((m) => m.kind === "jump").map((m) => m.kind === "jump" && m.why)).toEqual(["wrap"]);
  });

  it("an inactive loop with finish plays to its end and carries on; jump leaves at once; crossfade leaves with its fade", () => {
    let on = true;
    const p = new Playhead([loop(0, 2)], 3, 0, 0);
    step(p, 1, () => on);
    on = false;
    expect(step(p, 2.5, () => on)).toEqual([{ kind: "run", from: 1, to: 2.5, at: 1 }]); // no wrap at 2

    const j = new Playhead([loop(0, 2, { exit: "jump" })], 3, 0, 0);
    step(j, 1, () => true);
    expect(step(j, 1.5, () => false)).toEqual([
      { kind: "jump", from: 1, to: 2, at: 1, loop: 0, why: "exit", fadeMs: 5 },
      { kind: "run", from: 2, to: 2.5, at: 1 },
    ]);

    const x = new Playhead([loop(0, 2, { exit: "crossfade", exitFadeMs: 300 })], 3, 0, 0);
    step(x, 1, () => true);
    expect(step(x, 1.5, () => false)[0]).toEqual({ kind: "jump", from: 1, to: 2, at: 1, loop: 0, why: "exit", fadeMs: 300 });
  });

  it("finish leaves at the loop's next exit point when it has one", () => {
    const p = new Playhead([loop(0, 4, {}, { exitAfter: (from) => (from <= 1.5 ? 1.5 : 4) })], 5, 0, 0);
    step(p, 1, () => true);
    expect(step(p, 2, () => false)).toEqual([
      { kind: "run", from: 1, to: 1.5, at: 1 },
      { kind: "jump", from: 1.5, to: 4, at: 1.5, loop: 0, why: "exit", fadeMs: 0 },
      { kind: "run", from: 4, to: 4.5, at: 1.5 },
    ]);
  });

  it("an active hold point parks the playhead (once per arrival); when inactive it plays on, or goes to its leaveTo", () => {
    let held = true;
    const p = new Playhead([loop(1, 1, { active: "held" })], 3, 0, 0);
    expect(step(p, 2, () => held)).toEqual([{ kind: "run", from: 0, to: 1, at: 0 }, { kind: "park", position: 1, at: 1, loop: 0 }]);
    expect(step(p, 5, () => held)).toEqual([]);
    expect(p.position).toBe(1);
    held = false;
    expect(step(p, 5.5, () => held)).toEqual([{ kind: "run", from: 1, to: 1.5, at: 5 }]);

    const q = new Playhead([loop(1, 1, { active: "held" }, { leaveTo: 2 })], 3, 0, 0);
    step(q, 2, () => true);
    expect(step(q, 2.5, () => false)).toEqual([
      { kind: "jump", from: 1, to: 2, at: 2, loop: 0, why: "exit", fadeMs: 0 },
      { kind: "run", from: 2, to: 2.5, at: 2 },
    ]);
  });

  it("reenter jumps back into a loop that turns active again after the playhead left it; ignore doesn't", () => {
    for (const reentry of ["reenter", "ignore"] as const) {
      let on = false;
      const p = new Playhead([loop(0, 1, { active: "parameter", reentry })], 4, 0, 0);
      step(p, 0.5, () => on); // inactive: marked left, plays on
      step(p, 2, () => on);
      on = true;
      const moves = step(p, 2.5, () => on);
      if (reentry === "reenter") expect(moves[0]).toEqual({ kind: "jump", from: 2, to: 0, at: 2, loop: 0, why: "reenter", fadeMs: 5 });
      else expect(moves).toEqual([{ kind: "run", from: 2, to: 2.5, at: 2 }]);
    }
  });

  it("a hold point inside an active loop parks before the loop wraps (the innermost loop decides)", () => {
    const p = new Playhead([loop(0, 4), loop(1.6, 1.6, { active: "held", exit: "jump" })], 4, 0, 0);
    expect(step(p, 3, () => true)).toEqual([{ kind: "run", from: 0, to: 1.6, at: 0 }, { kind: "park", position: 1.6, at: 1.6, loop: 1 }]);
    const moves = step(p, 6, (i) => i === 0);
    expect(moves[0]).toEqual({ kind: "run", from: 1.6, to: 4, at: 3 });
    expect(moves[1]).toMatchObject({ kind: "jump", from: 4, to: 0, why: "wrap" });
  });

  it("a loop left is armed again once the playhead goes back before it", () => {
    let hold = true;
    const p = new Playhead([loop(0, 3), loop(1, 1, { active: "held" })], 4, 0, 0);
    step(p, 2, () => hold);
    hold = false;
    step(p, 3.5, (i) => i === 0 || hold); // leaves the hold, wraps at 3 back to 0
    hold = true;
    const moves = step(p, 6, (i) => i === 0 || hold);
    expect(moves.find((m) => m.kind === "park")).toMatchObject({ kind: "park", position: 1 });
  });

  it("seek jumps at the planned time; a clone predicts without moving the original", () => {
    const p = new Playhead([], 10, 0, 0);
    step(p, 1, () => true);
    const c = p.clone();
    step(c, 5, () => true);
    expect(p.position).toBe(1);
    const out: PlayheadMove[] = [];
    p.seek(7, out);
    expect(out).toEqual([{ kind: "jump", from: 1, to: 7, at: 1, loop: -1, why: "seek", fadeMs: 5 }]);
  });
});
