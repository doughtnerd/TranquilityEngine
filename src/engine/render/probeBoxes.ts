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
