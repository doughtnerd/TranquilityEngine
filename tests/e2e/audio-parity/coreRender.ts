// Renders a parity scene through the audio core: the committed wasm, in Node, no AudioContext (the shape of
// `createLoopbackHost` in `src/plugins/audio/runtime/testing.ts`, with the sample rate as a parameter, since the
// loopback host is fixed at 48 kHz and the parity scenes also run at 44.1 kHz).
import { readFile } from "node:fs/promises";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  BUS_ROOT,
  Kind,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_PANNER_SHIFT,
  PLAY_FLAGS_SPATIAL,
  writeBatchHeader,
  writeBusConfig,
  writeBusMix,
  writeClipBegin,
  writeClipChunk,
  writeEnvelope,
  writeMaster,
  writePlay,
  type BusConfigBuses,
  type BusConfigBusesEffects,
} from "../../../src/plugins/audio/runtime/wire.generated";
import { HRIR_CLIP_ID, resampleHrir } from "../../../src/plugins/audio/runtime/core/hrir";
import { CoreDriver, instantiateCore, type CorePreset } from "../../../src/plugins/audio/runtime/worklet/coreDriver";
import { makeClip, prerollFrames, QUANTUM, sceneBuses, sceneFrames, type Scene } from "./scenes";
import type { BusEffect } from "../../../src/engine/audio/settings";

/**
 * `limiterLookaheadMs: 0`: the master limiter's look-ahead (A2.9) would delay all core output by a fixed 1.5 ms by
 * default. The reference graph has no such delay and the parity nulls are aligned at the frame, so the core renders
 * these scenes with 0 ms (no latency; the limiter never acts here anyway, see HEADROOM) rather than trimming a delay.
 */
const PRESET: CorePreset = { maxLogical: 64, maxMixed: 16, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 0, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 };
const CHUNK_FRAMES = 8192;
/**
 * Headroom for the master limiter (A2.8). The reference graph has no limiter, and some scenes (high-Q filters on
 * noise) go over full scale, which the core's limiter would hold at 0 dBFS. So MASTER (before the limiter) is set to
 * 1/16 and the output is multiplied back by 16: both are powers of two, so the result is bit for bit the core's
 * unlimited mix, and the limiter, bypassed exactly while nothing exceeds its ceiling, never acts (checked below).
 */
const HEADROOM = 16;
/** The core copies at most 256 KB of clip per quantum (`CLIP_BYTES_PER_QUANTUM`). */
const CLIP_BYTES_PER_QUANTUM = 256 * 1024;

let wasmBytes: Uint8Array | null = null;
async function wasm(): Promise<Uint8Array> {
  return (wasmBytes ??= await readFile(new URL("../../../src/plugins/audio/runtime/wasm/myco_audio.wasm", import.meta.url)));
}

/** A `BusEffect` as BUS_CONFIG carries it (the mapping `coreBackend.ts` uses: q in dB, unused parameters 0). */
function wireEffect(e: BusEffect): BusConfigBusesEffects {
  const p = [0, 0, 0, 0, 0, 0, 0];
  switch (e.type) {
    case "lowpass":
    case "highpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: e.type === "lowpass" ? 0 : 1, p };
    case "compressor":
      p.splice(0, 5, e.threshold, e.knee, e.ratio, e.attack, e.release);
      return { type: 2, p };
    case "reverb":
      p[0] = e.send;
      return { type: 3, p };
  }
}

let hrirAsset: ArrayBuffer | null = null;
/** The shipped HRIR table (`myco_hrir.bin`, 44.1 kHz) resampled to `rate` as `hrir.ts` does at runtime. */
async function hrirBlob(rate: number): Promise<ArrayBuffer> {
  if (!hrirAsset) {
    const bytes = await readFile(new URL("../../../src/plugins/audio/runtime/wasm/myco_hrir.bin", import.meta.url));
    hrirAsset = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return resampleHrir(hrirAsset, rate);
}

export interface Render {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** The scene through the core: `sceneFrames(scene)` frames per channel, after the pre-roll. */
export async function renderCore(scene: Scene): Promise<Render> {
  const rate = scene.rate;
  const core = instantiateCore(await wasm(), PRESET, rate);
  let seq = 0;
  let date = 1_000_000;
  const driver = new CoreDriver(core, () => {}, date);
  let frame = 0;

  const envelope = (view: DataView, kind: number, bodyBytes: number): void => void writeEnvelope(view, 0, { kind, seq: seq++, bodyBytes });
  const batch = (bodyBytes: number, write: (view: DataView, at: number) => void, count: number): void => {
    const buffer = new ArrayBuffer(16 + 16 + bodyBytes);
    const view = new DataView(buffer);
    envelope(view, Kind.BATCH, 16 + bodyBytes);
    writeBatchHeader(view, 0, { firstFrame: frame, count, flags: 0 });
    write(view, 32);
    driver.onMessage(buffer, frame, date);
  };

  // The bus tree: "Master" (root), "Bus" under it.
  const resolved = sceneBuses(scene);
  const tree: BusConfigBuses[] = resolved.map((b) => ({ parent: b.parent === null ? BUS_ROOT : resolved.findIndex((x) => x.name === b.parent), effects: b.effects.map(wireEffect) }));
  const configBytes = 16 + tree.reduce((n, b) => n + 4 + 32 * b.effects.length, 0);
  batch(configBytes, (view, at) => void writeBusConfig(view, at, { voiceId: 0, frameOffset: ASAP, buses: tree }), 1);
  batch(20 + 8 * resolved.length, (view, at) => void writeBusMix(view, at, { voiceId: 0, frameOffset: ASAP, rampFrames: 0, buses: resolved.map((b) => ({ gain: b.gain, lpHz: b.snapshotLowpass ?? BUS_LP_OFF_HZ })) }), 1);
  batch(24, (view, at) => void writeMaster(view, at, { voiceId: 0, frameOffset: ASAP, volume: 1 / HEADROOM, muted: 0, rampFrames: 0 }), 1);

  // The clips (f32, at the context rate), copied into the arena by the shell over the pre-roll.
  scene.clips.forEach((spec, id) => {
    const channels = makeClip(spec, rate);
    const frames = channels[0]!.length;
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    envelope(beginView, Kind.CLIP_BEGIN, 20);
    writeClipBegin(beginView, 0, { clipId: id + 1, frames, channels: channels.length, sampleRate: rate, format: 0 });
    driver.onMessage(begin, frame, date);
    for (let at = 0; at < frames; at += CHUNK_FRAMES) {
      const n = Math.min(CHUNK_FRAMES, frames - at);
      const bytes = n * channels.length * 4;
      const chunk = new ArrayBuffer(16 + 16 + bytes);
      const view = new DataView(chunk);
      envelope(view, Kind.CLIP_CHUNK, 16 + bytes);
      writeClipChunk(view, 0, { clipId: id + 1, frameOffset: at, frames: n, reserved: 0 });
      // Interleaved frames.
      const out = new Float32Array(chunk, 32, n * channels.length);
      for (let i = 0; i < n; i++) for (let c = 0; c < channels.length; c++) out[i * channels.length + c] = channels[c]![at + i]!;
      driver.onMessage(chunk, frame, date);
    }
  });

  // HRTF scenes: the voice's HRTF flag is set in its PLAY (below), as `hrtfPick.ts` would on main, and the table is
  // loaded like `hrir.ts` does (a format 2 clip under the reserved id, int16 words), with quanta for the core to copy
  // it and build the panner bank before the voices start.
  let hrirQuanta = 0;
  if (scene.voices.some((v) => v.spatial?.panner === "hrtf")) {
    const blob = await hrirBlob(rate);
    const words = blob.byteLength / 2;
    const begin = new ArrayBuffer(16 + 20);
    const beginView = new DataView(begin);
    envelope(beginView, Kind.CLIP_BEGIN, 20);
    writeClipBegin(beginView, 0, { clipId: HRIR_CLIP_ID, frames: words, channels: 1, sampleRate: rate, format: 2 });
    driver.onMessage(begin, frame, date);
    for (let at = 0; at < words; at += CHUNK_FRAMES) {
      const n = Math.min(CHUNK_FRAMES, words - at);
      const bytes = (n * 2 + 3) & ~3;
      const chunk = new ArrayBuffer(16 + 16 + bytes);
      const view = new DataView(chunk);
      envelope(view, Kind.CLIP_CHUNK, 16 + bytes);
      writeClipChunk(view, 0, { clipId: HRIR_CLIP_ID, frameOffset: at, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32, n * 2).set(new Uint8Array(blob, at * 2, n * 2));
      driver.onMessage(chunk, frame, date);
    }
    hrirQuanta = Math.ceil(blob.byteLength / CLIP_BYTES_PER_QUANTUM) + 8;
  }

  const render = (quanta: number, into?: { l: Float32Array; r: Float32Array; at: number }): void => {
    for (let i = 0; i < quanta; i++) {
      const out = driver.process(frame, date);
      for (let k = 0; k < 2 * QUANTUM; k++) if (Math.abs(out[k]!) >= 1) throw new Error(`${scene.id}: the output reached the limiter's ceiling; raise HEADROOM`);
      if (into) {
        const n = Math.min(QUANTUM, into.l.length - into.at);
        if (n > 0) {
          into.l.set(out.subarray(0, n), into.at);
          into.r.set(out.subarray(QUANTUM, QUANTUM + n), into.at);
          into.at += n;
        }
      }
      frame += QUANTUM;
      date += (QUANTUM / rate) * 1000;
    }
  };

  render(prerollFrames(scene) / QUANTUM + hrirQuanta);

  const voices = scene.voices;
  batch(
    56 * voices.length,
    (view, at) => {
      voices.forEach((v, i) => {
        const spatial = v.spatial;
        const dir = spatial?.dir ?? [0, 0, -1];
        const panner = spatial?.panner === "hrtf" ? 1 : 0;
        at += writePlay(view, at, {
          voiceId: ((1 << 16) | (i + 1)) >>> 0,
          frameOffset: ASAP,
          clip: v.clip + 1,
          bus: v.bus === "Master" ? 0 : 1,
          flags: PLAY_FLAGS_MIXED | (spatial ? PLAY_FLAGS_SPATIAL | (panner << PLAY_FLAGS_PANNER_SHIFT) : 0),
          group: 0,
          gate: 0,
          gain: v.gain ?? 1,
          pitch: 1,
          dirX: dir[0],
          dirY: dir[1],
          dirZ: dir[2],
          lpHz: BUS_LP_OFF_HZ,
          score: 0,
          startOffsetFrames: 0,
        });
      });
    },
    voices.length,
  );
  const frames = sceneFrames(scene);
  const into = { l: new Float32Array(frames), r: new Float32Array(frames), at: 0 };
  render(Math.ceil(frames / QUANTUM), into);
  if (driver.traps > 0) throw new Error(`the core trapped rendering ${scene.id}`);
  for (let i = 0; i < frames; i++) {
    into.l[i] *= HEADROOM;
    into.r[i] *= HEADROOM;
  }
  return { left: into.l, right: into.r };
}
