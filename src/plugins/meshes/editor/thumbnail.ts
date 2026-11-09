// The Meshes plugin's thumbnails (ADR 0156): a MeshRenderer drawing the whole model, its materials resolved
// as a World resolves them (the model's import settings, then its own, ADR 0089), seen from above.
import { assetRef, stageNode, stageScene } from "../../../engine/render/thumbnailStages";
import type { AssetThumbnail } from "../../../editor/sdk";

export const modelThumbnail: AssetThumbnail = {
  id: "model",
  stage: (path) => ({ scene: stageScene(stageNode("Model", { type: "engine.MeshRenderer", data: { mesh: assetRef(path) } })), view: { from: "above" } }),
};
