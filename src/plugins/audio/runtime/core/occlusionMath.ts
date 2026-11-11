// The occlusion pass's pure math (ADR 0162; api-and-models §2.1, §2.2, architecture §3.2, contract S1): one-pole
// smoothing with per-material attack and release, the wet (reverb send) factor folded over several hits, and the
// lateral ray directions the high preset adds for its top sources. Nothing here allocates.

/** @internal [ARCH §3.2]: the lateral rays sit this far either side of the source, metres. */
export const LATERAL_OFFSET_M = 0.5;
/** @internal [ARCH §3.2]: rays per source for the multi-ray sources (centre, +lateral, −lateral). */
export const MULTI_RAYS = 3;
/** @internal [ARCH §3.2]: how many of the top sources get the lateral rays, on the high preset only. */
export const MULTI_RAY_SOURCES = 4;
/** @internal [ARCH §3.2]: a multi-ray source's rays are each followed through at most this many hits. */
export const MAX_HITS = 3;
/** @internal [ARCH §3.2]: a followed ray is re-cast from this far past the hit, metres. */
export const RECAST_STEP_M = 0.01;

/**
 * @internal The one-pole coefficient for a step of `dtMs` with time constant `tauMs`: `1 − exp(−dt/τ)`. A τ of 0 or
 * less (or not finite) is instant (1); a step of 0 or less (a paused game) moves nothing (0).
 */
export function onePoleCoef(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 0;
  if (!(tauMs > 0) || !Number.isFinite(tauMs)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

/**
 * @internal The time constant for one value moving from `current` to `target`: `attackMs` when closing (the value
 * falls: the gain drops, the cutoff goes down), `releaseMs` when opening; either one NaN (the material has none) gives
 * `defaultMs` (`audio.occlusion.smoothingMs`).
 */
export function smoothingTau(current: number, target: number, attackMs: number, releaseMs: number, defaultMs: number): number {
  const t = target < current ? attackMs : releaseMs;
  return Number.isNaN(t) ? defaultMs : t;
}

/**
 * @internal One smoothing step of `current` toward `target` (S1: one-pole, τ `smoothingMs` or the material's
 * attack/release). Within `snap` of the target it lands on it, so a settled value stops changing.
 */
export function smoothStep(current: number, target: number, dtMs: number, attackMs: number, releaseMs: number, defaultMs: number, snap: number): number {
  const k = onePoleCoef(dtMs, smoothingTau(current, target, attackMs, releaseMs, defaultMs));
  const next = current + (target - current) * k;
  return Math.abs(target - next) <= snap ? target : next;
}

/**
 * @internal The wet factor of one hit (architecture §3.2; coordinator ruling D5): `1 − (1 − g)·w`, `g` the hit's linear
 * gain (from `transmissionDb`) and `w` its `wetOcclusion`. A ray's wet factor is the product of its hits' factors.
 */
export function hitWetFactor(transmissionDb: number, wetOcclusion: number): number {
  return 1 - (1 - Math.pow(10, transmissionDb / 20)) * wetOcclusion;
}

/** @internal A reused 3-vector. */
export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/**
 * @internal The lateral axis for a ray along (`dx`, `dy`, `dz`) (any length), into `out`: the horizontal unit vector
 * `(−dz, 0, dx) / hypot(dx, dz)`, which is `dir × up` normalised (up +Y): the ray's right (a ray along −Z gives +X). A vertical
 * (or zero) ray has no horizontal part and takes +X. The high preset's side rays end at the source ± `LATERAL_OFFSET_M`
 * times this axis.
 */
export function lateralAxis(dx: number, dy: number, dz: number, out: Vec3Out): Vec3Out {
  void dy;
  const h = Math.sqrt(dx * dx + dz * dz);
  if (!(h > 1e-9)) {
    out.x = 1;
    out.y = 0;
    out.z = 0;
    return out;
  }
  out.x = -dz / h;
  out.y = 0;
  out.z = dx / h;
  return out;
}

/** @internal The signed lateral offset of ray `r` of a source, metres: ray 0 the centre, 1 to the right, 2 to the left. */
export function lateralOffset(r: number): number {
  return r === 0 ? 0 : r === 1 ? LATERAL_OFFSET_M : -LATERAL_OFFSET_M;
}
