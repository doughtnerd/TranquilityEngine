// The wasm golden runner (ADR 0157, api-and-models §8 "Golden (Vitest, Node)"; task A2.7). Each scene is scripted
// on the loopback host (testing.ts: the real committed wasm in Node, no AudioContext), rendered for a fixed number
// of quanta, and its output compared with the digest committed in `golden/<scene>.json`.
//
// Digest rule: the exact SHA-256 of the f32 output (left channel then right, little-endian bytes). The wasm is
// deterministic by construction: WebAssembly's f32 arithmetic is IEEE-754 with no fused multiply-add (relaxed-simd
// is not used), `libm` is compiled into the module (no platform math), and the scenes' inputs are integer-built, so
// every engine and CPU runs the same instruction stream to the same bits. A quantised hash was rejected: rounding
// at 1e-6 flips on values that sit on a boundary, which makes a harmless one-ulp change fail at random while a
// real change of less than the step passes. The exact hash is the stricter contract ("a refactor must not change
// audio output") and it never flips by chance. The native tests (`cargo test`, tolerance 1e-6) cover the same
// scenes' maths on the host's own float unit.
//
// A hash says only "changed", so each golden also keeps block statistics (RMS and peak per channel for every
// 1,024 frames, to 6 significant digits) and the scene's overall peak and RMS. A failure names the scene, the first
// block that moved, and how far RMS and peak moved there in dB, so a level change reads differently from a
// phase or noise change (hash differs, levels do not).
//
// Update path: `UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/audioGolden.test.ts` rewrites
// `golden/*.json` from the current wasm. Review the diff: an unexpected change in a scene means the core's output
// changed. Stale files in `golden/` (no scene of that name) fail the run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HRIR_CLIP_ID, resampleHrir } from "./core/hrir";
import { DecoderWasm } from "./decoder/wasm";
import { createLoopbackHost, LOOPBACK_RATE, type LoopbackHost } from "./testing";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  BUS_ROOT,
  EffectType,
  Kind,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_PANNER_SHIFT,
  PLAY_FLAGS_SPATIAL,
  SET_PARAMS_FLAGS_MIXED,
  SET_PARAMS_FLAGS_PANNER_SHIFT,
  SET_PARAMS_FLAGS_SPATIAL,
  SET_PARAMS_MASK_BUS,
  SET_PARAMS_MASK_DIR,
  SET_PARAMS_MASK_FLAGS,
  SET_PARAMS_MASK_GAIN,
  SET_PARAMS_MASK_PITCH,
  writeAutomate,
  writeBatchHeader,
  writeBusAutomate,
  writeBusConfig,
  writeBusMix,
  writeClipBegin,
  writeClipChunk,
  writeEnvelope,
  writeFade,
  writeCurves,
  writeMaster,
  writeParam,
  writePlay,
  writeSetLoop,
  writeSetParams,
  writeStop,
  type BusConfigBuses,
  type Play,
} from "./wire.generated";

const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";
/** Frames per statistics block. */
const BLOCK = 1024;

// --- Scene scripting -------------------------------------------------------------------------------------------

type Writer = (view: DataView, off: number) => number;

const voice = (n: number): number => 0x0001_0000 | n;
const OFF = BUS_LP_OFF_HZ;

const MIXED = PLAY_FLAGS_MIXED;
const LOOP = PLAY_FLAGS_LOOP;
const SPATIAL = PLAY_FLAGS_SPATIAL;

/** A PLAY of `clip`: mixed, gain 1, pitch 1, facing forward, asap, on bus 0. Override what a scene needs. */
function play(voiceId: number, clip: number, over: Partial<Play> = {}): Writer {
  const rec: Play = {
    voiceId, frameOffset: ASAP, clip, bus: 0, flags: MIXED, group: 0, reserved: 0, gain: 1, pitch: 1,
    dirX: 0, dirY: 0, dirZ: -1, lpHz: OFF, score: 0, startOffsetFrames: 0, ...over,
  };
  return (view, off) => writePlay(view, off, rec);
}

const stop = (voiceId: number, fadeFrames = 0): Writer => (view, off) => writeStop(view, off, { voiceId, frameOffset: ASAP, fadeFrames, reason: 0 });

const fade = (voiceId: number, target: number, frames: number): Writer => (view, off) => writeFade(view, off, { voiceId, frameOffset: ASAP, target, frames, flags: 0 });

/** SET_PARAMS asap with the fields `over` names (the mask is derived from them). */
function setParams(voiceId: number, rampFrames: number, over: { gain?: number; pitch?: number; dir?: [number, number, number]; bus?: number; flags?: number }): Writer {
  let mask = 0;
  if (over.gain !== undefined) mask |= SET_PARAMS_MASK_GAIN;
  if (over.pitch !== undefined) mask |= SET_PARAMS_MASK_PITCH;
  if (over.dir) mask |= SET_PARAMS_MASK_DIR;
  if (over.bus !== undefined) mask |= SET_PARAMS_MASK_BUS;
  if (over.flags !== undefined) mask |= SET_PARAMS_MASK_FLAGS;
  return (view, off) =>
    writeSetParams(view, off, {
      voiceId, frameOffset: ASAP, mask, gain: over.gain ?? 0, pitch: over.pitch ?? 0,
      dirX: over.dir?.[0] ?? 0, dirY: over.dir?.[1] ?? 0, dirZ: over.dir?.[2] ?? 0,
      lpHz: 0, score: 0, bus: over.bus ?? 0, rampFrames, flags: over.flags ?? 0,
    });
}

/** BUS_CONFIG: `parents[i]` is bus i's parent; `effects[i]` its effects as `[type, p0, p1, ...]`. */
function busConfig(parents: number[], effects: Record<number, number[][]> = {}): Writer {
  const buses: BusConfigBuses[] = parents.map((parent, i) => ({
    parent,
    effects: (effects[i] ?? []).map(([type, ...p]) => ({ type: type!, p: [...p, 0, 0, 0, 0, 0, 0, 0].slice(0, 7) })),
  }));
  return (view, off) => writeBusConfig(view, off, { voiceId: 0, frameOffset: ASAP, buses });
}

/** BUS_MIX: `[gain, lpHz]` per bus over `rampFrames`. */
const busMix = (rampFrames: number, buses: [number, number][]): Writer => (view, off) =>
  writeBusMix(view, off, { voiceId: 0, frameOffset: ASAP, rampFrames, buses: buses.map(([gain, lpHz]) => ({ gain, lpHz })) });

const master = (volume: number, muted: boolean, rampFrames: number): Writer => (view, off) =>
  writeMaster(view, off, { voiceId: 0, frameOffset: ASAP, volume, muted: muted ? 1 : 0, rampFrames });

// ADR 0158 E2: automation records.
/** CURVES from `first`: each curve `[x, y, interp]` keys (interp 0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut). */
const curves = (first: number, list: [number, number, number][][]): Writer => (view, off) =>
  writeCurves(view, off, { voiceId: 0, frameOffset: ASAP, firstCurve: first, curves: list.map((keys) => ({ reserved: 0, keys: keys.map(([x, y, interp]) => ({ x, y, interp })) })) });
/** PARAM: `group` 0 global, else an instance group. */
const param = (group: number, slot: number, value: number, seekPerSecond: number): Writer => (view, off) =>
  writeParam(view, off, { voiceId: 0, frameOffset: ASAP, group, slot, value, seekPerSecond });
/** AUTOMATE `voiceId` with `[param, curve, target]` bindings (param bit15 = global; target 0 volume, 1 pitch, 2 lowpass). */
const automate = (voiceId: number, bindings: [number, number, number][]): Writer => (view, off) =>
  writeAutomate(view, off, { voiceId, frameOffset: ASAP, bindings: bindings.map(([param, curve, target]) => ({ param, curve, target })) });
const busAutomate = (bus: number, bindings: [number, number, number][]): Writer => (view, off) =>
  writeBusAutomate(view, off, { voiceId: bus, frameOffset: ASAP, bindings: bindings.map(([param, curve, target]) => ({ param, curve, target })) });
/** SET_LOOP `voiceId`, `frameOffset` frames into the batch (ASAP for at once). */
const setLoop = (voiceId: number, frameOffset: number, start: number, end: number, looping: boolean): Writer => (view, off) =>
  writeSetLoop(view, off, { voiceId, frameOffset, loopStartFrame: start, loopEndFrame: end, flags: looping ? 1 : 0 });
const GLOBAL = 0x8000;

/** A scene's stage: a loopback host with clip loading, batch sending and a collected render. */
class Stage {
  private seq = 1;
  private readonly lefts: Float32Array[] = [];
  private readonly rights: Float32Array[] = [];

  private constructor(readonly host: LoopbackHost) {}

  static async create(): Promise<Stage> {
    return new Stage(await createLoopbackHost());
  }

  /** Loads an interleaved f32 clip (1 or 2 channels) in chunks of at most 2,048 frames. */
  loadF32(clipId: number, samples: Float32Array, channels = 1): void {
    this.loadClip(clipId, samples.length / channels, channels, 0, (frame, frames) => samples.subarray(frame * channels, (frame + frames) * channels));
  }

  /** Loads an interleaved i16 clip. */
  loadI16(clipId: number, samples: Int16Array, channels = 1): void {
    this.loadClip(clipId, samples.length / channels, channels, 1, (frame, frames) => samples.subarray(frame * channels, (frame + frames) * channels));
  }

  private loadClip(clipId: number, frames: number, channels: number, format: number, slice: (frame: number, frames: number) => ArrayBufferView): void {
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    writeEnvelope(beginView, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(beginView, 0, { clipId, frames, channels, sampleRate: LOOPBACK_RATE, format });
    this.host.send(begin);
    for (let frame = 0; frame < frames; frame += 2048) {
      const n = Math.min(2048, frames - frame);
      const part = slice(frame, n);
      const chunk = new ArrayBuffer(16 + 16 + part.byteLength);
      const view = new DataView(chunk);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + part.byteLength });
      writeClipChunk(view, 0, { clipId, frameOffset: frame, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      this.host.send(chunk);
    }
  }

  /** Sends one BATCH of the records, all asap at the current frame. */
  send(...records: Writer[]): void {
    const scratch = new ArrayBuffer(32 + 8192);
    const view = new DataView(scratch);
    let at = 32;
    for (const write of records) at += write(view, at);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.seq++, bodyBytes: at - 16 });
    writeBatchHeader(view, 0, { firstFrame: this.host.frame, count: records.length, flags: 0 });
    this.host.send(scratch.slice(0, at));
  }

  /**
   * Loads the HRIR table (H3's format 2 clip under the reserved id), resampled to the loopback rate as `hrir.ts` does at
   * runtime, then renders `warmQuanta` quanta that are not part of the output: the core copies the table and builds its
   * panner bank over them.
   */
  async loadHrir(warmQuanta = 40): Promise<void> {
    const bytes = await readFile(new URL("./wasm/myco_hrir.bin", import.meta.url));
    const blob = resampleHrir(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, LOOPBACK_RATE);
    const words = blob.byteLength / 2;
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    writeEnvelope(beginView, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(beginView, 0, { clipId: HRIR_CLIP_ID, frames: words, channels: 1, sampleRate: LOOPBACK_RATE, format: 2 });
    this.host.send(begin);
    for (let at = 0; at < words; at += 2048) {
      const n = Math.min(2048, words - at);
      const padded = Math.ceil((n * 2) / 4) * 4;
      const chunk = new ArrayBuffer(16 + 16 + padded);
      const view = new DataView(chunk);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + padded });
      writeClipChunk(view, 0, { clipId: HRIR_CLIP_ID, frameOffset: at, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32, n * 2).set(new Uint8Array(blob, at * 2, n * 2));
      this.host.send(chunk);
    }
    this.host.renderQuanta(warmQuanta);
  }

  /** Renders `quanta` more quanta into the scene's output. */
  run(quanta: number): void {
    const { left, right } = this.host.renderQuanta(quanta);
    this.lefts.push(left);
    this.rights.push(right);
  }

  output(): { left: Float32Array; right: Float32Array } {
    const join = (parts: Float32Array[]): Float32Array => {
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    return { left: join(this.lefts), right: join(this.rights) };
  }
}

// --- Source material (all integer-driven or fdlibm-exact, so identical on every run) ---------------------------------

/** Two sines and a little noise: broadband enough that filters, the compressor and the reverb all show. */
function mixClip(frames: number): Float32Array {
  const out = new Float32Array(frames);
  let state = 0x1234_5678;
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (state >>> 8) / 0x100_0000 - 0.5;
    out[i] = 0.35 * Math.sin((2 * Math.PI * 220 * i) / LOOPBACK_RATE) + 0.25 * Math.sin((2 * Math.PI * 1760 * i) / LOOPBACK_RATE) + 0.2 * noise;
  }
  return out;
}

/** A stereo i16 clip: 330 Hz left, 495 Hz right. */
function stereoI16(frames: number): Int16Array {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[2 * i] = Math.round(12_000 * Math.sin((2 * Math.PI * 330 * i) / LOOPBACK_RATE));
    out[2 * i + 1] = Math.round(12_000 * Math.sin((2 * Math.PI * 495 * i) / LOOPBACK_RATE));
  }
  return out;
}

const CLIP = 1;
const CLIP_FRAMES = 12_000;
const STEREO = 2;

async function stage(): Promise<Stage> {
  const s = await Stage.create();
  s.loadF32(CLIP, mixClip(CLIP_FRAMES));
  s.loadI16(STEREO, stereoI16(12_000), 2);
  return s;
}

// --- The scenes --------------------------------------------------------------------------------------------------

/** The panner bits for HRTF (kind 1) in a PLAY's flags and in a SET_PARAMS's. */
const HRTF_PLAY = 1 << PLAY_FLAGS_PANNER_SHIFT;
const HRTF_SET = 1 << SET_PARAMS_FLAGS_PANNER_SHIFT;
/** A SET_PARAMS `flags` that keeps the voice mixed and spatial (the other bits are the panner's). */
const SET_MIXED_SPATIAL = SET_PARAMS_FLAGS_MIXED | SET_PARAMS_FLAGS_SPATIAL;

const SCENES: Record<string, (s: Stage) => void | Promise<void>> = {
  "one-shot"(s) {
    s.send(play(voice(1), CLIP, { gain: 0.8 }));
    s.run(100);
  },
  "pitch-up"(s) {
    s.send(play(voice(1), CLIP, { pitch: 1.5 }), play(voice(2), CLIP, { pitch: 1.059_463_1, gain: 0.5 }));
    s.run(70);
  },
  "pitch-down"(s) {
    s.send(play(voice(1), CLIP, { pitch: 0.6 }));
    s.run(160);
  },
  "pitch-ramp"(s) {
    s.send(play(voice(1), CLIP, { flags: MIXED | LOOP }));
    s.run(20);
    s.send(setParams(voice(1), 4800, { pitch: 2 }));
    s.run(60);
    s.send(setParams(voice(1), 0, { pitch: 0.5 }));
    s.run(30);
  },
  "loop"(s) {
    s.send(play(voice(1), CLIP, { flags: MIXED | LOOP, startOffsetFrames: 3000, gain: 0.7 }));
    s.run(220);
  },
  "stop-and-fade"(s) {
    s.send(play(voice(1), CLIP, { flags: MIXED | LOOP }), play(voice(2), CLIP, { flags: MIXED | LOOP, pitch: 1.25, gain: 0.5 }));
    s.run(20);
    s.send(fade(voice(1), 0.2, 2400));
    s.run(30);
    s.send(stop(voice(2), 1200));
    s.run(20);
    s.send(stop(voice(1)));
    s.run(10);
  },
  "spatial-gains"(s) {
    s.send(
      play(voice(1), CLIP, { flags: MIXED | LOOP | SPATIAL, dirX: -1, dirZ: 0 }),
      play(voice(2), CLIP, { flags: MIXED | LOOP | SPATIAL, dirX: 0.5, dirZ: -0.866_025_4, gain: 0.6, pitch: 0.8 }),
      play(voice(3), CLIP, { flags: MIXED | LOOP | SPATIAL, dirX: 0, dirZ: 1, gain: 0.4 }),
    );
    s.run(40);
    s.send(setParams(voice(1), 2400, { dir: [1, 0, 0] }));
    s.run(40);
  },
  "stereo-i16"(s) {
    s.send(play(voice(1), STEREO), play(voice(2), STEREO, { flags: MIXED | SPATIAL, dirX: 0.7071, dirZ: -0.7071, gain: 0.5, startOffsetFrames: 2000 }));
    s.run(100);
  },
  "bus-gains"(s) {
    // 0 root; 1 and 2 under 0; 3 under 1.
    s.send(
      busConfig([BUS_ROOT, 0, 0, 1]),
      busMix(0, [[0.8, OFF], [0.5, OFF], [1, OFF], [0.5, OFF]]),
      play(voice(1), CLIP, { bus: 3, flags: MIXED | LOOP }),
      play(voice(2), CLIP, { bus: 2, flags: MIXED | LOOP, pitch: 1.5, gain: 0.5 }),
    );
    s.run(30);
    s.send(busMix(2400, [[0.8, OFF], [0.25, OFF], [0.5, OFF], [1, OFF]]));
    s.run(50);
  },
  "bus-mute"(s) {
    s.send(busConfig([BUS_ROOT, 0, 0]), play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }), play(voice(2), CLIP, { bus: 2, flags: MIXED | LOOP, pitch: 0.75 }));
    s.run(20);
    s.send(busMix(480, [[1, OFF], [0, OFF], [1, OFF]]), master(0.5, false, 480));
    s.run(30);
    s.send(master(0.5, true, 960));
    s.run(20);
    s.send(master(0.5, false, 960));
    s.run(20);
  },
  "fx-lowpass"(s) {
    s.send(busConfig([BUS_ROOT, 0], { 1: [[EffectType.Lowpass, 1500, 6]] }), play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }));
    s.run(80);
  },
  "fx-highpass"(s) {
    s.send(busConfig([BUS_ROOT, 0], { 1: [[EffectType.Highpass, 400, -3]] }), play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }));
    s.run(80);
  },
  "fx-compressor"(s) {
    s.send(
      busConfig([BUS_ROOT, 0], { 1: [[EffectType.Compressor, -30, 6, 8, 0.003, 0.25]] }),
      play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }),
    );
    s.run(40);
    s.send(play(voice(2), CLIP, { bus: 1, flags: MIXED | LOOP, pitch: 2, gain: 0.8 }));
    s.run(60);
  },
  "fx-reverb-send"(s) {
    s.send(busConfig([BUS_ROOT, 0], { 1: [[EffectType.ReverbSend, 0.5]] }), play(voice(1), CLIP, { bus: 1 }));
    s.run(100);
    s.run(200); // the tail
  },
  "snapshot"(s) {
    // A snapshot: bus gains and low-pass cut-offs ramped together, then released.
    s.send(busConfig([BUS_ROOT, 0, 0]), play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }), play(voice(2), CLIP, { bus: 2, flags: MIXED | LOOP, pitch: 1.5, gain: 0.5 }));
    s.run(20);
    s.send(busMix(2400, [[1, OFF], [0.4, 800], [1, 2000]]));
    s.run(60);
    s.send(busMix(2400, [[1, OFF], [1, OFF], [1, OFF]]));
    s.run(60);
  },
  "kitchen-sink"(s) {
    s.send(
      busConfig([BUS_ROOT, 0, 0, 0], { 1: [[EffectType.Lowpass, 4000, 0], [EffectType.ReverbSend, 0.3]], 2: [[EffectType.Compressor, -24, 10, 4, 0.01, 0.2]] }),
      busMix(0, [[0.9, OFF], [1, OFF], [0.8, OFF], [0.6, OFF]]),
      play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP | SPATIAL, dirX: 0.5, dirZ: -0.866_025_4 }),
      play(voice(2), CLIP, { bus: 2, flags: MIXED | LOOP, pitch: 1.2, gain: 0.7 }),
      play(voice(3), STEREO, { bus: 3, flags: MIXED | LOOP, gain: 0.5 }),
    );
    s.run(40);
    s.send(setParams(voice(1), 1200, { dir: [-0.7071, 0, -0.7071], gain: 0.8 }), busMix(1200, [[0.9, OFF], [1, OFF], [0.8, 1500], [0.6, OFF]]), fade(voice(2), 0, 2400));
    s.run(40);
    s.send(setParams(voice(3), 0, { bus: 2 }), stop(voice(1), 600));
    s.run(60);
  },
  // ADR 0158 E2: a voice with a volume binding (a global parameter through a smooth curve) and a lowpass binding (its
  // instance's local parameter through an easeOut curve) while both parameters seek, then jump.
  "automation-voice"(s) {
    s.send(
      curves(0, [[[0, 0.1, 2], [1, 1, 0]], [[0, 300, 4], [1, 12_000, 0]]]),
      param(0, 0, 0, 0),
      param(7, 2, 0, 0),
      play(voice(1), CLIP, { flags: MIXED | LOOP, group: 7 }),
      automate(voice(1), [[GLOBAL | 0, 0, 0], [2, 1, 2]]),
    );
    s.run(10);
    s.send(param(0, 0, 1, 2), param(7, 2, 1, 1.5));
    s.run(90);
    s.send(param(0, 0, 0.3, 0), param(7, 2, 0.2, 0));
    s.run(20);
  },
  // ADR 0158 E2: bus volume automation on a global parameter (a step then a linear segment), seeking, over BUS_MIX.
  "automation-bus"(s) {
    s.send(
      busConfig([BUS_ROOT, 0]),
      busMix(0, [[1, OFF], [0.8, OFF]]),
      curves(5, [[[0, 0.2, 1], [0.25, 0.5, 0], [1, 1, 0]]]),
      param(0, 3, 0, 0),
      play(voice(1), CLIP, { bus: 1, flags: MIXED | LOOP }),
      busAutomate(1, [[GLOBAL | 3, 5, 0]]),
    );
    s.run(10);
    s.send(param(0, 3, 1, 3));
    s.run(50);
    s.send(param(0, 3, 0.1, 1));
    s.run(40);
  },
  // ADR 0158 E2: SET_LOOP loops frames 2,000..5,000 of the clip (gapless across the seam) and, mid-pass, a release stamped
  // 77 frames into its quantum lets the voice play on through the clip's tail and end.
  "sustain-release"(s) {
    s.send(play(voice(1), CLIP, { gain: 0.8 }), setLoop(voice(1), ASAP, 2000, 5000, true));
    s.run(100); // 12,800 frames: the intro, then about 3.6 passes
    s.send(setLoop(voice(1), 77, 0, 0, false));
    s.run(70); // the rest of the pass, the tail to frame 12,000 and the end
  },
  // H4: the HRTF panner (the shipped table, resampled to 48 kHz). The HRTF flag is the voice's PLAY or SET_PARAMS panner
  // bits, as `pannerPick.ts` sets them on main; the table is loaded and the bank built before the voices start.
  async "hrtf-static"(s) {
    await s.loadHrir();
    s.send(
      play(voice(1), CLIP, { flags: MIXED | LOOP | SPATIAL | HRTF_PLAY, dirX: 0.5, dirZ: -0.866_025_4 }),
      play(voice(2), CLIP, { flags: MIXED | LOOP | SPATIAL | HRTF_PLAY, dirX: -1, dirZ: 0, pitch: 0.8, gain: 0.6 }),
      play(voice(3), STEREO, { flags: MIXED | LOOP | SPATIAL | HRTF_PLAY, dirX: 0.3, dirY: 0.5, dirZ: 0.812_403_8, gain: 0.5 }),
    );
    s.run(80);
  },
  // A source that moves across the listener while its panner kind changes: equal-power, then HRTF (the 45 ms crossfade, the
  // direction updated every two quanta as the backend does), then equal-power again; a second, static voice stays on HRTF.
  async "hrtf-moving-kind-change"(s) {
    await s.loadHrir();
    const toward = (azimuthDeg: number): [number, number, number] => [Math.sin((azimuthDeg * Math.PI) / 180), 0, -Math.cos((azimuthDeg * Math.PI) / 180)];
    s.send(
      play(voice(1), CLIP, { flags: MIXED | LOOP | SPATIAL, dirX: toward(-90)[0], dirZ: toward(-90)[2] }),
      play(voice(2), CLIP, { flags: MIXED | LOOP | SPATIAL | HRTF_PLAY, dirX: 0.5, dirZ: -0.866_025_4, pitch: 1.5, gain: 0.4 }),
    );
    const steps = 120;
    for (let k = 0; k < steps; k++) {
      const az = -90 + (180 * k) / (steps - 1);
      const kind = k >= 30 && k < 80 ? HRTF_SET : 0;
      const over: Parameters<typeof setParams>[2] = { dir: toward(az) };
      if (k === 30 || k === 80) over.flags = SET_MIXED_SPATIAL | kind;
      s.send(setParams(voice(1), 256, over));
      s.run(2);
    }
    s.run(10);
  },
  // B4: a looping clip of a lossy file across its seam (start 4,096 frames before the end, run 8,192): the decoder's
  // gapless trim and the core's wrap together. The scene also checks the output is the decode's end then its start.
  async "loop-seam-mp3"(s) {
    await loopSeam(s, "loop-48000-stereo.mp3", 3, DECODER_WASM);
  },
  async "loop-seam-vorbis"(s) {
    await loopSeam(s, "loop-48000-stereo.ogg", 4, DECODER_WASM);
  },
  async "loop-seam-aac"(s) {
    await loopSeam(s, "loop-48000-stereo.m4a", 5, DECODER_AAC_WASM);
  },
};

const DECODER_WASM = "./wasm/myco_audio_decode.wasm";
const DECODER_AAC_WASM = "./wasm/myco_audio_decode_aac.wasm";
const SEAM_CLIP = 3;

/** Decodes B1's loopable fixture `name` (int16, as the registry loads clips) with the committed decoder, plays it looping from 4,096 frames before its end and renders 8,192 frames (plus the limiter's latency); throws unless the output is the decode's last 4,096 frames then its first 4,096. */
async function loopSeam(s: Stage, name: string, hint: number, wasmPath: string): Promise<void> {
  const wasm = await readFile(new URL(wasmPath, import.meta.url));
  const file = await readFile(new URL(`../../../../native/audio/crates/audio-decode/tests/fixtures/${name}`, import.meta.url));
  const w = await DecoderWasm.load(wasm);
  const h = w.open(file, hint);
  const frames = w.info(h).frames;
  if (frames !== 48_000) throw new Error(`${name}: ${frames} frames, expected the source's 48,000`);
  const ptr = w.alloc(frames * 4);
  const pcm = Int16Array.from(w.i16(ptr, w.readI16(h, ptr, frames) * 2));
  w.close(h);
  s.loadI16(SEAM_CLIP, pcm, 2);
  s.host.renderQuanta(40); // not part of the output: the core copies the clip in over these
  const tail = 4096;
  s.send(play(voice(1), SEAM_CLIP, { flags: MIXED | LOOP, startOffsetFrames: frames - tail }));
  s.run((2 * tail) / 128 + 2);
  const { left, right } = s.output();
  // The master limiter's look-ahead delays everything by a fixed latency: the first sounding frame.
  let lag = 0;
  while (lag < left.length && left[lag] === 0 && right[lag] === 0) lag++;
  if (lag > 256) throw new Error(`${name}: silent for ${lag} frames`);
  for (let k = 0; k < 2 * tail; k++) {
    const f = (frames - tail + k) % frames;
    if (left[lag + k] !== pcm[2 * f]! / 32768 || right[lag + k] !== pcm[2 * f + 1]! / 32768) throw new Error(`${name}: output frame ${k} isn't decoded frame ${f}`);
  }
}

// --- Digests ---------------------------------------------------------------------------------------------------------

interface Golden {
  scene: string;
  frames: number;
  /** SHA-256 (hex) of the left channel's f32 bytes followed by the right's. */
  sha256: string;
  peak: number;
  rms: number;
  /** Per block of 1,024 frames: [rmsL, peakL, rmsR, peakR]. */
  blocks: number[][];
}

const sig = (v: number): number => Number(v.toPrecision(6));

function digest(scene: string, left: Float32Array, right: Float32Array): Golden {
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
  for (let from = 0; from < left.length; from += BLOCK) {
    const to = Math.min(left.length, from + BLOCK);
    const [rl, pl] = stat(left, from, to);
    const [rr, pr] = stat(right, from, to);
    blocks.push([sig(rl), sig(pl), sig(rr), sig(pr)]);
  }
  const [rmsL, peakL] = stat(left, 0, left.length);
  const [rmsR, peakR] = stat(right, 0, right.length);
  return { scene, frames: left.length, sha256: hash.digest("hex"), peak: sig(Math.max(peakL, peakR)), rms: sig(Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2)), blocks };
}

const dB = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));
const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : String(n));

/** A readable account of how `got` differs from `want`: which block moved first, and the level changes there. */
function explain(want: Golden, got: Golden): string {
  const lines = [`scene "${got.scene}": output differs from golden/${got.scene}.json`, `  sha256 ${want.sha256.slice(0, 16)}... -> ${got.sha256.slice(0, 16)}...`];
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
    lines.push(`  ${moved} of ${Math.max(want.blocks.length, got.blocks.length)} blocks (of ${BLOCK} frames) moved by more than 1e-6; the first is block ${first} (frame ${first * BLOCK})`);
    if (worst.block >= 0) lines.push(`  largest level change: ${fmt(worst.delta)} dB in ${worst.what} at block ${worst.block} (frame ${worst.block * BLOCK})`);
  }
  lines.push("  If the change is intended, rerun with UPDATE_GOLDENS=1 and review the diff of golden/*.json.");
  return lines.join("\n");
}

// --- The tests -----------------------------------------------------------------------------------------------------

describe("wasm goldens: the committed core's output, scene by scene", () => {
  it.each(Object.keys(SCENES))("scene %s matches its golden digest", async (name) => {
    const s = await stage();
    await SCENES[name]!(s);
    const { left, right } = s.output();
    for (const sample of left) expect(Number.isFinite(sample)).toBe(true);
    for (const sample of right) expect(Number.isFinite(sample)).toBe(true);
    const got = digest(name, left, right);
    const path = `${GOLDEN_DIR}${name}.json`;
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(path, `${JSON.stringify(got)}\n`);
      return;
    }
    if (!existsSync(path)) throw new Error(`no golden for scene "${name}": run UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/audioGolden.test.ts`);
    const want = JSON.parse(readFileSync(path, "utf8")) as Golden;
    if (want.sha256 !== got.sha256) throw new Error(explain(want, got));
  });

  it("every scene is audible (a silent scene proves nothing)", async () => {
    for (const name of Object.keys(SCENES)) {
      const path = `${GOLDEN_DIR}${name}.json`;
      if (!existsSync(path)) continue;
      const want = JSON.parse(readFileSync(path, "utf8")) as Golden;
      expect(want.peak, name).toBeGreaterThan(0.01);
    }
  });

  it("golden/ holds exactly the scenes' files", () => {
    const files = existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("event-")).sort() /* event-*.json: events/eventGolden.test.ts */ : [];
    if (UPDATE) return;
    expect(files).toEqual(Object.keys(SCENES).map((n) => `${n}.json`).sort());
  });

  it("a render is repeatable within one process (the digest does not depend on the run)", async () => {
    const run = async (): Promise<string> => {
      const s = await stage();
      await SCENES["kitchen-sink"]!(s);
      const { left, right } = s.output();
      return digest("kitchen-sink", left, right).sha256;
    };
    expect(await run()).toBe(await run());
  });
});

