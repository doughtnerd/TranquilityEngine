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
    dataTexture: (path) => {
      const t = host.materials.loadedTexture(path, "graphData");
      if (!t) host.materials.texture(path, "graphData").catch((err) => host.warnOnce(`map|${path}`, `failed to load "${path}": ${(err as Error).message}`));
      return t;
    },
    drawPolicy: () => host.policy().drawPolicy,
    warnOnce: (key, message) => host.warnOnce(key, message),
  });
