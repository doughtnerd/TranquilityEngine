/**
 * Stages 2–3 of ADR 0075 on Babylon.js: Light components (ADR 0043), which lights cast shadows and
 * how (ADR 0050, 0053; the frame graph draws the shadow maps, `frameGraph.ts`), and the Environment
 * component's lighting and sky (ADR 0053), with the default studio room when a World has no map.
 * Mirrors what the three.js backend does in `syncLights`, `syncCascades` and `syncEnvironment`.
 */
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import type { Light as BabylonLight } from "@babylonjs/core/Lights/light.js";
import { LightConstants } from "@babylonjs/core/Lights/lightConstants.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import type { IShadowLight } from "@babylonjs/core/Lights/shadowLight.js";
import { SpotLight } from "@babylonjs/core/Lights/spotLight.js";
import { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture.js";
import { EXRCubeTexture } from "@babylonjs/core/Materials/Textures/exrCubeTexture.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { SHADOW_MAP_SIZE } from "../../core/graphics";
import type { World } from "../../core/World";
import { Assets } from "../../scene/Assets";
import { Environment, Light } from "../components";
import { Graphics } from "../Graphics";
import type { ShadowRequest } from "./frameGraph";

/** The default sun's direction (a World without Lights). */
const DEFAULT_SUN = new Vector3(-4, -10, -6).normalize();

/** Scratch vector for `fitShadowArea`. */
const tmpBack = new Vector3();
import { studioHdrUrl } from "./studioEnvironment";
import { cubemapReady, loadCubemap } from "./sky/cubemaps";

interface LightEntry {
  light: BabylonLight;
  type: string;
  /** In the clustered light container (ADR 0079) rather than a light of the scene's own. */
  clustered: boolean;
}

/** WebGPU's guaranteed number of values between shader stages (`maxInterStageShaderVariables`). */
const MIN_STAGE_VARIABLES = 16;

/**
 * A Light's `range` as Babylon's: metres, with 0 meaning no limit (Babylon's default, which the
 * clustered container bounds at its `maxRange`, 16 km). Materials use glTF falloff (`useEngineLightFalloff`),
 * so a point or spot light fades with the square of distance and reaches nothing past its range.
 */
function lightRange(range: number): number {
  return range > 0 ? range : Number.MAX_VALUE;
}

let clustering = true;

/**
 * @internal Check pages only (`spikes/babylon/lights.ts`): turn clustering off for Worlds made after
 * this, so point and spot lights are the scene's own, to compare a frame against the clustered one.
 */
export function _setClustering(on: boolean): void {
  clustering = on;
}

/** The range a parked clustered light gets, so it falls in almost no cluster and costs almost nothing. */
const PARKED_RANGE = 0.001;

/**
 * @internal Before a camera's render pass (`frameGraph.ts`): make the scene's clustered light
 * container sort its lights and fill its depth slices again, for that camera. Babylon does it once a
 * frame (`_lightDataRenderId`), for whichever camera renders first, so a second camera in the same
 * frame (the editor's camera preview, split screen) shaded against the first camera's slices (ADR 0079).
 */
export function reclusterForNextCamera(scene: Scene): void {
  for (const light of scene.lights) {
    if (light.getTypeID() === LightConstants.LIGHTTYPEID_CLUSTERED_CONTAINER) (light as unknown as { _lightDataRenderId: number })._lightDataRenderId = -1;
  }
}

/**
 * The most Babylon lights the backend keeps, lit or parked: a material lights with the first
 * `maxSimultaneousLights` (8, `materials.ts`) enabled ones, so a parked light past that could push
 * a lit one out of the material's list.
 */
const MAX_KEPT_LIGHTS = 8;

interface EnvMap {
  path: string;
  texture: BaseTexture | null;
  /** A copy drawn as the sky (skybox coordinates). */
  sky: BaseTexture | null;
}

/**
 * How an environment map is read, by file name; null for unsupported files. Equirectangular images
 * (ADR 0053), prefiltered `.env`/`.dds` cubes and six-image `*.cubemap.json` assets (ADR 0113), and
 * procedural `*.sky.json` skies (ADR 0112, drawn and baked by `sky/BabylonSky.ts`).
 */
export function environmentKind(path: string): "hdr" | "exr" | "ldr" | "cube" | "faces" | "sky" | null {
  const p = path.split(/[?#]/)[0]!.toLowerCase();
  if (p.endsWith(".hdr")) return "hdr";
  if (p.endsWith(".exr")) return "exr";
  if (/\.(png|jpe?g)$/.test(p)) return "ldr";
  if (/\.(env|dds)$/.test(p)) return "cube";
  if (p.endsWith(".cubemap.json")) return "faces";
  if (p.endsWith(".sky.json")) return "sky";
  return null;
}

/**
 * @internal A light's `shadowEnabled`: true only while it has a shadow map this frame. Babylon's
 * frame graph object renderer sets every shadow-capable light's flag to "has a shadow map in this
 * graph" before each render and restores it after; a light left at Babylon's default (true) without
 * one flipped twice a frame, and each flip marks every mesh it lights as needing its shader defines
 * rebuilt, which cost tens of milliseconds a frame in the pirates sample.
 */
export function setShadowEnabled(light: BabylonLight, casts: boolean): void {
  if (light.shadowEnabled !== casts) light.shadowEnabled = casts;
}

/** The size of the prefiltered cube made from an environment map (per face). */
export const ENV_SIZE = 256;

/** @internal Lights, shadows and environment on the Babylon backend (ADR 0075 stages 2–3). */
export class BabylonLighting {
  private readonly lights = new Map<Light, LightEntry>();
  /**
   * Babylon lights whose Light went away, left enabled at zero intensity for the next Light of the
   * same type. A material's shader is compiled for the number and types of the lights on it
   * (`LIGHTCOUNT`, `POINTLIGHT3`…), so adding, removing, enabling or disabling one recompiles every
   * lit material, a 100–500 ms pause on WebGPU (the pirates match did it whenever a ship with a
   * lantern spawned or sank). Parked and reused, the set only grows to the most lights lit at once.
   */
  private readonly parked: LightEntry[] = [];
  /**
   * ADR 0079: point and spot lights without shadows go in one clustered light container, which takes
   * one slot on a material and keeps its shader the same however many lights it holds. Made with the
   * first such Light; null until then, and for good where the engine can't cluster (`clusterless`).
   */
  private cluster: ClusteredLightContainer | null = null;
  private clusterless = false;
  /** Clustered lights whose Light went away: dark, near zero range, for the next Light of their type. */
  private readonly clusterParked: LightEntry[] = [];
  private readonly defaults: BabylonLight[];
  private envMap: EnvMap | null = null;
  private studio: HDRCubeTexture | null = null;
  private skybox: Mesh | null = null;
  private skyMaterial: PBRMaterial | null = null;
  private readonly warned = new Set<string>();
  /** Whether the last sync asked for cascaded shadows, for tests. */
  private cascading = false;
  /** How many lights the last sync gave cascades (ADR 0110), for tests. */
  private cascadedCount = 0;
  /**
   * The main light shader graphs read (Main Light Direction / Color nodes), chosen as three.js's
   * `directionalLights[0]` is: the first shadow-casting directional light, else the first directional
   * one, else the default sun when the World has no Lights, else (0.4, 1, 0.6) and white. `direction`
   * is a unit world vector toward the light; `color` is linear colour × intensity. Updated in place.
   */
  readonly mainLight = { direction: [0.4, 1, 0.6].map((v) => v / Math.hypot(0.4, 1, 0.6)), color: [1, 1, 1] };
  /** How much the World's fog covers the sky (ADR 0071): the skybox dims by it and hides at 1. */
  private skyFog = 0;
  /** A procedural sky's baked environment (ADR 0112), set by `BabylonSky`; null until its first bake. */
  private skyEnvironment: BaseTexture | null = null;
  /** The sky's sun (ADR 0114): the main directional light follows it when set (`setSunOverride`). */
  private sunOverride: { direction: readonly number[]; color: readonly number[]; intensity: number } | null = null;

  constructor(private readonly scene: Scene) {
    // The light a World without Lights gets: a soft ambient light and a sun from above and in front.
    const ambient = new HemisphericLight("myco.default.ambient", new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.35;
    ambient.groundColor = new Color3(1, 1, 1);
    ambient.specular = Color3.Black();
    const sun = new DirectionalLight("myco.default.sun", DEFAULT_SUN.clone(), scene);
    sun.intensity = 1;
    this.defaults = [ambient, sun];
  }

  /**
   * Step 8: mirror the World's Lights, and return the shadow maps this frame needs: one per enabled
   * shadow-casting light, cascaded for the first `cascadedLights` directional ones (ADR 0110) on tiers
   * with cascades when a camera draws the view (cascades follow it).
   */
  syncLights(world: World, camera: BabylonCamera | null): ShadowRequest[] {
    const tier = Graphics.tier;
    const mapSize = SHADOW_MAP_SIZE[tier.shadows];
    const cascadeLights = new Set<Light>();
    if (camera && mapSize && tier.shadowCascades > 1) {
      for (const l of world._componentsOfType(Light)) {
        if (cascadeLights.size >= this.cascadeLimit(tier.cascadedLights ?? 1)) break;
        if (l.type === "directional" && l.castShadows && l.isActiveAndEnabled) cascadeLights.add(l);
      }
    }
    let any = false;
    this.cascading = false;
    this.cascadedCount = 0;
    const shadows: ShadowRequest[] = [];
    let main: BabylonLight | null = null;
    let mainCasts = false;
    const sunTarget = this.sunOverride ? this.sunLight(world) : null;
    for (const l of world._componentsOfType(Light)) {
      const on = this.syncLight(world, l);
      if (on && l === sunTarget) this.applySun(this.lights.get(l)!.light);
      const entry = this.lights.get(l)!;
      const casts = on && l.castShadows && l.type !== "ambient" && !!mapSize;
      setShadowEnabled(entry.light, casts);
      if (!on) continue;
      any = true;
      if (l.type === "directional" && (!main || (casts && !mainCasts))) {
        main = entry.light;
        mainCasts = casts;
      }
      if (!casts) continue;
      const light = entry.light as BabylonLight & IShadowLight;
      const cascaded = cascadeLights.has(l);
      if (cascaded) {
        this.cascading = true;
        this.cascadedCount++;
      }
      else if (light instanceof DirectionalLight) this.fitShadowArea(light, l.shadowArea);
      shadows.push({ light, cascaded, mapSize, numCascades: tier.shadowCascades, shadowMaxZ: tier.shadowDistance });
    }
    this.reservePointLights();
    // A World with no Light of its own gets the default ones, so meshes never draw black.
    for (const d of this.defaults) {
      d.setEnabled(!any);
      setShadowEnabled(d, false);
    }
    this.syncDefaultSun();
    this.syncMainLight(main ?? (any ? null : this.defaults[1]));
    return shadows;
  }

  /** Drive the main directional light from the sky (ADR 0114); null to leave Lights as authored. */
  setSunOverride(sun: { direction: readonly number[]; color: readonly number[]; intensity: number } | null): void {
    this.sunOverride = sun;
  }

  /** The Light the sky drives: the first enabled shadow-casting directional light, else the first directional one. */
  private sunLight(world: World): Light | null {
    let first: Light | null = null;
    for (const l of world._componentsOfType(Light)) {
      if (l.type !== "directional" || !l.isActiveAndEnabled) continue;
      if (l.castShadows) return l;
      first ??= l;
    }
    return first;
  }

  private applySun(light: BabylonLight): void {
    const sun = this.sunOverride;
    if (!sun || !(light instanceof DirectionalLight)) return;
    light.direction = light.direction.set(-sun.direction[0], -sun.direction[1], -sun.direction[2]);
    light.diffuse.set(sun.color[0], sun.color[1], sun.color[2]);
    light.specular.copyFrom(light.diffuse);
    light.intensity = Math.max(0, sun.intensity);
  }

  /** The default sun (a World without Lights) follows the sky too, and goes back when it stops. */
  private syncDefaultSun(): void {
    const sun = this.defaults[1] as DirectionalLight;
    if (this.sunOverride) return this.applySun(sun);
    sun.direction = sun.direction.copyFrom(DEFAULT_SUN);
    sun.diffuse.set(1, 1, 1);
    sun.specular.set(1, 1, 1);
    sun.intensity = 1;
  }

  /**
   * How many lights may have cascades: the tier's `cascadedLights`, but one on devices at WebGPU's
   * minimum of 16 values between shader stages. Each cascaded light passes two more (its position from
   * the camera and depth metric), and a material past the device's limit fails to compile and draws
   * black (see `clusterContainer`).
   */
  private cascadeLimit(wanted: number): number {
    const max = this.scene.getEngine().getCaps().maxVaryingVectors;
    return max <= MIN_STAGE_VARIABLES ? 1 : Math.max(1, Math.min(4, wanted));
  }

  private syncMainLight(light: BabylonLight | null): void {
    const { direction, color } = this.mainLight;
    if (light instanceof DirectionalLight) {
      const d = light.direction;
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      direction[0] = -d.x / len;
      direction[1] = -d.y / len;
      direction[2] = -d.z / len;
      const c = light.diffuse; // already linear (`syncLight`)
      color[0] = c.r * light.intensity;
      color[1] = c.g * light.intensity;
      color[2] = c.b * light.intensity;
    } else {
      const len = Math.hypot(0.4, 1, 0.6);
      direction[0] = 0.4 / len;
      direction[1] = 1 / len;
      direction[2] = 0.6 / len;
      color[0] = color[1] = color[2] = 1;
    }
  }

  /** Mirror one Light; true if it lights the scene. */
  private syncLight(world: World, l: Light): boolean {
    let entry = this.lights.get(l);
    const clustered = this.wantsCluster(l);
    if (!entry || entry.type !== l.type || entry.clustered !== clustered) {
      if (entry) this.release(l);
      entry = this.unpark(l, clustered) ?? this.create(l, clustered);
      this.lights.set(l, entry);
    }
    const { light } = entry;
    // A Light that's off stays enabled at zero intensity, so its material variants stay (see `parked`).
    const on = l.isActiveAndEnabled;
    if (!light.isEnabled()) light.setEnabled(true);
    if (!on) {
      light.intensity = 0;
      if (clustered) (light as PointLight | SpotLight).range = PARKED_RANGE;
      return false;
    }
    // In place: no new colours or vectors per light per frame (Babylon reads them by value).
    const color = light.diffuse.set(l.color.r, l.color.g, l.color.b).toLinearSpaceToRef(light.diffuse);
    light.intensity = Math.max(0, l.intensity);
    return this.pose(world, l, light, color);
  }

  /**
   * Once the World has a point light, fill the slots a material has left with dark point lights, so
   * point lights coming later (a ship's lantern as it spawns) take one instead of recompiling every
   * lit material once per new high (see `parked`). A dark light costs a little shading per pixel.
   */
  private reservePointLights(): void {
    if (this.cluster) return; // point lights cluster: nothing to reserve
    let points = false;
    for (const e of this.lights.values()) if (e.type === "point") points = true;
    if (!points) return;
    while (this.regularCount() < MAX_KEPT_LIGHTS) {
      const light = new PointLight("myco.parked", Vector3.Zero(), this.scene);
      light.intensity = 0;
      setShadowEnabled(light, false);
      this.parked.push({ light, type: "point", clustered: false });
    }
  }

  /** Lights of the scene's own, lit or parked: what counts against a material's 8 (the container takes one). */
  private regularCount(): number {
    let n = this.parked.length + (this.cluster ? 1 : 0);
    for (const e of this.lights.values()) if (!e.clustered) n++;
    return n;
  }

  /** Whether `l` goes in the clustered light container (ADR 0079): a point or spot light without a shadow map, where the engine can cluster. */
  private wantsCluster(l: Light): boolean {
    if (l.type !== "point" && l.type !== "spot") return false;
    if (l.castShadows && SHADOW_MAP_SIZE[Graphics.tier.shadows]) return false;
    return this.clusterContainer() !== null;
  }

  /** The scene's clustered light container, made on first use; null where the engine can't cluster (WebGL2 without float blending, NullEngine). */
  private clusterContainer(): ClusteredLightContainer | null {
    if (this.cluster || this.clusterless) return this.cluster;
    if (!clustering) return null; // the comparison page's regular-lights run (`_setClustering`)
    // Clustering adds a value passed from the vertex to the fragment stage; a material with cascaded
    // shadows and two-sided lighting then needs 17, past WebGPU's minimum of 16, and its pipeline fails
    // (the pass drew black). Devices at the minimum keep regular lights.
    if (this.scene.getEngine().getCaps().maxVaryingVectors <= MIN_STAGE_VARIABLES) {
      this.clusterless = true;
      return null;
    }
    const container = new ClusteredLightContainer("myco.clustered", [], this.scene);
    if (!container.isSupported) {
      container.dispose();
      this.clusterless = true;
      return null;
    }
    this.cluster = container;
    return container;
  }

  private create(l: Light, clustered: boolean): LightEntry {
    const name = `light:${l.node.name}`;
    if (clustered) {
      // Never in the scene's own list: the container draws it.
      const light =
        l.type === "point" ? new PointLight(name, Vector3.Zero(), this.scene, true) : new SpotLight(name, Vector3.Zero(), new Vector3(0, 0, -1), Math.PI / 6, 2, this.scene, true);
      setShadowEnabled(light, false); // a light with shadows can't cluster
      this.cluster!.addLight(light);
      return { light, type: l.type, clustered };
    }
    // Make room past the cap by giving up a parked light, so the new one stays in materials' first 8.
    if (this.regularCount() >= MAX_KEPT_LIGHTS) this.parked.shift()?.light.dispose();
    const light =
      l.type === "point"
        ? new PointLight(name, Vector3.Zero(), this.scene)
        : l.type === "spot"
          ? new SpotLight(name, Vector3.Zero(), new Vector3(0, 0, -1), Math.PI / 6, 2, this.scene)
          : l.type === "ambient"
            ? new HemisphericLight(name, new Vector3(0, 1, 0), this.scene)
            : new DirectionalLight(name, new Vector3(0, -1, 0), this.scene);
    return { light, type: l.type, clustered };
  }

  /** A parked light of `l`'s type (clustered or not), renamed for it; null if there's none. */
  private unpark(l: Light, clustered: boolean): LightEntry | null {
    const pool = clustered ? this.clusterParked : this.parked;
    const i = pool.findIndex((e) => e.type === l.type);
    if (i < 0) return null;
    const entry = pool.splice(i, 1)[0];
    entry.light.name = `light:${l.node.name}`;
    return entry;
  }

  /** Place `light` at `l`'s node and set its type's shape. */
  private pose(world: World, l: Light, light: BabylonLight, color: Color3): boolean {
    const m = world.worldMatrix(l.node.entity);
    const o = l.node.entity * 16;
    if (light instanceof HemisphericLight) {
      light.groundColor.copyFrom(color); // three's AmbientLight: the same from every direction
      light.specular.set(0, 0, 0);
      return true;
    }
    light.specular.copyFrom(color);
    // Set in place, then handed back so lights that react to a new position or direction (spot) do.
    const shadowLight = light as BabylonLight & IShadowLight;
    shadowLight.position = shadowLight.position.set(m[o + 12], m[o + 13], m[o + 14]);
    if (light instanceof DirectionalLight || light instanceof SpotLight) light.direction = light.direction.set(-m[o + 8], -m[o + 9], -m[o + 10]).normalize(); // -Z, where cameras look too
    if (light instanceof SpotLight) {
      light.range = lightRange(l.range);
      const angle = (Math.min(Math.max(l.spotAngle, 1), 179) * Math.PI) / 180;
      light.angle = angle;
      light.innerAngle = angle * (1 - Math.min(Math.max(l.spotSoftness, 0), 1));
    } else if (light instanceof PointLight) {
      light.range = lightRange(l.range);
    }
    return true;
  }

  /** Shadows inside a box `shadowArea` metres wide around a directional light's node, in front of and behind it. */
  private fitShadowArea(light: DirectionalLight, shadowArea: number): void {
    const half = Math.max(1, shadowArea) / 2;
    light.autoUpdateExtends = false;
    light.orthoLeft = light.orthoBottom = -half;
    light.orthoRight = light.orthoTop = half;
    // three.js puts the shadow camera's near plane behind the node; Babylon wants it in front, so the
    // light moves back along its direction by the same distance instead.
    light.position = light.position.subtractInPlace(light.direction.scaleToRef(half * 2, tmpBack));
    light.shadowMinZ = 0;
    light.shadowMaxZ = half * 4;
  }

  // --- Environment (ADR 0053) -------------------------------------------------------------------

  /**
   * The World's first active Environment sets lighting and sky: its map (loaded and prefiltered on
   * demand), intensities, blur and rotation. Without one, the studio room lights lit materials at 0.4
   * and there's no sky. `far` is the view camera's far plane, which the sky box fits inside.
   */
  syncEnvironment(world: World, far: number): void {
    const env = world._componentsOfType(Environment).find((e) => e.isActiveAndEnabled) ?? null;
    let path = env?.map.replace(/^asset:/, "") ?? "";
    const procedural = environmentKind(path) === "sky";
    if (procedural) path = ""; // drawn and baked by the sky (ADR 0112); its bake comes in through `setSkyEnvironment`
    if (path !== (this.envMap?.path ?? "")) this.loadEnvironmentMap(path);
    const map = procedural ? this.skyEnvironment : this.envMap?.texture && cubemapReady(this.envMap.texture) ? this.envMap.texture : null;
    this.studio ??= new HDRCubeTexture(studioHdrUrl(), this.scene, 128, false, true, false, true);
    const turn = env ? (env.rotation * Math.PI) / 180 : 0;
    // Only a ready texture goes to the scene: prefiltering swaps a cube's GPU texture when it finishes,
    // and materials that bound the first one on WebGPU would keep drawing with it once destroyed.
    const lighting = map ?? (this.studio.isReady() ? this.studio : null);
    if (lighting && "rotationY" in lighting) (lighting as { rotationY: number }).rotationY = turn;
    if (this.scene.environmentTexture !== lighting) this.scene.environmentTexture = lighting;
    this.scene.environmentIntensity = env ? Math.max(0, env.intensity) * (map ? 1 : 0.4) : 0.4;

    if (procedural) {
      this.skybox?.setEnabled(false);
      return;
    }
    // The sky's copy is made once the map is ready (after prefiltering), for the same reason.
    if (map && !this.envMap!.sky) {
      const copy = map.clone();
      if (copy) copy.coordinatesMode = Texture.SKYBOX_MODE;
      this.envMap!.sky = copy;
    }
    const sky = env?.skybox && map && this.skyFog < 1 ? this.envMap!.sky : null;
    if (!sky) {
      this.skybox?.setEnabled(false);
      return;
    }
    if (!this.skybox) {
      this.skybox = CreateBox("myco.skybox", { size: 1 }, this.scene);
      this.skybox.isPickable = false;
      // One box serves every camera: `fitSky` centres and sizes it for each camera just before it draws
      // (not `infiniteDistance`, whose matrix followed whichever camera computed it last, nor a size from
      // the first camera's far plane, which put the sky past the editor's camera preview inset's far
      // plane, drawing it black). Culling is skipped: each camera's cull task ran before its `fitSky`.
      this.skybox.alwaysSelectAsActiveMesh = true;
      this.skyMaterial = new PBRMaterial("myco.skybox", this.scene);
      this.skyMaterial.backFaceCulling = false;
      this.skyMaterial.disableLighting = true;
      this.skyMaterial.sideOrientation = BabylonMaterial.CounterClockWiseSideOrientation;
      this.skybox.material = this.skyMaterial;
    }
    const mat = this.skyMaterial!;
    this.skybox.setEnabled(true);
    this.skybox.scaling.setAll(Math.max(1, far) * 1.1); // until `fitSky` sizes it per camera
    if (mat.reflectionTexture !== sky) mat.reflectionTexture = sky;
    if ("rotationY" in sky) (sky as { rotationY: number }).rotationY = turn;
    mat.microSurface = 1 - Math.min(1, Math.max(0, env!.skyboxBlur));
    mat.environmentIntensity = Math.max(0, env!.skyboxIntensity) * (1 - this.skyFog);
  }

  /** Centre and size the skybox for the camera about to draw: its corners stay inside the far plane. */
  fitSky(camera: TargetCamera): void {
    const box = this.skybox;
    if (!box?.isEnabled()) return;
    const far = camera.maxZ > 0 ? camera.maxZ : 10000; // 0 is Babylon's infinite far plane
    camera.getViewMatrix(); // refreshes globalPosition (cached when the camera hasn't moved)
    box.position.copyFrom(camera.globalPosition);
    box.scaling.setAll(Math.max(1, far) * 1.1);
    box.computeWorldMatrix(true);
  }

  private loadEnvironmentMap(path: string): void {
    this.envMap?.texture?.dispose();
    this.envMap?.sky?.dispose();
    if (!path) {
      this.envMap = null;
      return;
    }
    const entry: EnvMap = { path, texture: null, sky: null };
    this.envMap = entry;
    let url: string;
    try {
      url = Assets.url(path);
    } catch {
      this.warnOnce(`env|${path}`, `environment map "${path}" isn't in the project; using the built-in environment.`);
      return;
    }
    const kind = environmentKind(path);
    if (!kind) {
      this.warnOnce(`env|${path}`, `environment map "${path}" isn't an .hdr, .exr, .png, .jpg, .env, .dds, .cubemap.json or .sky.json file; using the built-in environment.`);
      return;
    }
    const failed = (message?: string) => console.error(`[myco] failed to load environment map "${path}": ${message ?? "unknown error"}`);
    if (kind === "cube" || kind === "faces") {
      try {
        entry.texture = loadCubemap(path, kind, this.scene, failed);
      } catch (err) {
        failed((err as Error).message);
      }
      return;
    }
    entry.texture =
      kind === "hdr"
        ? new HDRCubeTexture(url, this.scene, ENV_SIZE, false, true, false, true, null, failed)
        : kind === "exr"
          ? new EXRCubeTexture(url, this.scene, ENV_SIZE, false, true, false, true, null, failed)
          : new EquiRectangularCubeTexture(url, this.scene, ENV_SIZE, false, true, null, failed);
  }

  /** A procedural sky's baked environment, or null (ADR 0112). */
  setSkyEnvironment(texture: BaseTexture | null): void {
    this.skyEnvironment = texture;
  }

  /** The World's fog over the sky this frame, 0 to 1 (ADR 0071). */
  setSkyFog(amount: number): void {
    this.skyFog = amount;
  }

  /** Tests: whether cascaded shadows are on, and the environment map's state. */
  state(): { cascades: boolean; cascadedLights: number; environment: string; environmentLoaded: boolean; skybox: boolean } {
    return {
      cascades: this.cascading,
      cascadedLights: this.cascadedCount,
      environment: this.envMap?.path ?? "",
      environmentLoaded: !!this.envMap?.texture && cubemapReady(this.envMap.texture),
      skybox: !!this.skybox?.isEnabled(),
    };
  }

  /** Tests and the editor: the shadow map size the tier gives, and whether any light has one. */
  shadowState(): { shadows: boolean; shadowMapSize: number } {
    return { shadows: Graphics.tier.shadows !== "off", shadowMapSize: SHADOW_MAP_SIZE[Graphics.tier.shadows] };
  }

  /**
   * `l` went away: park its Babylon light for the next Light of its type (see `parked`), or dispose of
   * it past the cap. A clustered light always parks in the container: Babylon's `removeLight` hands it
   * back to the scene, which marks every mesh's lights dirty, and the container has no cap.
   */
  release(l: Light): void {
    const e = this.lights.get(l);
    if (!e) return;
    this.lights.delete(l);
    if (e.clustered) {
      e.light.intensity = 0;
      (e.light as PointLight | SpotLight).range = PARKED_RANGE;
      this.clusterParked.push(e);
      return;
    }
    if (this.regularCount() >= MAX_KEPT_LIGHTS) {
      e.light.dispose();
      return;
    }
    e.light.intensity = 0;
    setShadowEnabled(e.light, false);
    this.parked.push(e);
  }

  /**
   * Dispose of what it made: its lights (in use, parked, clustered, the container and the defaults), the
   * environment map and its sky copy, the studio room, and the skybox. Not `skyEnvironment`, which
   * `BabylonSky` owns. Safe to call twice.
   */
  dispose(): void {
    for (const e of [...this.lights.values(), ...this.parked, ...this.clusterParked]) e.light.dispose();
    this.lights.clear();
    this.parked.length = 0;
    this.clusterParked.length = 0;
    this.cluster?.dispose();
    this.cluster = null;
    for (const d of this.defaults) d.dispose();
    this.envMap?.texture?.dispose();
    this.envMap?.sky?.dispose();
    this.envMap = null;
    if (this.scene.environmentTexture === this.studio) this.scene.environmentTexture = null;
    this.studio?.dispose();
    this.studio = null;
    this.skybox?.dispose();
    this.skybox = null;
    this.skyMaterial?.dispose();
    this.skyMaterial = null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
