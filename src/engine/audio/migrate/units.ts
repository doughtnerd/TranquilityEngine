/**
 * Unit conversions the `myco.audioevent@1` → `myco.playlist@1` migration (ADR 0329) needs: the old format stored
 * gains as linear multipliers, pitch as rate ratios and the reverb send against a normalised distance; playlists store
 * dB, semitones and metres. Pure and generic, so the migration's tests target these through their own interface.
 */
import { evalCurve, type Curve, type CurveKey } from "../../core/curve";

/** The floor every converted gain is clamped to: a linear 0 (silence) becomes this many dB. */
export const SILENT_DB = -96;

/** Round to 1/1000 and drop `-0`, so the written JSON is tidy and stable. */
export const tidy = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/** A linear gain multiplier in dB (`20·log10`), clamped below at `SILENT_DB`. */
export const gainToDb = (linear: number): number => (linear > 0 ? Math.max(SILENT_DB, tidy(20 * Math.log10(linear))) : SILENT_DB);

/** A playback-rate ratio in semitones (`12·log2`). A ratio at or below 0 is treated as 1 (no change). */
export const ratioToSemitones = (ratio: number): number => (ratio > 0 ? tidy(12 * Math.log2(ratio)) : 0);

/**
 * A curve with every `y` mapped by `mapY`. When the map is not linear (`resample`), each non-step segment gets interior
 * keys sampled from the original curve (its own shape included) so the mapped curve follows the old one in the new
 * unit, instead of interpolating linearly between mapped end points. The result has at most `maxKeys` keys (interior
 * samples are thinned first; the original keys are always kept, cut at `maxKeys`).
 */
export function mapCurve(curve: Curve, mapY: (y: number) => number, resample: boolean, maxKeys = 64): CurveKey[] {
  const n = Math.min(curve.length, maxKeys);
  const spare = n > 1 ? Math.floor((maxKeys - n) / (n - 1)) : 0;
  const interior = resample ? Math.max(0, Math.min(3, spare)) : 0;
  const out: CurveKey[] = [];
  for (let i = 0; i < n; i++) {
    const k = curve[i];
    const interp = k[2];
    const sampled = interior > 0 && i + 1 < n && interp !== "step" && curve[i + 1][0] > k[0];
    // A resampled segment becomes piecewise linear (its shape is in the samples); other keys keep their interp.
    // A Bézier key's handles are in the old unit, so a mapped Bézier key is resampled like the shapes (never kept).
    if (interp && interp !== "linear" && interp !== "bezier" && !sampled) out.push([tidy(k[0]), tidy(mapY(k[1])), interp]);
    else out.push([tidy(k[0]), tidy(mapY(k[1]))]);
    if (sampled) {
      const x0 = k[0], x1 = curve[i + 1][0];
      for (let s = 1; s <= interior; s++) {
        const x = x0 + ((x1 - x0) * s) / (interior + 1);
        out.push([tidy(x), tidy(mapY(evalCurve(curve, x)))]);
      }
    }
  }
  return out;
}

/** Combine two curves keyed on the same input point by point (at the union of their key `x`s), linear between. */
export function combineCurves(a: Curve, b: Curve, combine: (ya: number, yb: number) => number, maxKeys = 64): CurveKey[] {
  const xs = [...new Set([...a.map((k) => k[0]), ...b.map((k) => k[0])])].sort((p, q) => p - q).slice(0, maxKeys);
  return xs.map((x) => [tidy(x), tidy(combine(evalCurve(a, x), evalCurve(b, x)))] as CurveKey);
}
