/**
 * Blip presets and the randomiser (ADR 0360 §2): sfxr's generator functions (DrPetter's sfxr, MIT; jsfxr) re-implemented
 * on the blip's parameters, drawing from **mulberry32 seeded by the generator's `seed`**, so the same preset, seed and
 * locks always give the same parameters on every machine. The resolved parameters are what the file stores; `seed` and
 * `preset` record how they were made.
 *
 * - `blipPreset(preset, seed)`: the parameters one preset draws from one seed (sfxr's `ResetParams` then its case).
 * - `applyBlipPreset(body, preset, seed, locks)`: a blip made from that, keeping the locked parameters of `body`.
 * - `randomiseBlip(body, locks)`: a new seed drawn from the current one (so Randomise is repeatable too), then the
 *   preset re-run.
 * - `mutateBlip(body, locks)`: sfxr's Mutate: each unlocked number moves by up to ±0.05 with even odds, drawn from the
 *   current seed; the result carries the next seed, so Mutate again moves on.
 *
 * Draws never depend on the locks (a locked parameter's draws are taken and thrown away), so locking one parameter
 * changes no other. `level` is the blip's volume, not one of sfxr's synthesis parameters: presets, Randomise and
 * Mutate keep it, and `quality` too. A null seed counts as 0.
 *
 * Pure; no plugin, no DOM.
 */
import { clampGeneratorParam, defaultGeneratorParams, generatorSpec } from "./catalogue";
import { mulberry32, seedFrom, type Draw } from "./random";
import type { GeneratorBody } from "./types";

export const BLIP_PRESETS = [
  { id: "coin", label: "Coin" },
  { id: "jump", label: "Jump" },
  { id: "laser", label: "Laser" },
  { id: "hit", label: "Hit" },
  { id: "powerUp", label: "Power-up" },
  { id: "blip", label: "Blip" },
  { id: "explosion", label: "Explosion" },
  { id: "random", label: "Random" },
] as const;
export type BlipPresetId = (typeof BLIP_PRESETS)[number]["id"];

export const isBlipPreset = (id: unknown): id is BlipPresetId => typeof id === "string" && BLIP_PRESETS.some((p) => p.id === id);

/** Parameters presets, Randomise and Mutate never change: how loud and how band-limited, not the sound's design. */
const KEPT = new Set(["level", "quality"]);

/** sfxr's wave types, as the blip's `waveform` index. */
const SQUARE = 0, SAW = 1, NOISE = 3;

/** sfxr's draws over one seeded source: `rnd(n)` a whole number 0..n, `frnd(r)` a number in [0, r). */
function sfxrDraws(draw: Draw) {
  return { rnd: (n: number) => Math.floor(draw() * (n + 1)), frnd: (r: number) => draw() * r };
}

/** Every parameter fitted to its spec. */
function clampAll(params: Record<string, number>): Record<string, number> {
  for (const q of generatorSpec("blip").params) params[q.name] = clampGeneratorParam(q, params[q.name] ?? q.default);
  return params;
}

/** The parameters `preset` draws from `seed` (every blip parameter, `level` at its default). */
export function blipPreset(preset: BlipPresetId, seed: number): Record<string, number> {
  const { rnd, frnd } = sfxrDraws(mulberry32(seed));
  const p = defaultGeneratorParams("blip");
  switch (preset) {
    case "coin":
      p.baseFrequency = 0.4 + frnd(0.5);
      p.attack = 0;
      p.sustain = frnd(0.1);
      p.decay = 0.1 + frnd(0.4);
      p.punch = 0.3 + frnd(0.3);
      if (rnd(1)) {
        p.arpeggioSpeed = 0.5 + frnd(0.2);
        p.arpeggioAmount = 0.2 + frnd(0.4);
      }
      break;
    case "laser":
      p.waveform = rnd(2);
      if (p.waveform === 2 && rnd(1)) p.waveform = rnd(1);
      p.baseFrequency = 0.5 + frnd(0.5);
      p.frequencyLimit = Math.max(0.2, p.baseFrequency - 0.2 - frnd(0.6));
      p.slide = -0.15 - frnd(0.2);
      if (rnd(2) === 0) {
        p.baseFrequency = 0.3 + frnd(0.6);
        p.frequencyLimit = frnd(0.1);
        p.slide = -0.35 - frnd(0.3);
      }
      if (rnd(1)) {
        p.duty = frnd(0.5);
        p.dutySweep = frnd(0.2);
      } else {
        p.duty = 0.4 + frnd(0.5);
        p.dutySweep = -frnd(0.7);
      }
      p.attack = 0;
      p.sustain = 0.1 + frnd(0.2);
      p.decay = frnd(0.4);
      if (rnd(1)) p.punch = frnd(0.3);
      if (rnd(2) === 0) {
        p.phaserOffset = frnd(0.2);
        p.phaserSweep = -frnd(0.2);
      }
      if (rnd(1)) p.highpassCutoff = frnd(0.3);
      break;
    case "explosion":
      p.waveform = NOISE;
      if (rnd(1)) {
        p.baseFrequency = 0.1 + frnd(0.4);
        p.slide = -0.1 + frnd(0.4);
      } else {
        p.baseFrequency = 0.2 + frnd(0.7);
        p.slide = -0.2 - frnd(0.2);
      }
      p.baseFrequency *= p.baseFrequency;
      if (rnd(4) === 0) p.slide = 0;
      if (rnd(2) === 0) p.repeatSpeed = 0.3 + frnd(0.5);
      p.attack = 0;
      p.sustain = 0.1 + frnd(0.3);
      p.decay = frnd(0.5);
      if (rnd(1) === 0) {
        p.phaserOffset = -0.3 + frnd(0.9);
        p.phaserSweep = -frnd(0.3);
      }
      p.punch = 0.2 + frnd(0.6);
      if (rnd(1)) {
        p.vibratoDepth = frnd(0.7);
        p.vibratoSpeed = frnd(0.6);
      }
      if (rnd(2) === 0) {
        p.arpeggioSpeed = 0.6 + frnd(0.3);
        p.arpeggioAmount = 0.8 - frnd(1.6);
      }
      break;
    case "powerUp":
      if (rnd(1)) p.waveform = SAW;
      else p.duty = frnd(0.6);
      p.baseFrequency = 0.2 + frnd(0.3);
      if (rnd(1)) {
        p.slide = 0.1 + frnd(0.4);
        p.repeatSpeed = 0.4 + frnd(0.4);
      } else {
        p.slide = 0.05 + frnd(0.2);
        if (rnd(1)) {
          p.vibratoDepth = frnd(0.7);
          p.vibratoSpeed = frnd(0.6);
        }
      }
      p.attack = 0;
      p.sustain = frnd(0.4);
      p.decay = 0.1 + frnd(0.4);
      break;
    case "hit":
      p.waveform = rnd(2);
      if (p.waveform === 2) p.waveform = NOISE;
      if (p.waveform === SQUARE) p.duty = frnd(0.6);
      p.baseFrequency = 0.2 + frnd(0.6);
      p.slide = -0.3 - frnd(0.4);
      p.attack = 0;
      p.sustain = frnd(0.1);
      p.decay = 0.1 + frnd(0.2);
      if (rnd(1)) p.highpassCutoff = frnd(0.3);
      break;
    case "jump":
      p.waveform = SQUARE;
      p.duty = frnd(0.6);
      p.baseFrequency = 0.3 + frnd(0.3);
      p.slide = 0.1 + frnd(0.2);
      p.attack = 0;
      p.sustain = 0.1 + frnd(0.3);
      p.decay = 0.1 + frnd(0.2);
      if (rnd(1)) p.highpassCutoff = frnd(0.3);
      if (rnd(1)) p.lowpassCutoff = 1 - frnd(0.6);
      break;
    case "blip":
      p.waveform = rnd(1);
      if (p.waveform === SQUARE) p.duty = frnd(0.6);
      p.baseFrequency = 0.2 + frnd(0.4);
      p.attack = 0;
      p.sustain = 0.1 + frnd(0.1);
      p.decay = frnd(0.2);
      p.highpassCutoff = 0.1;
      break;
    case "random": {
      // sfxr's Randomize (jsfxr's: the wave type is drawn too).
      const signed = () => frnd(2) - 1;
      p.waveform = rnd(3);
      p.baseFrequency = signed() ** 2;
      if (rnd(1)) p.baseFrequency = signed() ** 3 + 0.5;
      p.frequencyLimit = 0;
      p.slide = signed() ** 5;
      if (p.baseFrequency > 0.7 && p.slide > 0.2) p.slide = -p.slide;
      if (p.baseFrequency < 0.2 && p.slide < -0.05) p.slide = -p.slide;
      p.deltaSlide = signed() ** 3;
      p.duty = signed();
      p.dutySweep = signed() ** 3;
      p.vibratoDepth = signed() ** 3;
      p.vibratoSpeed = signed();
      p.attack = signed() ** 3;
      p.sustain = signed() ** 2;
      p.decay = signed();
      p.punch = frnd(0.8) ** 2;
      if (p.attack + p.sustain + p.decay < 0.2) {
        p.sustain += 0.2 + frnd(0.3);
        p.decay += 0.2 + frnd(0.3);
      }
      p.lowpassResonance = signed();
      p.lowpassCutoff = 1 - frnd(1) ** 3;
      p.lowpassSweep = signed() ** 3;
      if (p.lowpassCutoff < 0.1 && p.lowpassSweep < -0.05) p.lowpassSweep = -p.lowpassSweep;
      p.highpassCutoff = frnd(1) ** 5;
      p.highpassSweep = signed() ** 5;
      p.phaserOffset = signed() ** 3;
      p.phaserSweep = signed() ** 3;
      p.repeatSpeed = signed();
      p.arpeggioSpeed = signed();
      p.arpeggioAmount = signed();
      break;
    }
  }
  return clampAll(p);
}

/** `fresh` with the locked parameters (and the kept ones) taken from `from` when it is a blip. */
function keepLocked(fresh: Record<string, number>, from: GeneratorBody, locks: readonly string[]): Record<string, number> {
  if (from.kind !== "blip") return fresh;
  for (const name of [...locks, ...KEPT]) if (name in fresh && typeof from.params[name] === "number") fresh[name] = from.params[name];
  return fresh;
}

/** `body` made into a blip from `preset` drawn with `seed`, its locked parameters kept (a non-blip `body` keeps none). */
export function applyBlipPreset(body: GeneratorBody, preset: BlipPresetId, seed: number, locks: readonly string[] = []): GeneratorBody {
  const out: GeneratorBody = { ...body, kind: "blip", params: keepLocked(blipPreset(preset, seed >>> 0), body, locks), seed: seed >>> 0, preset };
  return out;
}

/** Randomise: a new seed drawn from the current one, then the blip's preset (Random when it has none) re-run. */
export function randomiseBlip(body: GeneratorBody, locks: readonly string[] = []): GeneratorBody {
  const seed = seedFrom(mulberry32(body.seed ?? 0));
  const preset = isBlipPreset(body.preset) ? body.preset : "random";
  return applyBlipPreset(body, preset, seed, locks);
}

/** Mutate: every unlocked number nudged (sfxr's ±0.05 with even odds) with draws from the current seed; the next seed after. */
export function mutateBlip(body: GeneratorBody, locks: readonly string[] = []): GeneratorBody {
  const draw = mulberry32(body.seed ?? 0);
  const { rnd, frnd } = sfxrDraws(draw);
  const locked = new Set([...locks, ...KEPT]);
  const base = body.kind === "blip" ? body.params : defaultGeneratorParams("blip");
  const params: Record<string, number> = {};
  for (const q of generatorSpec("blip").params) {
    const v = base[q.name] ?? q.default;
    // Two draws for every parameter, whether it moves or not, so locks and choices change no other parameter's draws.
    const moves = rnd(1) === 1;
    const by = frnd(0.1) - 0.05;
    params[q.name] = !q.choices && !locked.has(q.name) && moves ? clampGeneratorParam(q, v + by) : v;
  }
  return { ...body, kind: "blip", params, seed: seedFrom(draw) };
}
