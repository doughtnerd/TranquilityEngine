/**
 * The procedural sky on Babylon (ADR 0112): the World's sky asset (an Environment whose map is a
 * `*.sky.json`) drawn live behind every camera, and baked to a prefiltered cubemap for image-based
 * lighting and reflections.
 *
 * - Drawing: a box around each camera (`fit`, as the skybox does) with the sky shader; its local
 *   vertex positions are the view directions.
 * - Baking: the six faces rendered with the same sky function through a full-screen effect (no
 *   cameras, no depth), prefiltered with Babylon's `HDRFiltering`, and handed to the lighting once
 *   its spherical harmonics (diffuse light) are read back. The previous bake keeps lighting the
 *   scene until then, and is disposed a few frames after the swap: a texture swapped under bound
 *   materials would leave WebGPU drawing with a destroyed one (see `lighting.ts`).
 * - When: `SkyBakeScheduler` (on change, throttled; when the time of day moves past a threshold).
 *   Bakes run before the frame graph, like reflection probe captures.
 */
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import "@babylonjs/core/Materials/Textures/baseTexture.polynomial.js";
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../../core/World";
import { Assets } from "../../../scene/Assets";
import { readSkyAsset, worldSkyPath, type LiveSky } from "../../../sky/skyAsset";
import type { SkySettings } from "../../../sky/skyFormat";
import { SkyBakeScheduler, skyLight } from "../../../sky/skyMath";
import { Environment, Fog } from "../../components";
import { SKY_BAKE_SHADER, SKY_SAMPLERS, SKY_SHADER, SKY_UNIFORMS } from "./skyShader";
import { Graphics } from "../../Graphics";
import { packSkyUniforms, SKY_QUALITY, type SkyFrame } from "./skyUniforms";

/** What the sky hands the lighting each frame. */
export interface SkyLightingHooks {
  /** The baked environment (null until the first bake is ready). */
  setSkyEnvironment(texture: BaseTexture | null): void;
  /** Drive the main directional light; null leaves the World's Lights as authored. */
  setSunOverride(sun: { direction: readonly number[]; color: readonly number[]; intensity: number } | null): void;
}

/** Samples per texel when prefiltering a bake: a sky is smooth, so far fewer than a photo's 4096. */
const PREFILTER_QUALITY = 256;
/** Frames to wait for a bake's diffuse lighting before using it anyway. */
const POLYNOMIAL_TIMEOUT = 90;
/** Frames a replaced bake lives on, so no frame still in flight draws with it. */
const RETIRE_FRAMES = 3;

/** Cube face directions (up, right, front) as Babylon's `HDRFiltering` maps a quad to each face. */
const FACES: readonly (readonly [Vector3, Vector3, Vector3])[] = [
  [new Vector3(0, 0, -1), new Vector3(0, -1, 0), new Vector3(1, 0, 0)],
  [new Vector3(0, 0, 1), new Vector3(0, -1, 0), new Vector3(-1, 0, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)],
  [new Vector3(1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1)],
  [new Vector3(-1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, -1)],
];

const language = (engine: AbstractEngine) => (engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL);

/**
 * @internal The sky's box and shader for one scene (asset thumbnails draw skies through the Sky feature
 * too, ADR 0156). `update` packs a frame's uniforms; textures load on demand by asset path.
 */
export class SkyDrawable {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly vectors = SKY_UNIFORMS.map(() => new Vector4());
  private readonly packed = new Float32Array(SKY_UNIFORMS.length * 4);
  private readonly textures = new Map<string, Texture | null>();
  private placeholder: RawTexture;
  private moonTex: BaseTexture | null = null;
  private milkyTex: BaseTexture | null = null;

  constructor(private readonly scene: Scene) {
    this.mesh = CreateBox("myco.sky", { size: 1 }, scene);
    this.mesh.isPickable = false;
    // One box serves every camera (`fit` centres it on each); culling is skipped for the same reason.
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.material = new ShaderMaterial(
      "myco.sky",
      scene,
      { vertex: SKY_SHADER, fragment: SKY_SHADER },
      { attributes: ["position"], uniforms: ["worldViewProjection", ...SKY_UNIFORMS], samplers: [...SKY_SAMPLERS], shaderLanguage: language(scene.getEngine()) },
    );
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    SKY_UNIFORMS.forEach((u, i) => this.material.setVector4(u, this.vectors[i]));
    this.placeholder = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false);
    this.material.setTexture("moonTex", this.placeholder);
    this.material.setTexture("milkyTex", this.placeholder);
    this.mesh.material = this.material;
  }

  /** A loaded image texture for an asset path, or null while loading / when missing. */
  texture(path: string): Texture | null {
    const p = path.replace(/^asset:/, "");
    if (!p) return null;
    let t = this.textures.get(p);
    if (t === undefined) {
      t = null;
      try {
        t = new Texture(Assets.url(p), this.scene, false, true);
        t.wrapU = Texture.WRAP_ADDRESSMODE;
        t.wrapV = Texture.CLAMP_ADDRESSMODE;
      } catch {
        console.warn(`[myco] sky texture "${p}" isn't in the project.`);
      }
      this.textures.set(p, t);
    }
    return t?.isReady() ? t : null;
  }

  /** Pack `frame` (its texture flags filled from the settings) into the material. */
  update(frame: Omit<SkyFrame, "moonTexture" | "milkyWayTexture">): SkyFrame {
    const moon = this.texture(frame.settings.moon.texture);
    const milky = this.texture(frame.settings.stars.milkyWay);
    this.moonTex = moon;
    this.milkyTex = milky;
    this.material.setTexture("moonTex", moon ?? this.placeholder);
    this.material.setTexture("milkyTex", milky ?? this.placeholder);
    const full: SkyFrame = { ...frame, moonTexture: !!moon, milkyWayTexture: !!milky };
    packSkyUniforms(full, this.packed);
    for (let i = 0; i < this.vectors.length; i++) this.vectors[i].set(this.packed[i * 4], this.packed[i * 4 + 1], this.packed[i * 4 + 2], this.packed[i * 4 + 3]);
    return full;
  }

  /** The packed uniforms of the last `update`, for the bake. */
  get uniforms(): Float32Array {
    return this.packed;
  }

  /** Bind the sky's textures (as the last `update` chose them) on a bake effect. */
  bindTextures(set: (name: string, texture: BaseTexture) => void): void {
    set("moonTex", this.moonTex ?? this.placeholder);
    set("milkyTex", this.milkyTex ?? this.placeholder);
  }

  /** Centre and size the box for the camera about to draw: its corners stay inside the far plane. */
  fit(camera: TargetCamera): void {
    if (!this.mesh.isEnabled()) return;
    const far = camera.maxZ > 0 ? camera.maxZ : 10000;
    camera.getViewMatrix();
    this.mesh.position.copyFrom(camera.globalPosition);
    this.mesh.scaling.setAll(Math.max(1, far) * 1.1);
    this.mesh.computeWorldMatrix(true);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
    this.placeholder.dispose();
    for (const t of this.textures.values()) t?.dispose();
    this.textures.clear();
  }
}

interface PendingBake {
  texture: BaseTexture;
  frames: number;
  /** Prefiltering has finished (or was skipped). */
  filtered: boolean;
}

/**
 * @internal Renders a sky's six faces into a new cube texture, then prefilters it. One per scene.
 */
export class SkyBaker {
  private renderer: EffectRenderer | null = null;
  private wrapper: EffectWrapper | null = null;
  private filtering: HDRFiltering | null = null;

  constructor(private readonly scene: Scene) {}

  /** True once the bake shader has compiled (it compiles on first use). */
  ready(): boolean {
    this.ensure();
    return !!this.wrapper?.effect.isReady();
  }

  private ensure(): void {
    if (this.wrapper) return;
    const engine = this.scene.getEngine();
    this.renderer = new EffectRenderer(engine);
    this.wrapper = new EffectWrapper({
      engine,
      name: SKY_BAKE_SHADER,
      vertexShader: SKY_BAKE_SHADER,
      fragmentShader: SKY_BAKE_SHADER,
      useShaderStore: true,
      attributeNames: ["position"],
      uniformNames: [...SKY_UNIFORMS, "up", "right", "front"],
      samplerNames: [...SKY_SAMPLERS],
      shaderLanguage: language(engine),
    });
  }

  /**
   * Draw the six faces with `uniforms` (packed with `baking` on) into a new `size`² cube and start
   * prefiltering it. Returns the bake (its texture swaps to the prefiltered one when `filtered`).
   */
  bake(size: number, uniforms: Float32Array, bindTextures: (set: (name: string, t: BaseTexture) => void) => void): PendingBake | null {
    if (!this.ready()) return null;
    const engine = this.scene.getEngine();
    const caps = engine.getCaps();
    const type = caps.textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : caps.textureFloatRender ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const rt: RenderTargetWrapper = engine.createRenderTargetCubeTexture(size, {
      type,
      format: Constants.TEXTUREFORMAT_RGBA,
      generateMipMaps: true,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      label: "myco.skyBake",
    });
    const effect = this.wrapper!.effect;
    const renderer = this.renderer!;
    renderer.saveStates();
    renderer.setViewport();
    for (let face = 0; face < 6; face++) {
      engine.bindFramebuffer(rt, face, undefined, undefined, true);
      renderer.applyEffectWrapper(this.wrapper!);
      for (let i = 0; i < SKY_UNIFORMS.length; i++) effect.setFloat4(SKY_UNIFORMS[i], uniforms[i * 4], uniforms[i * 4 + 1], uniforms[i * 4 + 2], uniforms[i * 4 + 3]);
      bindTextures((name, t) => effect.setTexture(name, t));
      effect.setVector3("up", FACES[face][0]);
      effect.setVector3("right", FACES[face][1]);
      effect.setVector3("front", FACES[face][2]);
      renderer.draw();
    }
    renderer.restoreStates();
    engine.unBindFramebuffer(rt);
    engine.restoreDefaultFramebuffer();

    const texture = new BaseTexture(this.scene, rt.texture);
    texture.name = "myco.skyBake";
    texture.coordinatesMode = Texture.CUBIC_MODE;
    texture.gammaSpace = false;
    const pending: PendingBake = { texture, frames: 0, filtered: false };
    const features = (engine as unknown as { _features: { allowTexturePrefiltering: boolean } })._features;
    if (!features.allowTexturePrefiltering) {
      pending.filtered = true;
      return pending;
    }
    this.filtering ??= new HDRFiltering(engine, { quality: PREFILTER_QUALITY });
    this.filtering
      .prefilter(texture)
      .catch((err: unknown) => console.warn("[myco] couldn't prefilter the sky bake; reflections use its mipmaps:", err))
      .finally(() => {
        pending.filtered = true;
        rt.dispose(true); // the framebuffers; its texture now belongs to `texture`
      });
    return pending;
  }

  dispose(): void {
    this.wrapper?.dispose();
    this.renderer?.dispose();
    this.wrapper = null;
    this.renderer = null;
  }
}

/** @internal The World's procedural sky on the Babylon backend (ADR 0112). */
export class BabylonSky {
  private drawable: SkyDrawable | null = null;
  private baker: SkyBaker | null = null;
  private readonly scheduler = new SkyBakeScheduler();
  private settings: SkySettings | null = null;
  private time = 0;
  private wantBake = false;
  private rebakes = 0;
  private pending: PendingBake | null = null;
  private current: BaseTexture | null = null;
  private readonly retiring: { texture: BaseTexture; frames: number }[] = [];
  private path = "";
  /** Bakes made, for tests and the editor's stats. */
  bakes = 0;
  /** Milliseconds the last bake's draw calls took on the CPU (GPU time is not measured). */
  lastBakeMs = 0;

  /**
   * `liveSky` finds the World's live sky control (the Sky plugin's `Sky` component, ADR 0135), or null
   * to draw the asset as saved.
   */
  constructor(
    private readonly scene: Scene,
    private readonly lighting: SkyLightingHooks,
    private readonly liveSky: (world: World) => LiveSky | null = () => null,
  ) {}

  /** Whether the World has a sky this frame. */
  get active(): boolean {
    return !!this.path;
  }

  /**
   * Step 8, before the lights sync: read the World's sky (its Environment's asset and the Sky
   * component's time and changes), update the drawn sky, drive the main light, and decide on a bake.
   */
  sync(world: World): void {
    this.path = worldSkyPath(world);
    this.ageTextures();
    if (!this.path) {
      this.drawable?.mesh.setEnabled(false);
      this.lighting.setSunOverride(null);
      this.lighting.setSkyEnvironment(null);
      if (this.current || this.pending) this.dropBakes();
      return;
    }
    const env = world._componentsOfType(Environment).find((e) => e.isActiveAndEnabled)!;
    const sky = this.liveSky(world);
    const settings = sky ? sky.settings : readSkyAsset(this.path);
    const time = sky ? sky.currentTime : settings.sun.timeOfDay;
    this.settings = settings;
    this.time = time;
    const fog = world._componentsOfType(Fog).find((f) => f.isActiveAndEnabled) ?? null;
    const fogFrame = fog ? { color: srgbToLinear(fog.color.r, fog.color.g, fog.color.b), amount: fog.affectsSkybox ? Math.min(1, Math.max(0, fog.skyboxFog)) : 0 } : null;

    this.drawable ??= new SkyDrawable(this.scene);
    this.drawable.mesh.setEnabled(env.skybox);
    const level = Graphics.tier.shaderLevel;
    this.drawn = { settings, time, seconds: world.time.realtimeSinceStartup, rotation: env.rotation, intensity: Math.max(0, env.skyboxIntensity), fog: fogFrame, baking: false, level };
    this.drawable.update(this.drawn);

    if (settings.lighting.driveSunLight) {
      const rotated = env.rotation ? { ...settings, sun: { ...settings.sun, northOffset: settings.sun.northOffset + env.rotation } } : settings;
      this.lighting.setSunOverride(skyLight(rotated, time));
    } else this.lighting.setSunOverride(null);

    if (!settings.lighting.bake) {
      if (this.current || this.pending) this.dropBakes();
      this.lighting.setSkyEnvironment(null);
      return;
    }
    const requests = sky?._rebakes ?? 0;
    const size = Math.min(settings.lighting.bakeSize, SKY_QUALITY[level].maxBakeSize);
    if (requests !== this.rebakes || size !== this.bakeSize) {
      this.rebakes = requests;
      this.bakeSize = size; // a new tier caps the bake differently: rebake at the new size
      this.scheduler.invalidate();
    }
    this.envRotation = env.rotation;
    this.fogFrame = fogFrame;
    if (this.scheduler.update(performance.now() / 1000, settings, time)) this.wantBake = true;
    this.promote();
    this.lighting.setSkyEnvironment(this.current);
  }

  private envRotation = 0;
  /** The bake's face size: the asset's, capped by the quality tier. */
  private bakeSize = 128;
  private fogFrame: SkyFrame["fog"] = null;
  /** This frame's drawn sky, put back after a bake packs its own uniforms. */
  private drawn: Omit<SkyFrame, "moonTexture" | "milkyWayTexture"> | null = null;

  /** Render a requested bake. Call before the frame graph runs. */
  bake(): void {
    if (!this.wantBake || this.pending || !this.settings || !this.drawable) return;
    this.baker ??= new SkyBaker(this.scene);
    const start = performance.now();
    this.drawable.update({ settings: this.settings, time: this.time, seconds: 0, rotation: this.envRotation, intensity: 1, fog: this.fogFrame, baking: true });
    const uniforms = this.drawable.uniforms.slice();
    // Put the drawn sky's uniforms back (the bake's differ: no discs, mirrored Z).
    if (this.drawn) this.drawable.update(this.drawn);
    const pending = this.baker.bake(this.bakeSize, uniforms, (set) => this.drawable!.bindTextures(set));
    if (!pending) return; // the bake shader is still compiling
    this.lastBakeMs = performance.now() - start;
    this.pending = pending;
    this.wantBake = false;
    this.bakes++;
  }

  /** Make a finished bake the lighting once its diffuse light (spherical harmonics) is ready. */
  private promote(): void {
    const p = this.pending;
    if (!p || !p.filtered) return;
    p.frames++;
    if (!p.texture.sphericalPolynomial && p.frames < POLYNOMIAL_TIMEOUT) return;
    if (this.current) this.retiring.push({ texture: this.current, frames: RETIRE_FRAMES });
    this.current = p.texture;
    this.pending = null;
  }

  private ageTextures(): void {
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      if (--this.retiring[i].frames > 0) continue;
      this.retiring[i].texture.dispose();
      this.retiring.splice(i, 1);
    }
  }

  private dropBakes(): void {
    if (this.current) this.retiring.push({ texture: this.current, frames: RETIRE_FRAMES });
    if (this.pending) {
      const p = this.pending;
      // Dispose once its prefiltering has finished with it.
      if (p.filtered) this.retiring.push({ texture: p.texture, frames: RETIRE_FRAMES });
      else this.retiring.push({ texture: p.texture, frames: POLYNOMIAL_TIMEOUT });
    }
    this.current = null;
    this.pending = null;
    this.scheduler.invalidate();
  }

  /** Centre the sky on the camera about to draw. */
  fit(camera: TargetCamera): void {
    if (this.path) this.drawable?.fit(camera);
  }

  /** Tests and the editor: the sky's state. */
  state(): { active: boolean; drawn: boolean; bakes: number; baked: boolean; time: number; lastBakeMs: number } {
    return { active: this.active, drawn: !!this.drawable?.mesh.isEnabled(), bakes: this.bakes, baked: !!this.current, time: this.time, lastBakeMs: this.lastBakeMs };
  }

  dispose(): void {
    this.drawable?.dispose();
    this.baker?.dispose();
    this.current?.dispose();
    this.pending?.texture.dispose();
    for (const r of this.retiring) r.texture.dispose();
    this.retiring.length = 0;
  }
}

/** sRGB 0–1 to linear. */
function srgbToLinear(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f(r), f(g), f(b)];
}
