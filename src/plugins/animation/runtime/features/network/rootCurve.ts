// A clip's extracted root curve (ADR 0370, `myco.anim@1`'s root curve section; D25, D35) sampled on the host: where
// the root is at a clip time, and the root delta between two clip times in the character's frame at the first one, as
// the core reports root motion. `animation.PredictedRootMotion` moves predicted ghosts with it (T33), so the same
// numbers come out on the server and on the owning client for the same ticks, and again on every re-simulation. Plain
// float maths in a fixed order (no state, no allocation in `rootDelta`). A pure library.

/** @internal A root curve: 4 floats per frame (translation xyz relative to frame 0, unwrapped yaw about +Y), at `sampleRate`. */
export interface RootCurve {
  readonly rootCurve: Float32Array;
  readonly sampleRate: number;
}

/** @internal One root delta: translation in the character's frame at its start, and the turn about +Y (radians). */
export interface RootDelta {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const a = [0, 0, 0, 0];
const b = [0, 0, 0, 0];

/** Writes the curve's root (x, y, z, yaw) at clip time `t` into `out`, linear between frames and held past either end. */
function sample(curve: RootCurve, t: number, out: number[]): void {
  const c = curve.rootCurve;
  const frames = c.length >> 2;
  if (frames === 0) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  const f = Math.max(0, Math.min(frames - 1, t * curve.sampleRate));
  const i = Math.min(frames - 1, Math.floor(f));
  const j = Math.min(frames - 1, i + 1);
  const k = f - i;
  for (let n = 0; n < 4; n++) out[n] = c[i * 4 + n]! + (c[j * 4 + n]! - c[i * 4 + n]!) * k;
}

/**
 * @internal The root delta from clip time `t0` to `t1` into `out`: the curve's movement turned into the character's
 * frame at `t0` (the curve's heading there, relative to frame 0, is the character's), and the yaw it turns by.
 */
export function rootDelta(curve: RootCurve, t0: number, t1: number, out: RootDelta): RootDelta {
  sample(curve, t0, a);
  sample(curve, t1, b);
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, dz = b[2]! - a[2]!;
  const s = Math.sin(a[3]!), c = Math.cos(a[3]!);
  out.x = c * dx - s * dz;
  out.y = dy;
  out.z = s * dx + c * dz;
  out.yaw = b[3]! - a[3]!;
  return out;
}
