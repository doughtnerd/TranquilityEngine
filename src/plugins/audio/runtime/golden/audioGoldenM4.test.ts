// ADR 0166 M4-0, task Z3 (api-and-models §9 "Golden (Node, real wasm)", §10 row Z3: "native equals wasm"). The in-voice
// goldens are rendered twice: natively by `native/audio/crates/audio-core/tests/in_voice_goldens.rs` (which also nulls
// each scene against the offline reference of architecture §4.4 and writes the fixture), and here by the real committed
// wasm on the loopback host (`testing.ts`). Both must give the same bits.
//
// **The fixture** (`golden/m4-<scene>.json`, written by the Rust test with `UPDATE_GOLDENS=1`; this file never writes
// it) carries everything the wasm side needs to replay the scene with no knowledge of it:
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { Kind, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";
import type { CorePreset } from "../worklet/coreDriver";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 over the bytes of `bytes`, as a BigInt. */
function fnv1aBytes(hash: bigint, bytes: Uint8Array): bigint {
  let h = hash;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * FNV_PRIME) & MASK64;
  return h;
}

const GOLDEN_DIR = fileURLToPath(new URL("./", import.meta.url));

/** A mono f32 clip at 48 kHz built from integers (identical bits on both sides). */
export interface M4Clip {
  readonly id: number;
  readonly frames: number;
  /**
   * `"dc"`: every sample `value` (a value exact in f32). `"lcg"`: `state = (state × 1,664,525 + 1,013,904,223) mod 2³²`
   * from `seed`, advanced once before each sample; the sample is `amp × ((state >>> 8) / 2²⁴ − 0.5)` (`amp` a power of
   * two, so every step is exact in f32).
   */
  readonly fill: "dc" | "lcg";
  readonly value?: number;
  readonly seed?: number;
  readonly amp?: number;
}

/** One step of a scene: a BATCH (record bytes in hex, `count` records) at the current frame, or `run` quanta. */
export type M4Step = { readonly send: string; readonly count: number } | { readonly run: number };

/** A fixture as the Rust test writes it (`golden/m4-<scene>.json`). */
export interface M4Fixture {
  readonly scene: string;
  /** What the scene shows, in a sentence. */
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly M4Clip[];
  readonly steps: readonly M4Step[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  /** The native null against the offline reference: the largest error and the bound it is held to (absent for a scene with no curve reference). */
  readonly null?: { readonly maxError: number; readonly tolerance: number };
}

/**
 * The row's list (api-and-models §10 Z3): exact fade start, the power-complementary crossfade, stamped STOP, the shaped
 * gain SET_PARAMS and two class G records in one quantum (class G); each class S record at sample 50, the low-pass ramp,
 * direction with sends and the bus move (class S, Z2c's scenes); a stamped SET_VOICE_FX (D7: applies at once).
 */
export const M4_CASES = [
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

/** Reads `golden/<name>.json`, or `undefined` when the Rust test hasn't written it. */
export function readFixture(name: string): M4Fixture | undefined {
  const path = `${GOLDEN_DIR}${name}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as M4Fixture) : undefined;
}

/** FNV-1a 64 (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over `left`'s bytes then `right`'s, as 16 lowercase hex digits. */
export function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = FNV_OFFSET;
  for (const part of [left, right]) h = fnv1aBytes(h, new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  return h.toString(16).padStart(16, "0");
}

/** A fixture clip's samples (see `M4Clip`). */
export function clipSamples(clip: M4Clip): Float32Array {
  const out = new Float32Array(clip.frames);
  if (clip.fill === "dc") {
    out.fill(clip.value ?? 0);
    return out;
  }
  const amp = clip.amp ?? 1;
  let state = (clip.seed ?? 0) >>> 0;
  for (let i = 0; i < clip.frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amp * ((state >>> 8) / 16777216 - 0.5);
  }
  return out;
}

/** `LOOPBACK_PRESET` with the fixture's four values. */
export function presetOf(fixture: M4Fixture): CorePreset {
  return {
    ...LOOPBACK_PRESET,
    maxLogical: fixture.preset.maxLogical,
    maxMixed: fixture.preset.maxMixed,
    maxBuses: fixture.preset.maxBuses,
    limiterLookaheadMs: fixture.preset.limiterLookaheadMs,
  };
}

/** Builds a loopback host with `presetOf(fixture)`, loads the clips (CLIP_BEGIN + CLIP_CHUNKs, format 0), plays the steps; returns the output and the host. */
export async function renderFixture(fixture: M4Fixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost }> {
  const host = await createLoopbackHost({ preset: presetOf(fixture) });
  let seq = 1;
  const lefts: Float32Array[] = [];
  const rights: Float32Array[] = [];

  for (const clip of fixture.clips) {
    const samples = clipSamples(clip);
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    writeEnvelope(beginView, 0, { kind: Kind.CLIP_BEGIN, seq: seq++, bodyBytes: 20 });
    writeClipBegin(beginView, 0, { clipId: clip.id, frames: clip.frames, channels: 1, sampleRate: 48_000, format: 0 });
    host.send(begin);
    for (let frame = 0; frame < clip.frames; frame += 2048) {
      const n = Math.min(2048, clip.frames - frame);
      const part = samples.subarray(frame, frame + n);
      const chunk = new ArrayBuffer(16 + 16 + part.byteLength);
      const view = new DataView(chunk);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: seq++, bodyBytes: 16 + part.byteLength });
      writeClipChunk(view, 0, { clipId: clip.id, frameOffset: frame, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      host.send(chunk);
    }
  }

  for (const step of fixture.steps) {
    if ("run" in step) {
      const out = host.renderQuanta(step.run);
      lefts.push(out.left);
      rights.push(out.right);
      continue;
    }
    const hex = step.send;
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
    const buffer = new ArrayBuffer(32 + bytes.length);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: 16 + bytes.length });
    writeBatchHeader(view, 0, { firstFrame: host.frame, count: step.count, flags: 0 });
    new Uint8Array(buffer, 32).set(bytes);
    host.send(buffer);
  }

  return { left: concat(lefts), right: concat(rights), host };
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("in-voice goldens: native equals wasm (Z3)", () => {
  it("fnv1a64: the empty input is the offset basis, and one f32 1.0 hashes as its four bytes", () => {
    expect(fnv1a64(new Float32Array(0), new Float32Array(0))).toBe("cbf29ce484222325");
    // 1.0f32 is 0x3f800000, little-endian bytes 00 00 80 3f; folded byte by byte, by hand.
    let h = 0xcbf29ce484222325n;
    for (const b of [0x00, 0x00, 0x80, 0x3f]) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    expect(fnv1a64(new Float32Array([1]), new Float32Array(0))).toBe(h.toString(16).padStart(16, "0"));
  });

  it("clipSamples: dc and lcg clips are built exactly", () => {
    expect(Array.from(clipSamples({ id: 0, frames: 4, fill: "dc", value: 0.5 }))).toEqual([0.5, 0.5, 0.5, 0.5]);
    // seed 1: state = 1 * 1664525 + 1013904223 = 1015568748; the first sample is (state >>> 8) / 2^24 - 0.5.
    const lcg = clipSamples({ id: 1, frames: 2, fill: "lcg", seed: 1, amp: 1 });
    expect(lcg.length).toBe(2);
    expect(lcg[0]).toBe((1015568748 >>> 8) / 16777216 - 0.5);
  });

  it.for(M4_CASES)("%s: the wasm output equals the native fixture's digest and split counts", async (name) => {
    const fixture = readFixture(name);
    if (fixture === undefined) throw new Error(`no golden/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test in_voice_goldens (native/audio)`);
    const { left, right, host } = await renderFixture(fixture);
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

  it("golden/ holds no m4-*.json outside the cases", () => {
    const names = readdirSync(GOLDEN_DIR)
      .filter((f) => /^m4-.*\.json$/.test(f))
      .map((f) => f.slice(0, -".json".length));
    for (const name of names) expect(M4_CASES, `${name}.json has no case`).toContain(name);
  });
});
