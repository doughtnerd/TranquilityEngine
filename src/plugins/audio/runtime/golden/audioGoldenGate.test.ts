// ADR 0166 M4a, task C3 (api-and-models §9 "Golden (Node, real wasm)", §10 row C3). The gate goldens are rendered twice:
// natively by `native/audio/crates/audio-core/tests/gate_{mixed,late,held,rebased}.rs` (which null each scene against the
// offline reference and write the fixture, `gate_common/mod.rs`), and here by the real committed wasm on the loopback
// host (`testing.ts`). Both must give the same bits and the same `groupStarts`.
//
// **The fixture** (`golden/gate/gate-<scene>.json`, written by the Rust tests with `UPDATE_GOLDENS=1`; this file never
// writes it) is Z3's format with three additions, all replayed by `golden/replay.ts`:
// - `preset.maxMusicRings`: the music ring pool the scene's streams open in;
// - two stream steps, handed to the shell as the decoder worker's port would (`CoreDriver.onStreamMessage`):
//   `{ open }` is a whole STREAM_OPEN message (envelope included) in hex; `{ chunk }` is a STREAM_CHUNK of `frames`
//   stereo f32 frames from stream frame `from`, each sample `noise32(seed, frame, channel)`;
// - `groupStarts`: every group start the scene reported, as `{ groupId, flags, slipFrames, startFrame }`.
// Clips are Z3's mono lcg clips (`fill: "lcg"`).

import { describe, expect, it } from "vitest";
import { fnv1a64, goldenNames, readFixture, replayFixture, type Fixture } from "./replay";

interface GroupStartEvent {
  readonly groupId: number;
  readonly flags: number;
  readonly slipFrames: number;
  readonly startFrame: number;
}

interface GateFixture extends Fixture {
  readonly groupStarts: readonly GroupStartEvent[];
}

/** Primed decoded and streamed stems (`gate_mixed.rs`), a slow ring's late start (`gate_late.rs`), a held group's dip and aligned resume (`gate_held.rs`), a rebased late group (`gate_rebased.rs`). */
const GATE_CASES = ["gate-mixed", "gate-late", "gate-held", "gate-rebased"] as const;

describe("gate goldens: native equals wasm (C3)", () => {
  it.for(GATE_CASES)("%s: the wasm output equals the native fixture's digest and group starts", async (name) => {
    const fixture = readFixture<GateFixture>("gate", name);
    if (fixture === undefined) throw new Error(`no golden/gate/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test gate_mixed --test gate_late --test gate_held --test gate_rebased (native/audio)`);
    const { left, right, host } = await replayFixture(fixture);
    expect(left.length, `${fixture.scene}: frames`).toBe(fixture.frames);
    let peak = 0;
    for (const s of [left, right]) for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak, `${fixture.scene}: audible`).toBeGreaterThan(0.01);
    const digest = fnv1a64(left, right);
    expect(digest, `${fixture.scene}: wasm digest ${digest} != native ${fixture.fnv1a64} (output peak ${peak})`).toBe(fixture.fnv1a64);
    // STATUS arrives every 6 quanta: one more period so the last events are posted.
    host.renderQuanta(6);
    const starts = host.statuses.flatMap((s) => s.groupStarts.map((g) => ({ groupId: g.groupId, flags: g.flags, slipFrames: g.slipFrames, startFrame: g.startFrameHi * 2 ** 32 + g.startFrameLo })));
    expect(starts, `${fixture.scene}: groupStarts`).toEqual(fixture.groupStarts);
  });

  it("golden/gate/ holds exactly the cases", () => {
    expect(goldenNames("gate")).toEqual([...GATE_CASES].sort());
  });
});
