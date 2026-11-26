/**
 * A SpriteRenderer's outline in its node's local XY (ADR 0414, 0415), renderer-neutral: its slice's traced outline
 * (the sidecar's `outline`, in slice pixels) placed by the sprite's frame (size, pivot, flips), else its rectangle. What
 * a ShadowCaster2D with shape `sprite` casts from and what a PolygonCollider2D with `fromSprite` collides along.
 */
import type { World } from "../../core/World";
import type { Point2 } from "../../physics/polygon";
import { Assets } from "../../scene/Assets";
import { findSlice, splitSpriteRef, type ImportSettings } from "../../scene/importSettings";
import type { SpriteRenderer } from "../components";
import { claimedOutline } from "../lights2D/outlineClaims";
import { spriteFrame } from "../spriteFrame";

/** A loaded texture's authored size in pixels (ADR 0119), or null while it isn't loaded. */
export type TextureSizeOf = (path: string) => readonly [number, number] | null;

/** A sprite's outline: closed loops in the node's XY, and whether they're the traced outline or only the rectangle. */
export interface SpriteOutline {
  loops: Point2[][];
  /** Changes whenever the outline does. */
  signature: string;
  from: "sprite" | "rect" | "deformed";
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * `r`'s outline now. `textureSize` gives sprite textures' sizes (a whole-texture sprite's frame needs it; without it the
 * sprite counts as its unit or `size` quad; a slice needs only its rect). With `deformed`, a deforming sprite's outline as its feature has it now
 * (a skinned sprite's, from its bones, ADR 0415); without, the rest outline.
 */
export function spriteOutline(world: World, r: SpriteRenderer, textureSize: TextureSizeOf, options: { deformed?: boolean } = {}): SpriteOutline {
  if (options.deformed) {
    const deformed = claimedOutline(r);
    if (deformed && deformed.length) return { loops: deformed, signature: `deformed:${JSON.stringify(deformed)}`, from: "deformed" };
  }
  const { path, slice } = splitSpriteRef(r.sprite);
  const settings: ImportSettings | null = path ? Assets.importSettings(path) : null;
  // A slice's outline needs only its rect, so it's placed before (or without) its texture loading, as on a server.
  const sliced = settings && slice !== null ? findSlice(settings, slice) : undefined;
  const size = (path ? textureSize(path) : null) ?? (sliced ? ([sliced.rect[0] + sliced.rect[2], sliced.rect[1] + sliced.rect[3]] as const) : null);
  const ppu = { component: r.pixelsPerUnit, project: world.settings.render.pixelsPerUnit };
  if (!settings || !size) {
    // Without a texture: a unit (or `size`) quad about the centre, as an empty sprite draws.
    const w = r.size?.x ?? 1, h = r.size?.y ?? 1;
    return { loops: [rect(-w / 2, -h / 2, w / 2, h / 2)], signature: `rect:${w},${h}`, from: "rect" };
  }
  const frame = spriteFrame(settings, slice, size[0], size[1], ppu, r.size);
  const [w, h] = frame.size;
  const [px, py] = frame.pivot;
  const sx = r.flipX ? -1 : 1, sy = r.flipY ? -1 : 1;
  const place = (u: number, v: number): Point2 => [sx * (u - px) * w, sy * (v - py) * h];
  const s = slice !== null ? findSlice(settings, slice) : undefined;
  const sig = `${r.sprite}:${w},${h},${px},${py},${sx},${sy}`;
  if (s?.outline && s.outline.length) {
    const [pw, ph] = frame.pixelSize;
    const loops = s.outline.map((poly) => poly.map(([x, y]) => place(x / pw, y / ph)));
    return { loops, signature: `sprite:${sig}:${JSON.stringify(s.outline)}`, from: "sprite" };
  }
  return { loops: [[place(0, 0), place(1, 0), place(1, 1), place(0, 1)]], signature: `rect:${sig}`, from: "rect" };
}
