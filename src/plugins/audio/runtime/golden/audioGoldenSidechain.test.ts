// 0171/0172 M5c, task Gs1 (api-and-models §10 "Golden (Node, real wasm)": sidechain null tests, a duck against an offline
// reference, presence and level combined by min; native equals wasm; architecture §4.6).
//
// The fixtures under `golden/m5/sidechain/` are written natively by `native/audio/crates/audio-core/tests/sidechain_goldens.rs`
// (`UPDATE_GOLDENS=1`; this file never writes them), which also holds each duck against its offline reference (the
// fixture's `null` member records that error). Here the real committed wasm replays each on the loopback host and must give
// the same bits, the same split counters, stay within the fixture's DS0 windows (`maxStep`, F-40) and report the duck gain it
// rendered in its last STATUS block's `busDuck`. `level-null` (level rules over their trigger's level) and its `twin`
// (`level-null-plain`, the same scene with no rule) share one digest.
//
// The format and the replay are Z3's with G1's additions (`golden/replay.ts`).

import { describe, expect, it } from "vitest";
import { maxStep } from "./maxStep";
import { fnv1a64, goldenNames, replayFixture, requireFixture, type Fixture } from "./replay";

interface SidechainFixture extends Fixture {
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  readonly ds0?: readonly (readonly [number, number, number])[];
  readonly busDuck?: { readonly slot: number; readonly level: number };
  /** The scene this one's digest must equal (`level-null`'s no-rule twin). */
  readonly twin?: string;
}

const DUCKS = ["level-peak", "level-rms", "presence-level"] as const;
const NULL = "level-null";
const PLAIN = "level-null-plain";

function read(name: string): SidechainFixture {
  return requireFixture<SidechainFixture>("m5/sidechain", name, "cargo test -p audio-core --test sidechain_goldens (native/audio)");
}

/** Digest, split counters (STATUS after 6 more quanta), DS0's windows and the busDuck reading; returns the wasm digest. */
async function checkScene(name: string): Promise<string> {
  const fixture = read(name);
  const { left, right, host } = await replayFixture(fixture);
  expect(left.length, `${name}: frames rendered`).toBe(fixture.frames);
  expect(left.every(Number.isFinite) && right.every(Number.isFinite), `${name}: finite`).toBe(true);
  const digest = fnv1a64(left, right);
  expect(digest, `${name}: wasm digest ${digest} != native ${fixture.fnv1a64}`).toBe(fixture.fnv1a64);
  for (const [from, to, bound] of fixture.ds0 ?? []) {
    const step = Math.max(maxStep(left, from, to), maxStep(right, from, to));
    expect(step, `${name}: DS0 ${from}..${to}: largest step ${step} over ${bound}`).toBeLessThanOrEqual(bound);
  }
  if (fixture.null) expect(fixture.null.maxError, `${name}: the native error against the reference`).toBeLessThanOrEqual(fixture.null.tolerance);
  // The duck gain the core holds at the end of the scene, before the 6 quanta Z3's split check renders (the duck keeps
  // releasing through them, so this reads the scene's last quantum through the next block, rendered alone).
  if (fixture.busDuck) {
    // Music is a DC 0.5 with no other lane moving, so the gain is the output over 0.5 at the quantum's last frame.
    const { slot, level } = fixture.busDuck;
    const before = host.statuses.length;
    let at = 0;
    let heard = 0;
    for (let q = 0; q < 48 && host.statuses.length === before; q++) {
      const out = host.renderQuanta(1);
      heard = out.left[out.left.length - 1]! / level;
      at = host.frame;
    }
    const last = host.statuses.at(-1);
    expect(host.statuses.length, `${name}: a STATUS block after the scene`).toBeGreaterThan(before);
    expect(last!.currentFrame, `${name}: the block reads the quantum just rendered`).toBe(at);
    const item = last!.busDuck.find((d) => d.slot === slot);
    expect(item, `${name}: busDuck has slot ${slot}`).toBeDefined();
    expect(Math.abs(item!.gain - heard), `${name}: busDuck gain ${item!.gain} at ${at}, the output says ${heard}`).toBeLessThanOrEqual(1e-6);
    expect(item!.gain).toBeLessThan(1);
  }
  host.renderQuanta(6);
  const last = host.statuses.at(-1);
  expect(last && { splitQuanta: last.splitQuanta, voiceSplits: last.voiceSplits }, `${name}: split counters`).toEqual(fixture.splits);
  expect(fixture.splits.splitQuanta, `${name}: no split quanta`).toBe(0);
  return digest;
}

describe("Sidechain goldens (Gs1): native equals wasm", () => {
  it("level-null: level rules over their trigger's level render the no-rule scene's bits on the wasm", async () => {
    const fixture = read(NULL);
    expect(fixture.twin).toBe(`sidechain/${PLAIN}`);
    const ruled = await checkScene(NULL);
    const plain = await checkScene(PLAIN);
    expect(ruled, "level-null and level-null-plain: one digest").toBe(plain);
    expect(read(PLAIN).fnv1a64).toBe(fixture.fnv1a64);
  });

  it.for(DUCKS)("%s: the wasm output equals the native digest; DS0 windows and busDuck STATUS hold", async (name) => {
    const fixture = read(name);
    expect(fixture.null?.tolerance, `${name}: held to the offline reference at 1e-5`).toBe(1e-5);
    expect(fixture.ds0?.length, `${name}: DS0 windows`).toBeGreaterThan(0);
    await checkScene(name);
  });

  it("the duck scenes differ: peak and RMS detectors are both exercised", () => {
    const digests = new Set(DUCKS.map((n) => read(n).fnv1a64));
    expect(digests.size).toBe(DUCKS.length);
    expect(digests.has(read(NULL).fnv1a64)).toBe(false);
  });

  it("golden/m5/sidechain/ holds exactly the cases", () => {
    expect(goldenNames("m5/sidechain")).toEqual([...DUCKS, NULL, PLAIN].sort());
  });
});
