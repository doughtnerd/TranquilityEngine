/**
 * The generator catalogue (ADR 0360 §2): the one place that names every generator kind and its parameters, declared
 * with the effect catalogue's `EffectParamSpec` (ranges, steps, units, defaults, `scale: "log"`, `choices`, `smooth`),
 * so curves interpolate log parameters in log space (ADR 0346), choices step, the Studio draws generated rows and the
 * parse clamps (ADR 0306).
 *
 * **The catalogue's order is the wire order**: the core reads parameter `i` of a GEN record as `params[i]` here
 * (`generatorWireValues`), so a parameter is only ever appended, never moved or removed. At most
 * `GENERATOR_PARAM_LIMIT` (32, the GEN record's mask bits) a kind.
 *
 * Times are ms unless the unit says `s`, levels dB. The blip's parameters are sfxr's own (0..1 or −1..1), so sfxr,
 * bfxr and jsfxr settings port; the core converts sfxr's 44.1 kHz period counter to hertz and seconds.
 *
 * A choice parameter's value is its option's index; `choices` are the labels a menu shows and `choiceIds` the names
 * the file writes (`"waveform": "square"`).
 *
 * Pure; no plugin, no DOM.
 */
import type { EffectParamSpec } from "../effects/types";
import { GENERATOR_KINDS, type GeneratorKind } from "./types";

/** At most this many parameters a kind (the GEN record's 32-bit mask). */
export const GENERATOR_PARAM_LIMIT = 32;

/** A generator parameter: an effect parameter row, plus, for a choice, the option names the file writes. */
export type GeneratorParamSpec = EffectParamSpec & { readonly choiceIds?: readonly string[] };

/** One kind in the catalogue. */
export interface GeneratorSpec {
  readonly kind: GeneratorKind;
  readonly label: string;
  /** In wire order. */
  readonly params: readonly GeneratorParamSpec[];
}

const p = (name: string, label: string, min: number, max: number, step: number, unit: string, def: number, scale: "linear" | "log" = "linear"): GeneratorParamSpec =>
  Object.freeze({ name, label, min, max, step, unit, default: def, scale });

/** A choice: `options` are `[id, label]` pairs; the value is the index. */
const choice = (name: string, label: string, options: readonly (readonly [string, string])[], def = 0): GeneratorParamSpec =>
  Object.freeze({
    name, label, min: 0, max: options.length - 1, step: 1, unit: "", default: def, scale: "linear" as const, smooth: false,
    choices: Object.freeze(options.map((o) => o[1])), choiceIds: Object.freeze(options.map((o) => o[0])),
  });

const OSC_WAVES = [["sine", "Sine"], ["square", "Square"], ["saw", "Saw"], ["triangle", "Triangle"], ["noise", "Noise"]] as const;
/** sfxr's order (0 square, 1 saw, 2 sine, 3 noise), then bfxr's triangle. */
const BLIP_WAVES = [["square", "Square"], ["saw", "Saw"], ["sine", "Sine"], ["noise", "Noise"], ["triangle", "Triangle"]] as const;

const level = () => p("level", "Level", -60, 0, 0.1, "dB", -12);
const length = (def: number) => p("length", "Length", 0, 60, 0.01, "s", def);
const ms = (name: string, label: string, max: number, def: number) => p(name, label, 0, max, 1, "ms", def);
const pct = (name: string, label: string, def: number, min = 0, max = 100) => p(name, label, min, max, 1, "%", def);
const freq = (name: string, label: string, def: number) => p(name, label, 20, 20000, 1, "Hz", def, "log");
/** An sfxr parameter: 0..1, or −1..1 when `signed`. */
const sfxr = (name: string, label: string, def: number, signed = false) => p(name, label, signed ? -1 : 0, 1, 0.001, "", def);

const spec = (kind: GeneratorKind, label: string, params: GeneratorParamSpec[]): GeneratorSpec => Object.freeze({ kind, label, params: Object.freeze(params) });

/** Every kind, in `GENERATOR_KINDS` order. */
export const GENERATOR_CATALOGUE: Readonly<Record<GeneratorKind, GeneratorSpec>> = Object.freeze({
  // Wwise Tone Generator, FMOD's oscillator. The 2 ms attack and 10 ms release are click guards.
  oscillator: spec("oscillator", "Oscillator", [
    choice("waveform", "Waveform", OSC_WAVES),
    choice("noiseColour", "Noise colour", [["white", "White"], ["pink", "Pink"], ["brown", "Brown"]]),
    freq("frequency", "Frequency", 440),
    pct("pulseWidth", "Pulse width", 50, 1, 99),
    level(),
    ms("attack", "Attack", 5000, 2),
    ms("decay", "Decay", 5000, 0),
    pct("sustain", "Sustain", 100),
    ms("release", "Release", 10000, 10),
    length(0),
  ]),
  // A two-oscillator subtractive voice (Synth One's shape).
  synth: spec("synth", "Synth", [
    choice("osc1Wave", "Oscillator 1", OSC_WAVES, 2),
    choice("osc2Wave", "Oscillator 2", OSC_WAVES, 2),
    p("osc2Semitones", "Oscillator 2 pitch", -24, 24, 1, "st", 0),
    p("detune", "Detune", 0, 100, 1, "ct", 7),
    pct("oscMix", "Oscillator mix", 50),
    pct("pulseWidth", "Pulse width", 50, 1, 99),
    freq("frequency", "Frequency", 220),
    choice("filterType", "Filter", [["lowpass", "Low-pass"], ["highpass", "High-pass"], ["bandpass", "Band-pass"]]),
    freq("cutoff", "Cutoff", 2000),
    p("resonance", "Resonance", 0, 1, 0.01, "", 0.2),
    p("filterEnvAmount", "Filter envelope", -48, 48, 1, "st", 24),
    ms("filterAttack", "Filter attack", 5000, 5),
    ms("filterDecay", "Filter decay", 5000, 300),
    pct("filterSustain", "Filter sustain", 30),
    ms("filterRelease", "Filter release", 10000, 300),
    ms("attack", "Attack", 5000, 5),
    ms("decay", "Decay", 5000, 200),
    pct("sustain", "Sustain", 80),
    ms("release", "Release", 10000, 300),
    choice("lfoWave", "LFO wave", [["sine", "Sine"], ["triangle", "Triangle"], ["square", "Square"], ["saw", "Saw"], ["sampleHold", "Sample & hold"]]),
    p("lfoRate", "LFO rate", 0.05, 20, 0.01, "Hz", 5, "log"),
    pct("lfoDepth", "LFO depth", 0),
    // At full depth: pitch ±2 st, cutoff ±4 octaves, amp, pulse width ±49 %.
    choice("lfoTarget", "LFO target", [["pitch", "Pitch"], ["cutoff", "Cutoff"], ["amp", "Amp"], ["pulseWidth", "Pulse width"]]),
    level(),
    length(0),
  ]),
  // sfxr, in sfxr's units.
  blip: spec("blip", "Blip", [
    choice("waveform", "Waveform", BLIP_WAVES),
    sfxr("attack", "Attack", 0),
    sfxr("sustain", "Sustain", 0.3),
    sfxr("punch", "Punch", 0),
    sfxr("decay", "Decay", 0.4),
    sfxr("baseFrequency", "Frequency", 0.3),
    sfxr("frequencyLimit", "Frequency cutoff", 0),
    sfxr("slide", "Slide", 0, true),
    sfxr("deltaSlide", "Delta slide", 0, true),
    sfxr("vibratoDepth", "Vibrato depth", 0),
    sfxr("vibratoSpeed", "Vibrato speed", 0),
    sfxr("arpeggioAmount", "Change amount", 0, true),
    sfxr("arpeggioSpeed", "Change speed", 0),
    sfxr("duty", "Square duty", 0),
    sfxr("dutySweep", "Duty sweep", 0, true),
    sfxr("repeatSpeed", "Repeat speed", 0),
    sfxr("phaserOffset", "Phaser offset", 0, true),
    sfxr("phaserSweep", "Phaser sweep", 0, true),
    sfxr("lowpassCutoff", "Low-pass cutoff", 1),
    sfxr("lowpassSweep", "Low-pass sweep", 0, true),
    sfxr("lowpassResonance", "Low-pass resonance", 0),
    sfxr("highpassCutoff", "High-pass cutoff", 0),
    sfxr("highpassSweep", "High-pass sweep", 0, true),
    level(),
  ]),
  // Wwise Silence: a placeholder and spacer that still counts as a play.
  silence: spec("silence", "Silence", [
    length(1),
    p("lengthRandom", "Length random", 0, 60, 0.01, "s", 0),
  ]),
});

// --- lookups ---------------------------------------------------------------------------------------------------------

const KIND_SET: ReadonlySet<string> = new Set(GENERATOR_KINDS);

/** True when `kind` names a generator kind. */
export const isGeneratorKind = (kind: unknown): kind is GeneratorKind => typeof kind === "string" && KIND_SET.has(kind);

/** The catalogue entry of `kind`. */
export const generatorSpec = (kind: GeneratorKind): GeneratorSpec => GENERATOR_CATALOGUE[kind];

/** The parameter `name` of `kind`, or undefined. */
export const generatorParamSpec = (kind: GeneratorKind, name: string): GeneratorParamSpec | undefined =>
  GENERATOR_CATALOGUE[kind].params.find((q) => q.name === name);

/** The wire index of parameter `name` of `kind` (the GEN mask bit and the AUTOMATE target-5 index), or -1. */
export const generatorParamIndex = (kind: GeneratorKind, name: string): number => GENERATOR_CATALOGUE[kind].params.findIndex((q) => q.name === name);

/** The kind's number after `GEN_CLIP_ID_FIRST` (ADR 0360 §3): 1 oscillator, 2 synth, 3 blip, 4 silence. */
export const generatorKindIndex = (kind: GeneratorKind): number => GENERATOR_KINDS.indexOf(kind) + 1;

/** Every parameter of `kind` at its default, by name. */
export const defaultGeneratorParams = (kind: GeneratorKind): Record<string, number> =>
  Object.fromEntries(GENERATOR_CATALOGUE[kind].params.map((q) => [q.name, q.default]));

/** A parameter value fitted to its spec: clamped, and a whole index for a choice. */
export function clampGeneratorParam(q: GeneratorParamSpec, value: number): number {
  const c = Math.min(q.max, Math.max(q.min, value)) + 0;
  return q.choices ? Math.round(c) : c;
}

/** The option index of `id` in a choice parameter (case-insensitive), or -1. */
export const choiceIndex = (q: GeneratorParamSpec, id: string): number => (q.choiceIds ?? []).findIndex((c) => c.toLowerCase() === id.toLowerCase());

/** The values of `params` in wire order (missing ones at their defaults, each fitted to its spec): what a GEN carries. */
export function generatorWireValues(kind: GeneratorKind, params: Readonly<Record<string, number>>): number[] {
  return GENERATOR_CATALOGUE[kind].params.map((q) => {
    const v = params[q.name];
    return typeof v === "number" && Number.isFinite(v) ? clampGeneratorParam(q, v) : q.default;
  });
}

/**
 * True when a generator of `kind` with `params` sounds until it is released or stopped (an oscillator or synth with
 * `length` 0). A blip ends with its envelope; a silence with its length.
 */
export function generatorIsEndless(kind: GeneratorKind, params: Readonly<Record<string, number>>): boolean {
  if (kind !== "oscillator" && kind !== "synth") return false;
  return (params.length ?? 0) <= 0;
}
