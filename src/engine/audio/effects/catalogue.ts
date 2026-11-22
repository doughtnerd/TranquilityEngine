/**
 * The effect catalogue (ADR 0331): the one place that names every effect type, its parameters (ranges, steps, units,
 * defaults, scale), the levels it may run at, its version and its profiler cost class. Every format that holds effects
 * (sample blocks, playlists, sequences, the mix) parses them with `parseEffect`/`parseEffects` and writes them with
 * `effectToJson`; the Studio's effect editors and the core's opcodes read their ranges from here.
 *
 * ```jsonc
 * { "id": "fx1", "type": "lowpass", "on": true, "params": { "cutoff": 800 } }
 * ```
 *
 * The parse is lenient: an unknown type is dropped with one problem line, a missing parameter takes its default, a
 * value out of range is clamped, an unknown parameter is dropped, and an effect at a level its type can't run at is
 * kept (so it can be moved, ADR 0331 "Move to the track") with a problem line; the runtime skips it (`allowedAt`).
 *
 * Pure; no plugin, no DOM.
 */
import { IdScope, isFiniteNumber, isRecord, LenientReader } from "../lenientRead";
import { EFFECT_TYPES, type Effect, type EffectLevel, type EffectParamSpec, type EffectSpec, type EffectType } from "./types";

export const EFFECT_LEVELS: readonly EffectLevel[] = ["sample", "voice", "instance", "bus"];
const ALL: readonly EffectLevel[] = EFFECT_LEVELS;

/** One parameter row; `scale` defaults to linear. */
const p = (name: string, label: string, min: number, max: number, step: number, unit: string, def: number, scale: "linear" | "log" = "linear"): EffectParamSpec =>
  Object.freeze({ name, label, min, max, step, unit, default: def, scale });

const freq = (name: string, label: string, def: number) => p(name, label, 20, 20000, 1, "Hz", def, "log");
const resonance = (def: number) => p("resonance", "Resonance", 0, 1, 0.01, "", def);
const drive = () => p("drive", "Drive", 0, 100, 1, "%", 0);
const mix = (def: number) => p("mix", "Mix", 0, 100, 1, "%", def);

const spec = (s: EffectSpec): EffectSpec => Object.freeze({ ...s, params: Object.freeze([...s.params]), levels: Object.freeze([...s.levels]) });

/** Every type, in `EFFECT_TYPES` order. Version "1" for all: a type's version changes when its parameters change meaning. */
export const EFFECT_CATALOGUE: Readonly<Record<EffectType, EffectSpec>> = Object.freeze({
  eq: spec({ type: "eq", label: "EQ", version: "1", cost: "light", levels: ALL, params: [
    p("low", "Low", -18, 18, 0.1, "dB", 0), p("mid", "Mid", -18, 18, 0.1, "dB", 0), p("high", "High", -18, 18, 0.1, "dB", 0),
  ] }),
  lowpass: spec({ type: "lowpass", label: "Low-pass", version: "1", cost: "light", levels: ALL, params: [freq("cutoff", "Cutoff", 20000), resonance(0.1), drive()] }),
  highpass: spec({ type: "highpass", label: "High-pass", version: "1", cost: "light", levels: ALL, params: [freq("cutoff", "Cutoff", 20), resonance(0.1), drive()] }),
  bandpass: spec({ type: "bandpass", label: "Band-pass", version: "1", cost: "light", levels: ALL, params: [freq("centre", "Centre", 1000), resonance(0.3), drive()] }),
  compressor: spec({ type: "compressor", label: "Compressor", version: "1", cost: "medium", levels: ALL, params: [
    p("threshold", "Threshold", -60, 0, 0.1, "dB", -18), p("ratio", "Ratio", 1, 20, 0.1, ":1", 3),
    p("attack", "Attack", 0.1, 200, 0.1, "ms", 10), p("release", "Release", 5, 2000, 1, "ms", 120), p("makeup", "Makeup", 0, 24, 0.1, "dB", 0),
  ] }),
  sidechainCompressor: spec({ type: "sidechainCompressor", label: "Sidechain compressor", version: "1", cost: "medium", levels: ["bus"], key: "bus", params: [
    p("threshold", "Threshold", -60, 0, 0.1, "dB", -24), p("ratio", "Ratio", 1, 20, 0.1, ":1", 3), p("release", "Release", 5, 2000, 1, "ms", 300),
  ] }),
  limiter: spec({ type: "limiter", label: "Limiter", version: "1", cost: "medium", levels: ["bus"], params: [
    p("ceiling", "Ceiling", -12, 0, 0.1, "dBTP", -1), p("release", "Release", 1, 1000, 1, "ms", 50),
  ] }),
  gain: spec({ type: "gain", label: "Gain", version: "1", cost: "light", levels: ["sample", "voice"], params: [p("gain", "Gain", -24, 24, 0.1, "dB", 0)] }),
  saturation: spec({ type: "saturation", label: "Saturation", version: "1", cost: "light", levels: ALL, params: [p("amount", "Amount", 0, 100, 1, "%", 30)] }),
  distortion: spec({ type: "distortion", label: "Distortion", version: "1", cost: "light", levels: ALL, params: [p("drive", "Drive", 0, 1, 0.01, "", 0.3), mix(100)] }),
  bitcrush: spec({ type: "bitcrush", label: "Bit-crush", version: "1", cost: "light", levels: ALL, params: [
    p("bits", "Bits", 4, 24, 1, "bits", 12), p("downsample", "Downsample", 1, 32, 1, "×", 1), mix(100),
  ] }),
  formantShift: spec({ type: "formantShift", label: "Formant shift", version: "1", cost: "heavy", levels: ["sample", "voice", "instance"], params: [p("shift", "Shift", -12, 12, 0.1, "st", 0)] }),
  pitchShift: spec({ type: "pitchShift", label: "Pitch shift", version: "1", cost: "heavy", levels: ["sample", "voice", "instance"], params: [
    p("semitones", "Semitones", -24, 24, 1, "st", 0), p("cents", "Cents", -50, 50, 1, "ct", 0),
  ] }),
  chorus: spec({ type: "chorus", label: "Chorus", version: "1", cost: "medium", levels: ["instance", "bus"], params: [
    p("rate", "Rate", 0.05, 10, 0.01, "Hz", 0.8, "log"), p("depth", "Depth", 0, 100, 1, "%", 30), mix(50),
  ] }),
  delay: spec({ type: "delay", label: "Delay", version: "1", cost: "medium", levels: ["instance", "bus"], params: [
    p("time", "Time", 1, 2000, 1, "ms", 250), p("feedback", "Feedback", 0, 95, 1, "%", 30), mix(25),
  ] }),
  reverb: spec({ type: "reverb", label: "Reverb", version: "1", cost: "heavy", levels: ["instance", "bus"], params: [
    p("size", "Size", 0, 1, 0.01, "", 0.5), p("decay", "Decay", 0.1, 20, 0.1, "s", 1.8), mix(20),
  ] }),
  envelope: spec({ type: "envelope", label: "Amp envelope", version: "1", cost: "light", levels: ["voice"], params: [
    p("attack", "Attack", 0, 5000, 1, "ms", 5), p("decay", "Decay", 0, 5000, 1, "ms", 100),
    p("sustain", "Sustain", 0, 100, 1, "%", 100), p("release", "Release", 0, 10000, 1, "ms", 200),
  ] }),
  fades: spec({ type: "fades", label: "Fades", version: "1", cost: "light", levels: ["sample"], params: [
    p("in", "Fade in", 0, 2000, 1, "ms", 0), p("out", "Fade out", 0, 2000, 1, "ms", 0),
  ] }),
  noiseReduction: spec({ type: "noiseReduction", label: "Noise reduction", version: "1", cost: "heavy", levels: ["sample"], params: [p("amount", "Amount", 0, 100, 1, "%", 50)] }),
  reverse: spec({ type: "reverse", label: "Reverse", version: "1", cost: "light", levels: ["sample"], params: [] }),
});

const TYPE_SET: ReadonlySet<string> = new Set(EFFECT_TYPES);

/** True when `type` names a catalogue type. */
export const isEffectType = (type: unknown): type is EffectType => typeof type === "string" && TYPE_SET.has(type);

/** The catalogue entry of `type`. */
export const effectSpec = (type: EffectType): EffectSpec => EFFECT_CATALOGUE[type];

/** The parameter `name` of `type`, or undefined. */
export const effectParamSpec = (type: EffectType, name: string): EffectParamSpec | undefined => EFFECT_CATALOGUE[type].params.find((q) => q.name === name);

/** True when `type` may run at `level`. */
export const allowedAt = (type: EffectType, level: EffectLevel): boolean => EFFECT_CATALOGUE[type].levels.includes(level);

/** The types that may run at `level`, in catalogue order (what an "Add effect" menu lists). */
export const effectTypesAt = (level: EffectLevel): EffectType[] => EFFECT_TYPES.filter((t) => allowedAt(t, level));

/** A parameter's value: the effect's own, else the catalogue default; undefined for a name the type doesn't have. */
export function effectParamValue(effect: Effect, name: string): number | undefined {
  const q = effectParamSpec(effect.type, name);
  if (!q) return undefined;
  const v = effect.params[name];
  return v === undefined ? q.default : v;
}

/** A parameter value fitted to its spec: clamped, and 0/1 for a switch. */
export function clampEffectParam(q: EffectParamSpec, value: number): number {
  const c = Math.min(q.max, Math.max(q.min, value));
  return q.bool ? (c >= 0.5 ? 1 : 0) : c;
}

/** A new effect of `type` with every parameter at its default. */
export function defaultEffect(type: EffectType, id: string): Effect {
  const s = EFFECT_CATALOGUE[type];
  const effect: Effect = { id, type, on: true, params: Object.fromEntries(s.params.map((q) => [q.name, q.default])) };
  if (s.key === "bus") effect.key = "";
  return effect;
}

/**
 * One effect from JSON, leniently, for a chain at `level`. Every parameter of the type is filled (missing ones take
 * their default), so the parsed effect is canonical. Null (with a problem) for a non-object or an unknown type. The id
 * is taken as written (a non-string id becomes `""`); `parseEffects` checks ids and makes them unique.
 */
export function parseEffect(raw: unknown, level: EffectLevel, where: string, problems: string[]): Effect | null {
  const r = new LenientReader(problems);
  if (!isRecord(raw)) {
    r.problem(where, "an effect must be an object; dropped.");
    return null;
  }
  if (!isEffectType(raw.type)) {
    r.problem(where, `unknown effect type ${JSON.stringify(raw.type)}; dropped.`);
    return null;
  }
  const s = EFFECT_CATALOGUE[raw.type];
  const id = typeof raw.id === "string" ? raw.id : "";
  const effect: Effect = { id, type: s.type, on: r.bool(raw.on, `${where}.on`, true), params: {} };
  const params = r.record(raw.params, `${where}.params`) ?? {};
  for (const q of s.params) {
    const v = params[q.name];
    if (q.bool && typeof v === "boolean") effect.params[q.name] = v ? 1 : 0;
    else {
      const n = r.num(v, `${where}.params.${q.name}`, q.default, q.min, q.max);
      effect.params[q.name] = q.bool ? (n >= 0.5 ? 1 : 0) : n;
    }
  }
  for (const name of Object.keys(params)) {
    if (!s.params.some((q) => q.name === name)) r.problem(`${where}.params.${name}`, `${s.label} has no parameter "${name}"; dropped.`);
  }
  if (s.key === "bus") effect.key = r.str(raw.key, `${where}.key`, "");
  else if (raw.key !== undefined) r.problem(`${where}.key`, `${s.label} takes no key bus; dropped.`);
  if (!allowedAt(s.type, level)) {
    r.problem(where, `${s.label} can't run at the ${level} level (it runs at ${s.levels.join(", ")}); kept but it won't play there.`);
  }
  return effect;
}

/**
 * An effect chain from JSON: `parseEffect` for each item, ids made unique within the chain (missing or repeated ids get
 * `fx1`, `fx2`, … with a problem), at most `limit` effects (the rest dropped with a problem).
 */
export function parseEffects(raw: unknown, level: EffectLevel, where: string, problems: string[], limit = Infinity): Effect[] {
  const r = new LenientReader(problems);
  const out: Effect[] = [];
  const ids = new IdScope(r);
  r.list(raw, where).forEach((item, i) => {
    const w = `${where}[${i}]`;
    if (out.length >= limit) return void r.problem(w, `at most ${limit} effects here; dropped.`);
    const effect = parseEffect(item, level, w, problems);
    if (!effect) return;
    effect.id = ids.take(isRecord(item) ? item.id : undefined, w, "fx");
    out.push(effect);
  });
  return out;
}

/**
 * An effect as JSON: `id`, `type`, `on`, then only the parameters that differ from their defaults (`params` left out
 * when none do), and `key` for a type that takes one. `parseEffect` of the result gives the effect back.
 */
export function effectToJson(effect: Effect): Record<string, unknown> {
  const s = EFFECT_CATALOGUE[effect.type];
  const out: Record<string, unknown> = { id: effect.id, type: effect.type, on: effect.on };
  const params: Record<string, number> = {};
  for (const q of s.params) {
    const v = effect.params[q.name];
    if (isFiniteNumber(v) && v !== q.default) params[q.name] = v;
  }
  if (Object.keys(params).length > 0) out.params = params;
  if (s.key === "bus" && effect.key !== undefined && effect.key !== "") out.key = effect.key;
  return out;
}

/** A chain as JSON. */
export const effectsToJson = (effects: readonly Effect[]): Record<string, unknown>[] => effects.map(effectToJson);
