// The Particles plugin's thumbnails (ADR 0153, 0156): a ParticleSystem playing the effect with seed 1 (so
// every picture of it is the same), drawn by the particles feature one second in. Additive light needs the
// two-draw matte; a hovered tile plays it, repeating a finished one-shot effect.
import { Assets } from "../../../engine/scene/Assets";
import { assetRef, stageNode, stageScene } from "../../../engine/render/thumbnailStages";
import type { AssetThumbnail } from "../../../editor/sdk";

/** The random seed every particle thumbnail plays with. */
const SEED = 1;

export const particlesThumbnail: AssetThumbnail = {
  id: "particles",
  stage(path) {
    Assets.json(path);
    const system = stageNode("Effect", { type: "engine.ParticleSystem", data: { effect: assetRef(path), seed: SEED } });
    return { scene: stageScene(system), view: { from: "above", pad: 0.4, fallback: { min: [-1, 0, -1], max: [1, 2, 1] } }, animates: true, matte: true };
  },
};
