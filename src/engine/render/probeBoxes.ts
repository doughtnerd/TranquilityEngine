// Reflection probe boxes (ADR 0054), shared by both render backends: no renderer types here.

export interface ProbeBox {
  id: number;
  center: { x: number; y: number; z: number };
  /** Full extent on each axis; the box is axis-aligned and centred on `center`. */
  size: { x: number; y: number; z: number };
}

/** The smallest-volume probe box containing `point` (edges inclusive); ties go to the lower id; null if none. */
export function pickProbe(point: { x: number; y: number; z: number }, probes: readonly ProbeBox[]): ProbeBox | null {
  let best: ProbeBox | null = null;
  let bestVolume = Infinity;
  for (const p of probes) {
    if (
      Math.abs(point.x - p.center.x) > p.size.x / 2 ||
      Math.abs(point.y - p.center.y) > p.size.y / 2 ||
      Math.abs(point.z - p.center.z) > p.size.z / 2
    )
      continue;
    const volume = p.size.x * p.size.y * p.size.z;
    if (volume < bestVolume || (volume === bestVolume && best !== null && p.id < best.id)) {
      best = p;
      bestVolume = volume;
    }
  }
  return best;
}

/** Cubemap face size per `reflectionProbes` quality tier (0 = probes off). */
export const PROBE_RESOLUTION = { off: 0, low: 128, medium: 256, high: 512 } as const;
export type ProbeQuality = keyof typeof PROBE_RESOLUTION;

/** A probe box with how far inside its faces blending starts (ADR 0110). */
export interface BlendBox extends ProbeBox {
  /** Metres inside the faces where the probe reaches full strength; 0: none (a hard edge). */
  blendDistance: number;
}

/** Steps a blend weight is rounded to: each step is a material copy, so they're few. */
export const BLEND_STEPS = 8;

/**
 * The probes a point reflects (ADR 0110): `primary` is the smallest box holding it (as `pickProbe`);
 * near that box's faces (within its `blendDistance`) it fades towards `secondary`, the next smallest
 * box holding the point. `weight` is the primary's share, 0–1, rounded to `BLEND_STEPS`. Outside every
 * box, null. With no second box the primary is used alone (probes don't fade into the global
 * environment: a mesh leaving a room would otherwise lose its reflections at the door).
 */
export function blendProbes(point: { x: number; y: number; z: number }, boxes: readonly BlendBox[]): { primary: BlendBox; secondary: BlendBox | null; weight: number } | null {
  const primary = pickProbe(point, boxes) as BlendBox | null;
  if (!primary) return null;
  const rest = boxes.filter((b) => b !== primary);
  const secondary = pickProbe(point, rest) as BlendBox | null;
  if (!secondary || primary.blendDistance <= 0) return { primary, secondary: null, weight: 1 };
  const inside = Math.min(
    primary.size.x / 2 - Math.abs(point.x - primary.center.x),
    primary.size.y / 2 - Math.abs(point.y - primary.center.y),
    primary.size.z / 2 - Math.abs(point.z - primary.center.z),
  );
  const weight = Math.round(Math.min(1, Math.max(0, inside / primary.blendDistance)) * BLEND_STEPS) / BLEND_STEPS;
  return weight >= 1 ? { primary, secondary: null, weight: 1 } : { primary, secondary, weight };
}
