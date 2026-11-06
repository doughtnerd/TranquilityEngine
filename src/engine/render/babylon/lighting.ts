/**
 * Stages 2–3 of ADR 0075 on Babylon.js: Light components (ADR 0043), which lights cast shadows and
 * how (ADR 0050, 0053; the frame graph draws the shadow maps, `frameGraph.ts`), and the Environment
 * component's lighting and sky (ADR 0053), with the default studio room when a World has no map.
 * Mirrors what the three.js backend does in `syncLights`, `syncCascades` and `syncEnvironment`.
 */
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import type { Light as BabylonLight } from "@babylonjs/core/Lights/light.js";
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
import type { Scene } from "@babylonjs/core/scene.js";
import { SHADOW_MAP_SIZE } from "../../core/graphics";
import type { World } from "../../core/World";
import { Assets } from "../../scene/Assets";
import { Environment, Light } from "../components";
import { Graphics } from "../Graphics";
import type { ShadowRequest } from "./frameGraph";
import { studioHdrUrl } from "./studioEnvironment";

interface LightEntry {
  light: BabylonLight;
  type: string;
}

interface EnvMap {
  path: string;
  texture: BaseTexture | null;
  /** A copy drawn as the sky (skybox coordinates). */
  sky: BaseTexture | null;
}

/** How an environment image is decoded, by file extension; null for unsupported files. */
function environmentKind(path: string): "hdr" | "exr" | "ldr" | null {
  const p = path.split(/[?#]/)[0]!.toLowerCase();
  if (p.endsWith(".hdr")) return "hdr";
  if (p.endsWith(".exr")) return "exr";
  if (/\.(png|jpe?g)$/.test(p)) return "ldr";
  return null;
}

/** The size of the prefiltered cube made from an environment map (per face). */
const ENV_SIZE = 256;

/** @internal Lights, shadows and environment on the Babylon backend (ADR 0075 stages 2–3). */
export class BabylonLighting {
  private readonly lights = new Map<Light, LightEntry>();
  private readonly defaults: BabylonLight[];
  private envMap: EnvMap | null = null;
  private studio: HDRCubeTexture | null = null;
  private skybox: Mesh | null = null;
  private skyMaterial: PBRMaterial | null = null;
  private readonly warned = new Set<string>();
  /** Whether the last sync asked for cascaded shadows, for tests. */
  private cascading = false;
  /** How much the World's fog covers the sky (ADR 0071): the skybox dims by it and hides at 1. */
  private skyFog = 0;

  constructor(private readonly scene: Scene) {
    // The light a World without Lights gets: a soft ambient light and a sun from above and in front.
    const ambient = new HemisphericLight("myco.default.ambient", new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.35;
    ambient.groundColor = new Color3(1, 1, 1);
    ambient.specular = Color3.Black();
    const sun = new DirectionalLight("myco.default.sun", new Vector3(-4, -10, -6).normalize(), scene);
    sun.intensity = 1;
    this.defaults = [ambient, sun];
  }

  /**
   * Step 8: mirror the World's Lights, and return the shadow maps this frame needs: one per enabled
   * shadow-casting light, cascaded for the first directional one on tiers with cascades when a camera
   * draws the view (cascades follow it).
   */
  syncLights(world: World, camera: BabylonCamera | null): ShadowRequest[] {
    const tier = Graphics.tier;
    const mapSize = SHADOW_MAP_SIZE[tier.shadows];
    let cascadeLight: Light | null = null;
    if (camera && mapSize && tier.shadowCascades > 1) {
      cascadeLight = world._componentsOfType(Light).find((l) => l.type === "directional" && l.castShadows && l.isActiveAndEnabled) ?? null;
    }
    let any = false;
    this.cascading = false;
    const shadows: ShadowRequest[] = [];
    for (const l of world._componentsOfType(Light)) {
      if (!this.syncLight(world, l)) continue;
      any = true;
      if (!l.castShadows || l.type === "ambient" || !mapSize) continue;
      const light = this.lights.get(l)!.light as BabylonLight & IShadowLight;
      const cascaded = l === cascadeLight;
      if (cascaded) this.cascading = true;
      else if (light instanceof DirectionalLight) this.fitShadowArea(light, l.shadowArea);
      shadows.push({ light, cascaded, mapSize, numCascades: tier.shadowCascades, shadowMaxZ: tier.shadowDistance });
    }
    // A World with no Light of its own gets the default ones, so meshes never draw black.
    for (const d of this.defaults) d.setEnabled(!any);
    return shadows;
  }

  /** Mirror one Light; true if it lights the scene. */
  private syncLight(world: World, l: Light): boolean {
    let entry = this.lights.get(l);
    if (!entry || entry.type !== l.type) {
      if (entry) this.release(l);
      const name = `light:${l.node.name}`;
      const light =
        l.type === "point"
          ? new PointLight(name, Vector3.Zero(), this.scene)
          : l.type === "spot"
            ? new SpotLight(name, Vector3.Zero(), new Vector3(0, 0, -1), Math.PI / 6, 2, this.scene)
            : l.type === "ambient"
              ? new HemisphericLight(name, new Vector3(0, 1, 0), this.scene)
              : new DirectionalLight(name, new Vector3(0, -1, 0), this.scene);
      entry = { light, type: l.type };
      this.lights.set(l, entry);
    }
    const { light } = entry;
    const on = l.isActiveAndEnabled;
    light.setEnabled(on);
    if (!on) return false;
    const color = new Color3(l.color.r, l.color.g, l.color.b).toLinearSpace();
    light.diffuse = color;
    light.specular = color;
    light.intensity = Math.max(0, l.intensity);
    const m = world.worldMatrix(l.node.entity);
    const o = l.node.entity * 16;
    const position = new Vector3(m[o + 12], m[o + 13], m[o + 14]);
    const forward = new Vector3(-m[o + 8], -m[o + 9], -m[o + 10]).normalize(); // -Z, where cameras look too
    if (light instanceof HemisphericLight) {
      light.groundColor = color; // three's AmbientLight: the same from every direction
      light.specular = Color3.Black();
    } else if (light instanceof DirectionalLight) {
      light.position = position;
      light.direction = forward;
    } else if (light instanceof SpotLight) {
      light.position = position;
      light.direction = forward;
      light.range = Math.max(0.001, l.range);
      const angle = (Math.min(Math.max(l.spotAngle, 1), 179) * Math.PI) / 180;
      light.angle = angle;
      light.innerAngle = angle * (1 - Math.min(Math.max(l.spotSoftness, 0), 1));
    } else if (light instanceof PointLight) {
      light.position = position;
      light.range = Math.max(0.001, l.range);
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
    light.position = light.position.subtract(light.direction.scale(half * 2));
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
    const path = env?.map.replace(/^asset:/, "") ?? "";
    if (path !== (this.envMap?.path ?? "")) this.loadEnvironmentMap(path);
    const map = this.envMap?.texture?.isReady() ? this.envMap.texture : null;
    this.studio ??= new HDRCubeTexture(studioHdrUrl(), this.scene, 128, false, true, false, true);
    const turn = env ? (env.rotation * Math.PI) / 180 : 0;
    // Only a ready texture goes to the scene: prefiltering swaps a cube's GPU texture when it finishes,
    // and materials that bound the first one on WebGPU would keep drawing with it once destroyed.
    const lighting = map ?? (this.studio.isReady() ? this.studio : null);
    if (lighting && "rotationY" in lighting) (lighting as { rotationY: number }).rotationY = turn;
    if (this.scene.environmentTexture !== lighting) this.scene.environmentTexture = lighting;
    this.scene.environmentIntensity = env ? Math.max(0, env.intensity) * (map ? 1 : 0.4) : 0.4;

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
      this.skybox.infiniteDistance = true;
      this.skybox.isPickable = false;
      this.skyMaterial = new PBRMaterial("myco.skybox", this.scene);
      this.skyMaterial.backFaceCulling = false;
      this.skyMaterial.disableLighting = true;
      this.skyMaterial.sideOrientation = BabylonMaterial.CounterClockWiseSideOrientation;
      this.skybox.material = this.skyMaterial;
    }
    const mat = this.skyMaterial!;
    this.skybox.setEnabled(true);
    this.skybox.scaling.setAll(Math.max(1, far) * 1.1); // the box's corners stay inside the far plane
    if (mat.reflectionTexture !== sky) mat.reflectionTexture = sky;
    if ("rotationY" in sky) (sky as { rotationY: number }).rotationY = turn;
    mat.microSurface = 1 - Math.min(1, Math.max(0, env!.skyboxBlur));
    mat.environmentIntensity = Math.max(0, env!.skyboxIntensity) * (1 - this.skyFog);
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
      this.warnOnce(`env|${path}`, `environment map "${path}" isn't an .hdr, .exr, .png or .jpg file; using the built-in environment.`);
      return;
    }
    const failed = (message?: string) => console.error(`[myco] failed to load environment map "${path}": ${message ?? "unknown error"}`);
    entry.texture =
      kind === "hdr"
        ? new HDRCubeTexture(url, this.scene, ENV_SIZE, false, true, false, true, null, failed)
        : kind === "exr"
          ? new EXRCubeTexture(url, this.scene, ENV_SIZE, false, true, false, true, null, failed)
          : new EquiRectangularCubeTexture(url, this.scene, ENV_SIZE, false, true, null, failed);
  }

  /** The World's fog over the sky this frame, 0 to 1 (ADR 0071). */
  setSkyFog(amount: number): void {
    this.skyFog = amount;
  }

  /** Tests: whether cascaded shadows are on, and the environment map's state. */
  state(): { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean } {
    return {
      cascades: this.cascading,
      environment: this.envMap?.path ?? "",
      environmentLoaded: !!this.envMap?.texture?.isReady(),
      skybox: !!this.skybox?.isEnabled(),
    };
  }

  /** Tests and the editor: the shadow map size the tier gives, and whether any light has one. */
  shadowState(): { shadows: boolean; shadowMapSize: number } {
    return { shadows: Graphics.tier.shadows !== "off", shadowMapSize: SHADOW_MAP_SIZE[Graphics.tier.shadows] };
  }

  release(l: Light): void {
    const e = this.lights.get(l);
    if (!e) return;
    e.light.dispose();
    this.lights.delete(l);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
