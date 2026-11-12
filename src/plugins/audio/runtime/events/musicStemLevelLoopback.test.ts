// F-9b: main knows a music stem's quantised level (`VoiceTable.stemGain` / `stemDry`, set by `musicOps.paramsShaped`), on
// the real core (the loopback host's wasm), through the whole runtime. The rig is F-9's (`musicQuantizedLoopback.test.ts`):
// the Sound Lab's `music-intensity` event quantised to the beat, DC stems pad 0.125 (x 0.8), pulse 0.25, lead 0.5, mono
// output, 10 frames a second, 120 bpm (a beat is 24,000 frames).
//
// - Audibility (`Audio.debug()`, selection) follows the stem's level: a stem at 0 reads 0 and goes virtual, a rise counts
//   at once, a fall only at its beat (R3a).
// - Every dry-gain write multiplies the level in: a promote (SET_MIXED), `_setVolume` and occlusion leave a stem at 0.5
//   at 0.5 on the core. Before F-9b each reset the in-voice ramp to the plain dry gain (the stem back at full).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer as globalMixer, registerCoreBackend, resetCoreFallbackState, setAudioBackend } from "../backend";
import { Audio } from "../index";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder } from "../core/fakeDecoder";
import type { AudioHost } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { AUDIO_SYSTEMS } from "../audioSystem";
import { musicPlayers } from "../music/musicSystem";
import { events } from "./eventRuntime";

const RATE = 48_000;
const BEAT = RATE / 2;
const QUANTA_PER_FRAME = 38;
const FRAME_FRAMES = QUANTA_PER_FRAME * 128;
const CLIP_FRAMES = 20 * RATE;
const LEVEL = { pad: 0.125 * 0.8, pulse: 0.25, lead: 0.5 };
/** The clip's level by its "encoded" size: pad 8 bytes, pulse 16, lead 24. */
const BYTES = { pad: 8, pulse: 16, lead: 24 } as const;
const DC = { 8: 0.125, 16: LEVEL.pulse, 24: LEVEL.lead } as Record<number, number>;

/** The Sound Lab's `music-intensity` event (samples/sound-lab), quantised to the beat, its clips the DC ones. */
const INTENSITY = {
  format: "myco.audioevent@1",
  bus: "Music",
  priority: 200,
  limit: { maxInstances: 1, steal: "oldest" },
  root: {
    type: "segment",
    id: "intensity",
    gridOffset: 0,
    tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }],
    cues: [{ name: "entry", at: "1:1:0" }, { name: "exit", at: "end" }],
    entry: "entry",
    exit: "exit",
    regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }],
    tracks: [
      { name: "pad", clip: "pad.wav", volume: 0.8 },
      { name: "pulse", clip: "pulse.wav", automation: [{ parameter: "Intensity", target: "volume", curve: [[0.2, 0], [0.6, 1]], quantize: "beat" }] },
      { name: "lead", clip: "lead.wav", automation: [{ parameter: "Intensity", target: "volume", curve: [[0.6, 0], [1, 1]], quantize: "beat" }] },
    ],
  },
};

let undo: (() => void) | null = null;
beforeEach(() => {
  setAudioBackend(null);
  resetCoreFallbackState();
  events()._reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  undo?.();
  undo = null;
  events()._reset();
  setAudioBackend(null);
  resetCoreFallbackState();
  vi.restoreAllMocks();
});

async function rig() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "pad.wav": "data:,pad", "pulse.wav": "data:,pulse", "lead.wav": "data:,lead",
    "music-intensity.audioevent.json": INTENSITY,
  }));
  const engine = await Engine.create({
    headless: true,
    project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }], seed: 7, backend: "core", parameters: [{ name: "Intensity", min: 0, max: 1, default: 1, seekSpeed: 0.5 }] } } as never,
  });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
  } catch {
    return null;
  }
  const link = loop.link;
  const bytes = (url: string): number => (url.includes("pulse") ? BYTES.pulse : url.includes("lead") ? BYTES.lead : BYTES.pad);
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (url: string) => new ArrayBuffer(bytes(url)),
    decodeWorker: fakeDecoder(async (b) => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(DC[b.byteLength]!)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  undo = registerCoreBackend(() => backend);
  // The out index is the core's frame: every rendered sample is kept from the first quantum.
  const out: number[] = [];
  const dt = FRAME_FRAMES / RATE;
  const step = async (n: number): Promise<void> => {
    for (let f = 0; f < n; f++) {
      AUDIO_SYSTEMS[1]!.run(engine.world, dt); // engine.AudioMusic: the early step
      AUDIO_SYSTEMS[0]!.run(engine.world, dt); // engine.Audio: the frame, the music plan, the commit, the event runtime
      for (const s of loop.renderQuanta(QUANTA_PER_FRAME).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  // Load the clips with silent voices and let the clock settle; Intensity at 0, as the sample's page starts it.
  for (const name of ["pad", "pulse", "lead"]) backend.play({ path: `${name}.wav`, url: Assets.url(`${name}.wav`), loop: false, stream: false, bus: "Music", volume: 0 } as never);
  Audio.setParameter("Intensity", 0);
  await step(30);
  return { backend, out, step };
}

/** The group's first sample (the first non-zero one after `from`), -1 while silent. */
const firstSound = (out: readonly number[], from: number): number => {
  for (let i = from; i < out.length; i++) if (out[i] !== 0) return i;
  return -1;
};
/** Largest |out[i] - level| over [from, to). */
const maxError = (out: readonly number[], from: number, to: number, level: number): number => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(out[i]! - level));
  return m;
};

/** The live music member playing `clip`: its id and slot. */
function stem(backend: CoreBackend, clip: "pulse" | "lead" | "pad"): { id: number; i: number } {
  const t = backend.table;
  for (let i = 0; i < t.capacity; i++) {
    if (t.state[i] === 0 || t.musicGroup[i] === 0) continue;
    const id = ((t.gen[i]! << 16) | i) >>> 0;
    const r = Audio.debug().voices.find((v) => v.id === id);
    if (r && r.clip.includes(clip)) return { id, i };
  }
  throw new Error(`no ${clip} stem`);
}
const row = (id: number) => Audio.debug().voices.find((v) => v.id === id)!;
/** The mean of the last 2,000 samples (the stems are DC, so a settled mix is flat). */
const settled = (out: readonly number[]): number => {
  let s = 0;
  for (let i = out.length - 2000; i < out.length; i++) s += out[i]!;
  return s / 2000;
};

describe("a quantised stem's level on main (F-9b, loopback host)", () => {
  it("audibility follows the level: 0 is virtual, a rise counts at once, a fall at its beat", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, out, step } = r;
    const mark = out.length;
    Audio.play("music-intensity.audioevent.json");
    await step(12);
    const start = firstSound(out, mark);
    expect(start).toBeGreaterThan(0);
    /** Steps until the beat the next change will pick is at least three frames away (so the checks before it hold). */
    const awayFromBeat = async (): Promise<void> => {
      for (let k = 0; k < 20; k++) {
        const horizon = backend.clockMap.frameOfTime(backend.horizon()) + FRAME_FRAMES;
        const beat = start + Math.ceil((horizon - start) / BEAT) * BEAT;
        if (beat - horizon > 3 * FRAME_FRAMES) return;
        await step(1);
      }
      throw new Error("no beat far enough away");
    };
    const pulse = stem(backend, "pulse");
    const lead = stem(backend, "lead");
    const pad = stem(backend, "pad");
    // Intensity 0: pulse and lead at level 0 read audibility 0 and are virtual; the pad is mixed.
    expect(row(pulse.id).audibility).toBe(0);
    expect(row(lead.id).audibility).toBe(0);
    expect(row(pulse.id).state).toBe("virtual");
    expect(row(lead.id).state).toBe("virtual");
    expect(row(pad.id).audibility).toBeGreaterThan(0);

    // Up to 1: audible at once, before the beat (the core keeps them silent until it). The ramp goes out after this
    // frame's selection, so audibility shows it on the next.
    await awayFromBeat();
    Audio.setParameter("Intensity", 1);
    await step(2);
    expect(backend.table.stemCount[pulse.i]).toBe(1); // the beat hasn't come
    // (The table's audibility: `Audio.debug()` clamps it to 1.)
    const full = backend.table.audibility[pulse.i]!;
    expect(full).toBeGreaterThan(0);
    expect(row(lead.id).audibility).toBeGreaterThan(0);
    expect(maxError(out, out.length - 2000, out.length, LEVEL.pad)).toBeLessThan(1e-6);
    await step(Math.ceil((2 * BEAT) / FRAME_FRAMES));
    expect(row(pulse.id).state).toBe("playing");
    expect(row(lead.id).state).toBe("playing");
    expect(maxError(out, out.length - 2000, out.length, LEVEL.pad + LEVEL.pulse + LEVEL.lead)).toBeLessThan(1e-5);

    // Down to 0.4: pulse to 0.5 and lead to 0 at the beat; until then both keep their audibility (R3a).
    await awayFromBeat();
    Audio.setParameter("Intensity", 0.4);
    await step(2);
    expect(backend.table.stemCount[pulse.i]).toBe(1);
    expect(backend.table.audibility[pulse.i]).toBeCloseTo(full, 5);
    expect(row(lead.id).audibility).toBeGreaterThan(0);
    await step(Math.ceil((2 * BEAT) / FRAME_FRAMES));
    expect(backend.table.audibility[pulse.i]).toBeCloseTo(full * 0.5, 5);
    expect(row(pulse.id).gain).toBeCloseTo(0.5, 5);
    expect(row(lead.id).audibility).toBe(0);
    await step(4);
    expect(row(lead.id).state).toBe("virtual");
    expect(maxError(out, out.length - 2000, out.length, LEVEL.pad + LEVEL.pulse * 0.5)).toBeLessThan(1e-5);
    backend.dispose();
  });

  it("a promote, _setVolume and occlusion keep a stem at 0.5 at 0.5 on the core", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, out, step } = r;
    Audio.setParameter("Intensity", 0.4);
    Audio.play("music-intensity.audioevent.json");
    await step(12);
    const pulse = stem(backend, "pulse");
    const half = LEVEL.pad + LEVEL.pulse * 0.5;
    expect(backend.table.stemDry[pulse.i]).toBeCloseTo(0.5, 6);
    expect(settled(out)).toBeCloseTo(half, 5);

    // A promote: the Music bus at 0 makes every stem virtual; back at 1, the pulse's SET_MIXED carries its level.
    Audio.bus("Music").volume = 0;
    await step(6);
    expect(row(pulse.id).state).not.toBe("playing");
    Audio.bus("Music").volume = 1;
    await step(6);
    expect(row(pulse.id).state).toBe("playing");
    expect(settled(out)).toBeCloseTo(half, 5);

    // `_setVolume`: the dry gain is the volume times the level (0.5 x 0.5 of the pulse), and back.
    backend._setVolume(pulse.id, 0.5);
    await step(3);
    expect(settled(out)).toBeCloseTo(LEVEL.pad + LEVEL.pulse * 0.25, 5);
    backend._setVolume(pulse.id, 1);
    await step(3);
    expect(settled(out)).toBeCloseTo(half, 5);

    // Occlusion: the smoothed dry occlusion gain times the level, and open again.
    backend._setOcclusion(pulse.id, 0.5, 0);
    await step(3);
    expect(settled(out)).toBeCloseTo(LEVEL.pad + LEVEL.pulse * 0.25, 5);
    backend._setOcclusion(pulse.id, 1, 0);
    await step(3);
    expect(settled(out)).toBeCloseTo(half, 5);
    backend.dispose();
  });
});
