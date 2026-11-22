/**
 * Input modifiers (ADR 0334): functions that change a value of 1–3 components, compiled once from
 * their specs. Some keep state (smoothing), so each mapping that uses one gets its own instance.
 */
import type { ModifierSpec } from "./contextTypes";

/** A value of up to three components, changed in place. */
export type Value3 = Float32Array | number[];

/** A compiled modifier: changes `v` (its first `dims` components) in place. `dt` is seconds since the last call. */
export type Modifier = (v: Value3, dims: number, dt: number) => void;

const AXES = { x: 0, y: 1, z: 2 } as const;

/** Compile a modifier spec into a modifier; throws with a readable message for a bad one. */
export function compileModifier(spec: ModifierSpec): Modifier {
  if ("deadzone" in spec) {
    const min = spec.deadzone.min ?? 0.15;
    const max = spec.deadzone.max ?? 1;
    const shape = spec.deadzone.shape;
    if (!(min >= 0 && max > min)) throw new Error(`deadzone: min (${min}) must be at least 0 and below max (${max}).`);
    return (v, dims) => deadzone(v, dims, min, max, shape ?? (dims > 1 ? "radial" : "axial"));
  }
  if ("negate" in spec) {
    const n = spec.negate === true ? { x: true, y: true, z: true } : spec.negate;
    const flips = [n.x ? -1 : 1, n.y ? -1 : 1, n.z ? -1 : 1];
    return (v, dims) => {
      for (let i = 0; i < dims; i++) v[i] *= flips[i];
    };
  }
  if ("swizzle" in spec) {
    const order = [...spec.swizzle].map((c) => AXES[c as keyof typeof AXES]);
    if (!order.length || order.length > 3 || order.some((i) => i === undefined)) throw new Error(`swizzle: "${spec.swizzle}" must be up to three of x, y and z.`);
    const tmp = [0, 0, 0];
    return (v) => {
      for (let i = 0; i < 3; i++) tmp[i] = v[i] ?? 0;
      for (let i = 0; i < 3; i++) v[i] = i < order.length ? tmp[order[i]] : 0;
    };
  }
  if ("scale" in spec) {
    const s = typeof spec.scale === "number" ? [spec.scale, spec.scale, spec.scale] : [spec.scale.x ?? 1, spec.scale.y ?? 1, spec.scale.z ?? 1];
    return (v, dims) => {
      for (let i = 0; i < dims; i++) v[i] *= s[i];
    };
  }
  if ("curve" in spec) {
    const e = spec.curve.exponent;
    if (!(e > 0)) throw new Error(`curve: exponent (${e}) must be above 0.`);
    return (v, dims) => {
      for (let i = 0; i < dims; i++) v[i] = Math.sign(v[i]) * Math.abs(v[i]) ** e;
    };
  }
  if ("smooth" in spec) {
    const rate = spec.smooth.rate;
    if (!(rate > 0)) throw new Error(`smooth: rate (${rate}) must be above 0.`);
    const state = [0, 0, 0];
    return (v, dims, dt) => {
      const k = 1 - Math.exp(-rate * dt);
      for (let i = 0; i < dims; i++) v[i] = state[i] += (v[i] - state[i]) * k;
    };
  }
  throw new Error(`Unknown modifier ${JSON.stringify(spec)} (deadzone, negate, swizzle, scale, curve or smooth).`);
}

/**
 * A dead zone: values under `min` read 0, the rest rescale from `min..max` to `0..1`. Axial applies
 * it to each component; radial to the length, keeping the direction.
 */
export function deadzone(v: Value3, dims: number, min: number, max: number, shape: "axial" | "radial"): void {
  if (shape === "axial" || dims === 1) {
    for (let i = 0; i < dims; i++) {
      const a = Math.abs(v[i]);
      v[i] = a < min ? 0 : Math.sign(v[i]) * Math.min(1, (a - min) / (max - min));
    }
    return;
  }
  let len = 0;
  for (let i = 0; i < dims; i++) len += v[i] * v[i];
  len = Math.sqrt(len);
  if (len < min) {
    for (let i = 0; i < dims; i++) v[i] = 0;
    return;
  }
  const scaled = Math.min(1, (len - min) / (max - min));
  for (let i = 0; i < dims; i++) v[i] = (v[i] / len) * scaled;
}
