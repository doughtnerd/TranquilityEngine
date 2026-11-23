// ADR 0347's core half, end to end on the loopback host: spatial test scenes (`playAudioTestScene`, the engine's own
// components) in a headless World, the real core wasm and core backend, the shipped HRIR table and MagLS filters, and the
// decoder wasm's generated reverbs for the zones, driven by `engine.step` (6 quanta a frame) as the Studio drives it.
//
// - **Spread.** A playlist's `spatial.spread` widens its voice: the interaural correlation of a noise source ahead falls
//   as the spread grows (a point reads near 1, 360° near 0).
// - **bedBeyond.** With the project's `bedBeyond` (`audio.bed.beyond`), a sound farther than it is heard in its bus's
//   bed even with an HRTF slot free; a near one keeps its HRTF slot (`Audio.debug()` voice rows).
// - **Zone interiors.** Inside an audio zone heard `inside` its sound plays in its bus's bed, spread all round (debug
//   rows; the output decorrelated).
// - **Reverb presets.** ADR 0347's presets ring for their own declared times: the T20 of the zone's response to a click
//   (mid band, Schroeder integration) is within 15% of the preset's reverberation time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, Engine } from "../../../../myco";
import { parseAudioTestScene } from "../../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_FORMAT, type AudioTestScene } from "../../../../engine/audio/spatial/testSceneTypes";
import { mixer as globalMixer, setAudioBackend } from "../backend";
import { presetFromSettings } from "../core/context";
import { createHrirLoader, createMaglsLoader } from "../core/hrir";
import { createZoneIrService } from "../core/zoneIr";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../decoder/protocol";
import { pla, sample } from "../playlists/testKit";
import { closeLoopbackAudio, endAudioSession, loopbackAudio, type LoopbackAudio, type LoopbackStreamPort } from "../testing";
import hash from "../wasm/hash.json";
import { playAudioTestScene, type AudioTestScenePlayer } from "./player";

const RATE = 48_000;
const QUANTA_PER_FRAME = 6;
const DT = (QUANTA_PER_FRAME * 128) / RATE;
const read = (url: URL): ArrayBuffer => {
  const b = readFileSync(fileURLToPath(url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const DECODER = read(new URL("../wasm/myco_audio_decode.wasm", import.meta.url));
const HRIR = read(new URL("../wasm/myco_hrir.bin", import.meta.url));
const MAGLS = read(new URL("../../../../engine/audio/magls-o3.bin", import.meta.url));

let engine: Engine | null = null;
let player: AudioTestScenePlayer | null = null;

beforeEach(() => {
  setAudioBackend(null);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  player?.dispose();
  player = null;
  await closeLoopbackAudio();
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  setAudioBackend(null);
  endAudioSession();
  vi.restoreAllMocks();
});

/** White noise at 0.25, `seconds` long (a different seed per name). */
function noise(seconds: number, seed: number): Float32Array {
  let s = seed >>> 0;
  return new Float32Array(Math.round(seconds * RATE)).map(() => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0;
    return 0.25 * ((s / 2 ** 32) * 2 - 1);
  });
}

/** What each clip decodes to: `click*.wav` 8 s of silence with one full-scale sample 0.6 s in, `noise*.wav` noise, else a 440 Hz tone. */
function clip(path: string): Float32Array {
  if (path.startsWith("click")) {
    const c = new Float32Array(8 * RATE);
    c[Math.round(0.6 * RATE)] = 1;
    return c;
  }
  if (path.startsWith("noise")) return noise(2, path.length * 7919);
  return new Float32Array(RATE).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / RATE));
}

/**
 * The Studio's World and the real core on the loopback (the page's mixer, configured by the Engine from `audio`), with
 * the HRIR and MagLS tables and the decoder worker in process for the zones' kernels. Returns a stepper that records the
 * output.
 */
async function rig(audio: Record<string, unknown>, assets: Record<string, unknown> = {}) {
  Assets.clearSources();
  const files: Record<string, unknown> = { ...assets };
  for (const name of ["noise.wav", "near.wav", "far.wav", "rain.wav", "click.wav"]) files[name] ??= "data:audio/wav;base64,AAAA";
  Assets.addSource(Assets.fromObject(files));
  engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], ...audio } } });
  engine.world.render = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;
  // The decoder worker in process for the zones' kernels, on a channel straight to the shell (as passByLoopback does).
  const irListeners: ((r: IrPreparedMessage | IrFailedMessage) => void)[] = [];
  const handler = createDecoderHandler({
    post: (r: DecoderReply) => {
      if (r.type === "irPrepared" || r.type === "irFailed") for (const l of irListeners) l(r);
    },
    expectedSourceHash: hash.sourceHash,
    fetchBytes: async () => {
      throw new Error("no assets here");
    },
  });
  await handler.handle({ type: "init", wasmBytes: DECODER.slice(0) });
  const worklet: LoopbackStreamPort = { onmessage: null, postMessage: (m: unknown) => port.onmessage?.({ data: m }) };
  const port: StreamPortLike = { onmessage: null, postMessage: (m: unknown) => worklet.onmessage?.({ data: m }) };
  await handler.handle({ type: "connectWorklet", port } as never);
  const pending: Promise<void>[] = [];
  const zoneIr = createZoneIrService({ sampleRate: RATE, decoder: { postIr: (req) => void pending.push(handler.handle(req)), onIr: (l) => (irListeners.push(l), () => {}) } });
  const loop: LoopbackAudio | null = await loopbackAudio({
    preset: presetFromSettings(globalMixer.audioSettings),
    decode: (path) => ({ channelData: [clip(path)] }),
    backend: (clips) => ({
      zoneIr,
      hrir: createHrirLoader({ clips, sampleRate: RATE, warn: () => {}, fetchBytes: async () => HRIR.slice(0) }),
      magls: createMaglsLoader({ clips, sampleRate: RATE, fetchBytes: async () => MAGLS.slice(0) }),
    }),
  });
  if (!loop) return null;
  loop.link.connectStreamPort(worklet as unknown as MessagePort);
  const left: number[] = [];
  const right: number[] = [];
  const run = async (seconds: number, record = true) => {
    const frames = Math.round(seconds / DT);
    for (let f = 0; f < frames; f++) {
      engine!.step(DT);
      const o = loop.render(QUANTA_PER_FRAME);
      if (record) for (let i = 0; i < o.left.length; i++) (left.push(o.left[i]!), right.push(o.right[i]!));
      await Promise.all(pending.splice(0));
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  return { left, right, run, loop };
}

const listener = { id: "p1", name: "Player 1", position: { x: 0, y: 0, z: 0 } };

/** A scene (parsed from its file form) with the listener at the origin facing +z and `emitters` (static), zones and reverb zones as given. */
function scene(parts: { emitters?: unknown[]; audioZones?: unknown[]; reverbZones?: unknown[] }): AudioTestScene {
  return parseAudioTestScene({ format: AUDIO_SCENE_FORMAT, listeners: [listener], activeListener: "p1", ...parts }).scene;
}
const emitter = (id: string, z: number, sound: string, x = 0) => ({ id, name: id, kind: "static", position: { x, y: 0, z }, sound, volume: 0 });
const box = (size: number) => ({ center: { x: 0, y: -5, z: 0 }, width: size, depth: size, yaw: 0, bottom: 0, top: 10 });

function correlation(a: readonly number[], b: readonly number[], from: number): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = from; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return ab / Math.sqrt(aa * bb);
}

/** Audio.debug()'s voice row of the voice playing `clip`. */
const rowOf = (clipName: string) => Audio.debug().voices.find((v) => v.clip.endsWith(clipName));

describe("ADR 0347 in the audio core, on the loopback (spread, bedBeyond, zone interiors, reverb presets)", () => {
  it("a playlist's spread widens its voice: interaural correlation falls as the spread grows", async (ctx) => {
    const measured: [number, number][] = [];
    for (const spread of [0, 90, 180, 360]) {
      const r = await rig({}, { "wide.playlist.json": pla("clip", [sample("noise.wav")], { playback: { plays: "untilStopped" }, spatial: { spread } }) });
      if (!r) return ctx.skip();
      player = playAudioTestScene(engine!.world, scene({ emitters: [emitter("src", 5, "wide.playlist.json")] }));
      await r.run(1);
      measured.push([spread, correlation(r.left, r.right, r.left.length - RATE / 2)]);
      player.dispose();
      player = null;
      await closeLoopbackAudio();
      engine!.world.render = undefined as never;
      engine!.dispose();
      engine = null;
    }
    console.info(`[spread] interaural correlation by spread: ${measured.map(([s, c]) => `${s}° ${c.toFixed(3)}`).join(", ")}`);
    expect(measured[0]![1]).toBeGreaterThan(0.9);
    for (let k = 1; k < measured.length; k++) expect(measured[k]![1]).toBeLessThan(measured[k - 1]![1] - 0.1);
    expect(Math.abs(measured[3]![1])).toBeLessThan(0.2);
  }, 120_000);

  it("a sound farther than bedBeyond is heard in its bus's bed; a near one keeps its HRTF slot", async (ctx) => {
    const audio = { bed: { maxBeds: 2, beyond: 20 }, voices: { hrtf: 8 } };
    const r = await rig(audio);
    if (!r) return ctx.skip();
    player = playAudioTestScene(engine!.world, scene({ emitters: [emitter("near", 5, "near.wav"), emitter("far", 40, "far.wav")] }));
    await r.run(1);
    const near = rowOf("near.wav"), far = rowOf("far.wav");
    console.info(`[bedBeyond] near (5 m): ${near?.panner}, far (40 m): ${far?.panner}, bed ${far?.bed}`);
    expect(near?.panner).toBe("hrtf");
    expect(far?.panner).toBe("bed");
    expect(far?.bed).not.toBeNull();
    // Without bedBeyond the far sound takes a free HRTF slot like the near one.
    player.dispose();
    player = null;
    await closeLoopbackAudio();
    engine!.world.render = undefined as never;
    engine!.dispose();
    engine = null;
    const without = await rig({ bed: { maxBeds: 2 }, voices: { hrtf: 8 } });
    if (!without) return ctx.skip();
    player = playAudioTestScene(engine!.world, scene({ emitters: [emitter("near", 5, "near.wav"), emitter("far", 40, "far.wav")] }));
    await without.run(1);
    expect(rowOf("far.wav")?.panner).toBe("hrtf");
  }, 120_000);

  it("inside an audio zone heard inside, its sound plays in its bus's bed, spread all round", async (ctx) => {
    const r = await rig({ bed: { maxBeds: 2 }, voices: { hrtf: 8 } }, { "rain.playlist.json": pla("clip", [sample("noise.wav")], { playback: { plays: "untilStopped" } }) });
    if (!r) return ctx.skip();
    player = playAudioTestScene(engine!.world, scene({
      emitters: [emitter("near", 5, "near.wav", 3)],
      audioZones: [{ id: "z", name: "Rain", box: box(20), sound: "rain.playlist.json", heard: "inside", feather: 5, volume: 0 }],
    }));
    await r.run(1.2);
    const zone = rowOf("noise.wav");
    console.info(`[zone interior] zone voice: ${zone?.panner} (bed ${zone?.bed}); a near emitter: ${rowOf("near.wav")?.panner}`);
    expect(rowOf("near.wav")?.panner).toBe("hrtf");
    expect(zone?.panner).toBe("bed");
    expect(zone?.bed).not.toBeNull();
  }, 120_000);

  for (const [preset, rt60] of [["smallStone", 1.1], ["canyonHall", 4.8], ["metalTunnel", 2.8], ["forest", 1.5]] as const) {
    it(`the ${preset} preset rings for its own time (${rt60} s)`, async (ctx) => {
      const r = await rig({ zones: { maxActive: 2, standby: 1, maxIrSeconds: 8 } });
      if (!r) return ctx.skip();
      // The listener and a click 2 m ahead inside the zone; the click sounds 0.6 s in, once the zone's kernel is in.
      player = playAudioTestScene(engine!.world, scene({
        emitters: [emitter("click", 2, "click.wav")],
        reverbZones: [{ id: "rz", name: "Room", box: box(60), preset, wet: 0, priority: 0, levelDefault: false }],
      }));
      await r.run(0.6 + rt60 + 0.4);
      const zones = r.loop.backend.zones.counters;
      const mono = r.left.map((v, i) => v + r.right[i]!);
      const onset = mono.findIndex((v) => Math.abs(v) > 0.05);
      expect(onset).toBeGreaterThan(0.5 * RATE);
      expect(zones.irPrepares).toBe(1);
      // Past the dry click, the zone's tail: its mid-band T20.
      const t = t20(mono.slice(onset + 64), RATE);
      console.info(`[reverb presets] ${preset}: measured T20 ${t.toFixed(3)} s, declared ${rt60} s (onset ${onset}, ${mono.length} frames, tail peak ${mono.slice(onset + 64).reduce((m, v) => Math.max(m, Math.abs(v)), 0).toExponential(2)})`);
      expect(Math.abs(t / rt60 - 1)).toBeLessThan(0.15);
    }, 120_000);
  }
});

/** T20 of `x` (seconds): two 700 Hz low-pass biquads (the mid band), Schroeder backward integration, -5 to -25 dB, times 3. */
function t20(x: readonly number[], rate: number): number {
  const w = (2 * Math.PI * 700) / rate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const [b0, b1, a1, a2] = [(1 - Math.cos(w)) / 2 / a0, (1 - Math.cos(w)) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
  let y = Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    let [x1, x2, y1, y2] = [0, 0, 0, 0];
    y = y.map((v) => {
      const out = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      [x2, x1, y2, y1] = [x1, v, y1, out];
      return out;
    });
  }
  const tail = new Float64Array(y.length + 1);
  for (let i = y.length - 1; i >= 0; i--) tail[i] = tail[i + 1]! + y[i]! * y[i]!;
  const db = (i: number) => 10 * Math.log10(tail[i]! / tail[0]!);
  let a = 0;
  while (a < y.length && db(a) > -5) a++;
  let b = a;
  while (b < y.length && db(b) > -25) b++;
  return (3 * (b - a)) / rate;
}
