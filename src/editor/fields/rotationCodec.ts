// Rotation codecs (ADR 0165): a rotation is stored as a quaternion (ADR 0163) and shown as Euler angles
// (order ZXY, ADR 0164) in radians or degrees, or as its raw x, y, z, w (a unitless debug view).
import { DEG2RAD, Quaternion } from "../../engine";
import type { QuatLike } from "../../engine/core/math";
import type { FieldCodec } from "./codec";

/** How a rotation field shows its value. */
export type RotationView = "radians" | "degrees" | "quaternion";

/** The views in the order the row's toggle cycles through them. */
export const ROTATION_VIEWS: readonly RotationView[] = ["radians", "degrees", "quaternion"];

/** The view after `view` in the toggle's cycle. */
export const nextRotationView = (view: RotationView): RotationView => ROTATION_VIEWS[(ROTATION_VIEWS.indexOf(view) + 1) % ROTATION_VIEWS.length];

/** A rotation in scene-file form: a unit quaternion `[x, y, z, w]` with w ≥ 0, 7 decimals, no -0. */
export function quaternionJSON(q: QuatLike): number[] {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const s = (q.w < 0 ? -1 : 1) / l;
  return [q.x, q.y, q.z, q.w].map((n) => Math.round(n * s * 1e7) / 1e7 + 0);
}

// The Euler angles (radians) last typed for each rotation, so the field shows a yaw of 200° after you
// type 200 rather than the -160 a quaternion reads back as, and editing one axis keeps the others you
// typed. Unity keeps the same "Euler hint" on its Transform. Keyed by the rotation, so it holds for any
// node that has it and lapses by itself once the node turns some other way.
const eulerHints = new Map<string, number[]>();
const EULER_HINT_LIMIT = 512;

/** A key for a rotation: the same for q and -q, and for float32 copies of it. */
const rotationKey = (q: QuatLike): string => quaternionJSON(q).map((n) => n.toFixed(5)).join(",");

/** Remember that `angles` (radians, order ZXY) were typed for the rotation `q`. */
export function rememberEulerRadians(angles: readonly number[], q: QuatLike): void {
  const key = rotationKey(q);
  eulerHints.delete(key);
  eulerHints.set(key, [...angles]);
  if (eulerHints.size > EULER_HINT_LIMIT) eulerHints.delete(eulerHints.keys().next().value!);
}

/** The Euler angles (radians) last typed for rotation `q`, if any. */
export const rememberedEulerRadians = (q: QuatLike): readonly number[] | undefined => eulerHints.get(rotationKey(q));

const roundTo = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f + 0; // + 0: no -0
};

/**
 * Euler angles in radians (order ZXY) for `q`: the ones last typed for it when there are any, else read from
 * the quaternion (pitch -π/2..π/2, yaw and roll -π..π), rounded so float noise doesn't show.
 */
export const eulerRadiansOf = (q: Quaternion): number[] => [...(rememberedEulerRadians(q) ?? q.toEuler().toArray().map((n) => roundTo(n, 6)))];

/** True when `a` and `b` are the same turn (q and -q included), to well under a thousandth of a degree. */
export function sameRotation(a: QuatLike, b: QuatLike): boolean {
  const la = Math.hypot(a.x, a.y, a.z, a.w) || 1, lb = Math.hypot(b.x, b.y, b.z, b.w) || 1;
  return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) / (la * lb) > 1 - 1e-11;
}

const RAD2DEG = 180 / Math.PI;

function eulerCodec(degrees: boolean): FieldCodec<Quaternion, number[]> {
  return {
    read: (q) => eulerRadiansOf(q).map((r) => (degrees ? roundTo(r * RAD2DEG, 4) : r)),
    write: (shown) => {
      const r = degrees ? shown.map((n) => n * DEG2RAD) : [...shown];
      const q = Quaternion.euler(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
      rememberEulerRadians(r, q);
      return q;
    },
    toJSON: quaternionJSON,
    same: sameRotation,
  };
}

const quaternionCodec: FieldCodec<Quaternion, number[]> = {
  read: quaternionJSON,
  // Normalized: the other components change to keep length 1. A zero or unreadable quaternion keeps the previous one.
  write: (shown, previous) => {
    const [x = 0, y = 0, z = 0, w = 0] = shown;
    const l = Math.hypot(x, y, z, w);
    if (!Number.isFinite(l) || l < 1e-9) return previous.clone();
    return new Quaternion(x / l, y / l, z / l, w / l);
  },
  toJSON: quaternionJSON,
  same: sameRotation,
};

const CODECS: Record<RotationView, FieldCodec<Quaternion, number[]>> = {
  radians: eulerCodec(false),
  degrees: eulerCodec(true),
  quaternion: quaternionCodec,
};

/** The codec for a rotation shown as `view`. */
export const rotationCodec = (view: RotationView): FieldCodec<Quaternion, number[]> => CODECS[view];

/** The axis labels for a view. */
export const rotationAxes = (view: RotationView): readonly string[] => (view === "quaternion" ? ["x", "y", "z", "w"] : ["x", "y", "z"]);

/** `q` (unset: the identity) with shown axis `axis` set to `n` in `view`, its other shown axes kept. */
export function withRotationAxis(q: Quaternion | null | undefined, view: RotationView, axis: number, n: number): Quaternion {
  const codec = rotationCodec(view);
  const previous = q ?? Quaternion.identity;
  return codec.write(codec.read(previous).map((old, i) => (i === axis ? n : old)), previous);
}

/**
 * A rotation from a field value: a Quaternion, a raw quaternion `[x, y, z, w]`, or Euler radians `[x, y, z]`
 * (ZXY; remembered as typed). Null for anything else.
 */
export function rotationFrom(value: unknown): Quaternion | null {
  if (value instanceof Quaternion) return value;
  if (!Array.isArray(value) || value.length < 3 || !value.every((n) => typeof n === "number")) return null;
  const q = Quaternion.from(value as number[]);
  if (value.length === 3) rememberEulerRadians(value as number[], q);
  return q;
}
