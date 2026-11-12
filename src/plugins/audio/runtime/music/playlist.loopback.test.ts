// ADR 0166 M4a (T1): a playlist and a forever loop on the real core, through `Audio.play` and the engine's audio systems
// on the deterministic-clock fixture. Sample-exact: each item starts one segment length after the last (no frame lost
// or gained over many items), no group is late, and a loop's pass n is the same samples as pass 0.
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

/** A segment of `seconds` (the clip's length) at 120 bpm 4/4: a bar is 2 s. */
const seg = (id: string, clip: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, tracks: [{ name: "t", clip }], ...extra });
const event = (root: unknown) => ({ format: "myco.audioevent@1", bus: "Music", root });

describe("a playlist on the core (M4a, T1)", () => {
  it("advances item to item exactly one segment length apart over 12 items, with no late group", async (ctx) => {
    const SECONDS = 2;
    const LEN = SECONDS * RATE;
    const ITEMS = 12;
    const LEVEL = { a: 0.2, b: 0.4 };
    const r = await musicLoopback({
      clips: { "a.wav": { level: LEVEL.a, seconds: SECONDS }, "b.wav": { level: LEVEL.b, seconds: SECONDS } },
      events: { "p.audioevent.json": event({ type: "playlist", id: "p", mode: "sequence", rounds: ITEMS / 2, children: [seg("A", "a.wav"), seg("B", "b.wav")] }) },
    });
    if (!r) return ctx.skip();
    const mark = r.out.length;
    r.play("p.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const start = r.frameOfTime(r.player()!.run!.startAt);
    expect(r.firstDeparture(mark, 0)).toBe(start);
    await r.stepToFrame(start + ITEMS * LEN + 4000);

    // Item i is A for even i and B for odd, from frame start + i * LEN to the sample before the next item.
    const levels: number[] = [];
    for (let i = 0; i < ITEMS; i++) {
      const from = start + i * LEN;
      const expected = i % 2 === 0 ? LEVEL.a : LEVEL.b;
      levels.push(r.out[from]!);
      expect(r.out[from]!).toBeCloseTo(expected, 3);
      // Flat for the whole item, and the sample before it is the previous item's: the seam is on `from`, exactly.
      expect(r.maxError(from, from + LEN, r.out[from]!)).toBe(0);
      if (i > 0) expect(r.out[from - 1]!).toBe(levels[i - 1]!);
      if (i > 0) expect(r.out[from - 1]!).not.toBe(r.out[from]!);
    }
    // After the last item the playlist is over: silence from its end.
    expect(r.maxError(start + ITEMS * LEN + 100, start + ITEMS * LEN + 4000, 0)).toBe(0);
    expect(r.late()).toEqual({ groupsLate: 0, maxSlipFrames: 0 });
    expect(r.player()?.counters.lateGroups ?? 0).toBe(0);
    r.dispose();
  });
});

describe("a forever loop on the core (M4a, T1)", () => {
  it("wraps on time over 40 passes: every pass is the first pass's samples, sample for sample", async (ctx) => {
    const SECONDS = 1;
    const LEN = SECONDS * RATE;
    const PASSES = 40;
    // A signal that tells every position apart.
    const signal = (i: number): number => 0.05 + 0.9 * (((i * 2654435761) >>> 0) / 2 ** 32);
    const r = await musicLoopback({
      clips: { "l.wav": { signal, seconds: SECONDS } },
      events: {
        "l.audioevent.json": event({
          type: "segment", id: "L", tracks: [{ name: "t", clip: "l.wav" }],
          tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }],
          regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }],
        }),
      },
    });
    if (!r) return ctx.skip();
    const mark = r.out.length;
    r.play("l.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const start = r.frameOfTime(r.player()!.run!.startAt);
    expect(r.firstDeparture(mark, 0)).toBe(start);
    await r.stepToFrame(start + PASSES * LEN + 1000);
    const first = r.out.slice(start, start + LEN);
    // int16 on the wire: the first pass is what every later one must equal.
    expect(first.every((v) => v !== 0)).toBe(true);
    for (const pass of [1, 2, 3, 10, 25, PASSES - 1, PASSES]) {
      const from = start + pass * LEN;
      const to = Math.min(from + LEN, r.out.length);
      expect(to - from).toBeGreaterThanOrEqual(1000);
      expect(r.maxError(from, to, (i) => first[i - from]!)).toBe(0);
    }
    expect(r.late()).toEqual({ groupsLate: 0, maxSlipFrames: 0 });
    r.dispose();
  });
});
