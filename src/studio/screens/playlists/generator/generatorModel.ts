// The Generator editor's rules (ADR 0360 §9, 0349): its parameter rows generated from the generator catalogue (grouped
// as the kinds' panels group them, sfxr's groups for blips; a parameter the catalogue gains later lands in "More" with
// no code here), real-unit readouts for the blip's sfxr units, and every edit the editor makes as a pure
// `EditResult<GeneratorBody>` (a parameter, the seed, `vary`, the note, a preset, Randomise, Mutate, the kind switch),
// so the screen applies each as one labelled undo step of its document. Locks are the editor's (not saved): the
// presets, Randomise and Mutate keep the locked parameters (`blipPresets.ts`, `synthPresets.ts`). The kind switch keeps
// the parameters both kinds share with the same range and unit and says which set values it would lose. Pure.
import { applyBlipPreset, BLIP_PRESETS, isBlipPreset, mutateBlip, randomiseBlip } from "../../../../engine/audio/generators/blipPresets";
import { clampGeneratorParam, defaultGeneratorParams, generatorSpec, type GeneratorParamSpec, type GeneratorSpec } from "../../../../engine/audio/generators/catalogue";
import { isPresetOf } from "../../../../engine/audio/generators/format";
import { MAX_SEED } from "../../../../engine/audio/generators/random";
import { applySynthPreset, isSynthPreset, SYNTH_PRESETS } from "../../../../engine/audio/generators/synthPresets";
import type { GeneratorBody, GeneratorKind } from "../../../../engine/audio/generators/types";
import { accept, refuse, type EditResult } from "../../../../editor/sdk/editResult";

export type GeneratorEdit = (g: GeneratorBody) => EditResult<GeneratorBody>;

// --- rows ------------------------------------------------------------------------------------------------------------

/** The panels each kind's parameters sit in, by parameter name; anything else goes to `MORE`, in catalogue order. */
const GROUPS: Readonly<Record<GeneratorKind, readonly (readonly [string, readonly string[]])[]>> = {
  oscillator: [
    ["Oscillator", ["waveform", "noiseColour", "frequency", "pulseWidth"]],
    ["Envelope", ["attack", "decay", "sustain", "release", "length"]],
    ["Output", ["level"]],
  ],
  synth: [
    ["Oscillators", ["osc1Wave", "osc2Wave", "osc2Semitones", "detune", "oscMix", "pulseWidth", "frequency"]],
    ["Filter", ["filterType", "cutoff", "resonance", "filterEnvAmount", "filterAttack", "filterDecay", "filterSustain", "filterRelease"]],
    ["Envelopes", ["attack", "decay", "sustain", "release", "length"]],
    ["LFO", ["lfoWave", "lfoRate", "lfoDepth", "lfoTarget"]],
    ["Output", ["level"]],
  ],
  // sfxr's panels.
  blip: [
    ["Waveform", ["waveform"]],
    ["Envelope", ["attack", "sustain", "punch", "decay"]],
    ["Frequency", ["baseFrequency", "frequencyLimit", "slide", "deltaSlide"]],
    ["Vibrato", ["vibratoDepth", "vibratoSpeed"]],
    ["Arpeggiation", ["arpeggioAmount", "arpeggioSpeed"]],
    ["Duty cycle", ["duty", "dutySweep"]],
    ["Retrigger", ["repeatSpeed"]],
    ["Flanger", ["phaserOffset", "phaserSweep"]],
    ["Filters", ["lowpassCutoff", "lowpassSweep", "lowpassResonance", "highpassCutoff", "highpassSweep"]],
    ["Output", ["level"]],
  ],
  silence: [["Length", ["length", "lengthRandom"]]],
};

/** The group a parameter the panels don't name yet goes to. */
export const MORE = "More";

export interface GeneratorParamRow {
  readonly name: string;
  readonly spec: GeneratorParamSpec;
  readonly value: number;
  /** A menu (its value is the option's index). */
  readonly choice: boolean;
  /** The value in real units beside the knob ("321 Hz", "204 ms"), when the unit isn't real already (blips). */
  readonly readout: string | null;
  /** Presets, Randomise and Mutate keep it. */
  readonly locked: boolean;
  /** It can be locked (kinds with presets; `level` is always kept, so it has no lock). */
  readonly lockable: boolean;
  readonly isDefault: boolean;
}

export interface GeneratorGroup {
  readonly title: string;
  readonly rows: readonly GeneratorParamRow[];
}

/** True when `kind` has presets (and so locks): blip and synth. */
export const hasPresets = (kind: GeneratorKind): boolean => kind === "blip" || kind === "synth";

/**
 * The editor's rows for `body` from the catalogue entry `spec` (the view passes `generatorSpec(body.kind)`), in the
 * kind's groups; parameters no group names follow in a last "More" group, in catalogue order.
 */
export function generatorRows(spec: GeneratorSpec, body: GeneratorBody, locks: readonly string[] = []): GeneratorGroup[] {
  const groups = GROUPS[spec.kind] ?? [];
  const placed = new Set(groups.flatMap(([, names]) => names));
  const row = (q: GeneratorParamSpec): GeneratorParamRow => {
    const raw = body.params[q.name];
    const value = typeof raw === "number" && Number.isFinite(raw) ? clampGeneratorParam(q, raw) : q.default;
    const lockable = hasPresets(spec.kind) && q.name !== "level";
    return {
      name: q.name, spec: q, value, choice: !!q.choices, readout: spec.kind === "blip" ? blipReadout(q.name, value) : null,
      locked: lockable && locks.includes(q.name), lockable, isDefault: value === q.default,
    };
  };
  const out: GeneratorGroup[] = [];
  for (const [title, names] of groups) {
    const rows = spec.params.filter((q) => names.includes(q.name)).map(row);
    if (rows.length) out.push({ title, rows });
  }
  const more = spec.params.filter((q) => !placed.has(q.name)).map(row);
  if (more.length) out.push({ title: MORE, rows: more });
  return out;
}

// --- blip readouts (sfxr's units in real ones; sfxr counts at 44.1 kHz, ADR 0360 §2) ----------------------------------

const SFXR_RATE = 44100;
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${hz.toFixed(hz >= 100 ? 0 : 1)} Hz`);
const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);

/** A blip parameter's value in real units, or null when sfxr's own number says it best. */
export function blipReadout(name: string, v: number): string | null {
  switch (name) {
    case "baseFrequency":
    case "frequencyLimit":
      // sfxr's period is 100 / (f² + 0.001) supersamples, at 8 supersamples a sample.
      return name === "frequencyLimit" && v <= 0 ? "off" : fmtHz((8 * SFXR_RATE * (v * v + 0.001)) / 100);
    case "attack":
    case "sustain":
    case "decay":
      return fmtMs((v * v * 100000) / SFXR_RATE);
    case "punch":
      return `+${Math.round(v * 200)} %`;
    case "vibratoSpeed":
      return fmtHz((SFXR_RATE * v * v * 0.01) / (2 * Math.PI));
    case "vibratoDepth":
      return `±${Math.round(v * 50)} %`;
    case "arpeggioAmount": {
      const mult = v >= 0 ? 1 - v * v * 0.9 : 1 + v * v * 10;
      const st = -12 * Math.log2(mult);
      return `${st >= 0 ? "+" : "−"}${Math.abs(st).toFixed(1)} st`;
    }
    case "arpeggioSpeed":
      return v >= 1 ? "off" : fmtMs(((1 - v) ** 2 * 20000 + 32) / SFXR_RATE);
    case "repeatSpeed":
      return v <= 0 ? "off" : fmtMs(((1 - v) ** 2 * 20000 + 32) / SFXR_RATE);
    case "duty":
      return `${Math.round(50 - v * 50)} %`;
    default:
      return null;
  }
}

// --- edits -----------------------------------------------------------------------------------------------------------

/** Set parameter `name` (fitted to its spec; the same value is no change). */
export function setGeneratorParam(g: GeneratorBody, name: string, value: number): EditResult<GeneratorBody> {
  const q = generatorSpec(g.kind).params.find((p) => p.name === name);
  if (!q) return refuse(`${generatorSpec(g.kind).label} has no parameter "${name}"`);
  if (!Number.isFinite(value)) return refuse("that isn't a number");
  const v = clampGeneratorParam(q, value);
  if (g.params[name] === v) return accept(g);
  return accept({ ...g, params: { ...g.params, [name]: v } });
}

/** Parse the seed field: a whole number 0..2³²−1, or blank for "drawn per trigger" (null). Undefined: not valid. */
export function parseSeed(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n <= MAX_SEED ? n : undefined;
}

/** Set the seed (null: the noise seed is drawn per trigger). */
export function setSeed(g: GeneratorBody, seed: number | null): EditResult<GeneratorBody> {
  if (seed !== null && !(Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED)) return refuse(`a seed is a whole number 0..${MAX_SEED}`);
  return g.seed === seed ? accept(g) : accept({ ...g, seed });
}

/** Set `vary` (0..1). */
export function setVary(g: GeneratorBody, vary: number): EditResult<GeneratorBody> {
  if (!Number.isFinite(vary)) return refuse("that isn't a number");
  const v = Math.min(1, Math.max(0, vary));
  return g.vary === v ? accept(g) : accept({ ...g, vary: v });
}

/** Set the help note (blank removes it). */
export function setNote(g: GeneratorBody, note: string): EditResult<GeneratorBody> {
  const t = note.trim();
  if ((g.note ?? "") === t) return accept(g);
  const { note: _n, ...rest } = g;
  return accept(t ? { ...rest, note: t } : rest);
}

export interface PresetOption {
  readonly id: string;
  readonly label: string;
}

/** The presets of `kind` (none for oscillator and silence). */
export function presetsOf(kind: GeneratorKind): readonly PresetOption[] {
  return kind === "blip" ? BLIP_PRESETS : kind === "synth" ? SYNTH_PRESETS : [];
}

/**
 * Apply preset `id`: a blip's is drawn from the generator's seed (0 when it has none), so the same preset and seed give
 * the same blip and Randomise moves on from there; a synth's is fixed. Locked parameters (and `level`) are kept.
 */
export function applyPreset(g: GeneratorBody, id: string, locks: readonly string[] = []): EditResult<GeneratorBody> {
  if (g.kind === "blip" && isBlipPreset(id)) return accept(applyBlipPreset(g, id, g.seed ?? 0, locks));
  if (g.kind === "synth" && isSynthPreset(id)) return accept(applySynthPreset(g, id, locks));
  return refuse(`${generatorSpec(g.kind).label} has no preset "${id}"`);
}

/** Randomise (blips): a new seed drawn from the current one, the preset re-run; locked parameters kept. */
export function randomise(g: GeneratorBody, locks: readonly string[] = []): EditResult<GeneratorBody> {
  if (g.kind !== "blip") return refuse("only a blip randomises");
  return accept(randomiseBlip(g, locks));
}

/** Mutate (blips): every unlocked number nudged with draws from the seed, then the next seed. */
export function mutate(g: GeneratorBody, locks: readonly string[] = []): EditResult<GeneratorBody> {
  if (g.kind !== "blip") return refuse("only a blip mutates");
  return accept(mutateBlip(g, locks));
}

/** Toggle the lock on `name`. */
export const toggleLock = (locks: readonly string[], name: string): string[] => (locks.includes(name) ? locks.filter((n) => n !== name) : [...locks, name]);

// --- the kind switch -------------------------------------------------------------------------------------------------

/** Two parameters hold the same thing when their range, unit and options match (a blip's 0..1 attack isn't ms). */
function sameMeaning(a: GeneratorParamSpec, b: GeneratorParamSpec): boolean {
  return a.unit === b.unit && a.min === b.min && a.max === b.max && !!a.choices === !!b.choices && (a.choiceIds ?? []).join("|") === (b.choiceIds ?? []).join("|");
}

export interface KindSwitch {
  readonly next: GeneratorBody;
  /** Parameters set away from their default that the new kind can't hold (labels, catalogue order). */
  readonly lost: readonly string[];
  /** The preset name is dropped (the new kind has no such preset). */
  readonly presetDropped: boolean;
}

/**
 * Switching `g` to `kind`: the new kind's defaults, with each parameter both kinds hold the same way carried over; the
 * seed, `vary` and note stay. `lost` lists what would go (the editor asks first when it isn't empty).
 */
export function kindSwitch(g: GeneratorBody, kind: GeneratorKind): KindSwitch {
  if (g.kind === kind) return { next: g, lost: [], presetDropped: false };
  const from = generatorSpec(g.kind), to = generatorSpec(kind);
  const params = defaultGeneratorParams(kind);
  const carried = new Set<string>();
  for (const q of to.params) {
    const old = from.params.find((p) => p.name === q.name);
    if (old && sameMeaning(old, q) && typeof g.params[q.name] === "number") {
      params[q.name] = clampGeneratorParam(q, g.params[q.name]!);
      carried.add(q.name);
    }
  }
  const lost = from.params.filter((q) => !carried.has(q.name) && (g.params[q.name] ?? q.default) !== q.default).map((q) => q.label);
  const { preset, ...rest } = g;
  const keepPreset = preset !== undefined && isPresetOf(kind, preset);
  const next: GeneratorBody = { ...rest, kind, params, ...(keepPreset ? { preset } : {}) };
  return { next, lost, presetDropped: preset !== undefined && !keepPreset };
}

/** The kind switch as an edit (the editor has asked already when it loses parameters). */
export const switchKind = (g: GeneratorBody, kind: GeneratorKind): EditResult<GeneratorBody> => accept(kindSwitch(g, kind).next);

/** The confirmation's text for a switch that loses parameters, or null when nothing set would be lost. */
export function kindSwitchQuestion(g: GeneratorBody, kind: GeneratorKind): string | null {
  const s = kindSwitch(g, kind);
  if (s.lost.length === 0) return null;
  const list = s.lost.length <= 4 ? s.lost.join(", ") : `${s.lost.slice(0, 3).join(", ")} and ${s.lost.length - 3} more`;
  return `${generatorSpec(kind).label} has no ${list}: ${s.lost.length === 1 ? "that setting is" : "those settings are"} lost (Undo brings ${s.lost.length === 1 ? "it" : "them"} back).`;
}
