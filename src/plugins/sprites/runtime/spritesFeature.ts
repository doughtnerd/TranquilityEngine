// The Sprites plugin's render feature (ADR 0140): `BabylonSprites` built from the renderer's shared
// services. Loaded on demand (before the renderer starts: it's eager), so Babylon stays out of `myco`.
import type { BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { BabylonSprites } from "../../../engine/render/babylon/sprites";

/** @internal Builds the feature from the renderer's shared services. */
export const createSpritesFeature: BabylonFeatureFactory = (host) =>
  new BabylonSprites({
    scene: host.scene,
    pixelsPerUnit: () => host.settings.render.pixelsPerUnit,
    sortingLayers: () => host.settings.render.sortingLayers,
    texture: (path) => host.materials.texture(path),
    loadedTexture: (path) => host.materials.loadedTexture(path),
    drawPolicy: () => host.drawPolicy(),
    warnOnce: (key, message) => host.warnOnce(key, message),
  });
