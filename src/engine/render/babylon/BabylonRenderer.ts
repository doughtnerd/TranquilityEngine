/**
 * Babylon.js renderer, stage 1 of ADR 0075: the engine (WebGPU, WebGL2 fallback), cameras, meshes
 * (built-in and imported), sprites and material assets. Loaded on demand by `BabylonSurface`, so a
 * page on the three.js backend never downloads Babylon. Internal: game code never sees anything here.
 *
 * The engine node graph is authoritative (ADR 0010): each frame, sync copies world matrices into
 * Babylon objects, which are kept flat (no parenting) with frozen world matrices. The scene is
 * right-handed, +Y up, like the engine (ADR 0014).
 *
 * Lights, shadows and the environment (stage 2) are in `lighting.ts`; the frame graph that draws each
 * frame, with post-processing (stage 3), is in `frameGraph.ts`.
 *
 * Not yet here (later stages): fog, shader graph materials, material property overrides,
 * particles, water, reflection probes, Text and UI, and every editor helper.
 */
import "./register";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { ProjectSettings } from "../../core/settings";
import type { World } from "../../core/World";
import type { Color } from "../../core/math";
import { Assets, sidecarValue } from "../../scene/Assets";
import { splitSpriteRef, type ImportSettings } from "../../scene/importSettings";
import { parseMaterial, materialGraph, type MaterialSettings } from "../../scene/material";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import { isShaderGraphPath } from "../../scene/shaderGraph";
import { Camera, Light, MeshRenderer, PostProcessing, SpriteRenderer } from "../components";
import { Graphics } from "../Graphics";
import { resolvePostEffects, type PostSettings } from "../postEffects";
import type { PostEffects, ToneMappingName } from "../PostProcessStack";
import { BabylonFrame, type CameraView, type ShadowRequest } from "./frameGraph";
import { BabylonLighting } from "./lighting";
import { spriteFrame } from "../spriteFrame";

interface SpriteEntry {
  mesh: Mesh;
  material: PBRMaterial;
  spritePath: string | null;
  texture: Texture | null;
  /** The UVs the quad has, as a key ("" for the whole texture). */
  uvKey: string;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
}

interface MeshEntry {
  meshes: Mesh[];
  sources: readonly ModelMesh[] | null;
  material: BabylonMaterial | null;
}

interface CameraEntry {
  camera: TargetCamera;
  /** Its rectangle on the canvas, fractions from the bottom-left (ADR 0056). */
  rect: { x: number; y: number; width: number; height: number };
}

interface MaterialEntry {
  raw: unknown;
  material: BabylonMaterial | null;
  textures: Texture[];
}

/** The parts of a three.js BufferGeometry the converter reads, without importing three.js. */
interface GeometryLike {
  attributes: Record<string, { array: ArrayLike<number>; itemSize: number } | undefined>;
  index: { array: ArrayLike<number> } | null;
}

/** The parts of a model's own (three.js) material the converter reads (ADR 0044's default lit material). */
interface ModelMaterialLike {
  color?: { r: number; g: number; b: number };
  opacity?: number;
  transparent?: boolean;
  metalness?: number;
  roughness?: number;
  map?: { image?: { src?: string; currentSrc?: string } | null } | null;
}

const tmpMatrix = new Matrix();
const tmpScale = new Vector3();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
/** Unit quad facing +Z, centred on the origin: bottom-left, bottom-right, top-right, top-left. */
const QUAD_POSITIONS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3];

/**
 * A PBR material for engine geometry. The engine's meshes wind their front faces counter-clockwise
 * (three.js and glTF convention); Babylon's default, even in a right-handed scene, is clockwise.
 */
function pbr(name: string, scene: Scene): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.sideOrientation = BabylonMaterial.CounterClockWiseSideOrientation;
  m.maxSimultaneousLights = 8; // Babylon's default is 4
  return m;
}

/** An sRGB engine colour as a linear Babylon colour (PBR colours are linear). */
function linear(c: Color): Color3 {
  return new Color3(c.r, c.g, c.b).toLinearSpace();
}

/** A CSS colour string or 0xRRGGBB number as a Babylon colour (gamma space, for clearing). */
function clearColorOf(v: string | number): Color4 {
  if (typeof v === "number") return Color4.FromColor3(Color3.FromInts((v >> 16) & 255, (v >> 8) & 255, v & 255), 1);
  const hex = /^#([0-9a-f]{6})$/i.test(v) ? v : /^#([0-9a-f]{3})$/i.test(v) ? "#" + [...v.slice(1)].map((c) => c + c).join("") : "#000000";
  return Color4.FromColor3(Color3.FromHexString(hex), 1);
}

/** @internal Stage 1 Babylon.js renderer (ADR 0075). */
export class BabylonRenderer {
  readonly scene: Scene;
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  private readonly meshRenderers = new Map<MeshRenderer, MeshEntry>();
  private readonly cameras = new Map<Camera, CameraEntry>();
  private readonly textures = new Map<string, Texture>();
  private readonly loading = new Map<string, Promise<Texture>>();
  /** The sidecar each texture's sampling came from (ADR 0040), so a changed sidecar is applied again. */
  private readonly textureMeta = new Map<string, object | undefined>();
  private readonly materialAssets = new Map<string, MaterialEntry>();
  /** Vertex data made from each model geometry, shared by every renderer drawing it. */
  private readonly vertexData = new WeakMap<object, VertexData>();
  /** Babylon materials made from models' own materials. */
  private readonly modelMaterials = new WeakMap<object, BabylonMaterial>();
  private readonly warned = new Set<string>();
  private readonly defaultMaterial: PBRMaterial;
  private readonly lighting: BabylonLighting;
  private readonly frame: BabylonFrame;
  private shadows: ShadowRequest[] = [];
  private readonly casters: Mesh[] = [];
  /** What the last frame's first camera ran, for tests and the editor. */
  private lastPost: { composed: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } | null = null;
  private clearColor: Color4;
  private owner: World | null = null;
  private disposed = false;

  /** Creates the engine (WebGPU, else the WebGL2 fallback, loaded only then) and the scene. */
  static async create(canvas: HTMLCanvasElement, settings: ProjectSettings, fill = false): Promise<BabylonRenderer> {
    let engine: AbstractEngine;
    if (await WebGPUEngine.IsSupportedAsync) {
      const gpu = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
      await gpu.initAsync();
      engine = gpu;
    } else {
      const { Engine } = await import("@babylonjs/core/Engines/engine.js");
      engine = new Engine(canvas, true, { adaptToDeviceRatio: false });
    }
    return new BabylonRenderer(engine, settings, fill);
  }

  private constructor(
    readonly engine: AbstractEngine,
    private readonly settings: ProjectSettings,
    /** An editor World: its scene view previews the scene camera's effects (ADR 0051). */
    private readonly fill: boolean,
  ) {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true; // the engine's convention (ADR 0014)
    scene.autoClear = true;
    this.clearColor = clearColorOf(settings.display.backgroundColor);
    scene.clearColor = this.clearColor;
    this.scene = scene;

    this.lighting = new BabylonLighting(scene);
    this.frame = new BabylonFrame(scene);

    this.defaultMaterial = pbr("myco.default", scene);
    this.defaultMaterial.albedoColor = new Color3(1, 1, 1);
    this.defaultMaterial.metallic = 0;
    this.defaultMaterial.roughness = 0.5;
  }

  /** Sets the editor background (editor Worlds) and clear colour. */
  setClearColor(color: string | number): void {
    this.clearColor = clearColorOf(color);
  }

  /** The drawing buffer follows the canvas's CSS size times `pixelRatio`. */
  resize(pixelRatio: number): void {
    this.engine.setHardwareScalingLevel(1 / Math.max(0.01, pixelRatio));
    this.engine.resize();
  }

  // --- Textures ---------------------------------------------------------------------------------

  /** Load textures ahead of time so sprites don't pop in. */
  async preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void> {
    let done = 0;
    await Promise.all(
      paths.map((p) =>
        this.texture(p)
          .catch((err) => console.error(`[myco] failed to load texture "${p}":`, err))
          .finally(() => onProgress?.(++done / paths.length)),
      ),
    );
  }

  private texture(path: string): Promise<Texture> {
    const cached = this.textures.get(path);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(path);
    if (!p) {
      p = new Promise<Texture>((resolve, reject) => {
        const settings: ImportSettings = Assets.importSettings(path);
        let url: string;
        try {
          url = Assets.url(path);
        } catch (err) {
          reject(err);
          return;
        }
        const tex = new Texture(url, this.scene, {
          noMipmap: !settings.mipmaps,
          invertY: true,
          samplingMode: this.samplingMode(settings),
          onLoad: () => {
            this.applySampling(path, tex);
            this.textures.set(path, tex);
            this.loading.delete(path);
            resolve(tex);
          },
          onError: (message) => {
            this.loading.delete(path);
            reject(new Error(message ?? `couldn't load ${path}`));
          },
        });
      });
      this.loading.set(path, p);
    }
    return p;
  }

  private samplingMode(settings: ImportSettings): number {
    const point = settings.filter === "point";
    if (!settings.mipmaps) return point ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE;
    return point ? Texture.NEAREST_NEAREST_MIPNEAREST : Texture.TRILINEAR_SAMPLINGMODE;
  }

  /** Filtering and wrapping from the image's import settings (ADR 0040). */
  private applySampling(path: string, tex: Texture): void {
    this.textureMeta.set(path, sidecarValue(path));
    const settings = Assets.importSettings(path);
    tex.updateSamplingMode(this.samplingMode(settings));
    const wrap = settings.wrap === "repeat" ? Texture.WRAP_ADDRESSMODE : settings.wrap === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
    tex.wrapU = wrap;
    tex.wrapV = wrap;
  }

  // --- Frame ------------------------------------------------------------------------------------

  /** Step 8: mirror the World's cameras, meshes and sprites into Babylon. */
  sync(world: World): void {
    this.claim(world);
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s);
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
    const view = this.viewCameras(world)[0];
    const camera = view ? this.cameras.get(view)!.camera : null;
    this.casters.length = 0;
    for (const [r, e] of this.meshRenderers) if (r.castShadows && r.isActiveAndEnabled) this.casters.push(...e.meshes);
    this.shadows = this.lighting.syncLights(world, camera);
    this.lighting.syncEnvironment(world, view?.far ?? 1000);
  }

  render(world: World): void {
    this.claim(world);
    const cams = this.viewCameras(world);
    const engine = this.engine;
    engine.beginFrame();
    const views: CameraView[] = cams.map((c, i) => {
      // Post-processing (ADR 0051, 0056): each camera's own component, filtered by the tier; the editor's view previews the scene camera's.
      const resolved = resolvePostEffects(this.postSettings(c) ?? (i === 0 && this.fill ? this.scenePostSettings(world) : null), Graphics.tier);
      const background = c.backgroundColor ? clearColorOf(c.backgroundColor.toHex().slice(0, 7)) : this.clearColor;
      const entry = this.cameras.get(c)!;
      return { camera: entry.camera, viewport: entry.rect, clear: i === 0 || c.backgroundColor ? background : null, effects: resolved.composer, toneMapping: resolved.toneMapping, exposure: resolved.exposure };
    });
    this.lastPost = views[0] ? { composed: !!views[0].effects, toneMapping: views[0].toneMapping, effects: views[0].effects } : null;
    if (views.length) this.frame.render(views, this.shadows, this.casters, Graphics.tier.antialias === "msaa" ? 4 : 1);
    if (!views.length || !this.frame.ready) engine.clear(this.clearColor, true, true, true);
    engine.endFrame();
  }

  /** A camera's PostProcessing component, if it has an enabled one. */
  private postSettings(c: Camera): PostSettings | null {
    const p = c.node.getComponent(PostProcessing);
    return p && p.isActiveAndEnabled ? ({ ...p, enabled: true } as unknown as PostSettings) : null;
  }

  /** Editor: the scene view previews the first camera with a PostProcessing component, minus depth of field. */
  private scenePostSettings(world: World): PostSettings | null {
    for (const p of world._componentsOfType(PostProcessing)) {
      if (p.isActiveAndEnabled && p.node.getComponent(Camera)) return { ...(p as unknown as PostSettings), enabled: true, depthOfField: false };
    }
    return null;
  }

  /** Tests and the editor: what the last frame's first camera ran. */
  postState(): { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } {
    return { composed: !!this.lastPost?.composed, loaded: this.frame.ready, toneMapping: this.lastPost?.toneMapping ?? "none", effects: this.lastPost?.effects ?? null };
  }

  release(c: Component): void {
    if (c instanceof SpriteRenderer) {
      const e = this.sprites.get(c);
      if (e) {
        e.mesh.dispose();
        e.material.dispose();
        this.sprites.delete(c);
      }
    } else if (c instanceof MeshRenderer) {
      const e = this.meshRenderers.get(c);
      if (e) {
        for (const m of e.meshes) m.dispose();
        this.meshRenderers.delete(c);
      }
    } else if (c instanceof Light) {
      this.lighting.release(c);
    } else if (c instanceof Camera) {
      this.cameras.get(c)?.camera.dispose();
      this.cameras.delete(c);
    }
  }

  releaseWorld(): void {
    this.owner = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frame.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private claim(world: World): void {
    this.owner ??= world;
    if (this.owner !== world) throw new Error(`This render surface draws World "${this.owner.name}"; World "${world.name}" needs its own (ADR 0032).`);
  }

  /** Enabled cameras that draw the view, in depth order (the editor's scene camera in edit mode, ADR 0026). */
  private viewCameras(world: World): Camera[] {
    return world
      ._componentsOfType(Camera)
      .filter((c) => c.isActiveAndEnabled && this.cameras.has(c) && !world.inEditMode(c.node.entity))
      .sort((a, b) => a.depth - b.depth);
  }

  // --- Cameras ----------------------------------------------------------------------------------

  private syncCamera(world: World, c: Camera): void {
    let entry = this.cameras.get(c);
    if (!entry) {
      const camera = new TargetCamera(`camera:${c.node.name}`, Vector3.Zero(), this.scene, false);
      camera.rotationQuaternion = new Quaternion();
      entry = { camera, rect: { x: 0, y: 0, width: 1, height: 1 } };
      this.cameras.set(c, entry);
    }
    const { camera } = entry;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const x = clamp(c.viewportPosition.x), y = clamp(c.viewportPosition.y);
    const w = Math.max(0.001, Math.min(clamp(c.viewportSize.x), 1 - x)), h = Math.max(0.001, Math.min(clamp(c.viewportSize.y), 1 - y));
    // Each camera renders into its own texture the size of its rectangle (frameGraph.ts), so its own viewport is the whole texture.
    camera.viewport = new Viewport(0, 0, 1, 1);
    entry.rect = { x, y, width: w, height: h };
    const canvas = this.engine.getRenderingCanvas();
    const cw = canvas?.clientWidth || this.settings.display.width, ch = canvas?.clientHeight || this.settings.display.height;
    const aspect = (cw * w) / (ch * h);
    if (c.projection === "orthographic") {
      camera.mode = BabylonCamera.ORTHOGRAPHIC_CAMERA;
      const s = c.orthographicSize;
      camera.orthoLeft = -s * aspect;
      camera.orthoRight = s * aspect;
      camera.orthoTop = s;
      camera.orthoBottom = -s;
    } else {
      camera.mode = BabylonCamera.PERSPECTIVE_CAMERA;
      camera.fov = (c.fieldOfView * Math.PI) / 180; // vertical, like the engine's
      camera.fovMode = BabylonCamera.FOVMODE_VERTICAL_FIXED;
    }
    camera.minZ = c.near;
    camera.maxZ = c.far;
    const e = c.node.entity;
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as ArrayLike<number> as number[], e * 16, tmpMatrix);
    tmpMatrix.decompose(tmpScale, tmpQuat, tmpPos);
    camera.position.copyFrom(tmpPos);
    camera.rotationQuaternion!.copyFrom(tmpQuat);
  }

  // --- Sprites (ADR 0014, 0040) -----------------------------------------------------------------

  private sortOrder(layer: string, order: number): number {
    let index = this.settings.render.sortingLayers.indexOf(layer);
    if (index < 0) {
      this.warnOnce(`layer|${layer}`, `unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`);
      index = 0;
    }
    return index * 10000 + order;
  }

  private syncSprite(world: World, s: SpriteRenderer): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      const mesh = new Mesh(`sprite:${s.node.name}`, this.scene);
      const data = new VertexData();
      data.positions = QUAD_POSITIONS;
      data.normals = QUAD_NORMALS;
      data.uvs = QUAD_UVS;
      data.indices = QUAD_INDICES;
      data.applyToMesh(mesh, true);
      const material = pbr(`sprite:${s.node.name}`, this.scene);
      material.unlit = true;
      material.backFaceCulling = false; // flipped sprites mirror their quad
      material.disableDepthWrite = true;
      material.depthFunction = Constants.ALWAYS; // sprites draw in layer order, not by depth (ADR 0014)
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      material.useAlphaFromAlbedoTexture = true;
      mesh.material = material;
      mesh.alwaysSelectAsActiveMesh = true;
      entry = { mesh, material, spritePath: null, texture: null, uvKey: "", size: null };
      this.sprites.set(s, entry);
    }
    const { mesh, material } = entry;
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = image ? (this.textures.get(image) ?? null) : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      material.albedoTexture = tex;
      if (image && !tex) {
        const requested = s.sprite;
        this.texture(image)
          .then(() => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
      }
    }
    // A sidecar rewritten since the texture loaded (the editor's import settings): sample it anew.
    if (entry.texture && image && this.textureMeta.get(image) !== sidecarValue(image)) this.applySampling(image, entry.texture);

    const ready = !s.sprite || !!entry.texture;
    const visible = s.isActiveAndEnabled && ready;
    mesh.setEnabled(visible);
    if (!visible) return;

    material.albedoColor = linear(s.color);
    material.alpha = s.color.a;
    mesh.alphaIndex = this.sortOrder(s.sortingLayer, s.orderInLayer);

    let w = 1, h = 1, px = 0.5, py = 0.5;
    if (entry.texture) {
      const size = entry.texture.getBaseSize();
      const frame = spriteFrame(Assets.importSettings(image), slice, size.width, size.height, { component: s.pixelsPerUnit, project: this.settings.render.pixelsPerUnit }, s.size);
      [w, h] = frame.size;
      [px, py] = frame.pivot;
      if (frame.missingSlice) this.warnOnce(`slice|${s.sprite}`, `${image} has no slice named "${slice}" (in ${image}.meta.json); drawing the whole image.`);
      this.setSpriteUVs(entry, frame.uv);
    } else if (s.size) {
      w = s.size.x;
      h = s.size.y;
    }
    entry.size = entry.texture || s.size ? [w, h] : null;
    // Scale the unit quad to size with the pivot at the node's origin (flips mirror about it).
    const e = s.node.entity;
    const local = Matrix.Translation(0.5 - px, 0.5 - py, 0).multiply(Matrix.Scaling(s.flipX ? -w : w, s.flipY ? -h : h, 1));
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as number[], e * 16, tmpMatrix);
    mesh.freezeWorldMatrix(local.multiply(tmpMatrix));
  }

  /** Draw a slice's part of the texture, or the whole texture. */
  private setSpriteUVs(entry: SpriteEntry, uv: [number, number, number, number] | null): void {
    const key = uv ? uv.join(",") : "";
    if (key === entry.uvKey) return;
    entry.uvKey = key;
    if (!uv) {
      entry.mesh.updateVerticesData(VertexBuffer.UVKind, QUAD_UVS);
      return;
    }
    const [u0, v0, u1, v1] = uv;
    entry.mesh.updateVerticesData(VertexBuffer.UVKind, [u0, v0, u1, v0, u1, v1, u0, v1]);
  }

  /** @internal The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.sprites.get(s)?.size ?? null;
  }

  // --- Meshes and materials (ADR 0043, 0044) ----------------------------------------------------

  private syncMesh(world: World, r: MeshRenderer): void {
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], sources: null, material: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const material = this.materialAsset(r.material);
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    if (!same || entry.material !== material) {
      for (const m of entry.meshes) m.dispose();
      entry.meshes = (sources ?? []).map((src) => {
        const mesh = new Mesh(`mesh:${r.node.name}:${src.name}`, this.scene);
        this.vertexDataOf(src).applyToMesh(mesh, false);
        mesh.material = material ?? this.modelMaterial(src) ?? this.defaultMaterial;
        return mesh;
      });
      entry.sources = sources;
      entry.material = material;
    }
    const visible = r.isActiveAndEnabled;
    const e = r.node.entity;
    for (const m of entry.meshes) {
      m.setEnabled(visible);
      m.receiveShadows = r.receiveShadows;
      if (visible) m.freezeWorldMatrix(Matrix.FromArray(world.worldMatrix(e) as unknown as number[], e * 16));
    }
  }

  /** A model geometry's vertices as Babylon vertex data (positions, normals, UVs, indices), made once. */
  private vertexDataOf(src: ModelMesh): VertexData {
    const g = src.geometry as unknown as GeometryLike;
    let data = this.vertexData.get(g);
    if (data) return data;
    data = new VertexData();
    const pos = g.attributes.position;
    data.positions = pos ? Array.from(pos.array) : [];
    const normal = g.attributes.normal;
    if (normal) data.normals = Array.from(normal.array);
    const uv = g.attributes.uv;
    if (uv) data.uvs = Array.from(uv.array);
    const count = data.positions.length / 3;
    data.indices = g.index ? Array.from(g.index.array) : Array.from({ length: count }, (_, i) => i);
    if (!normal) {
      const normals: number[] = [];
      VertexData.ComputeNormals(data.positions, data.indices, normals);
      data.normals = normals;
    }
    this.vertexData.set(g, data);
    return data;
  }

  /** A model's own material (its colour, texture, metalness and roughness) as a Babylon PBR material. */
  private modelMaterial(src: ModelMesh): BabylonMaterial | null {
    const own = src.materials[0] as unknown as ModelMaterialLike | undefined;
    if (!own) return null;
    if (src.materials.length > 1) this.warnOnce(`groups|${src.name}`, `${src.name}: meshes with several materials draw with the first on the Babylon backend for now.`);
    let m = this.modelMaterials.get(own);
    if (m) return m;
    const made = pbr(`model:${src.name}`, this.scene);
    if (own.color) made.albedoColor = new Color3(own.color.r, own.color.g, own.color.b); // three.js colours are linear already
    made.metallic = own.metalness ?? 0;
    made.roughness = own.roughness ?? 0.5;
    if (own.transparent && (own.opacity ?? 1) < 1) {
      made.alpha = own.opacity ?? 1;
      made.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
    const src2 = own.map?.image?.currentSrc || own.map?.image?.src;
    if (src2) made.albedoTexture = new Texture(src2, this.scene, { invertY: true });
    m = made;
    this.modelMaterials.set(own, m);
    return m;
  }

  /**
   * The Babylon material for a material asset, or null for none (empty, missing, or not a material:
   * warned once). Rebuilt when the asset's JSON changes (the editor's Material inspector).
   */
  private materialAsset(path: string): BabylonMaterial | null {
    if (!path) return null;
    let raw: unknown;
    try {
      raw = Assets.has(path) ? Assets.json(path) : undefined;
    } catch {
      raw = undefined;
    }
    const cached = this.materialAssets.get(path);
    if (cached && cached.raw === raw) return cached.material;
    cached?.material?.dispose();
    for (const t of cached?.textures ?? []) t.dispose();
    let material: BabylonMaterial | null = null;
    const owned: Texture[] = [];
    const where = path.replace(/^asset:/, "");
    if (raw === undefined) {
      this.warnOnce(`missing|${path}`, `material "${where}" isn't in the project; using the default material.`);
    } else if (isShaderGraphPath(path)) {
      this.warnOnce(`graph|${path}`, `${where}: shader graph materials aren't on the Babylon backend yet (ADR 0075 stage 4); using the default material.`);
    } else {
      try {
        const { settings, problems } = parseMaterial(raw, where);
        for (const p of problems) this.warnOnce(`${path}|${p}`, p);
        if (materialGraph(settings)) {
          this.warnOnce(`graph|${path}`, `${where}: shader graph materials aren't on the Babylon backend yet (ADR 0075 stage 4); using the default material.`);
        } else {
          material = this.builtinMaterial(path, settings, owned);
        }
      } catch (err) {
        this.warnOnce(`bad|${path}`, `${(err as Error).message} Using the default material.`);
      }
    }
    this.materialAssets.set(path, { raw, material, textures: owned });
    return material;
  }

  /** A lit, unlit or physical material asset (ADR 0043, 0052) as a Babylon PBR material. */
  private builtinMaterial(path: string, settings: MaterialSettings, owned: Texture[]): PBRMaterial {
    const m = pbr(`material:${path}`, this.scene);
    m.albedoColor = linear(settings.color);
    m.backFaceCulling = !settings.doubleSided;
    m.twoSidedLighting = settings.doubleSided;
    if (settings.color.a < 1) {
      m.alpha = settings.color.a;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
    if (settings.shader === "unlit") {
      m.unlit = true;
    } else {
      m.metallic = settings.metalness;
      m.roughness = settings.roughness;
      m.emissiveColor = linear(settings.emission);
    }
    if (settings.shader === "physical") {
      m.clearCoat.isEnabled = settings.clearcoat > 0;
      m.clearCoat.intensity = settings.clearcoat;
      m.clearCoat.roughness = settings.clearcoatRoughness;
      m.sheen.isEnabled = settings.sheen > 0;
      m.sheen.intensity = settings.sheen;
      m.sheen.color = linear(settings.sheenColor);
      m.sheen.roughness = settings.sheenRoughness;
      m.subSurface.isRefractionEnabled = settings.transmission > 0;
      m.subSurface.refractionIntensity = settings.transmission;
      m.subSurface.maximumThickness = Math.max(settings.thickness, 0.001);
      m.indexOfRefraction = settings.ior;
      m.iridescence.isEnabled = settings.iridescence > 0;
      m.iridescence.intensity = settings.iridescence;
      m.iridescence.indexOfRefraction = settings.iridescenceIOR;
      m.anisotropy.isEnabled = settings.anisotropy > 0;
      m.anisotropy.intensity = settings.anisotropy;
      m.anisotropy.angle = (settings.anisotropyRotation * Math.PI) / 180;
      m.metallicF0Factor = settings.specularIntensity;
      m.metallicReflectanceColor = linear(settings.specularColor);
    }
    const [tx, ty] = settings.tiling;
    const load = (ref: string, apply: (tex: Texture) => void) => {
      const image = ref.replace(/^asset:/, "");
      if (!image) return;
      this.texture(image)
        .then((shared) => {
          if (this.materialAssets.get(path)?.material !== m) return; // replaced meanwhile
          let tex = shared;
          if (tx !== 1 || ty !== 1) {
            tex = shared.clone(); // its own tiling; shares the image
            tex.uScale = tx;
            tex.vScale = ty;
            tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
            owned.push(tex);
          }
          apply(tex);
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}" for ${path}:`, err));
    };
    load(settings.texture, (tex) => (m.albedoTexture = tex));
    if (settings.shader !== "unlit") load(settings.normalMap, (tex) => (m.bumpTexture = tex));
    return m;
  }

  /** Tests: cascaded shadows and the environment map's state. */
  lightingState(): ReturnType<BabylonLighting["state"]> {
    return this.lighting.state();
  }

  // --- Diagnostics ------------------------------------------------------------------------------

  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number } {
    return { drawCalls: 0, triangles: 0, lines: 0, points: 0, geometries: this.scene.geometries.length, textures: this.scene.textures.length, programs: 0 };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }
}
