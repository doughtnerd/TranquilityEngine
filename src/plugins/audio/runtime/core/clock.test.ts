// A1.4-L1: tests for `ClockMap` (clock.ts), driven by a tiny in-file fake `HostClock` (hostClock.ts's `fakeHostClock`
// is A1.7's and not written yet, so this file builds its own and must not import it).
import { describe, it } from "vitest";

describe("ClockMap (architecture §4.3, §4.7)", () => {
  it.todo("first output timestamp anchors: offsetFrames equals the first sample");
  it.todo("offset EMA: a steady shift moves the offset by 0.1 of the difference per frame");
  it.todo("a sample more than 5 ms off the filtered offset is rejected and counted");
  it.todo("ten rejections in a row re-anchor to the newest sample; nine do not; an accepted sample resets the run");
  it.todo("a gap over 250 ms re-anchors without touching the frame-interval EMA");
  it.todo("leadFrames attacks at once and releases 1% of the gap per frame");
  it.todo("frameIntervalMs is an EMA (0.1) of rafTime differences, starting at 1000/60");
  it.todo("lookaheadFrames clamps 2*interval to 1024 frames .. 100 ms");
  it.todo("rampFrames clamps the interval to 5..50 ms");
  it.todo("framesNow and audioTime follow the primary formulas");
  it.todo("a null output timestamp uses the STATUS fallback: currentFrame + elapsed wall time + 512");
  it.todo("audioTime is 0 before any estimate");
  it.todo("nextFirstFrame never goes backwards, even when the estimate does");
  it.todo("beginFrame twice with the same rafTime changes nothing the second time");
  it.todo("reset forgets the estimates but keeps the counters");
});
