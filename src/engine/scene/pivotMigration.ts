/**
 * Scene format 1 → 2 (ADR 0118): model parts become node-pivoted by default. Before, one mesh of a
 * model (`asset:car.glb#Wheel`) was always in model space, and the editor dropped part nodes at
 * their parent's origin; now it's in its node's space unless the model's import settings say
 * `pivots: "model"`. So every part reference a version 1 file makes, from a MeshRenderer or a
 * MeshCollider (on a node or as a prefab override), of a model with a node tree (FBX, glTF; OBJ parts
 * are the same in both spaces), is pinned to model space with the `#model`
 * suffix (`asset:car.glb#Wheel#model`): the scene draws and collides exactly as before. Models whose
 * sidecar already chose `pivots: "node"` (opt-in under version 1) are left alone.
 *
 * Pure and synchronous (no model needs to be loaded), so it runs wherever scene files are read:
 * the editor, the game, the dedicated server and the rewrite CLI.
 */
import { sidecarValue } from "./Assets";
import { splitSpriteRef } from "./importSettings";
import { MODEL_SPACE_SUFFIX, isModelPath } from "./models";
import type { ComponentEntry, NodeEntry, SceneFile } from "./SceneLoader";

const MESH_COMPONENTS = new Set(["engine.MeshRenderer", "engine.MeshCollider"]);

/** A version 1 part reference pinned to model space; anything else unchanged. */
export function pinPartToModelSpace(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const { path, slice } = splitSpriteRef(value);
  // OBJ files have no node transforms: their parts are the same in node and model space.
  if (slice === null || slice.includes("#") || !isModelPath(path) || /\.obj$/i.test(path)) return value;
  let optedIn = false;
  try {
    optedIn = (sidecarValue(path) as { pivots?: unknown } | undefined)?.pivots === "node";
  } catch {
    // no asset sources (a file read on its own): pin it
  }
  return optedIn ? value : `${value}${MODEL_SPACE_SUFFIX}`;
}

function migrateComponent(c: ComponentEntry): ComponentEntry {
  if (!MESH_COMPONENTS.has(c.type) || !c.data || !("mesh" in c.data)) return c;
  const mesh = pinPartToModelSpace(c.data.mesh);
  return mesh === c.data.mesh ? c : { ...c, data: { ...c.data, mesh } };
}

function migrateNode(n: NodeEntry): NodeEntry {
  const components = n.components?.map(migrateComponent);
  const overrides = n.overrides?.map((o) => (o.component && MESH_COMPONENTS.has(o.component) && o.field === "mesh" ? { ...o, value: pinPartToModelSpace(o.value) } : o));
  return { ...n, ...(components ? { components } : {}), ...(overrides ? { overrides } : {}) };
}

/** The migration itself (registered by `SceneLoader` from version 1). */
export function migratePartPivots(file: SceneFile): SceneFile {
  return { ...file, nodes: (file.nodes ?? []).map(migrateNode) };
}
