/**
 * @internal Pieces the asset kinds' thumbnail stages share (ADR 0156): a stage's scene file, the built-in
 * sphere, the chrome sphere an environment or sky is seen in, and whether a material's graph reads Time.
 * Renderer-neutral: the stages are drawn by the render features (`render/babylon/previews/ThumbnailRenderer.ts`).
 */
import { Color } from "../core/math";
import { Assets } from "../scene/Assets";
import type { GameObject } from "../scene/GameObject";
import { materialGraph, parseMaterial } from "../scene/material";
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type ComponentEntry, type NodeEntry, type SceneFile } from "../scene/SceneLoader";
import { parseShaderGraph } from "../scene/shaderGraph";
import { MeshRenderer } from "./components";
import type { Bounds } from "./thumbnailMath";

/** The box around the built-in sphere (radius 0.5 at the origin): a material's, an environment's and a sky's frame. */
export const UNIT_BOUNDS: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };

/** A stage's scene file: `nodes` in the current scene format. */
export function stageScene(...nodes: NodeEntry[]): SceneFile {
  return { format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, nodes };
}

/** A node at the origin with `components` (and a Transform). */
export function stageNode(name: string, ...components: ComponentEntry[]): NodeEntry {
  return { id: name.toLowerCase(), name, components: [{ type: "engine.Transform", data: {} }, ...components] };
}

/** A project file as an asset reference field's value. */
export const assetRef = (path: string): string => (path.startsWith("asset:") || path.startsWith("builtin:") ? path : `asset:${path}`);

/** The built-in sphere drawing `material` (a material asset or shader graph path; "" for the default material). */
export function sphereNode(name = "Sphere", material = ""): NodeEntry {
  return stageNode(name, { type: "engine.MeshRenderer", data: { mesh: "builtin:sphere", material: material ? assetRef(material) : "" } });
}

/** The chrome sphere's node name. */
const CHROME = "Chrome";

/**
 * A mirror-like sphere that shows the lighting around it: its node, and the `dress` that gives it a white,
 * fully metallic script Material of the default lit material with `roughness`.
 */
export function chromeSphere(roughness: number): { node: NodeEntry; dress: (root: GameObject) => void } {
  return {
    node: sphereNode(CHROME),
    dress: (root) => {
      const material = root.find(CHROME)?.getBehavior(MeshRenderer)?.getMaterialInstance(0);
      if (!material) return;
      material.setColor("color", Color.white);
      material.setFloat("metalness", 1);
      material.setFloat("roughness", roughness);
    },
  };
}

/** True if a shader graph asset, or the graph a material asset uses, reads the Time node (so its picture moves). */
export function graphUsesTime(path: string): boolean {
  try {
    const raw = Assets.json(path);
    const graphPath = /\.shadergraph\.json$/i.test(path) ? path : materialGraph(parseMaterial(raw, path).settings);
    if (!graphPath) return false;
    const graph = parseShaderGraph(graphPath === path ? raw : Assets.json(graphPath), graphPath).graph;
    return graph.nodes.some((n) => n.type === "time");
  } catch {
    return false;
  }
}
