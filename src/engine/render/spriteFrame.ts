/**
 * What part of a texture a sprite draws, how big, and about which point (ADR 0040). Pure math, so
 * it's testable without WebGL; the render backend turns the result into UVs and a mesh matrix.
 */
import { findSlice, type ImportSettings } from "../scene/importSettings";

/** A border `[left, bottom, right, top]` with negatives zeroed and each opposite pair shrunk to fit `w` × `h`. */
export function clampBorder(border: readonly number[], w: number, h: number): [number, number, number, number] {
  const [l, b, r, t] = border.map((v) => Math.max(0, v));
  const fit = (a: number, c: number, total: number): [number, number] => (a + c > total && a + c > 0 ? [(a * total) / (a + c), (c * total) / (a + c)] : [a, c]);
  const [l2, r2] = fit(l, r, w);
  const [b2, t2] = fit(b, t, h);
  return [l2, b2, r2, t2];
}

export interface SpriteFrame {
  /** Texture coordinates `[u0, v0, u1, v1]` (v up, as three.js loads images), or null for the whole texture. */
  uv: [number, number, number, number] | null;
  /** Size in world units before the node's scale. */
  size: [number, number];
  /** The pivot, 0..1 from the bottom-left of the drawn rectangle. */
  pivot: [number, number];
  /** The slice's 9-slice border `[left, bottom, right, top]` in pixels (clamped inside the rect), or null when it has none. */
  border: [number, number, number, number] | null;
  /** Source pixels per world unit, which fixes the corners' world size when 9-slicing. */
  pixelsPerUnit: number;
  /** The drawn rectangle's size in source pixels. */
  pixelSize: [number, number];
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
    border: s && s.border && s.border.some((b) => b > 0) ? clampBorder(s.border, w, h) : null,
    pixelsPerUnit: pixelsPerUnit,
    pixelSize: [w, h],
    size: size ? [size.x, size.y] : [w / pixelsPerUnit, h / pixelsPerUnit],
    pivot,
    missingSlice: slice !== null && !s,
  };
}

/** A sprite's mesh as a 4 × 4 vertex grid (row-major from the bottom-left): positions in the unit quad (-0.5..0.5) and UVs. */
export interface SpriteMeshData {
  positions: number[];
  uvs: number[];
}

/**
 * @internal The vertex grid for `frame` drawn at `textureWidth` × `textureHeight` pixels. Without
 * a border the inner lines sit evenly between the edges, which draws exactly the plain quad.
 * With one (9-slice, ADR 0115) the corners keep their size in pixels (`border / pixelsPerUnit`
 * world units; shrunk together when two opposite corners don't fit the sprite's size) and the
 * edges and centre stretch to fill the rest.
 */
export function spriteMeshData(frame: SpriteFrame, textureWidth: number, textureHeight: number): SpriteMeshData {
  const [u0, v0, u1, v1] = frame.uv ?? [0, 0, 1, 1];
  const [w, h] = frame.size;
  let xs = [0, 1 / 3, 2 / 3, 1], ys = xs;
  let us = [u0, u0 + (u1 - u0) / 3, u0 + ((u1 - u0) * 2) / 3, u1], vs = [v0, v0 + (v1 - v0) / 3, v0 + ((v1 - v0) * 2) / 3, v1];
  if (frame.border && w > 0 && h > 0 && textureWidth > 0 && textureHeight > 0) {
    const [l, b, r, t] = frame.border;
    // Corner sizes in world units, shrunk together when a pair is wider than the sprite.
    const [lw, rw] = shrinkPair(l / frame.pixelsPerUnit, r / frame.pixelsPerUnit, Math.abs(w));
    const [bh, th] = shrinkPair(b / frame.pixelsPerUnit, t / frame.pixelsPerUnit, Math.abs(h));
    xs = [0, lw / Math.abs(w), 1 - rw / Math.abs(w), 1];
    ys = [0, bh / Math.abs(h), 1 - th / Math.abs(h), 1];
    us = [u0, u0 + l / textureWidth, u1 - r / textureWidth, u1];
    vs = [v0, v0 + b / textureHeight, v1 - t / textureHeight, v1];
  }
  const positions: number[] = [], uvs: number[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      positions.push(xs[col] - 0.5, ys[row] - 0.5, 0);
      uvs.push(us[col], vs[row]);
    }
  }
  return { positions, uvs };
}

const shrinkPair = (a: number, b: number, total: number): [number, number] => (a + b > total && a + b > 0 ? [(a * total) / (a + b), (b * total) / (a + b)] : [a, b]);

/** Indices of the 3 × 3 cells of the vertex grid, two triangles each, wound like the plain quad. */
export const SPRITE_GRID_INDICES: readonly number[] = (() => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const a = r * 4 + c;
      out.push(a, a + 1, a + 5, a, a + 5, a + 4);
    }
  }
  return out;
})();
