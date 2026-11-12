// ADR 0166 M4a (T1): quantised changes land on the grid on the real core, through `Audio.play`, `setParameter` and
// `trigger` (the public API) and the engine's audio systems, on the deterministic-clock fixture. 120 bpm 4/4: a beat is
// 24,000 frames, a bar 96,000. Segment A starts at frame `start`, so its grid points are `start + k * 24,000`. The
// landing is read off the output (the first sample that leaves A's level), not off the planner's number alone.
// Quantised stem automation is F-9's `events/musicQuantizedLoopback.test.ts` (sample-exact on the beat); it isn't
// repeated here. Recovery after a rebuild is P9's `core/musicRecoveryLoopback.test.ts`.
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE, type MusicLoopback } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const BEAT = RATE / 2;
const BAR = 4 * BEAT;
const LEVEL = { a: 0.25, b: 0.5, hit: 0.125 };
const TEMPO = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const seg = (id: string, clip: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, value: id, tempo: TEMPO, tracks: [{ name: "t", clip }], ...extra });

/** A switch over A and B with one rule A to B. */
const switchEvent = (rule: Record<string, unknown>) => ({
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "zone", labels: ["A", "B"] }],
  root: { type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A", "a.wav"), seg("B", "b.wav")], transitions: [{ from: "A", to: "B", ...rule }] },
});
const clips = { "a.wav": { level: LEVEL.a, seconds: 20 }, "b.wav": { level: LEVEL.b, seconds: 20 } };

/** A plays; after `wait` frames of audio the change to B is asked. Returns A's start, the planned seam and the handle. */
async function asked(r: MusicLoopback, waitFrames: number) {
  const h = r.play("sw.audioevent.json");
  await r.stepUntil(() => r.player()?.run?.state === "playing");
  const start = r.frameOfTime(r.player()!.run!.startAt);
  await r.stepToFrame(start + waitFrames);
  h.setParameter("zone", "B");
  await r.stepUntil(() => !!h.music?.transition);
  const seam = r.frameOfTime(h.music!.transition!.time);
  return { start, seam, h };
}

describe("quantised transitions on the core (M4a, T1)", () => {
  for (const [grid, unit] of [["beat", BEAT], ["bar", BAR]] as const) {
    it(`a cut on the ${grid} lands on the grid: A through the sample before it, B from it`, async (ctx) => {
      const r = await musicLoopback({ clips, events: { "sw.audioevent.json": switchEvent({ exit: grid, fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }) } });
      if (!r) return ctx.skip();
      // Asked a third of a unit past a grid point, so the next point is not the one the change was asked on.
      const { start, seam } = await asked(r, 3 * BAR + Math.round(unit / 3));
      expect((seam - start) % unit).toBe(0);
      expect(seam).toBeGreaterThan(start + 3 * BAR + unit / 3);
      await r.stepToFrame(seam + 20_000);
      const a = r.out[start]!;
      expect(a).toBeCloseTo(LEVEL.a, 3);
      expect(r.maxError(start, seam, a)).toBe(0);
      expect(r.out[seam]!).toBeCloseTo(LEVEL.b, 3);
      expect(r.maxError(seam, seam + 20_000, r.out[seam]!)).toBe(0);
      expect(r.late().groupsLate).toBe(0);
      r.dispose();
    });
  }

  it("a linear crossfade on the beat starts its ramps on the grid point and ends on B alone", async (ctx) => {
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const r = await musicLoopback({
      clips,
      events: { "sw.audioevent.json": switchEvent({ exit: "beat", fadeOut: { seconds, curve: "linear" }, fadeIn: { seconds, curve: "linear" } }) },
    });
    if (!r) return ctx.skip();
    const { start, seam } = await asked(r, 5 * BEAT + 5000);
    expect((seam - start) % BEAT).toBe(0);
    await r.stepToFrame(seam + n + 10_000);
    const a = r.out[start]!;
    const b = r.out[seam + n + 100]!;
    expect(b).toBeCloseTo(LEVEL.b, 3);
    // A alone to the sample before the grid point; the first step of the ramps is the grid point's own sample.
    expect(r.maxError(start, seam, a)).toBe(0);
    expect(r.firstDeparture(start, a)).toBe(seam);
    // A crossfade stays between the two levels, and B is alone once the ramps end.
    for (let i = seam; i < seam + n; i++) expect(r.out[i]!).toBeGreaterThanOrEqual(Math.min(a, b) - 1e-4);
    expect(r.maxError(seam + n + 1, seam + n + 10_000, b)).toBe(0);
    expect(r.late().groupsLate).toBe(0);
    r.dispose();
  });
});

describe("a stinger on the core (M4a, T1)", () => {
  const stingerEvent = (at: unknown) => ({
    format: "myco.audioevent@1",
    bus: "Music",
    root: {
      type: "playlist", id: "p", mode: "sequence",
      children: [seg("A", "a.wav")],
      library: [seg("hit", "hit.wav")],
      stingers: [{ trigger: "hit", segment: "hit", at }],
    },
  });
  const stingerClips = { "a.wav": { level: LEVEL.a, seconds: 20 }, "hit.wav": { level: LEVEL.hit, seconds: 1 } };

  for (const [at, unit] of [["beat", BEAT], ["bar", BAR]] as const) {
    it(`lands on its ${at} grid point, sounds over the music for its length, and ends cleanly`, async (ctx) => {
      const r = await musicLoopback({ clips: stingerClips, events: { "st.audioevent.json": stingerEvent(at) } });
      if (!r) return ctx.skip();
      const h = r.play("st.audioevent.json");
      await r.stepUntil(() => r.player()?.run?.state === "playing");
      const start = r.frameOfTime(r.player()!.run!.startAt);
      // Triggered a third of a unit past a grid point.
      const asked = start + 2 * BAR + Math.round(unit / 3);
      await r.stepToFrame(asked);
      expect(h.trigger("hit")).toBe(true);
      await r.stepToFrame(asked + 5 * BAR);
      const a = r.out[start]!;
      const hit = r.firstDeparture(start, a);
      expect(hit).toBeGreaterThan(asked);
      expect((hit - start) % unit).toBe(0);
      // The grid point after the one the stinger was asked on, or the one after that when the lead said so.
      expect(hit - asked).toBeLessThanOrEqual(2 * unit);
      // The stinger adds its level over A for exactly its 1 s, sample-exact at both ends.
      const len = RATE;
      expect(r.out[hit]!).toBeCloseTo(a + LEVEL.hit, 3);
      expect(r.maxError(hit, hit + len, r.out[hit]!)).toBe(0);
      expect(r.out[hit + len]!).toBe(a);
      expect(r.maxError(hit + len, hit + len + 2 * BAR, a)).toBe(0);
      expect(r.player()!.counters.stingers.played).toBe(1);
      expect(r.late().groupsLate).toBe(0);
      r.dispose();
    });
  }
});
