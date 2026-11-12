// ADR 0166 M4a, task C3 (api-and-models §9 "Golden (Node, real wasm)", §10 row C3). The gate goldens are rendered twice:
// natively by `native/audio/crates/audio-core/tests/gate_mixed.rs` and `gate_late.rs` (which null each scene against the
// offline reference and write the fixture, `gate_common/mod.rs`), and here by the real committed wasm on the loopback
// host (`testing.ts`). Both must give the same bits and the same `groupStarts`.
//
// **The fixture** (`golden/gate-<scene>.json`, written by the Rust tests with `UPDATE_GOLDENS=1`; this file never writes
// it) is Z3's format (`audioGoldenM4.test.ts`) with three additions:
// - `preset.maxMusicRings`: the music ring pool the scene's streams open in;
// - two stream steps, handed to the shell as the decoder worker's port would (`CoreDriver.onStreamMessage`):
//   `{ open }` is a whole STREAM_OPEN message (envelope included) in hex; `{ chunk }` is a STREAM_CHUNK of `frames`
//   stereo f32 frames from stream frame `from`, each sample `noise32(seed, frame, channel)`;
// - `groupStarts`: every group start the scene reported, as `{ groupId, flags, slipFrames, startFrame }`.
// Clips are Z3's mono lcg clips (`fill: "lcg"`).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { Kind, STREAM_CHUNK_FIXED_END, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope, writeStreamChunk } from "../wire.generated";

const GOLDEN_DIR = fileURLToPath(new URL("./", import.meta.url));

/** Z3's mono f32 clip at 48 kHz, built from integers (`audioGoldenM4.test.ts`' `M4Clip`, lcg only). */
interface GateClip {
  readonly id: number;
  readonly frames: number;
  readonly fill: "lcg";
  readonly seed: number;
  readonly amp: number;
}

interface GateChunk {
  readonly stream: number;
  readonly epoch: number;
  readonly from: number;
  readonly frames: number;
  readonly flags: number;
  readonly seed: number;
}

type GateStep = { readonly send: string; readonly count: number } | { readonly run: number } | { readonly open: string } | { readonly chunk: GateChunk };

interface GroupStartEvent {
  readonly groupId: number;
  readonly flags: number;
  readonly slipFrames: number;
  readonly startFrame: number;
}

interface GateFixture {
  readonly scene: string;
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number; readonly maxMusicRings: number };
  readonly clips: readonly GateClip[];
  readonly steps: readonly GateStep[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly groupStarts: readonly GroupStartEvent[];
  readonly null: { readonly maxError: number; readonly tolerance: number };
}

/** Primed decoded and streamed stems (`gate_mixed.rs`); a slow ring's late start (`gate_late.rs`). */
export const GATE_CASES = ["gate-mixed", "gate-late"] as const;

/** A streamed member's amplitude (`gate_common::STREAM_AMP`). */
const STREAM_AMP = 0.25;

/** `gate_common::noise32`: stream frame `k`, channel `ch` of the stream seeded `seed` (every step exact in f32). */
export function noise32(seed: number, k: number, ch: number): number {
  let h = (seed ^ Math.imul((2 * k + ch) >>> 0, 0x9e3779b1)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return STREAM_AMP * ((h >>> 8) / 16777216 - 0.5);
}

function lcgSamples(clip: GateClip): Float32Array {
  const out = new Float32Array(clip.frames);
  let state = clip.seed >>> 0;
  for (let i = 0; i < clip.frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = clip.amp * ((state >>> 8) / 16777216 - 0.5);
  }
  return out;
}

/** FNV-1a 64 over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits (`gate_common::fnv1a64`). */
function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = 0xcbf29ce484222325n;
  for (const part of [left, right]) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function readFixture(name: string): GateFixture | undefined {
  const path = `${GOLDEN_DIR}${name}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GateFixture) : undefined;
}

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Plays the fixture on a loopback host; returns the output and the host. */
async function renderFixture(fixture: GateFixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost }> {
  const host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, ...fixture.preset } });
  let seq = 1;
  const lefts: Float32Array[] = [];
  const rights: Float32Array[] = [];

  for (const clip of fixture.clips) {
    const samples = lcgSamples(clip);
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    writeEnvelope(beginView, 0, { kind: Kind.CLIP_BEGIN, seq: seq++, bodyBytes: 20 });
    writeClipBegin(beginView, 0, { clipId: clip.id, frames: clip.frames, channels: 1, sampleRate: 48_000, format: 0 });
    host.send(begin);
    for (let frame = 0; frame < clip.frames; frame += 2048) {
      const part = samples.subarray(frame, frame + Math.min(2048, clip.frames - frame));
      const chunk = new ArrayBuffer(16 + 16 + part.byteLength);
      const view = new DataView(chunk);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: seq++, bodyBytes: 16 + part.byteLength });
      writeClipChunk(view, 0, { clipId: clip.id, frameOffset: frame, frames: part.length, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      host.send(chunk);
    }
  }

  for (const step of fixture.steps) {
    if ("run" in step) {
      const out = host.renderQuanta(step.run);
      lefts.push(out.left);
      rights.push(out.right);
    } else if ("send" in step) {
      const bytes = fromHex(step.send);
      const buffer = new ArrayBuffer(32 + bytes.length);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: 16 + bytes.length });
      writeBatchHeader(view, 0, { firstFrame: host.frame, count: step.count, flags: 0 });
      new Uint8Array(buffer, 32).set(bytes);
      host.send(buffer);
    } else if ("open" in step) {
      const bytes = fromHex(step.open);
      host.driver.onStreamMessage(bytes.buffer, host.frame, host.clock.dateNow());
    } else {
      const c = step.chunk;
      const samples = new Float32Array(c.frames * 2);
      for (let i = 0; i < c.frames; i++) {
        samples[2 * i] = noise32(c.seed, c.from + i, 0);
        samples[2 * i + 1] = noise32(c.seed, c.from + i, 1);
      }
      const buffer = new ArrayBuffer(STREAM_CHUNK_FIXED_END + samples.byteLength);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.STREAM_CHUNK, seq: seq++, bodyBytes: STREAM_CHUNK_FIXED_END - 16 + samples.byteLength });
      writeStreamChunk(view, 0, { streamId: c.stream, chunkSeq: 0, frames: c.frames, flags: c.flags, epoch: c.epoch });
      new Uint8Array(buffer, STREAM_CHUNK_FIXED_END).set(new Uint8Array(samples.buffer));
      host.driver.onStreamMessage(buffer, host.frame, host.clock.dateNow());
    }
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

describe("gate goldens: native equals wasm (C3)", () => {
  it("noise32 matches the Rust generator's first values", () => {
    // Worked by hand from gate_common::noise32 for seed 0, frame 0: h = 0 throughout, so (0 >>> 8) / 2^24 - 0.5 = -0.5.
    expect(noise32(0, 0, 0)).toBe(-0.125);
    // Every value is a 24-bit fraction times 0.25: exact in f32.
    for (let k = 0; k < 64; k++) for (const ch of [0, 1]) expect(Math.fround(noise32(0x1234, k, ch))).toBe(noise32(0x1234, k, ch));
  });

  it.for(GATE_CASES)("%s: the wasm output equals the native fixture's digest and group starts", async (name) => {
    const fixture = readFixture(name);
    if (fixture === undefined) throw new Error(`no golden/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test gate_mixed --test gate_late (native/audio)`);
    const { left, right, host } = await renderFixture(fixture);
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

  it("golden/ holds no gate-*.json outside the cases", () => {
    const names = readdirSync(GOLDEN_DIR)
      .filter((f) => /^gate-.*\.json$/.test(f))
      .map((f) => f.slice(0, -".json".length));
    for (const name of names) expect(GATE_CASES, `${name}.json has no case`).toContain(name);
  });
});
