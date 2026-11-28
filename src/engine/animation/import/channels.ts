/**
 * Imported animation channels as 0371 tracks (`tracks.ts`): a loader's keyframes (glTF samplers, three.js keyframe
 * tracks from FBX) become one **take** (`ImportedTake`) per file animation, ready for clip splitting (`clips.ts`) and
 * the compile (T19).
 *
 * | channel | track | interpolation |
 * |---|---|---|
 * | bone translation, rotation, scale | `bone` (one per bone, the three channels merged) | linear keys: `LINEAR` kept; `STEP` held to just before the next key; `CUBICSPLINE` resampled at the clip rate (plus every key time) |
 * | node translation, scale | `vec3` on `engine.Transform.position` / `.scale` | engine curves: `LINEAR` linear keys, `STEP` step keys, `CUBICSPLINE` Bézier keys (handles from the tangents) |
 * | node rotation | `quat` on `engine.Transform.rotation` | as bone rotations |
 * | morph weights | `morph`, one per target | as node translations |
 * | a property (`KHR_animation_pointer`) | `float` … `color` | as node translations; a non-linear value map resamples `CUBICSPLINE` first |
 * | node visibility | `activation` | the ranges where the value is non-zero |
 *
 * Values go through each channel's `TrsSpace` (bones, nodes) or value map (properties) on the way, so tracks hold
 * engine values. Rotations keep one hemisphere from key to key (nlerp takes the short way). Pure. Internal.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { Quaternion } from "../../core/math";
import { bracket } from "../compile/keySampling";
import type { Binding, BoneTrack, CurveTrackKind, QuatKey, Track, Vec3Key } from "../tracks";
import { TRACK_LIMITS } from "../tracks";
import { IDENTITY_SPACE, mapRotation, mapScale, mapTranslation, type TrsSpace } from "./space";

/** @internal A sampler's interpolation (glTF's names; three.js keyframe tracks are `LINEAR`). */
export type Interpolation = "STEP" | "LINEAR" | "CUBICSPLINE";

/**
 * @internal Keyframes: `times` (seconds) and `values`, `width` numbers per key; a `CUBICSPLINE` sampler's values are
 * `[in-tangent, value, out-tangent]` per key, each `width` wide (glTF's layout).
 */
export interface Sampler {
  readonly times: ArrayLike<number>;
  readonly values: ArrayLike<number>;
  readonly width: number;
  readonly interpolation: Interpolation;
}

/** @internal What a channel animates. */
export type ChannelTarget =
  | { readonly kind: "bone"; readonly bone: string; readonly path: TrsPath; readonly space: TrsSpace }
  | { readonly kind: "node"; readonly nodePath: string; readonly path: TrsPath; readonly space: TrsSpace }
  | { readonly kind: "morph"; readonly nodePath: string; readonly names: readonly string[] }
  | {
      readonly kind: "property";
      readonly track: Exclude<CurveTrackKind, "morph" | "curve">;
      readonly binding: Binding;
      /** File value → engine value; absent: unchanged. */
      readonly map?: (v: readonly number[]) => number[];
      /** `map` is linear (also maps tangents); false resamples a cubic spline before mapping. Default true. */
      readonly linear?: boolean;
    }
  | { readonly kind: "activation"; readonly nodePath: string };

export type TrsPath = "translation" | "rotation" | "scale";

/** @internal One channel: a target and its keyframes. */
export interface ImportChannel {
  readonly target: ChannelTarget;
  readonly sampler: Sampler;
}

/** @internal One animation of a model file: a name, its duration and its tracks. Clips are cut from takes (`clips.ts`). */
export interface ImportedTake {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly Track[];
}

/** @internal The rate cubic splines are resampled at for linear-only tracks (the clip default, Hz). */
export const RESAMPLE_RATE = 30;
/** How far before the next key a held (`STEP`) value ends, seconds. */
const STEP_EPSILON = 1e-4;

/** One key's value (`width` numbers) at index `i`: the value of a cubic spline's triplet. */
function valueAt(s: Sampler, i: number): number[] {
  const w = s.width;
  const base = s.interpolation === "CUBICSPLINE" ? i * 3 * w + w : i * w;
  return Array.from({ length: w }, (_, k) => s.values[base + k]);
}

/** A cubic spline key's in (0) or out (2) tangent. */
function tangentAt(s: Sampler, i: number, which: 0 | 2): number[] {
  const w = s.width;
  return Array.from({ length: w }, (_, k) => s.values[i * 3 * w + which * w + k]);
}

/** @internal A sampler's value at `t` (clamped to its keys); a quaternion sampler (`normalize`) is normalised. */
export function evaluateSampler(s: Sampler, t: number, normalize = false): number[] {
  const n = s.times.length;
  if (n === 0) return new Array<number>(s.width).fill(0);
  const { lo, hi, u } = bracket(n, (i) => s.times[i], t);
  const a = valueAt(s, lo);
  if (lo === hi) return a;
  const b = valueAt(s, hi), dt = s.times[hi] - s.times[lo];
  let out: number[];
  if (s.interpolation === "STEP") out = a;
  else if (s.interpolation === "CUBICSPLINE") {
    const m0 = tangentAt(s, lo, 2), m1 = tangentAt(s, hi, 0);
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out = a.map((v, k) => h00 * v + h10 * dt * m0[k] + h01 * b[k] + h11 * dt * m1[k]);
  } else if (normalize) {
    // glTF: rotations interpolate spherically.
    const q = Quaternion.slerp({ x: a[0], y: a[1], z: a[2], w: a[3] }, { x: b[0], y: b[1], z: b[2], w: b[3] }, u);
    out = [q.x, q.y, q.z, q.w];
  } else out = a.map((v, k) => v + (b[k] - v) * u);
  if (normalize) {
    const len = Math.hypot(...out) || 1;
    out = out.map((v) => v / len);
  }
  return out;
}

/** Key times and values for a linear-only track (see the module table), before any value map. */
function linearKeys(s: Sampler, quaternion: boolean): { t: number; v: number[] }[] {
  const n = s.times.length;
  if (s.interpolation === "LINEAR" && !quaternion) return Array.from({ length: n }, (_, i) => ({ t: s.times[i], v: valueAt(s, i) }));
  if (s.interpolation === "STEP") {
    const out: { t: number; v: number[] }[] = [];
    for (let i = 0; i < n; i++) {
      const v = valueAt(s, i);
      out.push({ t: s.times[i], v });
      if (i + 1 < n) {
        const hold = Math.max(s.times[i], s.times[i + 1] - STEP_EPSILON);
        if (hold > s.times[i]) out.push({ t: hold, v });
      }
    }
    return out;
  }
  if (s.interpolation === "LINEAR") {
    // Rotations: slerp between keys (glTF) is close to the core's nlerp when keys are dense; sparse keys are refined
    // at the resample rate so the arc is kept.
    const out: { t: number; v: number[] }[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ t: s.times[i], v: valueAt(s, i) });
      if (i + 1 < n) {
        const a = valueAt(s, i), b = valueAt(s, i + 1);
        const angle = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
        if (angle > 0.35) for (const t of between(s.times[i], s.times[i + 1])) out.push({ t, v: evaluateSampler(s, t, true) });
      }
    }
    return out;
  }
  const times = new Set<number>();
  for (let i = 0; i < n; i++) times.add(s.times[i]);
  if (n > 1) for (let i = 0; i + 1 < n; i++) for (const t of between(s.times[i], s.times[i + 1])) times.add(t);
  return [...times].sort((a, b) => a - b).map((t) => ({ t, v: evaluateSampler(s, t, quaternion) }));
}

/** The resample grid's times strictly between `a` and `b`. */
function between(a: number, b: number): number[] {
  const out: number[] = [];
  for (let f = Math.floor(a * RESAMPLE_RATE) + 1; f / RESAMPLE_RATE < b - 1e-9; f++) if (f / RESAMPLE_RATE > a + 1e-9) out.push(f / RESAMPLE_RATE);
  return out;
}

/** Keys through `map`, rotations kept in one hemisphere. */
function mapped(keys: { t: number; v: number[] }[], map: (v: number[]) => number[], quaternion: boolean): { t: number; v: number[] }[] {
  let prev: number[] | null = null;
  return keys.map(({ t, v }) => {
    let out = map(v);
    if (quaternion) {
      const len = Math.hypot(...out) || 1;
      out = out.map((x) => x / len);
      if (prev && prev[0] * out[0] + prev[1] * out[1] + prev[2] * out[2] + prev[3] * out[3] < 0) out = out.map((x) => -x);
      prev = out;
    }
    return { t, v: out };
  });
}

/**
 * @internal A sampler as engine curves, one per component: `LINEAR` linear keys, `STEP` step keys, `CUBICSPLINE`
 * Bézier keys whose handles come from the tangents (through `map`, which must then be linear; `mapTangent` maps a
 * tangent when the value map has an offset).
 */
export function samplerCurves(s: Sampler, map: (v: number[]) => number[] = (v) => v, mapTangent: (v: number[]) => number[] = map): Curve[] {
  const n = s.times.length;
  const keys = Array.from({ length: n }, (_, i) => ({ t: s.times[i], v: map(valueAt(s, i)) }));
  const width = keys[0]?.v.length ?? 0;
  const curves: CurveKey[][] = Array.from({ length: width }, () => []);
  for (let i = 0; i < n; i++) {
    const { t, v } = keys[i];
    for (let c = 0; c < width; c++) {
      if (s.interpolation === "STEP") curves[c].push(i + 1 < n ? [t, v[c], "step"] : [t, v[c]]);
      else if (s.interpolation === "CUBICSPLINE") {
        const inT = mapTangent(tangentAt(s, i, 0)), outT = mapTangent(tangentAt(s, i, 2));
        const before = i > 0 ? (t - s.times[i - 1]) / 3 : 0;
        const after = i + 1 < n ? (s.times[i + 1] - t) / 3 : 0;
        curves[c].push([t, v[c], "bezier", { in: [-before + 0, -inT[c] * before + 0], out: [after + 0, outT[c] * after + 0] }]); // + 0: no -0 (JSON writes it as 0)
      } else curves[c].push([t, v[c]]);
    }
  }
  return curves;
}

/** The node-visibility ranges of a sampler (non-zero is visible): `[start, end]` pairs, the last ending at `duration`. */
function visibleRanges(s: Sampler, duration: number): { time: number; end: number }[] {
  const out: { time: number; end: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < s.times.length; i++) {
    const on = valueAt(s, i)[0] !== 0;
    if (on && start === null) start = s.times[i];
    if (!on && start !== null) {
      out.push({ time: start, end: s.times[i] });
      start = null;
    }
  }
  if (start !== null) out.push({ time: start, end: duration });
  return out;
}

const TRANSFORM = "engine.Transform";
const TRS_FIELDS: Record<TrsPath, string> = { translation: "position", rotation: "rotation", scale: "scale" };

/** @internal A take from its channels: bone channels merge per bone; every track's keys lie in `0..duration`. */
export function buildTake(name: string, channels: readonly ImportChannel[]): ImportedTake {
  let duration = 0;
  for (const c of channels) if (c.sampler.times.length) duration = Math.max(duration, c.sampler.times[c.sampler.times.length - 1]);
  duration = Math.min(duration, TRACK_LIMITS.duration);
  const bones = new Map<string, { translation: Vec3Key[]; rotation: QuatKey[]; scale: Vec3Key[] }>();
  const tracks: Track[] = [];
  const clampT = (t: number) => Math.min(duration, Math.max(0, t));
  for (const { target, sampler } of channels) {
    if (!sampler.times.length) continue;
    switch (target.kind) {
      case "bone": {
        let b = bones.get(target.bone);
        if (!b) bones.set(target.bone, (b = { translation: [], rotation: [], scale: [] }));
        const q = target.path === "rotation";
        const map = channelMap(target.path, target.space);
        const keys = mapped(linearKeys(sampler, q), map, q).map(({ t, v }) => [clampT(t), ...v]);
        if (q) b.rotation = keys as unknown as QuatKey[];
        else b[target.path] = keys as unknown as Vec3Key[];
        break;
      }
      case "node": {
        const binding: Binding = { nodePath: target.nodePath, component: TRANSFORM, field: TRS_FIELDS[target.path] };
        if (target.path === "rotation") {
          const keys = mapped(linearKeys(sampler, true), channelMap("rotation", target.space), true).map(({ t, v }) => [clampT(t), ...v] as unknown as QuatKey);
          tracks.push({ kind: "quat", target: binding, interp: "nlerp", keys });
        } else {
          const map = channelMap(target.path, target.space);
          const tangent = target.path === "translation" ? (v: number[]) => mapTranslation(target.space, v, false) : map;
          tracks.push({ kind: "vec3", target: binding, name: "", curves: clampCurves(samplerCurves(sampler, map, tangent), duration) });
        }
        break;
      }
      case "morph": {
        const curves = clampCurves(samplerCurves(sampler), duration);
        target.names.forEach((morph, i) => {
          if (i < curves.length) tracks.push({ kind: "morph", target: { nodePath: target.nodePath, component: "", field: morph }, name: "", curves: [curves[i]] });
        });
        break;
      }
      case "property": {
        const map = target.map ?? ((v: readonly number[]) => [...v]);
        const linear = target.linear ?? true;
        const s = !linear && sampler.interpolation === "CUBICSPLINE" ? resampled(sampler) : sampler;
        tracks.push({ kind: target.track, target: target.binding, name: "", curves: clampCurves(samplerCurves(s, map), duration) });
        break;
      }
      case "activation":
        tracks.push({ kind: "activation", target: { nodePath: target.nodePath, component: "", field: "" }, keys: visibleRanges(sampler, duration) });
        break;
    }
  }
  const boneTracks: BoneTrack[] = [...bones].map(([bone, b]) => ({ kind: "bone", bone, ...b }));
  return { name, duration, tracks: [...boneTracks, ...tracks] };
}

/** A cubic spline sampler as a linear one at the resample rate (plus its key times). */
function resampled(s: Sampler): Sampler {
  const keys = linearKeys(s, false);
  return { times: keys.map((k) => k.t), values: keys.flatMap((k) => k.v), width: s.width, interpolation: "LINEAR" };
}

function channelMap(path: TrsPath, space: TrsSpace = IDENTITY_SPACE): (v: number[]) => number[] {
  return path === "translation" ? (v) => mapTranslation(space, v) : path === "rotation" ? (v) => mapRotation(space, v) : (v) => mapScale(space, v);
}

/** Curves with their key times clamped into `0..duration`. */
function clampCurves(curves: Curve[], duration: number): Curve[] {
  return curves.map((c) => c.map((k) => (k[0] >= 0 && k[0] <= duration ? k : ([Math.min(duration, Math.max(0, k[0])), ...k.slice(1)] as unknown as CurveKey))));
}
