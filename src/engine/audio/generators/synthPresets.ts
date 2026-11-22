/**
 * Synth presets (ADR 0346 §2): Beep, Click, Pluck, Bass, Lead, Pad, Drone and Whoosh (noise through a swept band-pass).
 * Each is a fixed set of overrides on the synth's defaults; choosing one writes every parameter (the file stores the
 * resolved parameters, `preset` records which it was made from). Locked parameters keep their values; `level` is kept.
 *
 * Pure; no plugin, no DOM.
 */
import { choiceIndex, clampGeneratorParam, defaultGeneratorParams, generatorParamSpec, generatorSpec } from "./catalogue";
import type { GeneratorBody } from "./types";

export const SYNTH_PRESETS = [
  { id: "beep", label: "Beep" },
  { id: "click", label: "Click" },
  { id: "pluck", label: "Pluck" },
  { id: "bass", label: "Bass" },
  { id: "lead", label: "Lead" },
  { id: "pad", label: "Pad" },
  { id: "drone", label: "Drone" },
  { id: "whoosh", label: "Whoosh" },
] as const;
export type SynthPresetId = (typeof SYNTH_PRESETS)[number]["id"];

export const isSynthPreset = (id: unknown): id is SynthPresetId => typeof id === "string" && SYNTH_PRESETS.some((p) => p.id === id);

/** Overrides by name; a choice is written as its option name. */
type Overrides = Readonly<Record<string, number | string>>;

const OVERRIDES: Readonly<Record<SynthPresetId, Overrides>> = {
  beep: {
    osc1Wave: "square", osc2Wave: "square", detune: 0, oscMix: 0, frequency: 880, cutoff: 6000, resonance: 0, filterEnvAmount: 0,
    attack: 2, decay: 0, sustain: 100, release: 30, length: 0.15,
  },
  click: {
    osc1Wave: "noise", osc2Wave: "square", oscMix: 20, frequency: 2000, filterType: "highpass", cutoff: 1500, resonance: 0.1, filterEnvAmount: 0,
    attack: 0, decay: 15, sustain: 0, release: 10, length: 0.03,
  },
  pluck: {
    osc1Wave: "saw", osc2Wave: "square", osc2Semitones: 12, detune: 4, oscMix: 30, frequency: 330, cutoff: 600, resonance: 0.3, filterEnvAmount: 36,
    filterAttack: 0, filterDecay: 180, filterSustain: 0, filterRelease: 150, attack: 1, decay: 400, sustain: 0, release: 200, length: 0.6,
  },
  bass: {
    osc1Wave: "saw", osc2Wave: "square", osc2Semitones: -12, detune: 5, oscMix: 40, frequency: 55, cutoff: 400, resonance: 0.35, filterEnvAmount: 24,
    filterAttack: 2, filterDecay: 250, filterSustain: 20, filterRelease: 200, attack: 3, decay: 300, sustain: 70, release: 150,
  },
  lead: {
    osc1Wave: "saw", osc2Wave: "saw", detune: 12, oscMix: 50, frequency: 440, cutoff: 2500, resonance: 0.4, filterEnvAmount: 12,
    filterAttack: 10, filterDecay: 400, filterSustain: 50, filterRelease: 300, attack: 8, decay: 200, sustain: 85, release: 250,
    lfoWave: "sine", lfoRate: 5.5, lfoDepth: 15, lfoTarget: "pitch",
  },
  pad: {
    osc1Wave: "saw", osc2Wave: "triangle", osc2Semitones: 7, detune: 18, oscMix: 50, frequency: 220, cutoff: 1200, resonance: 0.15, filterEnvAmount: 12,
    filterAttack: 1200, filterDecay: 1500, filterSustain: 60, filterRelease: 2000, attack: 900, decay: 800, sustain: 80, release: 2500,
    lfoWave: "triangle", lfoRate: 0.3, lfoDepth: 25, lfoTarget: "cutoff",
  },
  drone: {
    osc1Wave: "saw", osc2Wave: "saw", osc2Semitones: -12, detune: 9, oscMix: 50, frequency: 82.41, cutoff: 700, resonance: 0.25, filterEnvAmount: 0,
    attack: 1500, decay: 0, sustain: 100, release: 3000, lfoWave: "sine", lfoRate: 0.12, lfoDepth: 30, lfoTarget: "cutoff",
  },
  whoosh: {
    osc1Wave: "noise", osc2Wave: "noise", oscMix: 0, frequency: 440, filterType: "bandpass", cutoff: 300, resonance: 0.55, filterEnvAmount: 40,
    filterAttack: 450, filterDecay: 700, filterSustain: 0, filterRelease: 300, attack: 300, decay: 800, sustain: 0, release: 300, length: 1.2,
  },
};

/** Every synth parameter of `preset` (`level` at its default). */
export function synthPreset(preset: SynthPresetId): Record<string, number> {
  const p = defaultGeneratorParams("synth");
  for (const [name, v] of Object.entries(OVERRIDES[preset])) {
    const q = generatorParamSpec("synth", name)!;
    p[name] = clampGeneratorParam(q, typeof v === "string" ? choiceIndex(q, v) : v);
  }
  return p;
}

/** `body` made into a synth from `preset`, its locked parameters and its `level` kept (a non-synth `body` keeps none). */
export function applySynthPreset(body: GeneratorBody, preset: SynthPresetId, locks: readonly string[] = []): GeneratorBody {
  const params = synthPreset(preset);
  if (body.kind === "synth") {
    for (const name of [...locks, "level"]) if (generatorSpec("synth").params.some((q) => q.name === name) && typeof body.params[name] === "number") params[name] = body.params[name];
  }
  return { ...body, kind: "synth", params, preset };
}
