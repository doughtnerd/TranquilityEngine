// ADR 0166 K3 acceptance: `handle.music.positionAt` on the real core (the deterministic-clock fixture) matches the grid
// exactly at known sample times, across a tempo and metre change and a transition. Segment A: 120 bpm 4/4 for bars 1-2
// (a beat is 0.5 s), then 90 bpm 3/4 from bar 3 (a beat is 2/3 s). A bar-quantised cut to B (150 bpm 4/4, a beat 0.4 s)
// is asked inside bar 3 and lands on the bar line after it. The input clock is the identity map `timeAt(ms) = ms / 1000`
// so a test names a heard time exactly; `Audio.timeAt` over the real clock map is P7's.
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const SAMPLE = 1 / RATE;
const LEVEL = { a: 0.25, b: 0.5 };
const tempoA = [
  { at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 },
  { at: "3:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 },
];
const tempoB = [{ at: "1:1:0", bpm: 150, beatsPerBar: 4, beatUnit: 4 }];
const seg = (id: string, clip: string, tempo: unknown) => ({ type: "segment", id, value: id, tempo, tracks: [{ name: "t", clip }] });
const event = {
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "zone", labels: ["A", "B"] }],
  root: {
    type: "musicSwitch", id: "sw", parameter: "zone",
    children: [seg("A", "a.wav", tempoA), seg("B", "b.wav", tempoB)],
    transitions: [{ from: "A", to: "B", exit: "bar", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }],
  },
};

/** Heard time of A's bar `bar` beat `beat` (1-based) relative to A's start: bars 1-2 at 0.5 s a beat, then 2/3 s. */
function aBeatSeconds(bar: number, beat: number): number {
  if (bar <= 2) return ((bar - 1) * 4 + (beat - 1)) * 0.5;
  return 4 + ((bar - 3) * 3 + (beat - 1)) * (2 / 3);
}

describe("positionAt on the core (M4c, K3)", () => {
  it("matches the grid at sample times across a tempo change and a transition", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": { level: LEVEL.a, seconds: 20 }, "b.wav": { level: LEVEL.b, seconds: 20 } },
      events: { "sw.audioevent.json": event },
    });
    if (!r) return ctx.skip();
    const h = r.play("sw.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const t0 = r.player()!.run!.startAt;
    const start = r.frameOfTime(t0);
    (r.backend as unknown as { timeAt(ms: number): number }).timeAt = (ms) => ms / 1000;
    const music = h.music!;
    const at = (heard: number) => music.positionAt(heard * 1000);

    // Before A's first sample: not playing.
    expect(at(t0 - 0.01).segment).toBeNull();

    // Ask inside bar 3 (it starts 4 s in); the bar-quantised cut lands on bar 4's line, 6 s in.
    await r.stepToFrame(start + Math.round(4.5 * RATE));
    h.setParameter("zone", "B");
    await r.stepUntil(() => !!music.transition);
    const seam = music.transition!.time;
    expect(seam - t0).toBeCloseTo(aBeatSeconds(4, 1), 9);
    // The queries run while the change is pending: the player still holds A as its run and B as its successor, which is
    // where an input's timestamp (a frame or two old) is judged. Once the change has landed, A's past is not kept.

    const near = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThan(1e-9);
    // Every beat of A before the cut: exactly on the grid, and one sample either side.
    for (const [bar, beat] of [[1, 1], [1, 4], [2, 1], [2, 4], [3, 1], [3, 2], [3, 3]] as const) {
      const t = t0 + aBeatSeconds(bar, beat);
      const on = at(t);
      expect([on.segment, on.bar, on.beat]).toEqual(["A", bar, beat]);
      near(on.nearestBeatTime, t);
      near(on.offset, 0);
      near(on.beatFraction, 0);
      const late = at(t + SAMPLE);
      expect([late.bar, late.beat]).toEqual([bar, beat]);
      near(late.offset, SAMPLE);
      near(late.beatFraction, SAMPLE / (bar <= 2 ? 0.5 : 2 / 3));
      if (bar === 1 && beat === 1) continue;
      const early = at(t - SAMPLE);
      expect(early.segment).toBe("A");
      near(early.offset, -SAMPLE);
      near(early.nearestBeatTime, t);
      expect(early.beatFraction).toBeGreaterThan(0.999);
    }
    // Mid-beat in the 3/4 bar: the metre's beats, and the fraction.
    const mid = at(t0 + aBeatSeconds(3, 2) + (2 / 3) * 0.25);
    expect([mid.bar, mid.beat]).toEqual([3, 2]);
    near(mid.beatFraction, 0.25);
    near(mid.offset, (2 / 3) * 0.25);

    // The transition: the last sample of A is A's bar 3 beat 3 (its beat at the seam is cut off, B's first beat is the
    // nearest heard one); the seam's own sample is B's bar 1 beat 1.
    const lastA = at(seam - SAMPLE);
    expect([lastA.segment, lastA.bar, lastA.beat]).toEqual(["A", 3, 3]);
    near(lastA.nearestBeatTime, seam);
    near(lastA.offset, -SAMPLE);
    const firstB = at(seam);
    expect([firstB.segment, firstB.bar, firstB.beat]).toEqual(["B", 1, 1]);
    near(firstB.offset, 0);
    near(firstB.beatFraction, 0);
    // B's own grid at 0.4 s a beat.
    for (const [bar, beat] of [[1, 2], [1, 4], [2, 1], [3, 3], [4, 2]] as const) {
      const t = seam + ((bar - 1) * 4 + (beat - 1)) * 0.4;
      const p = at(t);
      expect([p.segment, p.bar, p.beat]).toEqual(["B", bar, beat]);
      near(p.nearestBeatTime, t);
      near(p.offset, 0);
      near(at(t - SAMPLE).offset, -SAMPLE);
      near(at(t + SAMPLE).offset, SAMPLE);
    }
    // judged is the offset less the calibration (0 here: Rh2's default).
    const tap = at(seam + 0.4 + 0.03);
    near(tap.offset, 0.03);
    near(tap.judged, tap.offset);

    // The core really cut over on the seam's frame: the sample positionAt names as B's first.
    await r.stepToFrame(r.frameOfTime(seam) + 2 * RATE);
    expect(r.firstDeparture(start, r.out[start]!)).toBe(r.frameOfTime(seam));
    r.dispose();
  });
});
