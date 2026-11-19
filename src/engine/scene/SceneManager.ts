import { World } from "../core/World";
import { Assets } from "./Assets";
import { MATERIAL_MAPS, isMaterialPath } from "./material";
import { isModelPath, loadModel } from "./models";
import type { GameObject } from "./GameObject";
import { splitSpriteRef } from "./importSettings";
import { SceneInstance, collectAssetRefs, instantiateFile, loadSceneFile } from "./SceneLoader";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { warmSet, warmSetEmpty, type WarmSet } from "./warmUp";
import { _startWorldServicesForScene } from "../core/worldServices";
import { resolvedComponents } from "./resolvedScene";

export interface LoadSceneOptions {
  /** Keep already-loaded scene nodes instead of replacing them (ADR 0016). */
  additive?: boolean;
  /** Called with 0..1 while assets preload. */
  onProgress?: (progress: number) => void;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const NOTHING_TO_WARM: WarmSet = { meshes: [], prefabs: [], effects: [], worldUI: false };

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
    // World services (ADR 0135) the scene needs: by its settings, the World's tags, or its Components.
    await _startWorldServicesForScene(world, { path, settings: file.settings as Readonly<Record<string, unknown>> | undefined, componentTypes: () => sceneComponentTypes(path) });

    // What the scene can show, warmed up before the swap (ADR 0080): its own content, the prefabs it
    // and the project's scripts name, and its `preload` list. Their assets load with the scene's.
    const warm = world.render ? warmSet(path) : NOTHING_TO_WARM; // headless Worlds draw nothing
    await prepareAssets(world, [path, ...warm.prefabs], options.onProgress, warm);

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
      world.atFrameEnd(op); // now, with this World current (after an await, another may be), or at the end of its frame
    });
  }

  /**
   * Warm up prefabs and materials ahead of time (ADR 0080): their textures and models load, and the
   * renderer draws each once, hidden, so the shader pipelines they need exist before they're spawned.
   * For content chosen at runtime (a boss before its arena opens); scene loads already warm what their
   * scene, its `settings.preload` list and the project's scripts name.
   *
   * ```ts
   * await SceneManager.preload(["prefabs/boss.prefab.json"]);
   * ```
   */
  static async preload(paths: string[]): Promise<void> {
    const world = World.require();
    if (!world.render) return; // headless: nothing to draw, so nothing to warm
    const warm = warmSet(null, paths);
    await prepareAssets(world, warm.prefabs, undefined, warm);
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

/**
 * Load what the scene files at `files` need before they're instantiated: images, models, material
 * textures, UI document support; then warm up `warm`'s meshes (ADR 0080) once textures are in, since a
 * texture that hasn't loaded gives a material a different shader variant.
 */
async function prepareAssets(world: World, files: readonly string[], onProgress: ((p: number) => void) | undefined, warm: WarmSet): Promise<void> {
  // A slice reference (`images/sheet.png#walk_0`, ADR 0040) preloads its image; a mesh
  // reference (`models/a.fbx#Body`, ADR 0044) its model; a material (ADR 0043) its textures.
  const all = new Set<string>();
  for (const f of files) for (const r of collectAssetRefs(f)) all.add(splitSpriteRef(r).path);
  // As `collectAssetRefs` gives them: without `asset:`.
  for (const m of warm.meshes) {
    if (m.mesh) all.add(splitSpriteRef(m.mesh.replace(/^asset:/, "")).path);
    if (m.material) all.add(splitSpriteRef(m.material.replace(/^asset:/, "")).path);
    for (const slot of m.materials ?? []) if (slot) all.add(splitSpriteRef(slot.replace(/^asset:/, "")).path);
  }
  const refs = [...all];
  // A model's import settings can name material assets for its materials (ADR 0089): their textures too.
  for (const m of refs.filter((p) => isModelPath(p) && Assets.has(p))) {
    try {
      for (const material of Object.values(Assets.importSettings(m).materials)) refs.push(splitSpriteRef(material.replace(/^asset:/, "")).path);
    } catch {
      // reported when the model loads
    }
  }
  for (const m of refs.filter(isMaterialPath)) {
    try {
      const raw = Assets.has(m) ? Assets.json<Record<string, unknown>>(m) : null;
      for (const key of ["texture", "normalMap", ...MATERIAL_MAPS.map((m) => m.key)]) if (typeof raw?.[key] === "string" && raw[key]) refs.push(splitSpriteRef(raw[key] as string).path);
    } catch {
      // reported when the material is drawn
    }
  }
  // UI documents (ADR 0077): their parsers, so documents build as the scene is instantiated.
  if (refs.some((p) => p.endsWith(".ui.xml"))) await loadUIDocumentSupport();
  const images = [...new Set(refs.filter((p) => IMAGE.test(p)))];
  const models = [...new Set(refs.filter((p) => isModelPath(p) && Assets.has(p)))];
  await Promise.all(models.map((m) => loadModel(m).catch((err) => console.error(`[myco] failed to load the model "${m}":`, err))));
  if (world.render && images.length) await world.render.preloadTextures(images, onProgress);
  if (world.render && !warmSetEmpty(warm)) await world.render.warmUp(warm);
  onProgress?.(1);
}

/**
 * The Component type ids in a scene file and the prefabs it instances, for deciding which World services
 * it needs (ADR 0135): the resolved scene view, so every override kind counts (added Components and
 * added nodes alike).
 */
function sceneComponentTypes(path: string): Set<string> {
  return new Set(resolvedComponents(path).map((c) => c.type));
}
