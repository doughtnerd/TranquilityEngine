/**
 * @internal Editor: what an asset thumbnail draws (ADR 0061, 0153, 0189): one Babylon scene per asset on the
 * thumbnail engine, with a camera framing it, ready to draw. `ThumbnailRenderer` draws and captures it (stills,
 * hover animation, the Inspector's orbitable preview); this module builds it.
 *
 * - **Through the render features** (ADR 0153, 0189): prefabs and scenes, environment maps and skies load into
 *   a headless World of their own and are synced by a thumbnail `BabylonRenderer` with the registered render
 *   features, as a World draws them. An environment or a sky is a World whose one Environment uses the asset:
 *   the lighting rig loads the map and draws its skybox; the Sky plugin's feature draws and bakes the sky. Core
 *   names no plugin's code: what draws an asset kind is the feature its Component reaches, and the asset kind's
 *   `preview` policy (ADR 0140, 0143) says which of these scenes it gets.
 * - **On their own**: models and materials (a material library and meshes in a scene lit by the default light
 *   rig, a World's own, ADR 0277, through the World's own material code, ADR 0127, 0089), and particle effects
 *   (the effect player, seeded, ADR 0153).
 *
 * What's left here is framing (`thumbnailMath`) and the chrome sphere that shows an environment's reflections.
 */
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../../scene/Assets";
import { loadMeshes, meshesIfLoaded } from "../../../scene/models";
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type SceneFile } from "../../../scene/SceneLoader";
import { World } from "../../../core/World";
import type { ProjectSettings, ProjectSettingsInput } from "../../../core/settings";
import { instantiateDocument, instantiateNodes } from "../../../editor";
import { MeshRenderer, ParticleSystem } from "../../components";
import { BabylonRenderer, loadPluginFeatures } from "../BabylonRenderer";
import { EffectPlayer, EffectResources, libraryEffectHost } from "../effectPlayer";
import { frameView, type Bounds } from "../../thumbnailMath";
import type { PosedPreviewSpec, ThumbnailKind } from "../../previewTypes";
import type { GraphShared } from "../graphMaterial";
import { environmentKind } from "../lighting";
import { meshOf, pbr } from "../materials";
import { aimCamera, createPreviewScene, createStudioTexture, previewMaterials, sceneReady } from "./common";
import { addDefaultLights, useDefaultStudio } from "../lighting";

/** Particle effects are shown this many seconds in, simulated at this rate, with this random seed. */
const PARTICLE_TIME = 1;
const PARTICLE_DT = 1 / 30;
const PARTICLE_SEED = 1;
/** A hovered effect that finished plays again after this many seconds. */
const PARTICLE_REPEAT_GAP = 0.5;
const FOV = 30;

// Where the camera sits, from the target. The World is mirrored in z from the right-handed one these
// were chosen in (ADR 0164), so they are too and the pictures stay the same; imported models are
// mirrored in x instead (still facing +Z), so they are seen from x-mirrored directions, with the default
// rig's sun turned half round Y to match (`litScene(true)`).
const DIRECTION_3D: [number, number, number] = norm([1, 0.75, -1.15]);
const DIRECTION_FRONT: [number, number, number] = [0, 0, -1];
const DIRECTION_MATERIAL: [number, number, number] = norm([0, 0.35, -1]);
const DIRECTION_MODEL: [number, number, number] = norm([-1, 0.75, 1.15]);
const UNIT: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
/** How rough the chrome sphere is that reflects an environment map, and a sky's bake. */
const CHROME_ENVIRONMENT = 0.05;
const CHROME_SKY = 0.1;

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A scene ready to draw: what to render, from where, what to free, and how to advance it (animations). */
export interface ThumbnailScene {
  scene: Scene;
  camera: TargetCamera;
  /** What a preview orbits around. */
  target: [number, number, number];
  /** Before each draw with `camera` (a thumbnail renderer's sky box fits it). */
  beforeDraw?: (camera: TargetCamera) => void;
  /** Advance by `dt` seconds (time-based graphs, particles, a sky's clouds) and refresh what draws. */
  step?: (dt: number) => void;
  /**
   * Recover transparency by drawing over black and over white (particle effects): additive blending
   * leaves a transparent target's alpha at 0, so its light would be lost in the copy.
   */
  matte?: boolean;
  dispose(): void;
}

/** What to build thumbnails with; tests pass a headless engine and switch the studio room off. */
export interface ThumbnailOptions {
  /** The studio environment reflections (default on). */
  studio?: boolean;
  /** Longest wait, in ms, for a scene's shaders and textures before drawing it anyway (default: a few seconds per kind). */
  readyTimeout?: number;
  /**
   * The project settings prefabs and scenes load with (pixels per unit, sorting layers). Default: the
   * active World's, which in the editor are the open project's.
   */
  settings?: () => ProjectSettingsInput | ProjectSettings;
}

/** A headless World and the thumbnail renderer syncing it. */
interface Headless {
  world: World;
  renderer: BabylonRenderer;
  dispose(): void;
}

/** Builds the scene each thumbnail draws, on one engine, sharing one studio room (made in a host scene). */
export class ThumbnailScenes {
  private readonly host: Scene;
  private readonly studio: HDRCubeTexture | null;
  /** Resolves once the studio room can light a scene (or after giving up on it). */
  private studioReady: Promise<boolean> | null = null;
  private studioOk = false;
  private readonly readyTimeout: number | undefined;
  private readonly settings: () => ProjectSettingsInput | ProjectSettings;
  private disposed = false;

  /** `size` is the thumbnails' pixels (what time-based shader graphs see as their resolution until drawn). */
  constructor(
    private readonly engine: AbstractEngine,
    private readonly size: number,
    options: ThumbnailOptions = {},
  ) {
    this.readyTimeout = options.readyTimeout;
    this.settings = options.settings ?? (() => World.active?.settings ?? {});
    this.host = createPreviewScene(engine);
    this.studio = options.studio === false ? null : createStudioTexture(this.host);
  }

  /** The scene a thumbnail of this asset draws (`live`: the hover animation or the Inspector's preview), or null if it can't be made (warned). */
  async prepare(kind: ThumbnailKind, path: string, live: boolean): Promise<ThumbnailScene | null> {
    try {
      await this.loadStudio();
      switch (kind) {
        case "model":
          return await this.prepareModel(path);
        case "material":
        case "shadergraph":
          return await this.prepareMaterial(kind, path);
        case "environment":
        case "sky":
          return await this.prepareEnvironment(kind, path, live);
        case "particles":
          return await this.prepareParticles(path, live);
        case "prefab":
          return await this.prepareNodes(path, false);
        case "scene":
          return await this.prepareNodes(path, true);
      }
    } catch (err) {
      console.warn(`[myco] thumbnail: couldn't draw ${path}:`, err);
      return null;
    }
  }

  /**
   * A posed preview's scene (ADR 0373, T18b): `spec`'s nodes in a headless World that, unlike a prefab's, steps with each
   * frame of the preview (`step`), so its plugins' systems run (an Animator posing a skeleton through the animation core);
   * framed by what it draws at rest. Disposing it tears the World down, which closes the services it started.
   */
  async prepareWorld(spec: PosedPreviewSpec): Promise<ThumbnailScene | null> {
    try {
      await this.loadStudio();
      const { world, renderer, dispose } = await this.headless(spec.scene, spec.key, true);
      try {
        await this.settle(world, renderer, 3000);
        const scene = renderer.scene;
        scene.clearColor = new Color4(0, 0, 0, 0); // follows the editor theme
        const drawn = renderer.contentMeshes();
        if (!drawn.length) throw new Error("it has nothing to draw.");
        const framed = this.camera(scene, meshBounds(drawn), DIRECTION_3D, UNIT);
        await this.ready(scene, 3000);
        return {
          scene,
          ...framed,
          beforeDraw: (camera) => renderer.beforeStill(camera),
          step: (dt) => {
            World._runIn(world, () => spec.frame?.(world));
            world.step(dt);
            World._runIn(world, () => renderer.sync(world));
          },
          dispose,
        };
      } catch (err) {
        dispose();
        throw err;
      }
    } catch (err) {
      console.warn(`[myco] posed preview: couldn't draw ${spec.key}:`, err);
      return null;
    }
  }

  /** Free the studio room. Scenes already prepared are their callers' to dispose. */
  dispose(): void {
    this.disposed = true;
    this.studio?.dispose();
    this.host.dispose();
  }

  /** Wait until `scene` can draw (shaders compiled, textures loaded), at most `ms`. */
  private ready(scene: Scene, ms: number): Promise<boolean> {
    return sceneReady(scene, this.readyTimeout ?? ms);
  }

  /** A scene lit by the default rig (ADR 0277): soft ambient, a sun (turned half round Y for a model, see above), and the studio room. */
  private litScene(model = false): Scene {
    const scene = createPreviewScene(this.engine);
    const { sun } = addDefaultLights(scene, "preview");
    if (model) sun.direction = new Vector3(-sun.direction.x, sun.direction.y, -sun.direction.z);
    if (this.studioOk && this.studio) useDefaultStudio(scene, this.studio);
    return scene;
  }

  private camera(scene: Scene, bounds: Bounds | null, direction: readonly number[], fallback: Bounds): { camera: TargetCamera; target: [number, number, number] } {
    const camera = new TargetCamera("preview.camera", Vector3.Zero(), scene, false);
    camera.fov = (FOV * Math.PI) / 180; // vertical, like the engine's
    camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    const view = frameView(bounds ?? fallback, FOV, direction);
    camera.minZ = view.near;
    camera.maxZ = view.far;
    aimCamera(camera, view.position, view.target);
    scene.activeCamera = camera;
    return { camera, target: view.target };
  }

  private async prepareModel(path: string): Promise<ThumbnailScene> {
    const sources = await loadMeshes(path);
    const scene = this.litScene(true);
    const library = previewMaterials(scene, { time: 0, resolution: [this.size, this.size] }, true);
    const box = new BoundsBox();
    // Slots as the World renderer resolves them (ADR 0089): here, the model's import settings, then its own.
    const drawn = library.slotMaterials({ mesh: path, material: "" }, sources);
    for (const src of sources) {
      const mesh = meshOf(scene, `model:${src.name}`, src);
      mesh.material = drawn(src, mesh);
      box.add(src.data.positions, null);
    }
    await library.settled();
    await this.ready(scene, 3000); // the models' textures load on their own
    return { scene, ...this.camera(scene, box.bounds(), DIRECTION_MODEL, UNIT), dispose: () => scene.dispose() };
  }

  private async prepareMaterial(kind: "material" | "shadergraph", path: string): Promise<ThumbnailScene> {
    const scene = this.litScene();
    const shared: GraphShared = { time: 0, resolution: [this.size, this.size] };
    try {
      // A material asset, or a shader graph named directly (its own property values).
      const library = previewMaterials(scene, shared, true);
      const material = library.material(path);
      if (!material) throw new Error(`"${path}" isn't a ${kind === "shadergraph" ? "shader graph that can be read" : "material"}.`);
      await library.settled();
      previewSphere(scene).material = material;
      await this.ready(scene, 5000);
      let time = 0;
      return {
        scene,
        ...this.camera(scene, UNIT, DIRECTION_MATERIAL, UNIT),
        step: (dt) => {
          time += dt;
          shared.time = time;
          const canvas = this.engine.getRenderingCanvas();
          shared.resolution = [canvas?.width ?? this.size, canvas?.height ?? this.size];
        },
        dispose: () => scene.dispose(),
      };
    } catch (err) {
      scene.dispose();
      throw err;
    }
  }

  /**
   * An environment map (ADR 0053, 0113) or a procedural sky (ADR 0112), drawn by the render features: a
   * headless World whose one Environment uses the asset. An environment map is a chrome sphere reflecting
   * it, with the map itself behind in a live preview (the Environment's skybox). A sky is the sky alone in
   * a still; a live preview adds a chrome sphere reflecting the sky's bake, and the clouds drift and the
   * stars twinkle as the World's real time moves on.
   */
  private async prepareEnvironment(kind: "environment" | "sky", path: string, live: boolean): Promise<ThumbnailScene> {
    const sky = kind === "sky";
    const read = environmentKind(path);
    if (sky ? read !== "sky" : !read || read === "sky") throw new Error(sky ? `"${path}" isn't a .sky.json file.` : `"${path}" isn't an .hdr, .exr, .png, .jpg, .env, .dds or .cubemap.json file.`);
    if (!Assets.has(path)) throw new Error(`"${path}" isn't in the project.`);
    const file: SceneFile = {
      format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`,
      nodes: [{ id: "environment", name: "Environment", components: [{ type: "engine.Environment", data: { map: `asset:${path}`, skybox: sky || live } }] }],
    };
    const { world, renderer, dispose } = await this.headless(file, path);
    try {
      const scene = renderer.scene;
      scene.clearColor = new Color4(0, 0, 0, 0); // tiles follow the editor theme
      const view = this.camera(scene, UNIT, DIRECTION_FRONT, UNIT);
      if (!sky || live) chromeSphere(scene, sky ? CHROME_SKY : CHROME_ENVIRONMENT);
      await this.settle(world, renderer, sky ? 6000 : 8000);
      if (!sky && !renderer.diagnostics().lighting.environmentLoaded) throw new Error("the map didn't load.");
      await this.ready(scene, 5000);
      const sync = () => World._runIn(world, () => renderer.sync(world));
      return {
        scene,
        ...view,
        beforeDraw: (camera) => renderer.beforeStill(camera),
        step: sky && live
          ? (dt) => {
              world.advanceClock(dt); // the sky's clouds and stars move with its clock (ADR 0239)
              sync();
              world.advanceClock(0);
            }
          : undefined,
        dispose,
      };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  /** An effect one second in, played by an effect player (ADR 0153) seeded so every thumbnail of it is the same. */
  private async prepareParticles(path: string, live: boolean): Promise<ThumbnailScene> {
    const scene = createPreviewScene(this.engine);
    const shared: GraphShared = { time: 0, resolution: [this.size, this.size] };
    const library = previewMaterials(scene, shared, true);
    const resources = new EffectResources(libraryEffectHost(scene, library), () => undefined);
    let player: EffectPlayer | null = null;
    const dispose = () => {
      player?.dispose();
      resources.dispose();
      library.dispose();
      scene.dispose();
    };
    try {
      addDefaultLights(scene, "preview"); // for lit material assets (the default rig, ADR 0277)
      const compiled = resources.compile(Assets.json(path), path);
      if (!compiled) throw new Error("it isn't a particle effect that can be read.");
      const program = compiled.program;
      // Everything the emitters draw with, loaded first, so the effect is built once, with it.
      await resources.preload(program);
      await library.settled();
      const made = new EffectPlayer(resources, program, { name: "particles:thumbnail", seed: PARTICLE_SEED });
      player = made;
      if (!made.build()) throw new Error("what it draws with didn't load.");
      const step = (dt: number) => {
        shared.time += dt; // graph materials' Time node
        made.step(dt);
        // A finished one-shot effect starts again, so a hovered tile keeps showing something.
        if (live) made.repeatWhenFinished(dt, PARTICLE_REPEAT_GAP);
      };
      for (let t = 0; t < PARTICLE_TIME; t += PARTICLE_DT) step(PARTICLE_DT);
      // Frame what's alive now (the effect sits at the origin, so local and world space agree).
      const box = new BoundsBox();
      box.add(Float32Array.from(made.points()), null);
      const bounds = box.bounds();
      await this.ready(scene, 3000);
      return {
        scene,
        ...this.camera(scene, bounds && padded(bounds, 0.4), DIRECTION_3D, { min: [-1, 0, -1], max: [1, 2, 1] }),
        step: live ? step : undefined,
        matte: true,
        dispose,
      };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  /**
   * A prefab's or scene's nodes (instances expanded), loaded into a headless World of their own and drawn
   * by a thumbnail renderer with the render features of the enabled plugins, as a World draws them
   * (sprite sizes and slices, lights, cameras, materials, particle effects). A prefab is framed by its
   * bounds; a scene is seen from its main camera, framed like a prefab when it has none (ADR 0117).
   */
  private async prepareNodes(path: string, asScene: boolean): Promise<ThumbnailScene> {
    const { world, renderer, dispose } = await this.headless(Assets.json(path) as SceneFile, path);
    try {
      await this.settle(world, renderer, 3000);
      const scene = renderer.scene;
      scene.clearColor = new Color4(0, 0, 0, 0); // tiles follow the editor theme
      const drawn = renderer.contentMeshes();
      const particles = world._componentsOfType(ParticleSystem).some((c) => c.isActiveAndEnabled);
      if (!drawn.length && !particles) throw new Error("it has nothing to draw.");
      const view = asScene ? renderer.mainView() : null;
      let framed: { camera: TargetCamera; target: [number, number, number] };
      if (view) {
        // Seen as its main camera sees it (the renderer set it up from the Camera), over its background.
        const camera = view.babylon;
        const bg = view.camera.backgroundColor;
        if (bg) scene.clearColor = new Color4(bg.r, bg.g, bg.b, 1);
        const forward = new Vector3(0, 0, 1).applyRotationQuaternion(camera.rotationQuaternion ?? Quaternion.Identity());
        const p = camera.position;
        framed = { camera, target: [p.x + forward.x * 10, p.y + forward.y * 10, p.z + forward.z * 10] };
      } else {
        // From three-quarters above, or the front when it draws only sprites.
        const meshes = world._componentsOfType(MeshRenderer).some((c) => c.isActiveAndEnabled);
        framed = this.camera(scene, meshBounds(drawn), meshes || !drawn.length ? DIRECTION_3D : DIRECTION_FRONT, UNIT);
      }
      await this.ready(scene, 3000);
      return { scene, ...framed, beforeDraw: (camera) => renderer.beforeStill(camera), dispose };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  /**
   * `file` loaded into a headless `World("editor")` of its own, and a thumbnail renderer with the registered
   * render features (and the lazy ones that World needs) to sync it (ADR 0153). The nodes are the World's
   * own, so its cameras are canvas cameras; nothing runs, as the World never steps (unless `stepped`: a posed
   * preview's World, whose nodes are live and whose frames the preview steps).
   */
  private async headless(file: SceneFile, path: string, stepped = false): Promise<Headless> {
    const world = new World("editor", this.settings());
    try {
      if (stepped) {
        // A posed preview's nodes run as in a game (Animators start and evaluate): not an edit-mode scene, whose components stay inactive.
        World._runIn(world, () => instantiateNodes(world, file, world.root, path, { onProblem: () => undefined }));
      } else {
        const root = World._runIn(world, () => instantiateDocument(world, file, path, { onProblem: () => undefined }));
        world.setEditMode(root.entity, false);
      }
      const renderer = BabylonRenderer.forThumbnail(this.engine, world.settings, await loadPluginFeatures(world), { studio: this.studioOk ? this.studio : null });
      renderer.setPolicy({ drawPolicy: "perObject" }); // a mesh per MeshRenderer and sprite, framed by their bounds
      return {
        world,
        renderer,
        dispose: () => {
          renderer.dispose();
          world._destroyAll();
        },
      };
    } catch (err) {
      world._destroyAll();
      throw err;
    }
  }

  /**
   * Sync `world` into `renderer`, with each frame's once-a-frame work (a sky's bake), until what it draws
   * with has loaded and every feature has settled (ADR 0189), at most `ms` (or the ready timeout); then, if
   * it has particle effects, a second more of frames, as an effect's own thumbnail shows it.
   */
  private async settle(world: World, renderer: BabylonRenderer, ms: number): Promise<void> {
    const frame = () => {
      World._runIn(world, () => renderer.sync(world));
      renderer.beforeStill(null);
    };
    frame();
    const deadline = Date.now() + (this.readyTimeout ?? ms);
    while (!renderer.contentReady() && Date.now() < deadline && !this.disposed) {
      await new Promise((r) => setTimeout(r, 16));
      frame();
    }
    if (!world._componentsOfType(ParticleSystem).length) return;
    for (let t = 0; t < PARTICLE_TIME; t += PARTICLE_DT) {
      world.advanceClock(PARTICLE_DT); // the World is drawn, never stepped: only its clock moves (ADR 0239)
      World._runIn(world, () => renderer.sync(world));
    }
    world.advanceClock(0);
  }

  /** The studio room, once: ready for every scene, or not at all (thumbnails then have no reflections). */
  private loadStudio(): Promise<boolean> {
    this.studioReady ??= !this.studio
      ? Promise.resolve(false)
      : new Promise<boolean>((resolve) => {
          const started = Date.now();
          const poll = () => {
            if (this.disposed) return resolve(false);
            if (this.studio!.isReady()) {
              this.studioOk = true;
              return resolve(true);
            }
            if (Date.now() - started > 4000) return resolve(false);
            setTimeout(poll, 16);
          };
          poll();
        });
    return this.studioReady;
  }
}

// --- helpers ------------------------------------------------------------------------------------------

/** The built-in unit sphere, as a mesh of `scene` named `preview.sphere`, that materials and environments are shown on. */
function previewSphere(scene: Scene): Mesh {
  return meshOf(scene, "preview.sphere", meshesIfLoaded("builtin:sphere")![0]);
}

/**
 * The preview sphere in polished chrome of roughness `roughness`, reflecting the scene's environment. Unlit
 * by its lights: only the reflection shows, whatever lights the scene has (a World's default sun).
 */
function chromeSphere(scene: Scene, roughness: number): Mesh {
  const chrome = pbr("preview.chrome", scene);
  chrome.albedoColor = new Color3(1, 1, 1);
  chrome.metallic = 1;
  chrome.roughness = roughness;
  chrome.disableLighting = true;
  const sphere = previewSphere(scene);
  sphere.material = chrome;
  return sphere;
}

const padded = (b: Bounds, by: number): Bounds => ({ min: [b.min[0] - by, b.min[1] - by, b.min[2] - by], max: [b.max[0] + by, b.max[1] + by, b.max[2] + by] });

/** The box around points (optionally moved by a column-major matrix). */
class BoundsBox {
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];

  add(positions: ArrayLike<number>, world: readonly number[] | null): void {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      let x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (world) {
        const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
        const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
        const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
        x = wx;
        y = wy;
        z = wz;
      }
      if (x < this.min[0]) this.min[0] = x;
      if (y < this.min[1]) this.min[1] = y;
      if (z < this.min[2]) this.min[2] = z;
      if (x > this.max[0]) this.max[0] = x;
      if (y > this.max[1]) this.max[1] = y;
      if (z > this.max[2]) this.max[2] = z;
    }
  }

  bounds(): Bounds | null {
    return this.min[0] > this.max[0] ? null : { min: [...this.min], max: [...this.max] };
  }
}

/** The world-space box around Babylon meshes (each one's own box, moved by its world matrix). */
function meshBounds(meshes: readonly AbstractMesh[]): Bounds | null {
  const box = new BoundsBox();
  for (const m of meshes) {
    const { minimum: a, maximum: b } = m.getBoundingInfo().boundingBox;
    const corners = [a.x, a.y, a.z, b.x, a.y, a.z, a.x, b.y, a.z, b.x, b.y, a.z, a.x, a.y, b.z, b.x, a.y, b.z, a.x, b.y, b.z, b.x, b.y, b.z];
    box.add(corners, Array.from(m.computeWorldMatrix(true).asArray()));
  }
  return box.bounds();
}
