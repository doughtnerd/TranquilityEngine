// The Sky plugin's thumbnails (ADR 0112, 0156): an Environment with the sky, drawn by the Sky plugin's render
// feature as a World draws it. Stills (tiles) show the sky alone; a live preview adds a chrome sphere lit and
// reflecting the sky's bake. Clouds drift and stars twinkle, so it animates.
import { Assets } from "../../../engine/scene/Assets";
import { assetRef, chromeSphere, stageNode, stageScene, UNIT_BOUNDS } from "../../../engine/render/thumbnailStages";
import type { AssetThumbnail } from "../../../editor/sdk";

export const skyThumbnail: AssetThumbnail = {
  id: "sky",
  stage(path, live) {
    Assets.json(path); // a sky that isn't in the project gets no picture, not the default sky
    const environment = stageNode("Environment", { type: "engine.Environment", data: { map: assetRef(path), skybox: true } });
    const view = { from: "front", fallback: UNIT_BOUNDS } as const;
    if (!live) return { scene: stageScene(environment), view, animates: true };
    const chrome = chromeSphere(0.1);
    return { scene: stageScene(environment, chrome.node), dress: chrome.dress, view, animates: true };
  },
};
