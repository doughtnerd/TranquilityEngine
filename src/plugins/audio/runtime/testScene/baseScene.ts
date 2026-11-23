/**
 * A spatial test scene's base game scene in the World (ADR 0347: "names a game scene whose audio components and colliders
 * load read-only underneath"): the part `importBaseScene` takes from it (audio components, 3D colliders, the nodes above
 * them) is loaded through the engine's own scene loading (`SceneManager.load`, additive, 3D physics), so its sounds play,
 * its zones hold, and the occlusion pass casts at its colliders with their layers and occluder materials, as in the game.
 *
 * The imported part is served for the load only, from an asset source of its own under `.myco/studio/base/` (never a
 * project file; the game scene's file is never written), and gone once the load is done. The loaded scene node is named
 * after the game scene and is the World's active scene while it is loaded, so the test scene player builds under it
 * and its `replace` paths (`"Cave/Fire/AudioSource"`) find the base's components. Load the base before the player and
 * dispose the player first.
 *
 * Acts on the current World, as `SceneManager` does (the Studio's runtime World is its page's only one).
 */
import { importBaseScene, type BaseSceneImport } from "../../../../engine/audio/spatial/baseScene";
import { Assets } from "../../../../engine/scene/Assets";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { SceneManager } from "../../../../engine/scene/SceneManager";

/** Where the imported part of a base scene is served from while it loads (not a project path). */
export const BASE_SCENE_ROOT = ".myco/studio/base/";

export interface LoadedBaseScene {
  /** What was imported from the game scene (its objects for the plan, its problems). */
  readonly import: BaseSceneImport;
  /** The loaded scene node, or null when nothing was imported (a missing scene, or one with nothing audible). */
  readonly scene: GameObject | null;
  /** Unload the base (at the end of the World's frame). */
  dispose(): void;
}

/** Load the base scene `path` into the current World; each problem of the import is warned once. */
export async function loadBaseScene(path: string, imported: BaseSceneImport = importBaseScene(path)): Promise<LoadedBaseScene> {
  for (const p of imported.problems) console.warn(`[myco] audio test scene base: ${p}`);
  if (imported.file.nodes.length === 0) return { import: imported, scene: null, dispose() {} };
  const served = `${BASE_SCENE_ROOT}${path}`;
  const source = Assets.fromObject({ [served]: imported.file });
  Assets.addSource(source);
  let scene: GameObject;
  try {
    scene = await SceneManager.load(served, { additive: true });
  } finally {
    Assets.removeSource(source);
  }
  return {
    import: imported,
    scene,
    dispose() {
      if (scene.isValid) SceneManager.unload(scene);
    },
  };
}
