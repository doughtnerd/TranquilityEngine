import { World } from "../core/World";
import { ensurePhysics2D } from "../physics/physics2dSystems";
import { ensurePhysics3D, usesPhysics3D } from "../physics/physics3d";
import { ensureNavigation, preloadNavBakes, simulatesNavigation, usesNavigation } from "../nav/navigationSystems";
import { Assets } from "./Assets";
import { isMaterialPath } from "./material";
import { isModelPath, loadModel } from "./models";
import type { GameObject } from "./GameObject";
import { splitSpriteRef } from "./importSettings";
import { SceneInstance, collectAssetRefs, instantiateFile, loadSceneFile } from "./SceneLoader";
import { loadUIDocumentSupport } from "../ui/UIDocument";

export interface LoadSceneOptions {
  /** Keep already-loaded scene nodes instead of replacing them (ADR 0016). */
  additive?: boolean;
  /** Called with 0..1 while assets preload. */
  onProgress?: (progress: number) => void;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Loads scene files as scene nodes under the World root (ADR 0016). Acts on the current World
 * (ADR 0032): the one whose frame is running, else the Engine's default World. A load captures
 * that World when called, so the swap lands there even though it happens later.
 *
 * ```ts
 * await SceneManager.load("scenes/level1.scene.json");
 * await SceneManager.load("scenes/hud.scene.json", { additive: true });
 * ```
 */
export class SceneManager {
  /** The most recently loaded scene node. */
  static get activeScene(): GameObject | null {
    return World.require().activeScene;
  }

  /** All loaded scene nodes, oldest first. */
  static get scenes(): GameObject[] {
    return World.require().sceneNodes;
  }

  /**
   * Load a scene file. Assets are preloaded first; the swap happens at the end of the current
   * frame (or immediately when the engine isn't mid-frame). Resolves with the new scene node.
   */
  static async load(path: string, options: LoadSceneOptions = {}): Promise<GameObject> {
    const world = World.require();
    const file = loadSceneFile(path);
    if (file.settings?.physics === "2d") await ensurePhysics2D(world);
    // 3D physics when the scene says so, or (saying nothing) when it has 3D bodies or colliders (ADR 0045).
    if (file.settings?.physics === "3d" || (file.settings?.physics === undefined && usesPhysics3D(path))) await ensurePhysics3D(world);
    // Navigation (ADR 0065): the module, and the scene's baked chunks, so its NavChunks load as it's instantiated;
    // only in Worlds that run it (not clients, which get agents by replication).
    if (usesNavigation(path) && simulatesNavigation(world)) await Promise.all([ensureNavigation(world), preloadNavBakes(path)]);

    // A slice reference (`images/sheet.png#walk_0`, ADR 0040) preloads its image; a mesh
    // reference (`models/a.fbx#Body`, ADR 0044) its model; a material (ADR 0043) its textures.
    const refs = [...new Set([...collectAssetRefs(path)].map((p) => splitSpriteRef(p).path))];
    for (const m of refs.filter(isMaterialPath)) {
      try {
        const raw = Assets.has(m) ? Assets.json<Record<string, unknown>>(m) : null;
        for (const key of ["texture", "normalMap"]) if (typeof raw?.[key] === "string" && raw[key]) refs.push(splitSpriteRef(raw[key] as string).path);
      } catch {
        // reported when the material is drawn
      }
    }
    // UI documents (ADR 0077): their parsers, so documents build as the scene is instantiated.
    if (refs.some((p) => p.endsWith(".ui.xml"))) await loadUIDocumentSupport();
    const images = [...new Set(refs.filter((p) => IMAGE.test(p)))];
    const models = refs.filter((p) => isModelPath(p) && Assets.has(p));
    await Promise.all(models.map((m) => loadModel(m).catch((err) => console.error(`[myco] failed to load the model "${m}":`, err))));
    if (world.render && images.length) await world.render.preloadTextures(images, options.onProgress);
    options.onProgress?.(1);

    return new Promise<GameObject>((resolve, reject) => {
      const op = () => {
        try {
          if (!options.additive) {
            for (const scene of world.sceneNodes) world._destroyNode(scene.entity);
            world._flushDestroyed();
          }
          const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.(scene\.)?json$/, "");
          const sceneNode = world._createNode(name, world.root.entity, { transform: false });
          world.setSceneNode(sceneNode.entity);
          world._batch(() => sceneNode.addBehavior(SceneInstance, { source: path }));
          instantiateFile(world, file, sceneNode, path);
          resolve(sceneNode);
        } catch (err) {
          reject(err);
        }
      };
      if (world._inFrame) world._sceneOps.push(op);
      else World._runIn(world, op); // after an await, another World may be current
    });
  }

  /** Unload a scene node and everything in it (at the end of the frame). */
  static unload(scene: GameObject): void {
    if (!scene.isSceneNode) throw new Error(`${scene.name} is not a scene node.`);
    scene.world._destroyNode(scene.entity);
  }

  /** @internal Instance autoload files under the World root; they persist across loads. */
  static loadAutoloads(world: World): void {
    for (const path of world.settings.autoload) {
      instantiateFile(world, loadSceneFile(path), world.root, path);
    }
  }
}
