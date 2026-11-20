// 0171/0172 M5, task Rv1 (ADR 0172 owner decision 1, architecture §4.5 "Post-fader sends", R11): the one named golden of
// the post-fader flip, `golden/m5/bus-mute-send.json`. A bus with a reverb send is muted (the send stops feeding, the
// tail rings out), unmuted, then turned down (the send follows its gain). The fixture is written natively by
// `native/audio/crates/audio-core/tests/sends_post_fader_golden.rs` (`UPDATE_GOLDENS=1`) in Z3's format, plus each mute or
// unmute transition's `[first frame, frames]`; here the real committed wasm replays it (`golden/replay.ts`) on the
// loopback host and must give the same bits.
// The discontinuity check (F-40's `maxStep`) runs on the wasm output too: each mute or unmute window steps no more than
// the steady output's largest step plus the dry ramp's.

import { describe, expect, it } from "vitest";
import { maxStep } from "./maxStep";
import { fnv1a64, replayFixture, requireFixture, type Fixture } from "./replay";

interface SendsFixture extends Fixture {
  readonly toggles: readonly (readonly [number, number])[];
}

/** The scene's dry ramp step: a 0.5-gain DC voice under MASTER 0.5, ramped over the toggle's frames. */
const DRY_LEVEL = 0.25;

describe("Rv1: a muted bus with a reverb send (post-fader), native equals wasm", () => {
  it("bus-mute-send: the wasm output equals the native digest, the mute silences the send, and no toggle clicks", async () => {
    const fixture = requireFixture<SendsFixture>("m5", "bus-mute-send", "cargo test -p audio-core --test sends_post_fader_golden (native/audio)");
    const { left, right } = await replayFixture(fixture);
    expect(left.length, "frames rendered").toBe(fixture.frames);
    const digest = fnv1a64(left, right);
    expect(digest, `wasm digest ${digest} != native ${fixture.fnv1a64}`).toBe(fixture.fnv1a64);

    // Muted long enough for the tail to ring out: exactly silent before the unmute (pre-fader, the reverb kept going).
    const unmute = fixture.toggles[1]![0];
    expect(maxStep(left, unmute - 50 * 128, unmute)).toBe(0);
    expect(Math.max(...Array.from(left.subarray(unmute - 50 * 128, unmute), Math.abs))).toBe(0);

    const steady = Math.max(maxStep(left, 20 * 128, 40 * 128), maxStep(right, 20 * 128, 40 * 128));
    for (const [at, n] of fixture.toggles) {
      const bound = steady + DRY_LEVEL / n;
      const from = Math.max(0, at - 128);
      const to = Math.min(left.length, at + n + 128);
      const step = Math.max(maxStep(left, from, to), maxStep(right, from, to));
      expect(step, `toggle at ${at}: largest step ${step} over ${bound}`).toBeLessThanOrEqual(bound);
    }
  });
});
