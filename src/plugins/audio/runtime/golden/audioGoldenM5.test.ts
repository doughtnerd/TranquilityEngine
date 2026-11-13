// 0171/0172 M5-0, tasks G1 and DS0 (api-and-models §10 "Golden (Node, real wasm)": new goldens for stamped ramps, stamped
// config, the tombstone, a late sequence and a presence duck, native equals wasm; the waves plan's DS0: the discontinuity
// check on the stamped fade, snapshot, presence duck and post-fader mute scenes).
//
// The fixtures under `golden/m5/` are written natively by `native/audio/crates/audio-core/tests/m5_goldens.rs` and
// `m5_presence_golden.rs` (`UPDATE_GOLDENS=1`; this file never writes them), which also hold each scene against its
// offline reference. Here the real committed wasm replays each on the loopback host and must give the same bits, the
// same split and late counters, and stay within the fixture's discontinuity bounds (`maxStep`, F-40).
//
// The format is Z3's (`audioGoldenM4.test.ts`, whose renderer this repeats rather than importing that test file and
// running its suite twice), plus: a send step's optional `firstFrame` (the batch header's first frame when the batch
// arrives after it; otherwise the host's current frame), `late` (`lateCommands`, `maxLatenessFrames`), `null` (the
// native error against the reference, informational), `ds0` (`[from, to, bound]` windows) and `busDuck` (the presence
// duck's target slot and its voice's level: the last STATUS block's busDuck gain is checked against the output).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { Kind, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";
import { maxStep } from "./maxStep";

const M5_DIR = fileURLToPath(new URL("./m5/", import.meta.url));

interface M5Fixture {
  readonly scene: string;
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly { readonly id: number; readonly frames: number; readonly fill: "dc"; readonly value: number }[];
  readonly steps: readonly ({ readonly send: string; readonly count: number; readonly firstFrame?: number } | { readonly run: number })[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  readonly late?: { readonly lateCommands: number; readonly maxLatenessFrames: number };
  readonly null?: { readonly maxError: number; readonly tolerance: number; readonly from: number; readonly to: number };
  readonly ds0?: readonly (readonly [number, number, number])[];
  readonly busDuck?: { readonly slot: number; readonly level: number };
  /** Rv1's `bus-mute-send` only: each mute or unmute transition's `[first frame, frames]`. */
  readonly toggles?: readonly (readonly [number, number])[];
}

/** G1's scenes (`m5_goldens.rs`), the presence duck (`m5_presence_golden.rs`, after Dp1) and Rv1's named golden. */
const G1_CASES = ["stamped-fade", "stamped-snapshot", "stamped-slot", "tombstone", "late-sequence", "two-sends"] as const;
const PRESENCE = "presence-duck";
const RV1 = "bus-mute-send";

function readM5(name: string): M5Fixture {
  const path = `${M5_DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`no golden/m5/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test m5_goldens (native/audio)`);
  return JSON.parse(readFileSync(path, "utf8")) as M5Fixture;
}

/** FNV-1a 64 over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits (Z3's digest). */
function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = 0xcbf29ce484222325n;
  for (const part of [left, right]) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Replays the fixture on a loopback host (DC clips as CLIP_BEGIN + one CLIP_CHUNK; steps as BATCHes). */
async function render(fixture: M5Fixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost; readonly lateness: { max: number } }> {
  const host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, ...fixture.preset } });
  // `maxLatenessFrames` is per STATUS block (reset at each take): keep the largest any block carried.
  const lateness = { max: 0 };
  host.link.onStatus((s) => {
    lateness.max = Math.max(lateness.max, s.maxLatenessFrames);
  });
  let seq = 1;
  for (const clip of fixture.clips) {
    const begin = new ArrayBuffer(16 + 20);
    writeEnvelope(new DataView(begin), 0, { kind: Kind.CLIP_BEGIN, seq: seq++, bodyBytes: 20 });
    writeClipBegin(new DataView(begin), 0, { clipId: clip.id, frames: clip.frames, channels: 1, sampleRate: 48_000, format: 0 });
    host.send(begin);
    const samples = new Float32Array(clip.frames).fill(clip.value);
    const chunk = new ArrayBuffer(32 + samples.byteLength);
    writeEnvelope(new DataView(chunk), 0, { kind: Kind.CLIP_CHUNK, seq: seq++, bodyBytes: 16 + samples.byteLength });
    writeClipChunk(new DataView(chunk), 0, { clipId: clip.id, frameOffset: 0, frames: clip.frames, reserved: 0 });
    new Uint8Array(chunk, 32).set(new Uint8Array(samples.buffer));
    host.send(chunk);
  }
  const left = new Float32Array(fixture.frames);
  const right = new Float32Array(fixture.frames);
  let at = 0;
  for (const step of fixture.steps) {
    if ("run" in step) {
      const out = host.renderQuanta(step.run);
      left.set(out.left, at);
      right.set(out.right, at);
      at += out.left.length;
      continue;
    }
    const bytes = Uint8Array.from(step.send.match(/../g) ?? [], (b) => parseInt(b, 16));
    const buffer = new ArrayBuffer(32 + bytes.length);
    writeEnvelope(new DataView(buffer), 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: 16 + bytes.length });
    writeBatchHeader(new DataView(buffer), 0, { firstFrame: step.firstFrame ?? host.frame, count: step.count, flags: 0 });
    new Uint8Array(buffer, 32).set(bytes);
    host.send(buffer);
  }
  expect(at, `${fixture.scene}: frames rendered`).toBe(fixture.frames);
  return { left, right, host, lateness };
}

/** The largest step of both channels over `[from, to)`. */
function step2(left: Float32Array, right: Float32Array, from: number, to: number): number {
  return Math.max(maxStep(left, from, to), maxStep(right, from, to));
}

/** Digest, counters (STATUS after 6 more quanta, as Z3's test reads them), DS0's windows and the busDuck reading. */
async function checkScene(name: string): Promise<void> {
  const fixture = readM5(name);
  const { left, right, host, lateness } = await render(fixture);
  expect(left.every(Number.isFinite) && right.every(Number.isFinite), `${name}: finite`).toBe(true);
  const digest = fnv1a64(left, right);
  expect(digest, `${name}: wasm digest ${digest} != native ${fixture.fnv1a64}`).toBe(fixture.fnv1a64);
  for (const [from, to, bound] of fixture.ds0 ?? []) {
    const step = step2(left, right, from, to);
    expect(step, `${name}: DS0 ${from}..${to}: largest step ${step} over ${bound}`).toBeLessThanOrEqual(bound);
  }
  host.renderQuanta(6);
  const last = host.statuses.at(-1);
  expect(last && { splitQuanta: last.splitQuanta, voiceSplits: last.voiceSplits }, `${name}: split counters`).toEqual(fixture.splits);
  expect(fixture.splits.splitQuanta, `${name}: no split quanta`).toBe(0);
  if (fixture.late) expect(last && { lateCommands: last.lateCommands, maxLatenessFrames: lateness.max }, `${name}: late counters (lateCommands cumulative; maxLatenessFrames per block, the largest)`).toEqual(fixture.late);
  if (fixture.busDuck) {
    // The last block's busDuck gain is the duck gain at the end of the quantum ending at its `currentFrame` (STATUS
    // follows the 6/48-quantum cadence, so take whichever block came last). The scene's voice is a DC 0.5 on the target
    // with no other lane moving, so that gain is twice the output's sample just before `currentFrame`.
    const { slot, level } = fixture.busDuck;
    const item = last?.busDuck.find((d) => d.slot === slot);
    expect(item, `${name}: busDuck has slot ${slot}`).toBeDefined();
    const at = last!.currentFrame;
    expect(at, `${name}: a STATUS block inside the scene`).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(fixture.frames);
    const heard = left[at - 1]! / level;
    expect(Math.abs(item!.gain - heard), `${name}: busDuck gain ${item!.gain} at ${at}, the output says ${heard}`).toBeLessThanOrEqual(1e-6);
    expect(item!.gain).toBeLessThan(1);
  }
}

describe("M5 goldens (G1): native equals wasm", () => {
  it.for(G1_CASES)("%s: the wasm output equals the native digest; counters and DS0 windows hold", async (name) => {
    await checkScene(name);
  });

  // Needs Dp1's core (presence in `duck.rs`): enabled when Dp1 merges into G1.
  it.skip(`${PRESENCE}: the wasm output equals the native digest; the duck's DS0 window and busDuck STATUS hold`, async () => {
    await checkScene(PRESENCE);
  });

  it("golden/m5/ holds no fixture without a case", () => {
    const names = readdirSync(M5_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
    const known: readonly string[] = [...G1_CASES, PRESENCE, RV1];
    for (const name of names) expect(known, `m5/${name}.json has no case`).toContain(name);
  });
});

describe("DS0: the discontinuity check on M5-0's scenes (wasm output)", () => {
  // The stamped fade, the snapshot change and (after Dp1) the presence duck carry their windows in their fixtures and run
  // in `checkScene` above; the fixture's bound is the offline reference's own largest step plus 1 %.
  it("the stamped fade and the snapshot scenes carry DS0 windows", () => {
    for (const name of ["stamped-fade", "stamped-snapshot"]) expect(readM5(name).ds0?.length, `${name}: DS0 windows`).toBeGreaterThan(0);
  });

  // Rv1's post-fader mute (`m5/bus-mute-send`): each mute or unmute window steps no more than the steady output's largest
  // step plus the dry ramp's (the voice's 0.5 under MASTER 0.5, ramped over the toggle).
  it("post-fader mute (bus-mute-send): every toggle under its bound", async () => {
    const fixture = readM5(RV1);
    const { left, right } = await render(fixture);
    expect(fnv1a64(left, right)).toBe(fixture.fnv1a64);
    const steady = step2(left, right, 20 * 128, 40 * 128);
    for (const [at, n] of fixture.toggles ?? []) {
      const bound = steady + 0.25 / n;
      const step = step2(left, right, Math.max(0, at - 128), Math.min(left.length, at + n + 128));
      expect(step, `toggle at ${at}: ${step} over ${bound}`).toBeLessThanOrEqual(bound);
    }
    expect(fixture.toggles?.length).toBe(2);
  });
});
