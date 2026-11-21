/**
 * Scene format 1 → 2 (ADR 0118): model parts become node-pivoted by default. Before, one mesh of a
 * model (`asset:car.glb#Wheel`) was always in model space, and the editor dropped part nodes at
 * their parent's origin; now it's in its node's space unless the model's import settings say
 * `pivots: "model"`. So every part reference a version 1 file makes, from a MeshRenderer or a
 * MeshCollider (on a node, as a prefab override, an added component or in added nodes; the walk is
 * `sceneFileWalk.ts`, ADR 0279), of a model with a node tree (FBX, glTF; OBJ parts
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
import type { SceneFile } from "./SceneLoader";
import { mapSceneFile } from "./sceneFileWalk";

const MESH_COMPONENTS = new Set(["engine.MeshRenderer", "engine.MeshCollider"]);

/** A version 1 part reference pinned to model space; anything else unchanged. */
function pinPartToModelSpace(value: unknown): unknown {
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

/** The migration itself (registered by `SceneLoader` from version 1). */
export function migratePartPivots(file: SceneFile): SceneFile {
  return mapSceneFile(file, { field: (component, field, value) => (field === "mesh" && MESH_COMPONENTS.has(component) ? pinPartToModelSpace(value) : value) });
}
