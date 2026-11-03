// Internal (ADR 0053): cascaded shadow maps through three's CSM addon. three.js types are allowed here and
// never reach the public API (ADR 0010). The addon is imported on demand, only when a World needs cascades.
import { type Camera, type Color, type DirectionalLight, type Material, type Object3D, type Vector3, type WebGLRenderer } from "three";
import type { CSM } from "three/examples/jsm/csm/CSM.js";

export interface CascadeSettings {
  cascades: number;
  /** Metres from the camera the cascades cover. */
  distance: number;
  /** Shadow map size per cascade. */
  mapSize: number;
  color: Color;
  intensity: number;
  /** World direction the light shines (normalized). */
  direction: Vector3;
  castShadows: boolean;
}

/** The cascade lights' shadow camera depth range, metres (CSM's defaults, set explicitly because the bias depends on it). */
const LIGHT_NEAR = 1;
const LIGHT_FAR = 2000;
/**
 * Shadow bias is in the shadow camera's normalized depth, so it scales with its depth range: 2 cm here.
 * A fixed -0.0005 was about a metre over 2000 m, which erased most of small objects' shadows.
 */
const SHADOW_BIAS = -0.02 / (LIGHT_FAR - LIGHT_NEAR);

type CompileHook =(shader: never, renderer: WebGLRenderer) => void;

interface Saved {
  hadOwnHook: boolean;
  hook: CompileHook;
  hadOwnKey: boolean;
  key: () => string;
}

/**
 * The instance each material is set up by. CSM keeps the compiled shader of every material it sets
 * up and, on dispose, deletes its uniforms from it; a material set up by two instances at once (two
 * render backends sharing it) would lose them under the instance still using them. So a material
 * belongs to one live instance at a time.
 */
const owners = new WeakMap<Material, CascadedShadows>();

export class CascadedShadows {
  private readonly saved = new Map<Material, Saved>();
  private readonly materials = new WeakSet<Material>();
  private cameraSig: string;
  private distance: number;
  private readonly cascades: number;
  private readonly mapSize: number;

  private constructor(
    private readonly csm: CSM,
    private readonly camera: Camera,
    s: CascadeSettings,
  ) {
    this.distance = s.distance;
    this.cascades = s.cascades;
    this.mapSize = s.mapSize;
    this.cameraSig = cameraSignature(camera);
  }

  /** Loads the CSM addon lazily. */
  static async create(camera: Camera, parent: Object3D, s: CascadeSettings): Promise<CascadedShadows> {
    const { CSM: CSMClass } = await import("three/examples/jsm/csm/CSM.js");
    const csm = new CSMClass({
      camera,
      parent,
      cascades: s.cascades,
      maxFar: s.distance,
      mode: "practical",
      shadowMapSize: s.mapSize,
      lightNear: LIGHT_NEAR,
      lightFar: LIGHT_FAR,
      shadowBias: SHADOW_BIAS,
      lightDirection: s.direction.clone().normalize(),
      lightIntensity: s.intensity,
    });
    csm.fade = true;
    for (const light of csm.lights) light.shadow.normalBias = 0.02;
    const instance = new CascadedShadows(csm, camera, s);
    instance.update(s);
    return instance;
  }

  /** True if the structure (cascades, map size, camera) differs and a new instance is needed. */
  needsRebuild(camera: Camera, s: CascadeSettings): boolean {
    return camera !== this.camera || s.cascades !== this.cascades || s.mapSize !== this.mapSize;
  }

  /** Per frame: push light settings into the cascade lights, refit when distance or the camera changed, then update. */
  update(s: CascadeSettings): void {
    const csm = this.csm;
    csm.lightDirection.copy(s.direction).normalize();
    for (const light of csm.lights as DirectionalLight[]) {
      light.color.copy(s.color);
      light.intensity = s.intensity;
      light.castShadow = s.castShadows;
    }
    const sig = cameraSignature(this.camera);
    if (s.distance !== this.distance || sig !== this.cameraSig) {
      this.distance = s.distance;
      this.cameraSig = sig;
      csm.maxFar = s.distance;
      csm.updateFrustums();
    }
    csm.update();
  }

  /** Sets a material up for CSM, chaining any existing onBeforeCompile (the material's runs first, then CSM's). */
  setupMaterial(material: Material): void {
    if (this.materials.has(material)) return;
    const owner = owners.get(material);
    if (owner && owner !== this) return; // another live instance owns it (see `owners`)
    owners.set(material, this);
    this.materials.add(material);

    const original = material.onBeforeCompile as unknown as CompileHook;
    const originalKey = material.customProgramCacheKey;
    this.saved.set(material, {
      hadOwnHook: Object.prototype.hasOwnProperty.call(material, "onBeforeCompile"),
      hook: original,
      hadOwnKey: Object.prototype.hasOwnProperty.call(material, "customProgramCacheKey"),
      key: originalKey,
    });

    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile as unknown as CompileHook;
    material.onBeforeCompile = ((shader: never, renderer: WebGLRenderer) => {
      original.call(material, shader, renderer);
      csmHook.call(material, shader, renderer);
    }) as unknown as Material["onBeforeCompile"];
    const cascades = this.cascades;
    material.customProgramCacheKey = function (this: Material) {
      return `${originalKey.call(this)}|csm${cascades}`;
    };
    material.needsUpdate = true;
  }

  /** Undoes the setup on every material, then removes and disposes the cascade lights. */
  dispose(): void {
    // CSM's dispose removes its defines and deletes the hook, so it runs first and our originals are restored after.
    this.csm.dispose();
    for (const [material, saved] of this.saved) {
      if (saved.hadOwnHook) material.onBeforeCompile = saved.hook as unknown as Material["onBeforeCompile"];
      else delete (material as { onBeforeCompile?: unknown }).onBeforeCompile;
      if (saved.hadOwnKey) material.customProgramCacheKey = saved.key;
      else delete (material as { customProgramCacheKey?: unknown }).customProgramCacheKey;
      this.materials.delete(material);
      if (owners.get(material) === this) owners.delete(material);
    }
    this.saved.clear();
    this.csm.remove();
    for (const light of this.csm.lights as DirectionalLight[]) light.dispose();
  }
}

function cameraSignature(camera: Camera): string {
  const c = camera as Camera & { near?: number; far?: number; fov?: number; aspect?: number; zoom?: number };
  return `${c.near}|${c.far}|${c.fov}|${c.aspect}|${c.zoom}`;
}
