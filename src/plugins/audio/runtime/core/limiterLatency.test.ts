import { describe, expect, it } from "vitest";
import { LIMITER_MAX_LATENCY_FRAMES, limiterLatencyFrames } from "./limiterLatency";

// The same table as `the_latency_is_the_lookahead_in_whole_frames` in native/audio/crates/audio-dsp/src/limiter.rs,
// so the clock map and the core agree on the latency; `clockLoopback.test.ts` measures 72 and 0 on the real wasm.
describe("limiterLatencyFrames (A2.9, mirrors audio-dsp latency_frames)", () => {
  it("is round(ms · rate / 1000), clamped to 0..5 ms and capped at 480 frames", () => {
    expect(limiterLatencyFrames(48_000, 1.5)).toBe(72);
    expect(limiterLatencyFrames(44_100, 1.5)).toBe(66);
    expect(limiterLatencyFrames(96_000, 1.5)).toBe(144);
    expect(limiterLatencyFrames(48_000, 0)).toBe(0);
    expect(limiterLatencyFrames(96_000, 5)).toBe(LIMITER_MAX_LATENCY_FRAMES);
    expect(limiterLatencyFrames(192_000, 5)).toBe(LIMITER_MAX_LATENCY_FRAMES);
    expect(limiterLatencyFrames(192_000, 1.5)).toBe(288);
    expect(limiterLatencyFrames(48_000, 9)).toBe(240);
    expect(limiterLatencyFrames(48_000, -1)).toBe(0);
    expect(limiterLatencyFrames(48_000, Number.NaN)).toBe(72);
    expect(limiterLatencyFrames(Number.NaN, 1.5)).toBe(72);
    expect(limiterLatencyFrames(44_100, 0.01)).toBe(0);
    expect(limiterLatencyFrames(22_050, 1)).toBe(22);
    expect(limiterLatencyFrames(48_000)).toBe(72);
  });
});
