// @internal test fixture (ADR 0166 M4b, T2): the seam goldens' offline reference, fixture format and wasm replay.
//
// **The reference** is the intended mix of a music seam, built with no knowledge of the runtime: a sum of terms, each a
// clip level (as the core holds it) times the product of its fades, over a span of core frames. A fade is Z3's
// same-knot control-rate law (`native/audio/crates/audio-core/tests/in_voice_reference/mod.rs`, architecture §4.4),
// ported here line for line: the core runs a shaped fade on a linear ramp retargeted at control rate, so
// - knots sit at the fade's start F, at each quantum boundary after it, and at F + N;
// - at a knot x the phase is u = 1 − (1 − u0)·(F + N − x)/N and the value is the law's (b exactly at F + N);
// - the output at frame t is the linear interpolation between the knots around x = t + 1 (the first frame after a knot
//   already moves); before F it is a, from F + N − 1 on it is b.
// The laws are `audio_dsp::curve_laws::value`'s: linear a + (b − a)u; sCurve a + (b − a)u²(3 − 2u); equalPowerIn
// a + (b − a)sin(uπ/2); equalPowerOut b + (a − b)cos(uπ/2). Seams null to 1e-5 against it (README "Notes for the build").
//
// **The fixture** (`golden/seams/seam-<case>.json`) is a seam as the runtime played it on the real core, written by
// `music/seam.test.ts` with `UPDATE_GOLDENS=1` (never by the replays): every BATCH and clip message the core received,
// each at the core frame it was delivered on, the clips as run-length sample words, the output's length and FNV-1a 64
// digest, and the reference. `audioGoldenSeams.test.ts` replays it on the committed wasm and
// `native/audio/crates/audio-core/tests/seam_goldens.rs` natively; both must give the digest, and the replayed output
// must null against the reference (so native equals wasm, and both null).

import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { Kind, readClipBegin, readClipChunk, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";
import { clipSampleBytes } from "../worklet/coreDriver";

export const QUANTUM = 128;

/** A fade law, as the wire's `fade_law` names them. */
export type SeamLaw = "linear" | "sCurve" | "equalPowerIn" | "equalPowerOut";

/** A fade from `a` to `b` under `law`, starting at core frame `f`, over `n` frames, from phase `u0` (default 0). */
export interface SeamFade {
  readonly law: SeamLaw;
  readonly a: number;
  readonly b: number;
  readonly f: number;
  readonly n: number;
  readonly u0?: number;
}

/** One voice of the mix: `level` times the product of `fades`, over core frames [from, to) (`to` absent: on). */
export interface SeamTerm {
  readonly what: string;
  readonly level: number;
  readonly from: number;
  readonly to?: number;
  readonly fades?: readonly SeamFade[];
}

/** The intended mix over core frames [from, to), and the bound the output is held to. */
export interface SeamReference {
  readonly from: number;
  readonly to: number;
  readonly tolerance: number;
  readonly terms: readonly SeamTerm[];
}

const HALF_PI = Math.PI / 2;

/** The law's value at phase `u` going from `a` to `b` (exact at both ends). */
export function lawValue(law: SeamLaw, a: number, b: number, u: number): number {
  if (u <= 0) return a;
  if (u >= 1) return b;
  switch (law) {
    case "linear":
      return a + (b - a) * u;
    case "sCurve":
      return a + (b - a) * (u * u * (3 - 2 * u));
    case "equalPowerIn":
      return a + (b - a) * Math.sin(u * HALF_PI);
    case "equalPowerOut":
      return b + (a - b) * Math.cos(u * HALF_PI);
  }
}

/** The same-knot reference: the fade's gain at core frame `t`. */
export function fadeAt(fade: SeamFade, t: number): number {
  const { f, n, a, b } = fade;
  const u0 = fade.u0 ?? 0;
  if (t < f) return a;
  const x = t + 1;
  if (x >= f + n) return b;
  const knot = (k: number): number => (k >= f + n ? b : lawValue(fade.law, a, b, 1 - ((1 - u0) * (f + n - k)) / n));
  const lo = Math.max(Math.floor((x - 1) / QUANTUM) * QUANTUM, f);
  const hi = Math.min((Math.floor((x - 1) / QUANTUM) + 1) * QUANTUM, f + n);
  const vl = knot(lo);
  const vh = knot(hi);
  return vl + ((vh - vl) * (x - lo)) / (hi - lo);
}

/** The exact curve (no knots): the law at frame t + 1. What control rate costs is the gap between the two. */
export function fadeExact(fade: SeamFade, t: number): number {
  const { f, n, a, b } = fade;
  const u0 = fade.u0 ?? 0;
  if (t < f) return a;
  const x = t + 1;
  return x >= f + n ? b : lawValue(fade.law, a, b, 1 - ((1 - u0) * (f + n - x)) / n);
}

/** The reference mix at core frame `t`. */
export function referenceAt(ref: SeamReference, t: number, exact = false): number {
  let v = 0;
  for (const term of ref.terms) {
    if (t < term.from || (term.to !== undefined && t >= term.to)) continue;
    let g = term.level;
    for (const fade of term.fades ?? []) g *= exact ? fadeExact(fade, t) : fadeAt(fade, t);
    v += g;
  }
  return v;
}

/** The largest |out[t] − reference(t)| over the reference's span, and the frame it is at. */
export function seamNull(out: ArrayLike<number>, ref: SeamReference, exact = false): { maxError: number; at: number } {
  let maxError = 0;
  let at = ref.from;
  for (let t = ref.from; t < ref.to; t++) {
    const e = Math.abs(out[t]! - referenceAt(ref, t, exact));
    if (e > maxError) {
      maxError = e;
      at = t;
    }
  }
  return { maxError, at };
}

// --- The fixture -------------------------------------------------------------------------------------------------

/** A clip as the core received it: its CLIP_BEGIN fields and its sample words (little-endian hex) run-length coded. */
export interface SeamClip {
  readonly id: number;
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly format: number;
  /** `[word, count]`: `count` sample words of `clipSampleBytes(format)` bytes, each the hex `word`. */
  readonly runs: readonly (readonly [string, number])[];
}

/**
 * One message, delivered at core frame `frame` (the first frame of the next quantum to render): a BATCH (`batch`, the
 * whole message in hex, envelope included), a CLIP_BEGIN of clip `begin`, a CLIP_CHUNK of `chunk` = [clip, frameOffset,
 * frames], or a CLIP_UNLOAD of clip `unload`.
 */
export type SeamStep =
  | { readonly frame: number; readonly batch: string }
  | { readonly frame: number; readonly begin: number }
  | { readonly frame: number; readonly chunk: readonly [number, number, number] }
  | { readonly frame: number; readonly unload: number };

export interface SeamFixture {
  readonly scene: string;
  readonly about: string;
  /** `LOOPBACK_PRESET` with these values (the loopback fixture's: a 0 ms look-ahead, so frames are core frames). */
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly arenaInitialBytes: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly SeamClip[];
  readonly steps: readonly SeamStep[];
  /** Output length in frames (whole quanta). */
  readonly frames: number;
  /** FNV-1a 64 over the left channel's f32 bytes then the right's (`audioGoldenM4.test.ts`' `fnv1a64`). */
  readonly fnv1a64: string;
  readonly reference: SeamReference;
  /** The null measured when the fixture was written (informational; the replays measure their own). */
  readonly null: { readonly maxError: number; readonly exact: number };
}

/** FNV-1a 64 (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits (as `audioGoldenM4.test.ts`). */
export function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = 0xcbf29ce484222325n;
  for (const part of [left, right]) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/**
 * Records what a core receives: call `onMessage(buffer, frame)` for every buffer handed to the shell (`CoreDriver.
 * onMessage`'s arguments), before the shell sees it. Keeps BATCH and clip messages (TIME_PING, RECYCLE and the rest
 * don't touch the output).
 */
export class SeamRecorder {
  readonly steps: SeamStep[] = [];
  private readonly clips = new Map<number, { begin: { id: number; frames: number; channels: number; sampleRate: number; format: number }; data: Uint8Array }>();

  onMessage(buffer: ArrayBuffer, frame: number): void {
    if (buffer.byteLength < 16) return;
    const view = new DataView(buffer);
    const kind = view.getUint16(6, true);
    if (kind === Kind.BATCH) {
      const len = 16 + view.getUint32(12, true);
      this.steps.push({ frame, batch: hexOf(new Uint8Array(buffer, 0, len)) });
    } else if (kind === Kind.CLIP_BEGIN) {
      const b = readClipBegin(view, 0);
      const id = b.clipId;
      const bytes = b.frames * b.channels * clipSampleBytes(b.format);
      this.clips.set(id, { begin: { id, frames: b.frames, channels: b.channels, sampleRate: b.sampleRate, format: b.format }, data: new Uint8Array(bytes) });
      this.steps.push({ frame, begin: id });
    } else if (kind === Kind.CLIP_CHUNK) {
      const c = readClipChunk(view, 0);
      const clip = this.clips.get(c.clipId);
      if (!clip) return;
      const frameBytes = clip.begin.channels * clipSampleBytes(clip.begin.format);
      clip.data.set(new Uint8Array(buffer, 32, c.frames * frameBytes), c.frameOffset * frameBytes);
      this.steps.push({ frame, chunk: [c.clipId, c.frameOffset, c.frames] });
    } else if (kind === Kind.CLIP_UNLOAD) {
      this.steps.push({ frame, unload: view.getUint32(16, true) });
    }
  }

  /** The clips received, run-length coded. */
  clipList(): SeamClip[] {
    const out: SeamClip[] = [];
    for (const { begin, data } of this.clips.values()) {
      const w = clipSampleBytes(begin.format);
      const runs: [string, number][] = [];
      for (let i = 0; i < data.length; i += w) {
        const word = hexOf(data.subarray(i, i + w));
        const last = runs[runs.length - 1];
        if (last && last[0] === word) last[1]++;
        else runs.push([word, 1]);
      }
      out.push({ ...begin, runs });
    }
    return out;
  }
}

/** A clip's bytes from its runs. */
export function clipBytes(clip: SeamClip): Uint8Array {
  const w = clipSampleBytes(clip.format);
  const out = new Uint8Array(clip.frames * clip.channels * w);
  let at = 0;
  for (const [word, count] of clip.runs) {
    const b = bytesOf(word);
    for (let k = 0; k < count; k++, at += w) out.set(b, at);
  }
  return out;
}

/** Replays a fixture on a loopback host over the committed wasm: each message at its frame, then the rest of the output. */
export async function replaySeam(fixture: SeamFixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost }> {
  const host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, ...fixture.preset } });
  const clips = new Map(fixture.clips.map((c) => [c.id, { clip: c, bytes: clipBytes(c) }]));
  const lefts: Float32Array[] = [];
  const rights: Float32Array[] = [];
  const renderTo = (frame: number): void => {
    if (frame < host.frame) throw new Error(`seam fixture ${fixture.scene}: step at frame ${frame} after ${host.frame}`);
    const n = (frame - host.frame) / QUANTUM;
    if (n > 0) {
      const out = host.renderQuanta(n);
      lefts.push(out.left);
      rights.push(out.right);
    }
  };
  let seq = 1;
  for (const step of fixture.steps) {
    renderTo(step.frame);
    if ("batch" in step) {
      const bytes = bytesOf(step.batch);
      host.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } else if ("begin" in step) {
      const c = clips.get(step.begin)!.clip;
      const buffer = new ArrayBuffer(16 + 20);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_BEGIN, seq: seq++, bodyBytes: 20 });
      writeClipBegin(view, 0, { clipId: c.id, frames: c.frames, channels: c.channels, sampleRate: c.sampleRate, format: c.format });
      host.send(buffer);
    } else if ("chunk" in step) {
      const [id, frameOffset, frames] = step.chunk;
      const { clip, bytes } = clips.get(id)!;
      const frameBytes = clip.channels * clipSampleBytes(clip.format);
      const part = bytes.subarray(frameOffset * frameBytes, (frameOffset + frames) * frameBytes);
      const buffer = new ArrayBuffer(32 + part.byteLength);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: seq++, bodyBytes: 16 + part.byteLength });
      writeClipChunk(view, 0, { clipId: id, frameOffset, frames, reserved: 0 });
      new Uint8Array(buffer, 32).set(part);
      host.send(buffer);
    } else {
      const buffer = new ArrayBuffer(16 + 4);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: seq++, bodyBytes: 4 });
      view.setUint32(16, step.unload, true);
      host.send(buffer);
    }
  }
  renderTo(fixture.frames);
  const concat = (parts: Float32Array[]): Float32Array => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  return { left: concat(lefts), right: concat(rights), host };
}
