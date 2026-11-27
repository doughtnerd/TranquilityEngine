// G9b (ADR 0171 amended by 0172; architecture §4.6; E3's finding in `tests/e2e/audio-mix-c.spec.ts`): a level rule's
// trigger far under its threshold never dips the target, at the voice's start included. E3 saw a quiet `AudioSource`
// (the tone at volume 0.02) on a compressed SFX bus dip Music to ≈ 0.82 at its start against a -30 dBFS RMS rule. The
// core gives exactly 1 for a voice that starts quiet (`audio-core/tests/duck_level_voice_start.rs`); the dip was the
// voice starting **loud**: `AudioSource.play` sent the PLAY at gain 1 and its volume in the next frame's SET_PARAMS, so
// for a frame the compressor (its makeup gain) and the detector heard the tone at full scale. `AudioSource.play` now
// starts the voice at its volume and pitch. Run on the real wasm (the loopback host), with E3's buses and rule, timed
// in rendered frames: the duck gain is read from every STATUS (each 6 quanta).
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { mixer } from "../../../../engine/audio/mixer";
import type { DuckingRule } from "../../../../engine/audio/settings";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, loopbackAudio, closeLoopbackAudio } from "../testing";
import { AudioSource } from "../AudioSource";
import { presetFromSettings } from "./context";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
/** E3's reference tone: 1 kHz at -23 dBFS peak (-26 dBFS RMS). */
const PEAK = Math.pow(10, -23 / 20);
/** E3's rule (`audio-mix-c.spec.ts` `LEVEL`). */
const LEVEL: DuckingRule = { target: "Music", trigger: "SFX", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.05, release: 0.4 };
/** E3's SFX compressor (`audioMixLive.ts` `BUSES`). */
const COMPRESSOR = { type: "compressor", threshold: -24, knee: 30, ratio: 8, attack: 0.003, release: 0.25 };

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

/** A headless engine with E3's buses and rule, its audio on the real core over the loopback host. */
async function rig() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "tone.wav": "data:audio/wav;base64,AAAA" }));
  const audio = { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Master", effects: [COMPRESSOR] }], ducking: [LEVEL] };
  const engine = await Engine.create({ headless: true, project: { audio } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const tone = new Float32Array(CLIP_FRAMES).map((_, i) => PEAK * Math.sin((2 * Math.PI * 1000 * i) / RATE));
  // ADR 0221: the production assembly on the loopback, on the page's mixer (the Engine configured it), registered.
  const loop = await loopbackAudio({
    preset: { ...presetFromSettings(mixer.audioSettings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [tone] }),
    recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return null;
  const backend = loop.backend;
  /** `n` frames of 6 quanta (one STATUS each); returns Music's lowest duck gain over them. */
  const frames = async (n: number) => {
    let min = 1;
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.016);
      loop.render(6);
      for (let k = 0; k < 8; k++) await Promise.resolve();
      min = Math.min(min, mixer.bus("Music").duckGain);
    }
    return min;
  };
  const source = (bus: string, volume: number) =>
    GameObject.create(`Tone ${bus}`).addBehavior(AudioSource, { clip: "asset:tone.wav", loop: true, volume, playOnAwake: false, output: bus });
  return { backend, frames, source };
}

it("a quiet AudioSource on a level rule's trigger (far under its threshold) never dips the target, at its start included", { timeout: 60_000 }, async (ctx) => {
  const r = await rig();
  if (!r) return ctx.skip();
  r.source("Music", 1).play();
  expect(await r.frames(20), "nothing on the trigger yet").toBe(1);
  // E3's order: the loud trigger ducks, stops, and the duck releases to exactly 1 (12 time constants of 0.4 s).
  const loud = r.source("SFX", 1);
  loud.play();
  expect(await r.frames(60), "the loud trigger ducks").toBeLessThan(0.35);
  loud.stop();
  await r.frames(300);
  expect(mixer.bus("Music").duckGain, "released").toBe(1);
  // The tone at 0.02: about -60 dBFS RMS (and the compressor's makeup), far under -30.
  r.source("SFX", 0.02).play();
  const quiet = await r.frames(150);
  expect(quiet, "the quiet trigger's start dips nothing").toBe(1);
  r.backend.dispose();
});

it("AudioSource.play starts the voice at its volume (times the clip's import volume) and its pitch, one case each", async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "tone.wav": "data:audio/wav;base64,AAAA", "tone.wav.meta.json": { format: "myco.import@1", volume: 0.5 } }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const fake = makeFakeBackend();
  fake.ready = true;
  setAudioBackend(fake);
  const importVolume = Assets.importSettings("tone.wav").volume;
  expect(importVolume).toBe(0.5);
  GameObject.create("v").addBehavior(AudioSource, { clip: "asset:tone.wav", volume: 0.02, playOnAwake: false, output: "SFX" }).play();
  expect(fake.plays.at(-1)).toMatchObject({ volume: 0.02 * importVolume });
  GameObject.create("p").addBehavior(AudioSource, { clip: "asset:tone.wav", pitch: 1.5, playOnAwake: false, output: "SFX" }).play();
  expect(fake.plays.at(-1)).toMatchObject({ volume: importVolume, pitch: 1.5 });
});
