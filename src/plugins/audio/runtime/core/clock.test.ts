// A1.4-L1: tests for `ClockMap` (clock.ts), driven by a tiny in-file fake `HostClock` (hostClock.ts's `fakeHostClock`
// is A1.7's and not written yet, so this file builds its own and must not import it).
//
// Hand-computed numbers throughout: sr = 48000, so 1 ms = 48 frames, and an output timestamp {contextTime: c,
// performanceTime: t} gives an offset sample o_obs = sr * (c - t / 1000), whatever the frame's rafTime.
import { describe, expect, it } from "vitest";
import { ClockMap } from "./clock";
import type { HostClock, OutputTimestamp } from "./hostClock";

const SR = 48000;

interface FakeClock extends HostClock {
  rafMs: number;
  ts: OutputTimestamp | null;
  ct: number;
  wall: number;
}

function fakeClock(): FakeClock {
  const f: FakeClock = {
    rafMs: 0,
    ts: null,
    ct: 0,
    wall: 0,
    fake: true,
    rafTime: () => f.rafMs,
    outputTimestamp: () => f.ts,
    currentTime: () => f.ct,
    dateNow: () => f.wall,
  };
  return f;
}

/** Advances the fake's rafTime by dtMs, sets the timestamp and context time, and runs one frame. */
function frame(f: FakeClock, map: ClockMap, dtMs: number, ts: OutputTimestamp | null, ct = 0): void {
  f.rafMs += dtMs;
  f.ts = ts;
  f.ct = ct;
  map.beginFrame();
}

/** Runs n frames of dtMs each with no output timestamp (the interval filter only). */
function run(f: FakeClock, map: ClockMap, dtMs: number, n: number): void {
  for (let i = 0; i < n; i++) frame(f, map, dtMs, null);
}

/** Base timestamp: o_obs = 48000 * (2 - 1000 / 1000) = 48000 frames. */
const BASE: OutputTimestamp = { contextTime: 2, performanceTime: 1000 };
/** A timestamp whose offset sample is `frames` frames above BASE: 48000 * (2 + frames / 48000 - 1) = 48000 + frames. */
function shifted(frames: number): OutputTimestamp {
  return { contextTime: 2 + frames / SR, performanceTime: 1000 };
}

describe("ClockMap (architecture §4.3, §4.7)", () => {
  it("first output timestamp anchors: offsetFrames equals the first sample", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    // p = 1000, ts = {2, 1000}: H = 48000 * (2 + 0) = 96000; o_obs = 96000 - 1000 * 48 = 48000.
    // ct = 2.1: lambda_obs = 2.1 * 48000 - 96000 = 4800, so Lambda = 4800 at once.
    frame(f, map, 1000, BASE, 2.1);
    expect(map.anchored).toBe(true);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    expect(map.leadFrames).toBeCloseTo(4800, 6);
    expect(map.rejected).toBe(0);
    expect(map.reanchors).toBe(0);
  });

  it("offset EMA: a steady shift moves the offset by 0.1 of the difference per frame", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE);
    // o = 48000. Next sample: 192 frames above, accepted (under 240): o = 48000 + 0.1 * 192 = 48019.2.
    frame(f, map, 16, shifted(192));
    expect(map.offsetFrames).toBeCloseTo(48019.2, 6);
    // Same sample again: diff = 192 - 19.2 = 172.8, o = 48019.2 + 0.1 * 172.8 = 48036.48.
    frame(f, map, 16, shifted(192));
    expect(map.offsetFrames).toBeCloseTo(48036.48, 6);
    expect(map.rejected).toBe(0);
  });

  it("a sample more than 5 ms off the filtered offset is rejected and counted", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE);
    // 5 ms at 48 kHz = 240 frames. A sample 241 frames above o = 48000 is over the limit: rejected, o unchanged.
    frame(f, map, 16, shifted(241));
    expect(map.rejected).toBe(1);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    expect(map.reanchors).toBe(0);
  });

  it("ten rejections in a row re-anchor to the newest sample; nine do not; an accepted sample resets the run", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE);
    // Nine rejections: o stays 48000 (48241 is the rejected observation), no re-anchor.
    for (let i = 0; i < 9; i++) frame(f, map, 16, shifted(241));
    expect(map.rejected).toBe(9);
    expect(map.reanchors).toBe(0);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    // An accepted sample (o_obs = 48000, diff 0) resets the run; o stays 48000.
    frame(f, map, 16, BASE);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    // Nine more rejections: run 9 again, still no re-anchor. Rejected total 18.
    for (let i = 0; i < 9; i++) frame(f, map, 16, shifted(241));
    expect(map.rejected).toBe(18);
    expect(map.reanchors).toBe(0);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    // The tenth in a row re-anchors: o = o_obs = 48241. Rejected 19, reanchors 1.
    frame(f, map, 16, shifted(241));
    expect(map.rejected).toBe(19);
    expect(map.reanchors).toBe(1);
    expect(map.offsetFrames).toBeCloseTo(48241, 6);
  });

  it("a gap over 250 ms re-anchors without touching the frame-interval EMA", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE);
    frame(f, map, 16, BASE);
    // Delta-bar after one 16 ms interval: 1000/60 + 0.1 * (16 - 1000/60) = 16.6.
    const before = map.frameIntervalMs;
    expect(before).toBeCloseTo(16.6, 6);
    // Gap of 300 ms (over 250): stall. Observation 52800 = 48000 + 4800 is far off, but a stall re-anchors at once.
    // ts = {2.1, 1000}: o_obs = 48000 * (2.1 - 1) = 52800.
    frame(f, map, 300, { contextTime: 2.1, performanceTime: 1000 });
    expect(map.offsetFrames).toBeCloseTo(52800, 6);
    expect(map.reanchors).toBe(1);
    expect(map.rejected).toBe(0);
    expect(map.frameIntervalMs).toBe(before);
  });

  it("leadFrames attacks at once and releases 1% of the gap per frame", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    // p = 1000: Lambda = 4800 (see the first test).
    frame(f, map, 1000, BASE, 2.1);
    // p = 1016: H = 48000 * 2.016 = 96768. ct = 2.216: lambda_obs = 106368 - 96768 = 9600 > 4800: attack, Lambda = 9600.
    frame(f, map, 16, BASE, 2.216);
    expect(map.leadFrames).toBeCloseTo(9600, 6);
    // p = 1032: H = 97536. ct = 2.032: lambda_obs = 0. Release 1% of the gap: 9600 - 96 = 9504.
    frame(f, map, 16, BASE, 2.032);
    expect(map.leadFrames).toBeCloseTo(9504, 6);
    // p = 1048: H = 98304, lambda_obs = 0. Release: 9504 - 95.04 = 9408.96.
    frame(f, map, 16, BASE, 2.048);
    expect(map.leadFrames).toBeCloseTo(9408.96, 6);
  });

  it("frameIntervalMs is an EMA (0.1) of rafTime differences, starting at 1000/60", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, null);
    // First call leaves the interval at its initial value.
    expect(map.frameIntervalMs).toBeCloseTo(1000 / 60, 9);
    // dt = 20: 1000/60 + 0.1 * (20 - 1000/60) = 15 + 2 = 17.
    frame(f, map, 20, null);
    expect(map.frameIntervalMs).toBeCloseTo(17, 9);
    // dt = 30: 17 + 0.1 * (30 - 17) = 18.3.
    frame(f, map, 30, null);
    expect(map.frameIntervalMs).toBeCloseTo(18.3, 9);
  });

  it("lookaheadFrames clamps 2*interval to 1024 frames .. 100 ms", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, null);
    // 200 frames of 1 ms: interval = 1 + (1000/60 - 1) * 0.9^200 ~ 1 (error ~1e-8).
    // 2 * 1 * 48 = 96 < 1024: L = 1024.
    run(f, map, 1, 200);
    expect(map.lookaheadFrames()).toBe(1024);
    // 200 frames of 90 ms: interval ~ 90. 2 * 90 * 48 = 8640 > 4800 (100 ms): L = 4800.
    run(f, map, 90, 200);
    expect(map.lookaheadFrames()).toBe(4800);
    // 200 frames of 20 ms: interval ~ 20. 2 * 20 * 48 = 1920, inside the clamps: L = 1920.
    run(f, map, 20, 200);
    expect(map.lookaheadFrames()).toBe(1920);
  });

  it("rampFrames clamps the interval to 5..50 ms", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, null);
    // interval ~ 2 (error ~1e-8): clamped to 5 ms: 5 * 48 = 240.
    run(f, map, 2, 200);
    expect(map.rampFrames()).toBe(240);
    // interval ~ 100: clamped to 50 ms: 50 * 48 = 2400.
    run(f, map, 100, 200);
    expect(map.rampFrames()).toBe(2400);
  });

  it("framesNow and audioTime follow the primary formulas", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    // p = 1000, o = 48000, Lambda = 4800 (ct = 2.1).
    frame(f, map, 1000, BASE, 2.1);
    // framesNow = p * sr / 1000 + o + Lambda = 48000 + 48000 + 4800 = 100800.
    expect(map.framesNow()).toBeCloseTo(100800, 6);
    // audioTime = (p * sr / 1000 + o) / sr = (48000 + 48000) / 48000 = 2.
    expect(map.audioTime()).toBeCloseTo(2, 9);
  });

  it("a null output timestamp uses the STATUS fallback: currentFrame + elapsed wall time + 512", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 5000, null);
    expect(map.anchored).toBe(false);
    // STATUS: currentFrame 96000 at dateMs 10000. Now is 10500 ms: 500 ms * 48 = 24000 frames elapsed.
    map.noteStatus(96000, 10000);
    f.wall = 10500;
    // framesNow = 96000 + 24000 + 512 = 120512.
    expect(map.framesNow()).toBeCloseTo(120512, 6);
    // audioTime = (96000 + 24000) / 48000 = 2.5 (no 512).
    expect(map.audioTime()).toBeCloseTo(2.5, 9);
  });

  it("audioTime is 0 before any estimate", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    expect(map.audioTime()).toBe(0);
    expect(map.framesNow()).toBe(0);
    frame(f, map, 1000, null);
    expect(map.audioTime()).toBe(0);
    expect(map.framesNow()).toBe(0);
  });

  it("nextFirstFrame never goes backwards, even when the estimate does", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    // p = 1000, o = 48000, Lambda = 4800: framesNow = 100800. Interval 1000/60: L = 2 * 16.667 * 48 = 1600.
    // First result: round(100800 + 1600) = 102400.
    frame(f, map, 1000, BASE, 2.1);
    expect(map.nextFirstFrame()).toBe(102400);
    // A stall (300 ms) re-anchors to o_obs = 48000 * (1.375 - 1) = 18000, Lambda = max(0, 0) = 0 (ct = 1.675).
    // framesNow = 1300 * 48 + 18000 + 0 = 80400: the estimate moved backwards.
    frame(f, map, 300, { contextTime: 1.375, performanceTime: 1000 }, 1.675);
    expect(map.framesNow()).toBeCloseTo(80400, 6);
    // round(80400 + 1600) = 82000 < 102400: the result holds at 102400.
    expect(map.nextFirstFrame()).toBe(102400);
  });

  it("beginFrame twice with the same rafTime changes nothing the second time", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE, 2.1);
    const offsetBefore = map.offsetFrames;
    const leadBefore = map.leadFrames;
    const intervalBefore = map.frameIntervalMs;
    // Same rafTime (dt 0), with a timestamp that would be a rejected sample and a different context time.
    frame(f, map, 0, shifted(241), 0);
    expect(map.offsetFrames).toBe(offsetBefore);
    expect(map.leadFrames).toBe(leadBefore);
    expect(map.frameIntervalMs).toBe(intervalBefore);
    expect(map.rejected).toBe(0);
    expect(map.reanchors).toBe(0);
    // The next real frame still runs: dt 16 moves the interval to 16.6.
    frame(f, map, 16, BASE, 2.1);
    expect(map.frameIntervalMs).toBeCloseTo(16.6, 6);
  });

  it("A3.2: an output timestamp back after frames without one re-anchors at once instead of rejecting ten", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE, 2.1);
    // Three frames with no timestamp (a suspended context): the estimate holds.
    run(f, map, 16, 3);
    expect(map.offsetFrames).toBeCloseTo(48000, 6);
    // The context resumed 1 s behind: the sample is 48000 frames off, far past the 5 ms rejection, yet taken as is.
    frame(f, map, 16, shifted(-48000), 0);
    expect(map.offsetFrames).toBeCloseTo(0, 6);
    expect(map.rejected).toBe(0);
    expect(map.reanchors).toBe(1);
    // Back to normal filtering: the next off sample is rejected.
    frame(f, map, 16, shifted(-47000), 0);
    expect(map.rejected).toBe(1);
  });

  it("A3.2: frameOfTime is round(at·sr); stampFor stamps a frame after F_now and sends past ones asap", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    // F_now = 100800 (see "framesNow and audioTime follow the primary formulas").
    frame(f, map, 1000, BASE, 2.1);
    expect(map.frameOfTime(2.5)).toBe(120000);
    expect(map.frameOfTime(undefined)).toBe(0);
    expect(map.frameOfTime(Number.NaN)).toBe(0);
    expect(map.stampFor(120000)).toBe(120000);
    expect(map.stampFor(100801)).toBe(100801);
    // Heard at 2.05 s, but the core already renders at 100800: past.
    expect(map.stampFor(map.frameOfTime(2.05))).toBeUndefined();
    expect(map.stampFor(0)).toBeUndefined();
  });

  it("reset forgets the estimates but keeps the counters", () => {
    const f = fakeClock();
    const map = new ClockMap(f, SR);
    frame(f, map, 1000, BASE, 2.1);
    frame(f, map, 16, shifted(241));
    expect(map.rejected).toBe(1);
    frame(f, map, 300, shifted(4800));
    expect(map.reanchors).toBe(1);
    map.noteStatus(96000, 10000);
    expect(map.nextFirstFrame()).toBeGreaterThan(0);
    map.reset();
    expect(map.anchored).toBe(false);
    expect(map.offsetFrames).toBe(0);
    expect(map.leadFrames).toBe(0);
    expect(map.frameIntervalMs).toBeCloseTo(1000 / 60, 9);
    // The fallback pair is gone: no STATUS, so no frames and no time.
    f.wall = 10500;
    expect(map.framesNow()).toBe(0);
    expect(map.audioTime()).toBe(0);
    // The previous firstFrame is gone too: with no estimate, round(0 + 1600) = 1600, below the old 102400 or so.
    expect(map.nextFirstFrame()).toBe(1600);
    // Counters keep their counts.
    expect(map.rejected).toBe(1);
    expect(map.reanchors).toBe(1);
  });
});
