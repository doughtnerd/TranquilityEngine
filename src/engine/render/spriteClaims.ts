/**
 * SpriteRenderers another render feature draws instead of the sprites feature (ADR 0370, 0371: a slice with a 2D skin
 * under a `Skeleton2D` is drawn deformed by the Animation plugin's skinned sprites, on the quad-batch path). A plugin's
 * feature registers a claim while it exists; the sprites feature skips every sprite some claim takes, in the same
 * frame, so a sprite is never drawn twice. Renderer-neutral; core never imports the plugin (ADR 0135).
 */
import type { SpriteRenderer } from "./components";

/** @internal Whether a feature draws `renderer` itself. Called each frame per sprite: keep it cheap, never throw. */
export type SpriteClaim = (renderer: SpriteRenderer) => boolean;

const claims = new Set<SpriteClaim>();

/** @internal Registers a claim; the returned function removes it. */
export function claimSprites(claim: SpriteClaim): () => void {
  claims.add(claim);
  return () => void claims.delete(claim);
}

/** @internal Whether some feature draws `renderer` itself. */
export function spriteClaimed(renderer: SpriteRenderer): boolean {
  for (const claim of claims) if (claim(renderer)) return true;
  return false;
}
