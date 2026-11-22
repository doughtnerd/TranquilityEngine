/**
 * Attenuation (ADR 0333): parse and write `*.attenuation.json` (`myco.attenuation@1`) and the inline object of the same
 * shape in a playlist's `spatial.attenuation`; the presets that write curve keys (the old rolloff laws, ADR 0162); and the
 * Min/Max stretch the curve editor's handles apply.
 *
 * ```jsonc
 * { "format": "myco.attenuation@1", "minDistance": 2, "maxDistance": 40,
 *   "curves": { "volume": [[0, 0], [2, 0], [40, -60, "easeOut"]], "lowpass": [[0, 20000], [40, 2000]] } }
 * ```
 *
 * Curves are engine curves (`core/curve.ts`) keyed on metres; a missing curve is flat. Lenient: bad values fall back to
 * defaults with one problem line; nothing throws.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { curveToJson, isRecord, LenientReader } from "../effects/lenientRead";
import { ATTENUATION_FORMAT, type Attenuation, type AttenuationAsset, type AttenuationCurves, type AttenuationPreset } from "./types";

export const ATTENUATION_CURVES = ["volume", "lowpass", "reverbSend", "spread"] as const satisfies readonly (keyof AttenuationCurves)[];
export const ATTENUATION_PRESETS: readonly AttenuationPreset[] = ["linear", "inverse", "exponential", "inverseSquare"];

/** The quietest a preset goes, in dB (the curve editor's volume floor). */
export const ATTENUATION_FLOOR_DB = -60;
/** How many keys a sampled preset writes between Min and Max (the prototype's inverse-square preset: 6). */
export const PRESET_KEYS = 6;
/** The farthest distance the format accepts, in metres. */
export const MAX_ATTENUATION_DISTANCE = 100000;

/** What each curve's values may be (the target's units). */
const CURVE_RANGE: Record<(typeof ATTENUATION_CURVES)[number], [number, number]> = {
  volume: [-144, 24],
  lowpass: [10, 24000],
  reverbSend: [-144, 24],
  spread: [0, 360],
};

export const DEFAULT_MIN_DISTANCE = 1;
export const DEFAULT_MAX_DISTANCE = 50;

/** Flat attenuation: the default distances, no curves. */
export const defaultAttenuation = (): Attenuation => ({ minDistance: DEFAULT_MIN_DISTANCE, maxDistance: DEFAULT_MAX_DISTANCE, curves: {} });

/**
 * An attenuation object (inline or the body of an asset), leniently. `minDistance` ≥ 0, `maxDistance` > `minDistance`
 * (a bad pair falls back to the defaults, keeping what it can); each curve is an engine curve of at most 64 keys with
 * values clamped to its target's range; unknown curve names are dropped with a problem.
 */
export function parseAttenuation(raw: unknown, where: string, problems: string[]): Attenuation {
  const r = new LenientReader(problems);
  const out = defaultAttenuation();
  if (!isRecord(raw)) {
    r.problem(where, "attenuation must be an object; using flat attenuation.");
    return out;
  }
  const min = r.num(raw.minDistance, `${where}.minDistance`, DEFAULT_MIN_DISTANCE, 0, MAX_ATTENUATION_DISTANCE);
  let max = r.num(raw.maxDistance, `${where}.maxDistance`, Math.max(DEFAULT_MAX_DISTANCE, min + 1), 0, MAX_ATTENUATION_DISTANCE);
  if (max <= min) {
    const fixed = min + Math.max(1, min);
    r.problem(`${where}.maxDistance`, `must be beyond minDistance (${min}); using ${fixed}.`);
    max = fixed;
  }
  out.minDistance = min;
  out.maxDistance = max;
  const curves = r.record(raw.curves, `${where}.curves`);
  if (curves) {
    for (const [name, value] of Object.entries(curves)) {
      if (!(ATTENUATION_CURVES as readonly string[]).includes(name)) {
        r.problem(`${where}.curves.${name}`, `unknown curve (expected ${ATTENUATION_CURVES.join(", ")}); dropped.`);
        continue;
      }
      const key = name as (typeof ATTENUATION_CURVES)[number];
      const curve = r.curve(value, `${where}.curves.${name}`);
      if (!curve || curve.length === 0) continue;
      const [lo, hi] = CURVE_RANGE[key];
      let clamped = false;
      const keys = curve.map((k) => {
        const x = Math.max(0, k[0]);
        const y = Math.min(hi, Math.max(lo, k[1]));
        if (x === k[0] && y === k[1]) return k;
        clamped = true;
        return withXY(k, x, y);
      });
      if (clamped) r.problem(`${where}.curves.${name}`, `keys must have distance ≥ 0 and values in ${lo}..${hi}; clamped.`);
      out.curves[key] = keys;
    }
  }
  return out;
}

/** A key with new `x` and `y`, keeping anything after them (interpolation, and key forms added later). */
function withXY(k: CurveKey, x: number, y: number): CurveKey {
  return [x, y, ...k.slice(2)] as unknown as CurveKey;
}

/** `*.attenuation.json`, leniently. A wrong or missing `format` is a problem but the rest is still read. */
export function parseAttenuationAsset(raw: unknown, path = "attenuation"): { attenuation: AttenuationAsset; problems: string[] } {
  const problems: string[] = [];
  if (isRecord(raw) && raw.format !== ATTENUATION_FORMAT) {
    problems.push(`${path}: format: expected "${ATTENUATION_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  }
  const body = parseAttenuation(raw, path, problems);
  return { attenuation: { format: ATTENUATION_FORMAT, ...body }, problems };
}

/** An attenuation as JSON (no `format`): the distances, then the curves present, in `ATTENUATION_CURVES` order. */
export function attenuationToJson(att: Attenuation): Record<string, unknown> {
  const curves: Record<string, unknown> = {};
  for (const name of ATTENUATION_CURVES) {
    const c = att.curves[name];
    if (c && c.length > 0) curves[name] = curveToJson(c);
  }
  return { minDistance: att.minDistance, maxDistance: att.maxDistance, curves };
}

/** `*.attenuation.json` content: `format` first. */
export const attenuationAssetToJson = (att: Attenuation): Record<string, unknown> => ({ format: ATTENUATION_FORMAT, ...attenuationToJson(att) });

// --- presets ---------------------------------------------------------------------------------------------------------

const db = (gain: number): number => (gain <= 0 ? ATTENUATION_FLOOR_DB : Math.max(ATTENUATION_FLOOR_DB, 20 * Math.log10(gain)));
const round = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The volume curve a preset writes, keyed between `min` and `max` (dB, floored at `ATTENUATION_FLOOR_DB`):
 *
 * - `linear`: the engine's linear law (ADR 0162): gain falls linearly from 1 at Min to 0 at Max.
 * - `inverse`: the engine's inverse law (gain = Min / d, −6 dB per doubling), not faded at Max; the value holds beyond.
 * - `exponential`: gain falls exponentially (a straight line in dB) from 0 dB at Min to the floor at Max.
 * - `inverseSquare`: the prototype's preset, −20·log10(d / Min) clamped at the floor, tapered so it reaches the floor at
 *   Max (a sound is silent at its max distance, as Wwise and FMOD treat it).
 *
 * Sampled presets write `PRESET_KEYS` keys, spaced geometrically for the logarithmic laws when Min > 0. With Min = 0 the
 * logarithmic laws use Max / 1000 as their reference distance.
 */
export function attenuationPresetCurve(preset: AttenuationPreset, min: number, max: number): Curve {
  const lo = Math.max(0, min);
  const hi = Math.max(lo + 1e-3, max);
  if (preset === "exponential") return [[round(lo), 0], [round(hi), ATTENUATION_FLOOR_DB]];
  const n = PRESET_KEYS;
  const ref = lo > 0 ? lo : hi / 1000;
  const geometric = preset !== "linear" && lo > 0;
  const xs = Array.from({ length: n }, (_, i) => (i === 0 ? lo : i === n - 1 ? hi : geometric ? lo * Math.pow(hi / lo, i / (n - 1)) : lo + ((hi - lo) * i) / (n - 1)));
  return xs.map((x, i): CurveKey => {
    let y: number;
    if (preset === "linear") y = db(1 - (x - lo) / (hi - lo));
    else y = db(Math.min(1, ref / Math.max(x, 1e-9)));
    if (preset === "inverseSquare" && i === n - 1) y = ATTENUATION_FLOOR_DB;
    return [round(x), round(y)];
  });
}

/** `att` with its volume curve replaced by `preset`'s, between its own Min and Max. */
export function applyAttenuationPreset(att: Attenuation, preset: AttenuationPreset): Attenuation {
  return { ...att, curves: { ...att.curves, volume: attenuationPresetCurve(preset, att.minDistance, att.maxDistance) } };
}

// --- Min/Max stretch -------------------------------------------------------------------------------------------------

/**
 * `att` with new Min and Max distances and every curve's keys moved with them (the curve editor's Min/Max handles):
 * keys up to Min scale with Min, keys between Min and Max map linearly onto the new span, keys beyond Max move by the
 * change in Max. `newMin` is clamped to ≥ 0 and `newMax` to beyond `newMin`. Key values and shapes don't change.
 */
export function stretchAttenuation(att: Attenuation, newMin: number, newMax: number): Attenuation {
  const nMin = Math.max(0, Number.isFinite(newMin) ? newMin : att.minDistance);
  const nMax = Math.max(nMin + 1e-3, Number.isFinite(newMax) ? newMax : att.maxDistance);
  const { minDistance: oMin, maxDistance: oMax } = att;
  const map = (x: number): number => {
    if (x <= oMin) return oMin > 0 ? (x * nMin) / oMin : x;
    if (x <= oMax) return nMin + ((x - oMin) * (nMax - nMin)) / (oMax - oMin);
    return x + (nMax - oMax);
  };
  const curves: AttenuationCurves = {};
  for (const name of ATTENUATION_CURVES) {
    const c = att.curves[name];
    if (c) curves[name] = c.map((k) => withXY(k, round(map(k[0])), k[1]));
  }
  return { minDistance: nMin, maxDistance: nMax, curves };
}
