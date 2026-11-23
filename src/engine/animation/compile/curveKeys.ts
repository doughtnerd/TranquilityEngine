/**
 * An engine curve in the animation core's key layout (ADR 0370, T70): the one conversion the runtime core's `load_curve`
 * and the editor module's `curve_sample` both read, so a curve means the same thing wherever it is sampled.
 *
 * Seven floats per key: `x, y, interp, inDx, inDy, outDx, outDy` (`interp` is `curveKeyInterpCode`; the four handle
 * offsets are a Bézier key's `in` and `out`, zeros for any other key). The crate precomputes each Bézier segment's
 * control points from them exactly as `core/curve.ts`'s `bezierControls` does, so none are baked here. Internal.
 */
import { curveKeyHandles, curveKeyInterpCode, type Curve } from "../../core/curve";

/** Floats per key (`CURVE_KEY_FLOATS` of the `tween` wire family). */
const KEY_FLOATS = 7;

/** @internal `curve`'s keys in the core's layout. The keys must be sorted by x (the core refuses others). */
export function curveKeyFloats(curve: Curve): Float32Array {
  const out = new Float32Array(curve.length * KEY_FLOATS);
  curve.forEach((k, i) => {
    const h = curveKeyHandles(k);
    out.set([k[0], k[1], curveKeyInterpCode(k), h?.in[0] ?? 0, h?.in[1] ?? 0, h?.out[0] ?? 0, h?.out[1] ?? 0], i * KEY_FLOATS);
  });
  return out;
}

/**
 * @internal Samples `curve` at `frames` frames of `rate` Hz, frame `i` at `min(i / rate, end)` seconds: the raw clip
 * writers' curve tracks. An empty curve, or one the core refuses (keys out of order, a non-finite number), samples 0.
 * The runtime's is the animation core's (`AnimationCore.curveSamples`), the compile step's the editor module's.
 */
export type CurveSampler = (curve: Curve, rate: number, end: number, frames: number) => Float32Array;
