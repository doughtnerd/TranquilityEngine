/**
 * Key sampling (ADR 0451): the one place a linear key list is read at a time. Keys are `[time, ...value]` tuples in
 * ascending time (`inTimeOrder` sorts a list that isn't); a time before the first key holds the first, after the last
 * holds the last, and between two keys the value blends from the earlier (u = 0) to the later (u = 1). Where several
 * keys share a time, a sample at that time reads the last of them (a jump).
 *
 * - `bracket` finds the pair for any key store (a key list, or a glTF sampler's time array);
 * - `sampleVec` blends each component linearly;
 * - `sampleQuat` blends by nlerp or slerp on the shorter arc (`core/math` `Quaternion`) and normalises the result, so
 *   a key that isn't unit length still samples to a unit rotation.
 *
 * The raw clip writer (`rawClip.ts`), the clip import's loop pose-match and the glTF channel resampler use it. Pure.
 * Internal: not public API.
 */
import { Quaternion } from "../../core/math";

/** @internal The keys around a time: their indices (equal when `t` is outside the keys) and the blend between them. */
export interface KeyBracket {
  readonly lo: number;
  readonly hi: number;
  readonly u: number;
}

/** @internal The keys around `t` among `count` keys (at least one) whose times `timeAt(i)` ascend. */
export function bracket(count: number, timeAt: (i: number) => number, t: number): KeyBracket {
  const last = count - 1;
  if (count <= 1 || t <= timeAt(0)) return { lo: 0, hi: 0, u: 0 };
  if (t >= timeAt(last)) return { lo: last, hi: last, u: 0 };
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeAt(mid) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = timeAt(lo), t1 = timeAt(hi);
  return { lo, hi, u: t1 > t0 ? (t - t0) / (t1 - t0) : 0 };
}

/** @internal A key list's bracket at `t` (keys in time order, at least one). */
export const bracketKeys = (keys: readonly (readonly number[])[], t: number): KeyBracket => bracket(keys.length, (i) => keys[i]![0]!, t);

/** @internal `keys` in time order: the list itself when it already is, else a stable sort of it. */
export function inTimeOrder<K>(keys: readonly K[], timeOf: (k: K) => number): readonly K[] {
  for (let i = 1; i < keys.length; i++) if (timeOf(keys[i]!) < timeOf(keys[i - 1]!)) return [...keys].sort((a, b) => timeOf(a) - timeOf(b));
  return keys;
}

/** @internal A vector key list (`[time, ...components]`) at `t`, each component linear, written into `out` from `at`. */
export function sampleVec(keys: readonly (readonly number[])[], t: number, out: number[] = [], at = 0): number[] {
  const { lo, hi, u } = bracketKeys(keys, t);
  const a = keys[lo]!, b = keys[hi]!;
  for (let k = 1; k < a.length; k++) out[at + k - 1] = a[k]! + (b[k]! - a[k]!) * u;
  return out;
}

/** @internal How rotations blend between keys. */
export type QuatBlend = "nlerp" | "slerp";

/** @internal A quaternion key list (`[time, x, y, z, w]`) at `t`, blended by `mode` and normalised, written into `out` from `at`. */
export function sampleQuat(keys: readonly (readonly number[])[], t: number, mode: QuatBlend, out: number[] = [], at = 0): number[] {
  const { lo, hi, u } = bracketKeys(keys, t);
  const a = keys[lo]!, b = keys[hi]!;
  const qa = { x: a[1]!, y: a[2]!, z: a[3]!, w: a[4]! };
  const q = mode === "slerp" ? Quaternion.slerp(qa, { x: b[1]!, y: b[2]!, z: b[3]!, w: b[4]! }, u).normalize() : Quaternion.nlerp(qa, { x: b[1]!, y: b[2]!, z: b[3]!, w: b[4]! }, u);
  out[at] = q.x;
  out[at + 1] = q.y;
  out[at + 2] = q.z;
  out[at + 3] = q.w;
  return out;
}
