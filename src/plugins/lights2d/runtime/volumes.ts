/**
 * 2D light volumes (ADR 0415): the visible glow of a Light2D whose `volumeIntensity` is above 0, as a mesh in the
 * light's local XY with a colour per vertex. The Lights 2D plugin's render feature (`volumeRenderer.ts`) draws it as an
 * additive quad batch over the light's target layers. Brightness follows the light's own shape rules
 * (`render/lights2D/lightShapes.ts`): a point light's radial and cone falloff sampled on a polar grid, a freeform light's
 * falloff band, a sprite light's sprite. Pure: no renderer.
 */
import type { Point2 } from "../../../engine/physics/polygon";
import { freeformMesh, pointAttenuation, type PointShape } from "../../../engine/render/lights2D/lightShapes";

/** A volume's geometry: xyz positions, uv, sRGB colour and alpha per vertex, and triangles. */
export interface VolumeMesh {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** The Light2D fields a volume reads. */
export interface VolumeLight extends PointShape {
  type: "global" | "point" | "freeform" | "sprite";
  color: { r: number; g: number; b: number };
  intensity: number;
  volumeIntensity: number;
  shape: readonly Point2[];
  falloffSize: number;
}

/** Rings and (at most) segments of a point light's polar grid. */
const RINGS = 16;
const SEGMENTS = 48;

/** How strong the glow is where the light is at full brightness (0..1: it's alpha in an additive draw). */
export const volumeStrength = (l: Pick<VolumeLight, "intensity" | "volumeIntensity">): number => Math.min(1, Math.max(0, l.intensity) * Math.max(0, l.volumeIntensity));

/**
 * The volume mesh of a point or freeform light, or null (a global light has no volume; a freeform light needs a
 * polygon). A sprite light's is its sprite's quad (`spriteVolume`).
 */
export function volumeMesh(l: VolumeLight): VolumeMesh | null {
  const k = volumeStrength(l);
  if (k <= 0) return null;
  const { r, g, b } = l.color;
  if (l.type === "point") {
    const outer = Math.max(l.outerRadius, 0);
    if (outer <= 0) return null;
    const half = Math.min(Math.max(l.outerAngle, 0), 360) / 2;
    if (half <= 0) return null;
    const round = half >= 180;
    const segs = Math.max(4, Math.ceil((SEGMENTS * half) / 180));
    const spokes = round ? segs : segs + 1; // a full circle wraps; a cone has both edges
    const pos: number[] = [0, 0, 0];
    const col: number[] = [r, g, b, pointAttenuation(l, 0, 0) * k];
    for (let ring = 1; ring <= RINGS; ring++) {
      const rad = (outer * ring) / RINGS;
      for (let s = 0; s < spokes; s++) {
        const a = ((-half + (2 * half * s) / segs) * Math.PI) / 180; // clockwise from +Y, the cone's axis
        const x = Math.sin(a) * rad, y = Math.cos(a) * rad;
        pos.push(x, y, 0);
        col.push(r, g, b, pointAttenuation(l, x, y) * k);
      }
    }
    const idx: number[] = [];
    const at = (ring: number, s: number) => 1 + (ring - 1) * spokes + (round ? s % spokes : s);
    for (let s = 0; s < segs; s++) idx.push(0, at(1, s + 1), at(1, s));
    for (let ring = 1; ring < RINGS; ring++)
      for (let s = 0; s < segs; s++) {
        const a = at(ring, s), b2 = at(ring, s + 1), c = at(ring + 1, s + 1), d = at(ring + 1, s);
        idx.push(a, b2, c, a, c, d);
      }
    return { positions: Float32Array.from(pos), uvs: new Float32Array((pos.length / 3) * 2), colors: Float32Array.from(col), indices: Uint32Array.from(idx) };
  }
  if (l.type === "freeform") {
    const mesh = freeformMesh(l.shape, l.falloffSize);
    if (!mesh) return null;
    const n = mesh.alpha.length;
    const positions = new Float32Array(n * 3), colors = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      positions.set([mesh.positions[v * 2]!, mesh.positions[v * 2 + 1]!, 0], v * 3);
      colors.set([r, g, b, mesh.alpha[v]! * k], v * 4);
    }
    return { positions, uvs: new Float32Array(n * 2), colors, indices: mesh.indices };
  }
  return null;
}

/** A sprite light's volume: its sprite's quad `box` ([x0, y0, x1, y1] local) with `uv` ([u0, v0, u1, v1]), tinted. */
export function spriteVolume(l: Pick<VolumeLight, "color" | "intensity" | "volumeIntensity">, box: readonly number[], uv: readonly number[]): VolumeMesh | null {
  const k = volumeStrength(l);
  if (k <= 0) return null;
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  const [u0, v0, u1, v1] = uv as [number, number, number, number];
  const { r, g, b } = l.color;
  return {
    positions: Float32Array.from([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0]),
    uvs: Float32Array.from([u0, v0, u1, v0, u1, v1, u0, v1]),
    colors: Float32Array.from([r, g, b, k, r, g, b, k, r, g, b, k, r, g, b, k]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

/** The sorting layer a volume draws at the top of: its light's highest target layer (every layer: the last). */
export function volumeLayer(sortingLayers: readonly string[], targets: readonly string[]): string {
  if (!targets.length) return sortingLayers[sortingLayers.length - 1] ?? "Default";
  let best = -1;
  for (const t of targets) best = Math.max(best, sortingLayers.indexOf(t));
  return best >= 0 ? sortingLayers[best]! : (targets[0] ?? "Default");
}
