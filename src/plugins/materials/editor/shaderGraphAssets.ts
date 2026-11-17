// Shader graph assets in the editor (ADR 0046, 0047; the Materials plugin since 0134): editing a graph goes
// through its asset document, `shaderGraphDocument(project, path)`, over the formats the plugin's kinds declare.
// Creating, reading and opening graphs in the Shader Graph panel is the asset kind host's (ADR 0233).
import type { ShaderGraph } from "../../../engine/scene/shaderGraph";
import { defaultMaterialSettings, formatMaterial } from "../../../engine/scene/material";
import { editor, openAssetDocument, type AssetDocument, type EditorProject } from "../../../editor/sdk";

/** The Shader Graph panel's id: the panel shader graphs and sub-graphs open in. */
export const SHADER_GRAPH_PANEL = "shadergraph";

/** The asset document editing the graph at `path`: its value, edits, undo and redo, saving. */
export const shaderGraphDocument = (project: EditorProject, path: string): AssetDocument<ShaderGraph> => openAssetDocument<ShaderGraph>(project, path);

/** Create a material that draws with `graphPath`, beside it. Returns its path, or null. */
export function createMaterialForGraph(graphPath: string): Promise<string | null> {
  const base = editor.assets.fileName(graphPath).replace(/\.shadergraph\.json$/i, "");
  return editor.project.createFile({
    folder: editor.assets.folderOf(graphPath),
    name: `${base}.material.json`,
    what: "materials",
    write: (project, path) => project.writeText(path, formatMaterial({ ...defaultMaterialSettings(), shader: `asset:${graphPath}` })),
    created: (path) => `Created ${editor.assets.fileName(path)}, drawn with ${editor.assets.fileName(graphPath)}.`,
  });
}
