// The Materials plugin's runtime half (ADR 0134). The `Material` handle, the material, shader graph
// and shader asset formats, and the graph compiler still live in `src/engine/` (`Material` and the
// `MaterialSettings` types are exported from `myco`) until the runtime contribution points
// (Components, render features) exist; this re-exports them so the plugin already has its shape.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import { materialsManifest } from "../manifest";

export { Material, type MaterialValue } from "../../../engine/render/Material";
export {
  MATERIAL_FORMAT,
  MATERIAL_SUFFIX,
  MATERIAL_MAPS,
  isMaterialPath,
  defaultMaterialSettings,
  parseMaterial,
  formatMaterial,
  materialGraph,
  type MaterialSettings,
  type MaterialShader,
  type MaterialMapKey,
  type MaterialAlphaMode,
  type MaterialInstancing,
} from "../../../engine/scene/material";
export {
  SHADER_GRAPH_FORMAT,
  SHADER_GRAPH_SUFFIX,
  SHADER_SUBGRAPH_FORMAT,
  SHADER_SUBGRAPH_SUFFIX,
  isShaderGraphPath,
  isShaderSubGraphPath,
  defaultShaderGraph,
  defaultShaderSubGraph,
  parseShaderGraph,
  formatShaderGraph,
  type ShaderGraph,
  type GraphNode,
  type GraphEdge,
  type GraphProperty,
  type GraphPropertyType,
  type GraphValue,
} from "../../../engine/scene/shaderGraph";
export { SHADER_ASSET_FORMAT, SHADER_ASSET_SUFFIX, isShaderAssetPath, defaultShaderAsset, parseShaderAsset, formatShaderAsset, type ShaderAsset } from "../../../engine/scene/shaderAsset";
export type { ShaderKeyword, KeywordValue } from "../../../engine/scene/shaderKeywords";
export { compileShaderGraph, type CompiledShaderGraph } from "../../../engine/render/shaderGraph/compile";

export const materialsRuntimePlugin = { manifest: materialsManifest } as const;
