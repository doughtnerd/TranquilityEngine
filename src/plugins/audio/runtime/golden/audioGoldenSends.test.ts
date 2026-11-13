// 0171/0172 M5, task Rv1 (ADR 0172 owner decision 1, architecture §4.5 "Post-fader sends", R11): the one named golden of
// the post-fader flip, `golden/m5/bus-mute-send.json`. A bus with a reverb send is muted (the send stops feeding, the
// tail rings out), unmuted, then turned down (the send follows its gain). The fixture is written natively by
// `native/audio/crates/audio-core/tests/sends_post_fader_golden.rs` (`UPDATE_GOLDENS=1`) in Z3's format
// (`audioGoldenM4.test.ts`); here the real committed wasm replays it on the loopback host and must give the same bits.
// The discontinuity check (F-40's `maxStep`) runs on the wasm output too: each mute or unmute window steps no more than
// the steady output's largest step plus the dry ramp's.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLoopbackHost, LOOPBACK_PRESET } from "../testing";
import { Kind, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";

const PATH = fileURLToPath(new URL("./m5/bus-mute-send.json", import.meta.url));

/**
 * Z3's fixture format (`audioGoldenM4.test.ts`' `M4Fixture`, whose renderer this repeats rather than importing that test
 * file and running its suite twice), with DC clips only, plus each mute or unmute transition's `[first frame, frames]`.
 */
interface SendsFixture {
  readonly scene: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly { readonly id: number; readonly frames: number; readonly fill: "dc"; readonly value: number }[];
  readonly steps: readonly ({ readonly send: string; readonly count: number } | { readonly run: number })[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly toggles: readonly (readonly [number, number])[];
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

/** Replays the fixture on a loopback host (clips as CLIP_BEGIN + one CLIP_CHUNK, steps as BATCHes at the host's frame). */
async function render(fixture: SendsFixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array }> {
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
    writeBatchHeader(new DataView(buffer), 0, { firstFrame: host.frame, count: step.count, flags: 0 });
    new Uint8Array(buffer, 32).set(bytes);
    host.send(buffer);
  }
  expect(at, `${fixture.scene}: frames rendered`).toBe(fixture.frames);
  return { left, right };
}

/** The largest step between neighbouring samples of `x[from..to)` (`audioGolden.test.ts`' `maxStep`). */
function maxStep(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

/** The scene's dry ramp step: a 0.5-gain DC voice under MASTER 0.5, ramped over the toggle's frames. */
const DRY_LEVEL = 0.25;

describe("Rv1: a muted bus with a reverb send (post-fader), native equals wasm", () => {
  it("bus-mute-send: the wasm output equals the native digest, the mute silences the send, and no toggle clicks", async () => {
    if (!existsSync(PATH)) throw new Error("no golden/m5/bus-mute-send.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test sends_post_fader_golden (native/audio)");
    const fixture = JSON.parse(readFileSync(PATH, "utf8")) as SendsFixture;
    const { left, right } = await render(fixture);
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
