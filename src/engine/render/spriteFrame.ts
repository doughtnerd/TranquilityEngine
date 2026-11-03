/**
 * What part of a texture a sprite draws, how big, and about which point (ADR 0040). Pure math, so
 * it's testable without WebGL; the render backend turns the result into UVs and a mesh matrix.
 */
import { findSlice, type ImportSettings } from "../scene/importSettings";

export interface SpriteFrame {
  /** Texture coordinates `[u0, v0, u1, v1]` (v up, as three.js loads images), or null for the whole texture. */
  uv: [number, number, number, number] | null;
  /** Size in world units before the node's scale. */
  size: [number, number];
  /** The pivot, 0..1 from the bottom-left of the drawn rectangle. */
  pivot: [number, number];
  /** True when the reference named a slice the sidecar doesn't have (the whole image is drawn). */
  missingSlice: boolean;
}

/**
 * @internal Resolve a sprite: `slice` (or null for the whole image) of an image `width` × `height`
 * pixels with import settings `settings`. Pixels per unit: the SpriteRenderer's when > 0, else the
 * sidecar's when > 0, else the project's. `size`, when set, replaces the computed size.
 */
export function spriteFrame(
  settings: ImportSettings,
  slice: string | null,
  width: number,
  height: number,
  ppu: { component: number; project: number },
  size?: { x: number; y: number } | null,
): SpriteFrame {
  const pixelsPerUnit = ppu.component > 0 ? ppu.component : settings.pixelsPerUnit > 0 ? settings.pixelsPerUnit : ppu.project;
  const s = slice !== null ? findSlice(settings, slice) : undefined;
  let w = width, h = height, uv: SpriteFrame["uv"] = null, pivot: [number, number] = [settings.pivot[0], settings.pivot[1]];
  if (s && width > 0 && height > 0) {
    const [x, y, rw, rh] = s.rect;
    w = rw;
    h = rh;
    uv = [x / width, 1 - (y + rh) / height, (x + rw) / width, 1 - y / height];
    pivot = [s.pivot[0], s.pivot[1]];
  }
  return {
    uv,
    size: size ? [size.x, size.y] : [w / pixelsPerUnit, h / pixelsPerUnit],
    pivot,
    missingSlice: slice !== null && !s,
  };
}
