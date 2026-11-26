/**
 * Sprite outlines another feature knows better than the slice's (ADR 0415): a skinned sprite's outline deformed by its
 * bones, from the Animation plugin. A ShadowCaster2D with shape `sprite` (or `auto` falling back to the sprite) casts
 * from the claimed outline while there is one, so a deforming silhouette moves its shadow. Renderer-neutral; core never
 * imports the plugin (ADR 0135), as `spriteClaims.ts`.
 */
import type { Point2 } from "../../physics/polygon";
import type { SpriteRenderer } from "../components";

/** @internal A sprite's outline now, in its node's local XY (closed loops), or null when the claim doesn't know it. */
export type OutlineClaim = (renderer: SpriteRenderer) => Point2[][] | null;

const claims = new Set<OutlineClaim>();

/** @internal Registers a claim; the returned function removes it. */
export function claimSpriteOutlines(claim: OutlineClaim): () => void {
  claims.add(claim);
  return () => void claims.delete(claim);
}

/** @internal The outline some feature gives `renderer` now, or null. */
export function claimedOutline(renderer: SpriteRenderer): Point2[][] | null {
  for (const claim of claims) {
    const o = claim(renderer);
    if (o) return o;
  }
  return null;
}
