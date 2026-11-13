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
// The format and the renderer are G1's (`audioGoldenM5.test.ts`, whose renderer this repeats rather than importing that test
// file and running its suite twice).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { Kind, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";
import { maxStep } from "./maxStep";

const DIR = fileURLToPath(new URL("./m5/sidechain/", import.meta.url));

interface SidechainFixture {
  readonly scene: string;
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly { readonly id: number; readonly frames: number; readonly fill: "dc"; readonly value: number }[];
  readonly steps: readonly ({ readonly send: string; readonly count: number; readonly firstFrame?: number } | { readonly run: number })[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  readonly null?: { readonly maxError: number; readonly tolerance: number; readonly from: number; readonly to: number };
  readonly ds0?: readonly (readonly [number, number, number])[];
  readonly busDuck?: { readonly slot: number; readonly level: number };
  /** The scene this one's digest must equal (`level-null`'s no-rule twin). */
  readonly twin?: string;
}

const DUCKS = ["level-peak", "level-rms", "presence-level"] as const;
const NULL = "level-null";
const PLAIN = "level-null-plain";

function read(name: string): SidechainFixture {
  const path = `${DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`no golden/m5/sidechain/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test sidechain_goldens (native/audio)`);
  return JSON.parse(readFileSync(path, "utf8")) as SidechainFixture;
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
async function render(fixture: SidechainFixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost }> {
  const host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, ...fixture.preset } });
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
  return { left, right, host };
}

/** Digest, split counters (STATUS after 6 more quanta), DS0's windows and the busDuck reading; returns the wasm digest. */
async function checkScene(name: string): Promise<string> {
  const fixture = read(name);
  const { left, right, host } = await render(fixture);
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

  it("golden/m5/sidechain/ holds no fixture without a case", () => {
    const names = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
    const known: readonly string[] = [...DUCKS, NULL, PLAIN];
    expect(names.length).toBe(known.length);
    for (const name of names) expect(known, `m5/sidechain/${name}.json has no case`).toContain(name);
  });
});
