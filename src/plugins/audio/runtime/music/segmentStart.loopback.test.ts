// ADR 0166 M4a (T1): a segment's start on the real core, through the whole runtime (`Audio.play` of a music event, the
// engine's audio systems, the CoreBackend) on the deterministic-clock fixture (`testing/loopbackClock.ts`).
// "Planned frame" is the clock map's frame of the run's `startAt`; each stem is a DC clip of its own level, so the
// first non-zero sample and its level say when and which stems started. C2b's `groupStart.loopback.test.ts` covers the
// gate with the planner driven by hand; these go from `Audio.play`.
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const STEMS = 8;
const level = (k: number): number => 0.01 * (k + 1);
const sum = Array.from({ length: STEMS }, (_, k) => level(k)).reduce((a, b) => a + b, 0);

const stemsEvent = (n: number) => ({
  format: "myco.audioevent@1",
  bus: "Music",
  root: { type: "segment", id: "A", tracks: Array.from({ length: n }, (_, k) => ({ name: `t${k}`, clip: `s${k}.wav` })) },
});
const clips = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`s${k}.wav`, { level: level(k), seconds: 3 }]));

describe("a segment's start on the core (M4a, T1)", () => {
  it("starts on its planned frame, with silence before it and the stem's level from it", async (ctx) => {
    const r = await musicLoopback({ clips: clips(1), events: { "m.audioevent.json": stemsEvent(1) } });
    if (!r) return ctx.skip();
    const mark = r.out.length;
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    const planned = r.frameOfTime(run.startAt);
    expect(planned).toBeGreaterThan(mark);
    expect(r.firstDeparture(mark, 0)).toBe(planned);
    await r.step(10);
    expect(r.maxError(planned, r.out.length, level(0))).toBeLessThan(1e-4); // int16 on the wire
    expect(r.late().groupsLate).toBe(0);
    r.dispose();
  });

  it("8 stems start on one frame, at the sum of their levels from the first sample", async (ctx) => {
    const r = await musicLoopback({ clips: clips(STEMS), events: { "m.audioevent.json": stemsEvent(STEMS) } });
    if (!r) return ctx.skip();
    const mark = r.out.length;
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const run = r.player()!.run!;
    expect(run.stems).toHaveLength(STEMS);
    const planned = r.frameOfTime(run.startAt);
    await r.step(10);
    expect(r.firstDeparture(mark, 0)).toBe(planned);
    // Every stem is in the first sample (no stem a frame early or late) and the level is flat from it.
    expect(r.out[planned]!).toBeCloseTo(sum, 3); // each stem is int16 on the wire
    expect(r.maxError(planned, r.out.length, r.out[planned]!)).toBe(0);
    expect(r.late()).toEqual({ groupsLate: 0, maxSlipFrames: 0 });
    r.dispose();
  });

  it("starts on the planned frame at the e2e frame rate too (38 quanta a frame)", async (ctx) => {
    const r = await musicLoopback({ clips: clips(STEMS), events: { "m.audioevent.json": stemsEvent(STEMS) }, quantaPerFrame: 38 });
    if (!r) return ctx.skip();
    const mark = r.out.length;
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const planned = r.frameOfTime(r.player()!.run!.startAt);
    await r.step(3);
    expect(r.firstDeparture(mark, 0)).toBe(planned);
    expect(r.out[planned]!).toBeCloseTo(sum, 3); // each stem is int16 on the wire
    expect(r.late().groupsLate).toBe(0);
    expect(RATE).toBe(48_000);
    r.dispose();
  });
});
