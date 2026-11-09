// The Materials plugin's editor half (ADR 0133: Material and Shader together; ADR 0134): the
// `material`, `shader` (`*.shader.json`, ADR 0106), `shadergraph` and `shadersubgraph` asset kinds (New… entries, Inspector views, opening
// graphs in the Shader Graph panel, accepted by material fields, thumbnails), their asset formats and
// the Shader Graph panel. Other editor code still compares these kind ids (dropping a material on a
// mesh, model material slots, the particle graph's material list); only the definitions live here.
import { materialsManifest } from "../manifest";
import { createMaterial } from "./materialAssets";
import { materialFormat } from "./materialFormat";
import { createShader } from "./shaderAssets";
import { createShaderGraph, createShaderSubGraph, openShaderGraphAsset } from "./shaderGraphAssets";
import { shaderGraphFormat, shaderSubgraphFormat } from "./shaderGraphFormat";
import { type EditorPlugin, editor } from "../../../editor/sdk";

/** A sphere with a highlight, stroked in a 24×24 box. */
const MATERIAL_ICON = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 9a7 7 0 0 1 6-4";
/** A page with a folded corner: the file icon graphs have always shown until their thumbnail renders. */
const GRAPH_ICON = "M7 3h7l5 5v13H7zM14 3v5h5";

/** A hand-written shader: a page with code brackets, stroked in a 24×24 box. */
const SHADER_ICON = "M7 3h7l5 5v13H7zM14 3v5h5M10.5 12l-2 2.5 2 2.5M14.5 12l2 2.5-2 2.5";

const shaderGraphInspector = () => import("./MaterialInspector").then((m) => m.ShaderGraphInspector);

export const materialsEditorPlugin: EditorPlugin = {
  manifest: materialsManifest,
  activate(context) {
    context.registerAssetKind({
      id: "material",
      extensions: [".material.json"],
      label: "Material",
      icon: MATERIAL_ICON,
      inspector: () => import("./MaterialInspector").then((m) => m.MaterialInspector),
      create: { label: "New Material", create: (folder) => createMaterial(folder) },
      referencedAs: ["material"],
      preview: "material",
    });
    context.registerAssetKind({
      id: "shader",
      extensions: [".shader.json"],
      label: "Shader",
      icon: SHADER_ICON,
      // The asset's JSON opens in the Code panel, as `.shader.json` always has.
      open: (path) => editor.assets.openScript(path),
      create: { label: "New Shader", create: (folder) => createShader(folder) },
    });
    context.registerAssetKind({
      id: "shadergraph",
      extensions: [".shadergraph.json"],
      label: "Shader Graph",
      icon: GRAPH_ICON,
      open: (path) => openShaderGraphAsset(path),
      inspector: shaderGraphInspector,
      create: { label: "New Shader Graph", create: (folder) => createShaderGraph(folder) },
      // A material field takes a graph too: it draws with the graph's defaults.
      referencedAs: ["material"],
      preview: "shadergraph",
    });
    context.registerAssetKind({
      id: "shadersubgraph",
      extensions: [".shadersubgraph.json"],
      label: "Sub Graph",
      icon: GRAPH_ICON,
      open: (path) => openShaderGraphAsset(path),
      inspector: shaderGraphInspector,
      create: { label: "New Shader Sub Graph", create: (folder) => createShaderSubGraph(folder) },
    });
    context.registerAssetFormat(materialFormat);
    context.registerAssetFormat(shaderGraphFormat);
    context.registerAssetFormat(shaderSubgraphFormat);
    context.registerPanel({
      id: "shadergraph",
      title: "Shader Graph",
      view: () => import("./ShaderGraphPanel").then((m) => m.ShaderGraphPanel),
      // In the default layout, the tab after the Scene view.
      beside: "scene",
    });
  },
};
