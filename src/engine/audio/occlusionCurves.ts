/**
 * Internal (ADR 0362 item 6): occlusion curves. `audio.occlusion.curves` (the project's, `audio.json` `settings`) and a
 * spatial test scene's `settings.occlusion.curves` map how blocked the path from a source to the listener is to a
 * volume and a low-pass cutoff:
 *
 * ```jsonc
 * "occlusion": { "curves": { "volume": [[0, 0], [1, -9]], "lowpass": [[0, 20000], [1, 1200, "easeOut"]] } }
 * ```
 *
 * - **Blocked** is 0 (clear) .. 1 (fully blocked), from the rays and the materials' losses: each ray's combined loss
 *   (the hits' dB added, floored at −60 dB, ADR 0162 §2.2) over that floor, then the mean over the source's rays. So
 *   one concrete wall (−30 dB) is 0.5 blocked, two are 1.
 * - Each curve is an engine curve (`core/curve.ts`) keyed on Blocked: `volume` in dB (−80..0), `lowpass` in Hz
 *   (100..22000; at or above 20,000 is off). A curve present replaces what the materials' losses give for that
 *   property (the dry gain or the cutoff); a curve absent leaves that property to the materials (ADR 0347 behaviour).
 *   The materials still decide how much each obstacle blocks; the curves map the total to sound.
 * - Lenient parse, never throws: a bad curve is dropped with a problem, keys outside 0..1 or the value range are
 *   clamped with one problem per curve.
 *
 * Pure; no plugin, no DOM.
 */
import { curveToJson, evalCurve, parseCurve, type Curve, type CurveKey } from "../core/curve";

/** The curves; each optional. */
export interface OcclusionCurves {
  /** Blocked (0..1) → dB, −80..0. */
  volume?: Curve;
  /** Blocked (0..1) → low-pass cutoff in Hz, 100..22000. */
  lowpass?: Curve;
}

/** The curve names, in the Curves window's order. */
export const OCCLUSION_CURVES = ["volume", "lowpass"] as const satisfies readonly (keyof OcclusionCurves)[];

/** Each curve's value range, `[min, max]` (x is always 0..1). */
export const OCCLUSION_CURVE_LIMITS = { volume: [-80, 0], lowpass: [100, 22000] } as const;

/** A path whose rays lose this much (the combined-hits floor) is fully blocked. */
export const FULLY_BLOCKED_DB = -60;

/**
 * How blocked one ray is (0..1) from its combined transmission in dB (≤ 0; the hits added): `dB / FULLY_BLOCKED_DB`,
 * clamped. A non-finite input is clear.
 */
export function blockedOfDb(transmissionDb: number): number {
  if (!(transmissionDb < 0)) return 0;
  const b = transmissionDb / FULLY_BLOCKED_DB;
  return b > 1 ? 1 : b;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The volume curve's dB at `blocked` (clamped to its range), or NaN without one. */
export function occlusionVolumeDb(curves: OcclusionCurves | undefined, blocked: number): number {
  const c = curves?.volume;
  if (!c || c.length === 0) return NaN;
  return clamp(evalCurve(c, blocked), OCCLUSION_CURVE_LIMITS.volume[0], OCCLUSION_CURVE_LIMITS.volume[1]);
}

/** The low-pass curve's cutoff in Hz at `blocked` (clamped to its range), or NaN without one. */
export function occlusionCutoffHz(curves: OcclusionCurves | undefined, blocked: number): number {
  const c = curves?.lowpass;
  if (!c || c.length === 0) return NaN;
  return clamp(evalCurve(c, blocked), OCCLUSION_CURVE_LIMITS.lowpass[0], OCCLUSION_CURVE_LIMITS.lowpass[1]);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys moved into x 0..1 and the curve's value range; whether anything moved. */
function clampKeys(keys: CurveKey[], [lo, hi]: readonly [number, number]): { keys: CurveKey[]; moved: boolean } {
  let moved = false;
  const out = keys.map((k): CurveKey => {
    const x = clamp(k[0], 0, 1), y = clamp(k[1], lo, hi);
    if (x === k[0] && y === k[1]) return k;
    moved = true;
    return [x, y, ...k.slice(2)] as unknown as CurveKey;
  });
  return { keys: out, moved };
}

/**
 * `occlusion.curves` (`raw`, undefined when absent) → the curves, or undefined when absent, not an object, or with no
 * usable curve. Problems are prefixed by `key` (e.g. `audio.occlusion.curves`). Unknown curve names are reported and
 * ignored.
 */
export function parseOcclusionCurves(raw: unknown, key: string, problems: string[]): OcclusionCurves | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    problems.push(`${key} must be an object with volume and/or lowpass curves; ignored.`);
    return undefined;
  }
  const out: OcclusionCurves = {};
  for (const name of Object.keys(raw)) {
    if (!(OCCLUSION_CURVES as readonly string[]).includes(name)) problems.push(`${key}.${name}: unknown curve (volume or lowpass); ignored.`);
  }
  for (const name of OCCLUSION_CURVES) {
    if (raw[name] === undefined) continue;
    const where = `${key}.${name}`;
    const keys = parseCurve(raw[name], where, problems);
    if (!keys) continue;
    if (keys.length === 0) {
      problems.push(`${where}: a curve needs at least one key; ignored.`);
      continue;
    }
    const c = clampKeys(keys, OCCLUSION_CURVE_LIMITS[name]);
    if (c.moved) problems.push(`${where}: keys must lie in blocked 0..1 and ${OCCLUSION_CURVE_LIMITS[name].join("..")}; clamped.`);
    out[name] = c.keys;
  }
  return out.volume || out.lowpass ? out : undefined;
}

/** The JSON form (only the curves present); `parseOcclusionCurves` reads it back unchanged. */
export function occlusionCurvesToJson(curves: OcclusionCurves): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of OCCLUSION_CURVES) {
    const c = curves[name];
    if (c && c.length > 0) out[name] = curveToJson(c);
  }
  return out;
}

/** Whether two curve sets say the same thing (both absent included). */
export function sameOcclusionCurves(a: OcclusionCurves | undefined, b: OcclusionCurves | undefined): boolean {
  const json = (c: OcclusionCurves | undefined) => {
    const j = c ? occlusionCurvesToJson(c) : {};
    return Object.keys(j).length === 0 ? "null" : JSON.stringify(j);
  };
  return json(a) === json(b);
}
