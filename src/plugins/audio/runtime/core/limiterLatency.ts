// The core's fixed output latency (ADR 0157, A2.9): the master limiter's look-ahead delays everything the core renders
// by a constant number of frames, set once when the core starts from `audio.limiterLookaheadMs`. This mirrors
// `latency_frames` in `native/audio/crates/audio-dsp/src/limiter.rs` exactly (the same f32 ms, the same rounding and
// cap), so the clock map (clock.ts) knows when a rendered frame is heard. `limiterLatency.test.ts` checks the Rust
// table; `clockLoopback.test.ts` measures the latency on the real wasm.
import { DEFAULT_LIMITER_LOOKAHEAD_MS, LIMITER_LOOKAHEAD_LIMITS } from "../../../../engine/audio/settings";

/** @internal The limiter's delay line in frames: 5 ms at 96 kHz (`MAX_LATENCY_FRAMES`); a higher rate is capped here. */
export const LIMITER_MAX_LATENCY_FRAMES = 480;

/**
 * @internal The core's output latency in frames for a look-ahead of `lookaheadMs` at `sampleRate`: round(ms·rate/1000)
 * with the ms as the f32 the core receives, clamped to 0..5 (NaN is the 1.5 ms default), capped at 480 frames.
 * 72 at 48 kHz and 66 at 44.1 kHz for 1.5 ms; 0 for 0 ms. A rate that isn't a positive number counts as 48 kHz.
 */
export function limiterLatencyFrames(sampleRate: number, lookaheadMs: number = DEFAULT_LIMITER_LOOKAHEAD_MS): number {
  const [min, max] = LIMITER_LOOKAHEAD_LIMITS;
  const ms = Number.isNaN(lookaheadMs) ? DEFAULT_LIMITER_LOOKAHEAD_MS : Math.min(max, Math.max(min, Math.fround(lookaheadMs)));
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.fround(sampleRate) : 48_000;
  return Math.min(Math.round((ms * rate) / 1000), LIMITER_MAX_LATENCY_FRAMES);
}
