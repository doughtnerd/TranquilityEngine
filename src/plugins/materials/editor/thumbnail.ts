// The Materials plugin's thumbnails (ADR 0156): a material asset, or a shader graph named directly (with
// its own property values), on the built-in sphere, drawn by the Meshes feature with the World's materials.
// A picture whose graph reads Time moves on hover.
import { Assets } from "../../../engine/scene/Assets";
import { parseMaterial } from "../../../engine/scene/material";
import { parseShaderGraph } from "../../../engine/scene/shaderGraph";
import { graphUsesTime, sphereNode, stageScene } from "../../../engine/render/thumbnailStages";
import type { AssetThumbnail } from "../../../editor/sdk";

/** The thumbnail of a material asset (`material`) or a shader graph (`shadergraph`). */
export function materialThumbnail(id: "material" | "shadergraph"): AssetThumbnail {
  return {
    id,
    stage(path) {
      // Read first, so a file that isn't one gets no picture rather than the default material's.
      if (id === "material") parseMaterial(Assets.json(path), path);
      else parseShaderGraph(Assets.json(path), path);
      return { scene: stageScene(sphereNode("Sphere", path)), view: { from: "level" }, animates: graphUsesTime(path) };
    },
  };
}
