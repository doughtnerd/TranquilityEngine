// F-9: quantised automation on a music segment's stems, on the real core (the loopback host's wasm), through the whole
// runtime: `Audio.play` of the Sound Lab's `music-intensity` event (a copy, with its pulse and lead automation quantised
// to the beat as R6 means it; the sample itself dropped `quantize` until this was fixed), the music player, the event
// runtime and the CoreBackend, driven by the engine's own audio systems at 10 frames a second (the e2e frame cap; a frame
// is 38 quanta). The stems are DC clips at levels that tell them apart in the mono output: pad 0.125 (x its track volume
// 0.8), pulse 0.25, lead 0.5. 120 bpm 4/4, so a beat is 24,000 frames.
//
// Before F-9 the event runtime ticked stem automation after the frame's BATCH had committed, so what it wrote went out a
// frame later than the horizon it was planned against. At the start that put the bind-time level after the members'
// stamped PLAYs (an asap one found no voice and was dropped, a stamped one arrived late), and pulse and lead sounded at
// full for the first samples: that is what fails here without the fix. In the browser the same delay could put any
// quantised ramp up to a frame after its beat; on this host the clock map's lead hides that past the first samples, so
// the beat checks below pin the landing (sample-exact, on the beat line, with the beat just past the horizon) rather
// than reproduce the late case.
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
import { QUANTIZED_RAMP_SECONDS } from "./automation";
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

describe("quantised stem automation on the core (F-9, loopback host)", () => {
  it("pulse and lead start at their automated level and move to it on the beat, sample-exact", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, out, step } = r;
    const mark = out.length;
    Audio.play("music-intensity.audioevent.json");
    await step(12);
    expect(musicPlayers()).toHaveLength(1);
    const start = firstSound(out, mark);
    expect(start).toBeGreaterThan(0);
    // Intensity 0: the pad alone from the group's very first sample (pulse and lead at 0 from the start).
    expect(maxError(out, start, out.length, LEVEL.pad)).toBeLessThan(1e-6);

    /**
     * Steps until the beat the next frame's plan will pick (the first one past that frame's horizon, a frame on from
     * now) is less than a frame past that horizon (the tightest case, the one a frame's delay made late), then sets
     * Intensity; returns that beat's frame. 200 frames of margin either side keep the pick unambiguous.
     */
    const changeNearHorizon = async (value: number): Promise<number> => {
      for (let k = 0; k < 20; k++) {
        const horizon = backend.clockMap.frameOfTime(backend.horizon()) + FRAME_FRAMES;
        const beat = start + Math.ceil((horizon - start) / BEAT) * BEAT;
        if (beat - horizon > 200 && beat - horizon < FRAME_FRAMES - 200) {
          Audio.setParameter("Intensity", value);
          return beat;
        }
        await step(1);
      }
      throw new Error("no beat within a frame of the horizon");
    };
    const ramp = Math.round(QUANTIZED_RAMP_SECONDS * RATE);
    const expectOnBeat = async (beat: number, from: number, to: number): Promise<void> => {
      await step(Math.ceil((beat + ramp - out.length) / FRAME_FRAMES) + 3);
      // `from` through the sample before the beat, the ramp from the beat, `to` once it ends.
      expect(maxError(out, beat - BEAT / 2, beat, from)).toBeLessThan(1e-6);
      expect(Math.abs(out[beat + 1]! - from)).toBeGreaterThan(1e-4);
      expect(maxError(out, beat + ramp + 1, beat + ramp + 2000, to)).toBeLessThan(1e-5);
    };

    // Up to 1: pulse and lead in, on the beat.
    let beat = await changeNearHorizon(1);
    await expectOnBeat(beat, LEVEL.pad, LEVEL.pad + LEVEL.pulse + LEVEL.lead);
    // Down to 0.4: pulse at half ((0.4 - 0.2) / 0.4), lead out.
    beat = await changeNearHorizon(0.4);
    await expectOnBeat(beat, LEVEL.pad + LEVEL.pulse + LEVEL.lead, LEVEL.pad + LEVEL.pulse * 0.5);
    // And to 0: the pad alone again.
    beat = await changeNearHorizon(0);
    await expectOnBeat(beat, LEVEL.pad + LEVEL.pulse * 0.5, LEVEL.pad);
    backend.dispose();
  });
});
