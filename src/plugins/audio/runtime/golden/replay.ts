// @internal Test support (ADR 0166 M4-0 task Z3 and the golden families after it; consistent with ADR 0221 and 0234): the
// one replay of the audio goldens on the committed wasm. Never imported by runtime code.
//
// **Where fixtures live.** One folder per suite under `golden/` (`goldenDir`): `core/` (`audioGolden.test.ts`),
// `zones/` (`core/zonesLoopback.test.ts`), `m4/` and `gate/` (written natively by
// `in_voice_goldens.rs` and `gate_*.rs`), `m5/` and `m5/sidechain/` (`m5_goldens.rs`, `sends_post_fader_golden.rs`,
// `sidechain_goldens.rs`), `seams/` (written by the retired music runtime's `music/seam.test.ts`, kept as recorded wire traces), `loudness/` (`loudness_ebu.rs`). A suite owns its folder, so
// "the folder holds exactly the suite's files" needs no filename prefix.
//
// **Z3's fixture** (`Fixture`): `preset` (the init values that differ from `LOOPBACK_PRESET`), `clips` (mono f32 clips at
// 48 kHz built from integers, `clipSamples`), `steps` in order, `frames` and `fnv1a64`, plus what a family adds. A step is
// `{ send, count, firstFrame? }`, one BATCH of `count` records whose bytes are the hex `send` (record heads included, no
// envelope or batch header), stamped `firstFrame` or else the host's current frame; `{ run }`, that many quanta rendered
// into the output; or the gate family's streams, handed in as the decoder worker's port would: `{ open }`, a whole
// STREAM_OPEN message in hex, and `{ chunk }`, a STREAM_CHUNK of `frames` stereo frames of `noise32` from stream frame
// `from`. `replayFixture` plays any of them on `createLoopbackHost` and returns the output; each suite keeps its own checks.
//
// **Digests.** `fnv1a64` is Z3's (FNV-1a 64 over the left channel's f32 bytes then the right's, the native tests' digest).
// `levelDigest` is the wasm-only goldens' (SHA-256 of the same bytes, with per-block levels so a failure says what moved).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost, type LoopbackStreamPort } from "../testing";
import { Kind, STREAM_CHUNK_FIXED_END, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope, writeStreamChunk } from "../wire.generated";
import type { CorePreset } from "../worklet/coreDriver";

/** `UPDATE_GOLDENS=1`: the wasm-only suites write their fixtures instead of comparing. */
export const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "1";

/** A suite's fixture folder (see the header). */
export type GoldenSuite = "core" | "zones" | "m4" | "gate" | "m5" | "m5/sidechain" | "seams" | "loudness";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

/** The absolute path of `suite`'s folder, ending in `/`. */
export function goldenDir(suite: GoldenSuite): string {
  return `${ROOT}${suite}/`;
}

/** The names (without `.json`) of the fixtures in `suite`'s folder. */
export function goldenNames(suite: GoldenSuite): string[] {
  const dir = goldenDir(suite);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort() : [];
}

// --- digests -------------------------------------------------------------------------------------------------------------

/** FNV-1a 64 (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits. */
export function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = 0xcbf29ce484222325n;
  for (const part of [left, right]) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The frames a level block covers. */
export const LEVEL_BLOCK = 1024;

/** A wasm-only golden: the output's SHA-256 and its levels. */
export interface LevelGolden {
  scene: string;
  frames: number;
  /** SHA-256 (hex) of the left channel's f32 bytes followed by the right's. */
  sha256: string;
  peak: number;
  rms: number;
  /** Per block of `LEVEL_BLOCK` frames: [rmsL, peakL, rmsR, peakR]. */
  blocks: number[][];
}

const sig = (v: number): number => Number(v.toPrecision(6));

/** The golden of an output. */
export function levelDigest(scene: string, left: Float32Array, right: Float32Array): LevelGolden {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
  hash.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  const stat = (x: Float32Array, from: number, to: number): [number, number] => {
    let sum = 0;
    let peak = 0;
    for (let i = from; i < to; i++) {
      sum += x[i]! * x[i]!;
      peak = Math.max(peak, Math.abs(x[i]!));
    }
    return [Math.sqrt(sum / (to - from)), peak];
  };
  const blocks: number[][] = [];
  for (let from = 0; from < left.length; from += LEVEL_BLOCK) {
    const to = Math.min(left.length, from + LEVEL_BLOCK);
    const [rl, pl] = stat(left, from, to);
    const [rr, pr] = stat(right, from, to);
    blocks.push([sig(rl), sig(pl), sig(rr), sig(pr)]);
  }
  const [rmsL, peakL] = stat(left, 0, left.length);
  const [rmsR, peakR] = stat(right, 0, right.length);
  return { scene, frames: left.length, sha256: hash.digest("hex"), peak: sig(Math.max(peakL, peakR)), rms: sig(Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2)), blocks };
}

const dB = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));
const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : String(x));

/** What moved between a golden and an output whose digests differ: frames, overall levels, and the blocks that changed. */
export function explainLevels(suite: GoldenSuite, want: LevelGolden, got: LevelGolden): string {
  const lines = [`scene "${got.scene}": output differs from golden/${suite}/${got.scene}.json`, `  sha256 ${want.sha256.slice(0, 16)}... -> ${got.sha256.slice(0, 16)}...`];
  if (want.frames !== got.frames) lines.push(`  frames ${want.frames} -> ${got.frames}`);
  lines.push(`  overall peak ${fmt(dB(want.peak))} -> ${fmt(dB(got.peak))} dBFS, rms ${fmt(dB(want.rms))} -> ${fmt(dB(got.rms))} dBFS`);
  let moved = 0;
  let first = -1;
  let worst = { block: -1, delta: 0, what: "" };
  const names = ["rmsL", "peakL", "rmsR", "peakR"];
  for (let b = 0; b < Math.max(want.blocks.length, got.blocks.length); b++) {
    const w = want.blocks[b];
    const g = got.blocks[b];
    if (!w || !g) {
      moved++;
      first = first < 0 ? b : first;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      if (Math.abs(w[k]! - g[k]!) > 1e-6) {
        moved++;
        first = first < 0 ? b : first;
        const delta = Math.abs(dB(g[k]!) - dB(w[k]!));
        if (delta > worst.delta) worst = { block: b, delta, what: names[k]! };
        break;
      }
    }
  }
  if (moved === 0) {
    lines.push("  every block's level is within 1e-6 of the golden: the bits changed but the levels did not (rounding, phase or noise-floor change)");
  } else {
    lines.push(`  ${moved} of ${Math.max(want.blocks.length, got.blocks.length)} blocks (of ${LEVEL_BLOCK} frames) moved by more than 1e-6; the first is block ${first} (frame ${first * LEVEL_BLOCK})`);
    if (worst.block >= 0) lines.push(`  largest level change: ${fmt(worst.delta)} dB in ${worst.what} at block ${worst.block} (frame ${worst.block * LEVEL_BLOCK})`);
  }
  lines.push(`  If the change is intended, rerun with UPDATE_GOLDENS=1 and review the diff of golden/${suite}/*.json.`);
  return lines.join("\n");
}

/** The level golden `suite` holds for `scene`, or undefined. */
export function readLevelGolden(suite: GoldenSuite, scene: string): LevelGolden | undefined {
  const path = `${goldenDir(suite)}${scene}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LevelGolden) : undefined;
}

/**
 * Compares `got` with `suite`'s golden (throws `explainLevels`' text on a different digest, and `rerun`'s command when there
 * is none), or writes it under `UPDATE_GOLDENS=1`. Returns the golden compared against (undefined when written).
 */
export function matchLevelGolden(suite: GoldenSuite, got: LevelGolden, rerun: string): LevelGolden | undefined {
  if (UPDATE_GOLDENS) {
    mkdirSync(goldenDir(suite), { recursive: true });
    writeFileSync(`${goldenDir(suite)}${got.scene}.json`, `${JSON.stringify(got)}\n`);
    return undefined;
  }
  const want = readLevelGolden(suite, got.scene);
  if (!want) throw new Error(`no golden for scene "${got.scene}" in golden/${suite}/: run UPDATE_GOLDENS=1 ${rerun}`);
  if (want.sha256 !== got.sha256) throw new Error(explainLevels(suite, want, got));
  return want;
}

// --- Z3's fixture --------------------------------------------------------------------------------------------------------

/** A mono f32 clip at 48 kHz built from integers (identical bits on both sides). */
export interface FixtureClip {
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

/** A stream chunk step's content: `frames` stereo frames of `noise32(seed, …)` from stream frame `from`. */
export interface FixtureStreamChunk {
  readonly stream: number;
  readonly epoch: number;
  readonly from: number;
  readonly frames: number;
  readonly flags: number;
  readonly seed: number;
}

/** One step of a scene (see the header). */
export type FixtureStep =
  | { readonly send: string; readonly count: number; readonly firstFrame?: number }
  | { readonly run: number }
  | { readonly open: string }
  | { readonly chunk: FixtureStreamChunk };

/** Z3's fixture; a family's own members extend it. */
export interface Fixture {
  readonly scene: string;
  /** What the scene shows, in a sentence. */
  readonly about?: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number; readonly maxMusicRings?: number };
  readonly clips: readonly FixtureClip[];
  readonly steps: readonly FixtureStep[];
  readonly frames: number;
  readonly fnv1a64: string;
  /** The core's cumulative `splitQuanta` and `voiceSplits` after the last step. */
  readonly splits?: { readonly splitQuanta: number; readonly voiceSplits: number };
  /** The native null against the offline reference (informational here: the native test asserts it). */
  readonly null?: { readonly maxError: number; readonly tolerance: number; readonly from?: number; readonly to?: number };
}

/** `suite`'s fixture `name`, or undefined when its native test hasn't written it. */
export function readFixture<F extends Fixture = Fixture>(suite: GoldenSuite, name: string): F | undefined {
  const path = `${goldenDir(suite)}${name}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as F) : undefined;
}

/** `readFixture`, throwing with the native command that writes it when it is missing. */
export function requireFixture<F extends Fixture = Fixture>(suite: GoldenSuite, name: string, writtenBy: string): F {
  const f = readFixture<F>(suite, name);
  if (f === undefined) throw new Error(`no golden/${suite}/${name}.json: run UPDATE_GOLDENS=1 ${writtenBy}`);
  return f;
}

/** A fixture clip's samples (see `FixtureClip`). */
export function clipSamples(clip: FixtureClip): Float32Array {
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

/** `LOOPBACK_PRESET` with the fixture's values. */
export function presetOf(fixture: Pick<Fixture, "preset">): CorePreset {
  return { ...LOOPBACK_PRESET, ...fixture.preset };
}

/** Hex to bytes. */
export const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Concatenates rendered parts. */
export function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The frames one CLIP_CHUNK carries when a clip is sent whole. */
const CLIP_CHUNK_FRAMES = 2048;

/** Wire messages to a loopback host, numbered from seq 1 as a fresh link numbers them. */
export class LoopbackWire {
  private seq = 1;

  constructor(readonly host: LoopbackHost) {}

  /** A CLIP_BEGIN. */
  clipBegin(c: { readonly clipId: number; readonly frames: number; readonly channels: number; readonly sampleRate: number; readonly format: number }): void {
    const buffer = new ArrayBuffer(16 + 20);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(view, 0, c);
    this.host.send(buffer);
  }

  /** A CLIP_CHUNK of `frames` frames from `frameOffset`, `bytes` the frames' sample bytes. */
  clipChunk(clipId: number, frameOffset: number, frames: number, bytes: Uint8Array): void {
    const buffer = new ArrayBuffer(32 + bytes.byteLength);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + bytes.byteLength });
    writeClipChunk(view, 0, { clipId, frameOffset, frames, reserved: 0 });
    new Uint8Array(buffer, 32).set(bytes);
    this.host.send(buffer);
  }

  /** A mono f32 clip at 48 kHz: CLIP_BEGIN, then CLIP_CHUNKs of `CLIP_CHUNK_FRAMES`. */
  monoClip(clipId: number, samples: Float32Array): void {
    this.clipBegin({ clipId, frames: samples.length, channels: 1, sampleRate: 48_000, format: 0 });
    for (let frame = 0; frame < samples.length; frame += CLIP_CHUNK_FRAMES) {
      const part = samples.subarray(frame, frame + Math.min(CLIP_CHUNK_FRAMES, samples.length - frame));
      this.clipChunk(clipId, frame, part.length, new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    }
  }

  /** A CLIP_UNLOAD. */
  clipUnload(clipId: number): void {
    const buffer = new ArrayBuffer(16 + 4);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: this.seq++, bodyBytes: 4 });
    view.setUint32(16, clipId, true);
    this.host.send(buffer);
  }

  /** One BATCH of `count` records (`records`: their bytes, heads included), stamped `firstFrame` (default: the host's frame). */
  batch(records: Uint8Array, count: number, firstFrame = this.host.frame): void {
    const buffer = new ArrayBuffer(32 + records.byteLength);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.seq++, bodyBytes: 16 + records.byteLength });
    writeBatchHeader(view, 0, { firstFrame, count, flags: 0 });
    new Uint8Array(buffer, 32).set(records);
    this.host.send(buffer);
  }

  /** A STREAM_CHUNK message of `c` (stereo `noise32` frames), for the stream port. */
  streamChunk(c: FixtureStreamChunk): ArrayBuffer {
    const samples = new Float32Array(c.frames * 2);
    for (let i = 0; i < c.frames; i++) {
      samples[2 * i] = noise32(c.seed, c.from + i, 0);
      samples[2 * i + 1] = noise32(c.seed, c.from + i, 1);
    }
    const buffer = new ArrayBuffer(STREAM_CHUNK_FIXED_END + samples.byteLength);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CHUNK, seq: this.seq++, bodyBytes: STREAM_CHUNK_FIXED_END - 16 + samples.byteLength });
    writeStreamChunk(view, 0, { streamId: c.stream, chunkSeq: 0, frames: c.frames, flags: c.flags, epoch: c.epoch });
    new Uint8Array(buffer, STREAM_CHUNK_FIXED_END).set(new Uint8Array(samples.buffer));
    return buffer;
  }
}

/** What `replayFixture` returns: the output of every `run` step, in order, and the host (for the STATUS checks after it). */
export interface Replay {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly host: LoopbackHost;
}

/**
 * Plays `fixture` on a loopback host over the committed wasm: the clips (CLIP_BEGIN and CLIP_CHUNKs), then the steps.
 * `onHost` runs once the host exists, before any message (a suite that watches STATUS subscribes there).
 */
export async function replayFixture(fixture: Fixture, onHost?: (host: LoopbackHost) => void): Promise<Replay> {
  const host = await createLoopbackHost({ preset: presetOf(fixture) });
  onHost?.(host);
  const wire = new LoopbackWire(host);
  // ADR 0223: a scene with streams gets them on the worklet's own port, handed over as the backend hands it
  // (`connectStreamPort`) before anything is sent; the loopback serves it as the processor does.
  const streamPort: LoopbackStreamPort = { onmessage: null, postMessage: () => {} };
  if (fixture.steps.some((s) => "open" in s || "chunk" in s)) host.link.connectStreamPort(streamPort as unknown as MessagePort);
  const postStream = (message: ArrayBuffer): void => {
    if (!streamPort.onmessage) throw new Error("the loopback didn't take the stream port");
    streamPort.onmessage({ data: message });
  };
  const lefts: Float32Array[] = [];
  const rights: Float32Array[] = [];
  for (const clip of fixture.clips) wire.monoClip(clip.id, clipSamples(clip));
  for (const step of fixture.steps) {
    if ("run" in step) {
      const out = host.renderQuanta(step.run);
      lefts.push(out.left);
      rights.push(out.right);
    } else if ("send" in step) {
      wire.batch(fromHex(step.send), step.count, step.firstFrame ?? host.frame);
    } else if ("open" in step) {
      postStream(fromHex(step.open).buffer as ArrayBuffer);
    } else {
      postStream(wire.streamChunk(step.chunk));
    }
  }
  return { left: concat(lefts), right: concat(rights), host };
}
