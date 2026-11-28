// The skinned sprites render feature for the Babylon backend (ADR 0370 "2D bones", 0135; T21): `SkinnedSprites` over the
// renderer's quad batches. Loaded on demand (`register.ts` names it only in a dynamic import), so games without a
// Skeleton2D never download it. While it exists the sprites feature leaves skinned slices to it (`spriteClaims.ts`).
// Skinned sprites are picked like sprites, by draw order (ADR 0276).
import type { Component } from "../../../../../engine/core/Component";
import type { World } from "../../../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory, DrawnDescription, DrawnNode } from "../../../../../engine/render/babylon/feature";
import { SpriteRenderer } from "../../../../../engine/render/components";
import { claimSprites } from "../../../../../engine/render/spriteClaims";
import { claimSpriteOutlines } from "../../../../../engine/render/lights2D/outlineClaims";
import { claimsSkinnedSprite, SkinnedSprites } from "./skinnedSprites";

class SkinnedSpritesFeature implements BabylonFeature {
  private readonly unclaim = claimSprites(claimsSkinnedSprite);
  /** ADR 0415: 2D shadow casters on skinned sprites cast from the deformed outline. */
  private readonly unclaimOutlines: () => void;

  constructor(private readonly sprites: SkinnedSprites) {
    this.unclaimOutlines = claimSpriteOutlines((r) => this.sprites.deformedOutline(r));
  }

  sync(world: World): void {
    this.sprites.sync(world);
  }

  release(c: Component): void {
    if (c instanceof SpriteRenderer) this.sprites.release(c);
  }

  *drawn(): Iterable<DrawnNode> {
    for (const d of this.sprites.drawn()) yield { component: d.renderer, shape: { kind: "quads", batches: d.batches } };
  }

  describe(drawn: object): DrawnDescription | null {
    for (const d of this.sprites.drawn()) if (d.batches.includes(drawn as never)) return { node: d.renderer.node, what: `"${d.renderer.node.name}" (skinned sprite)` };
    return null;
  }

  dispose(): void {
    this.unclaim();
    this.unclaimOutlines();
    this.sprites.dispose();
  }
}

/** @internal Builds the feature from the renderer's shared services: only the quad batches. */
export const createSkinnedSpritesFeature: BabylonFeatureFactory = (host) => new SkinnedSpritesFeature(new SkinnedSprites(host.quads));
