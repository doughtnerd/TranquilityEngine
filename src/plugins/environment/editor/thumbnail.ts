// The Environment plugin's thumbnails (ADR 0156): an Environment with the map, lighting a chrome sphere
// that reflects it, drawn by the lighting rig as a World's Environment is. A live preview also shows the
// map itself behind the sphere (the Environment's skybox).
import { Assets } from "../../../engine/scene/Assets";
import { assetRef, chromeSphere, stageNode, stageScene, UNIT_BOUNDS } from "../../../engine/render/thumbnailStages";
import type { AssetThumbnail } from "../../../editor/sdk";

export const environmentThumbnail: AssetThumbnail = {
  id: "environment",
  stage(path, live) {
    if (!Assets.has(path)) throw new Error(`"${path}" isn't in the project.`);
    const chrome = chromeSphere(0.05);
    const environment = stageNode("Environment", { type: "engine.Environment", data: { map: assetRef(path), skybox: live } });
    return { scene: stageScene(environment, chrome.node), dress: chrome.dress, view: { from: "front", fallback: UNIT_BOUNDS } };
  },
};
