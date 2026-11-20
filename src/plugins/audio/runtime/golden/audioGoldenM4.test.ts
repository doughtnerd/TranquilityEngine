// ADR 0166 M4-0, task Z3 (api-and-models §9 "Golden (Node, real wasm)", §10 row Z3: "native equals wasm"). The in-voice
// goldens are rendered twice: natively by `native/audio/crates/audio-core/tests/in_voice_goldens.rs` (which also nulls
// each scene against the offline reference of architecture §4.4 and writes the fixture), and here by the real committed
// wasm on the loopback host (`testing.ts`). Both must give the same bits.
//
// **The fixture** (`golden/m4/m4-<scene>.json`, written by the Rust test with `UPDATE_GOLDENS=1`; this file never writes
// it) carries everything the wasm side needs to replay the scene with no knowledge of it (its schema, the clips and the
// replay are `golden/replay.ts`'s, which every golden family shares):
// - `preset`: the four init values that differ from `LOOPBACK_PRESET` (`maxLogical`, `maxMixed`, `maxBuses`,
//   `limiterLookaheadMs`); every other preset field is `LOOPBACK_PRESET`'s (none of them changes the output).
// - `clips`: mono f32 clips at 48 kHz, each built from integers so both sides make the same bits (`clipSamples`).
// - `steps`, in order: `{ send, count }` is one BATCH whose records are the hex bytes `send` (record heads included,
//   no envelope and no batch header; `count` records), sent at the current frame (`firstFrame` = the host's `frame`,
//   as `audioGolden.test.ts`' `Stage.send` does); `{ run }` renders that many quanta into the output.
// - `frames`: the output length; `fnv1a64`: FNV-1a 64 over the left channel's f32 bytes (little-endian) then the
//   right's, as 16 lowercase hex digits (`fnv1a64`, the digest of `audio-dsp/tests/bed_identity.rs`); `splits`: the
//   core's cumulative `splitQuanta` and `voiceSplits` after the last step; `null`: the native null result against the
//   offline reference (informational here: the Rust test asserts it).
//
// Digest rule as `audioGolden.test.ts`: exact bits, no tolerance. WebAssembly's f32 arithmetic is IEEE-754 without
// fused multiply-add and the core's transcendentals are `libm` on both sides, so native and wasm agree bit for bit.

import { describe, expect, it } from "vitest";
import { fnv1a64, goldenNames, readFixture, replayFixture } from "./replay";

/**
 * The row's list (api-and-models §10 Z3): exact fade start, the power-complementary crossfade, stamped STOP, the shaped
 * gain SET_PARAMS and two class G records in one quantum (class G); each class S record at sample 50, the low-pass ramp,
 * direction with sends and the bus move (class S, Z2c's scenes); a stamped SET_VOICE_FX (D7: applies at once).
 */
const M4_CASES = [
  "m4-fade-start",
  "m4-fade-scurve-phase",
  "m4-crossfade-equal-power",
  "m4-stop-stamped",
  "m4-gain-shaped",
  "m4-two-class-g",
  "m4-s-pitch",
  "m4-s-lowpass",
  "m4-s-lowpass-ramp",
  "m4-s-direction",
  "m4-s-direction-sends",
  "m4-s-bus",
  "m4-s-paused",
  "m4-s-seek",
  "m4-s-loop",
  "m4-s-voice-fx",
] as const;

describe("in-voice goldens: native equals wasm (Z3)", () => {
  it.for(M4_CASES)("%s: the wasm output equals the native fixture's digest and split counts", async (name) => {
    const fixture = readFixture("m4", name);
    if (fixture === undefined) throw new Error(`no golden/m4/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test in_voice_goldens (native/audio)`);
    const { left, right, host } = await replayFixture(fixture);
    expect(left.length, `${fixture.scene}: frames`).toBe(fixture.frames);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite), `${fixture.scene}: finite samples`).toBe(true);
    let peak = 0;
    for (const s of [left, right]) for (const v of s) peak = Math.max(peak, Math.abs(v));
    const digest = fnv1a64(left, right);
    expect(digest, `${fixture.scene}: wasm digest ${digest} != native ${fixture.fnv1a64} (output peak ${peak})`).toBe(fixture.fnv1a64);
    // STATUS arrives every 6 quanta: render one more period (not part of the output; with no records left, the
    // cumulative counters can't move) so a scene shorter than that still reports them.
    host.renderQuanta(6);
    const last = host.statuses.at(-1);
    expect(last && { splitQuanta: last.splitQuanta, voiceSplits: last.voiceSplits }, `${fixture.scene}: split counters`).toEqual(fixture.splits);
  });

  it("golden/m4/ holds exactly the cases", () => {
    expect(goldenNames("m4")).toEqual([...M4_CASES].sort());
  });
});
