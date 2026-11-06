/**
 * three.js render backend (ADR 0004, 0010). Internal: game code never sees anything here.
 *
 * The engine node graph is authoritative. Each frame, render sync copies world matrices into
 * three.js objects kept flat under one root, with `matrixAutoUpdate = false`.
 */
import type { WarmMesh } from "../scene/warmUp";
import {
  AdditiveBlending,
  AmbientLight,
  AxesHelper,
  Box3,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  ClampToEdgeWrapping,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Float32BufferAttribute,
  GridHelper,
  Color as ThreeColor,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapNearestFilter,
  NoColorSpace,
  NoToneMapping,
  NormalBlending,
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  type ToneMapping as ThreeToneMapping,
  Object3D,
  PCFShadowMap,
  PMREMGenerator,
  PointLight,
  Quaternion,
  OrthographicCamera,
  Points,
  PointsMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  SpotLight,
  Sprite as ThreeSprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2 as ThreeVector2,
  Vector3 as ThreeVector3,
  WebGLRenderer,
  type Camera as ThreeCamera,
} from "three";
import type { Component } from "../core/Component";
import type { ProjectSettings } from "../core/settings";
import { SHADOW_MAP_SIZE } from "../core/graphics";
import { Graphics } from "./Graphics";
import { resolvePostEffects, type PostSettings, type ResolvedPost } from "./postEffects";
import type { PostEffects, PostProcessStack, PostViewport, ToneMappingName } from "./PostProcessStack";
import type { CascadedShadows, CascadeSettings } from "./cascadedShadows";
import { loadEquirectangular, prefilter } from "./environmentMap";
import { applyFog } from "./fog";
import type { World, WorldKind } from "../core/World";
import { Assets, sidecarValue } from "../scene/Assets";
import { splitSpriteRef, type ImportSettings } from "../scene/importSettings";
import type { GameObject } from "../scene/GameObject";
import { Camera, Environment, Fog, Light, MeshRenderer, ParticleSystem, PostProcessing, ReflectionProbe, SpriteRenderer, Text, type Anchor } from "./components";
import type { ParticlePreview, ParticleRenderer } from "./particles/ParticleRenderer";
import type { ParticleRenderer as ParticleRendererSettings } from "../scene/particles";
import { PROBE_RESOLUTION, ProbeCapture, pickProbe, type ProbeBox } from "./reflectionProbes";
import { meshesIfLoaded, type ModelMesh } from "../scene/models";
import { colorHex, materialGraphOfJson, parseMaterial } from "../scene/material";
import { isShaderGraphPath, parseShaderGraph, type GraphValue } from "../scene/shaderGraph";
import { Color, Vector2, Vector3 } from "../core/math";
import type { MaterialPropertyValue } from "./components";
import { compileShaderGraph } from "./shaderGraph/compile";
import { createGraphMaterial, createSharedGraphUniforms, type GraphMaterial } from "./shaderGraph/threeMaterial";
import type { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { frustumSegments } from "./cameraGizmo";
import { localPoseFromWorld, type LocalPose } from "./gizmoMath";
import { rayQuadDistance } from "./picking";
import { spriteFrame } from "./spriteFrame";
import { WaterRenderer } from "./water/WaterRenderer";
import { WaterSurface } from "./water/WaterSurface";
import { UICanvas, isUIComponent } from "../ui/components";
import type { UIRuntime } from "../ui/UIRuntime";
import type { EditorColors, EditorOverlay, GizmoHandlers, GizmoOptions, RenderSurface, ScreenRect } from "./RenderSurface";

export type { EditorColors, EditorOverlay, GizmoHandlers, GizmoOptions, ScreenRect } from "./RenderSurface";

interface SpriteEntry {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  spritePath: string | null;
  /** Its own quad with a slice's UVs (ADR 0040), or null while it draws the whole texture with the shared quad. */
  geometry: PlaneGeometry | null;
  /** The UVs `geometry` has, as a key. */
  uvKey: string;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
}

interface MeshEntry {
  /** One three.js mesh per model mesh drawn. */
  objects: Mesh[];
  /** The model meshes and material they were made from. */
  sources: readonly ModelMesh[] | null;
  material: Material | null;
}

interface LightEntry {
  light: DirectionalLight | PointLight | SpotLight | AmbientLight;
  type: string;
  /** Where directional and spot lights point (one metre down the node's -Z). */
  target: Object3D | null;
}

/** A material asset made into a three.js material, rebuilt when its JSON changes. */
interface MaterialEntry {
  raw: unknown;
  /** A shader graph material's graph JSON (ADR 0047), so editing the graph rebuilds it. */
  graphRaw?: unknown;
  material: Material | null;
  /** Textures made for this material alone (tiled or linear copies), freed with it. */
  textures: Texture[];
  /** A shader graph material and its shadow materials. */
  graph?: GraphMaterial;
  /** Sub-graph files the graph uses, with the JSON they had (ADR 0048): a change rebuilds it. */
  deps?: [string, unknown][];
  /** The shader level a graph with Quality Branch nodes was compiled for (ADR 0050): another tier's level rebuilds it. */
  level?: string;
}

/** A renderer's own copy of its material, holding its property overrides (ADR 0049). */
interface RendererMaterial {
  base: Material;
  material: Material;
  graph?: GraphMaterial;
  version: number;
  /** The reflection probe's map it holds (ADR 0054); undefined: apply again. */
  probe?: Texture | null;
}

/** A camera's viewport (ADR 0056) in CSS pixels from the canvas's bottom-left. */
function cameraViewport(c: Camera, width: number, height: number): PostViewport {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = clamp(c.viewportPosition.x), y = clamp(c.viewportPosition.y);
  const w = Math.min(clamp(c.viewportSize.x), 1 - x), h = Math.min(clamp(c.viewportSize.y), 1 - y);
  return { x: x * width, y: y * height, width: Math.max(1, w * width), height: Math.max(1, h * height) };
}

const BUILTIN_PROPERTIES = new Set([
  "color", "emission", "metalness", "roughness", "texture",
  "clearcoat", "clearcoatRoughness", "sheen", "sheenColor", "sheenRoughness", "transmission", "thickness", "ior",
  "iridescence", "iridescenceIOR", "anisotropy", "anisotropyRotation", "specularIntensity", "specularColor",
]);

/** A script's property value as material-file data: colours as `#rrggbbaa`, vectors as number lists. */
function toGraphValue(v: MaterialPropertyValue): GraphValue {
  if (v instanceof Color) return colorHex(v);
  if (v instanceof Vector2) return [v.x, v.y];
  if (v instanceof Vector3) return [v.x, v.y, v.z];
  return Array.isArray(v) ? [...v] : (v as number | string);
}

interface CameraEntry {
  camera: OrthographicCamera | PerspectiveCamera;
  projection: string;
}

interface TextEntry {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  signature: string;
  width: number;
  height: number;
}

const tmpWorld = new Matrix4();
const tmpScale = new Matrix4();
const tmpPivot = new Matrix4();
const raycaster = new Raycaster();
const ndc = new ThreeVector2();

const DEFAULT_EDITOR_COLORS: EditorColors = { background: 0x24272d, grid: 0x3a3f47, gridCenter: 0x5a606b, outline: 0x4c8dff, cameraGizmo: 0xc9ccd1 };
/** Editor camera gizmos: icon size (fraction of view height) and click radius (CSS px). */
const CAMERA_ICON_SIZE = 0.065;
const CAMERA_ICON_PICK_RADIUS = 16;
const tmpPoint = new ThreeVector3();
/** Draw outlines above every sprite (sprites sort by layer * 10000 + order). */
const OUTLINE_ORDER = 1e9;
/** Meshes are depth-tested and drawn before sprites, so in picking they come below every sprite. */
const MESH_ORDER = -1e12;
/** Editor light icons: size (fraction of view height), as camera icons. */
const LIGHT_ICON_SIZE = 0.055;
const tmpBox = new Box3();
const tmpDir = new ThreeVector3();
const tmpCorner = new ThreeVector3();
/** The renderer's tone mapping for each PostProcessing `toneMapping` (ADR 0051). */
const TONE_MAPPING: Record<ToneMappingName, ThreeToneMapping> = { none: NoToneMapping, aces: ACESFilmicToneMapping, agx: AgXToneMapping, neutral: NeutralToneMapping };

/** Which editor helpers a composed (post-processed) camera draws after its effects; see `renderComposed`. */
type ComposedHelpers = "editor" | "overlays" | "none";

export class RenderBackend implements RenderSurface {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly uiScene = new Scene();
  private readonly uiCamera: OrthographicCamera;
  private readonly quad = new PlaneGeometry(1, 1);
  private readonly loader = new TextureLoader();
  private readonly textures = new Map<string, Texture>();
  private readonly loading = new Map<string, Promise<Texture>>();
  /** The sidecar each loaded texture's sampling came from (ADR 0040), so a changed sidecar is applied again. */
  private readonly textureMeta = new Map<string, object | undefined>();
  private readonly warnedSlices = new Set<string>();
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  private readonly cameras = new Map<Camera, CameraEntry>();
  private readonly texts = new Map<Text, TextEntry>();
  private readonly meshRenderers = new Map<MeshRenderer, MeshEntry>();
  private readonly lights = new Map<Light, LightEntry>();
  private readonly materialAssets = new Map<string, MaterialEntry>();
  private readonly warnedMaterials = new Set<string>();
  /** Time and drawing-buffer size, shared by every shader graph material (ADR 0047). */
  private readonly graphUniforms = createSharedGraphUniforms();
  /** Shadow materials for graph materials that move their vertices. */
  private readonly graphShadows = new WeakMap<Material, GraphMaterial>();
  /** This backend's copies of materials shared by every World (a model's own), dropped when the shared one is disposed. */
  private readonly localMaterials = new Map<Material, Material>();

  /** This backend's copy of a material shared between Worlds. */
  private localMaterial(shared: Material): Material {
    let local = this.localMaterials.get(shared);
    if (!local) {
      local = shared.clone();
      this.localMaterials.set(shared, local);
      const copy = local;
      shared.addEventListener("dispose", () => {
        if (this.localMaterials.get(shared) !== copy) return;
        this.localMaterials.delete(shared);
        copy.dispose();
      });
    }
    return local;
  }

  /** Renderers with property overrides, and their own materials. */
  private readonly rendererMaterials = new Map<MeshRenderer, RendererMaterial>();
  /** Linear (non-sRGB) copies of textures, for normal maps sampled in shader graphs. */
  private readonly linearTextures = new Map<string, Texture>();
  /** Lit meshes without a material of their own (ADR 0043). */
  private readonly defaultMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  /** The light a World without Lights gets: a soft ambient light and a sun from above and in front. */
  private readonly defaultLights: Object3D[];
  private readonly resizeObserver: ResizeObserver;
  private readonly warnedLayers = new Set<string>();
  private readonly clearColor: ThreeColor;
  /**
   * The one World this backend draws (ADR 0032): its three.js scene holds that World's objects
   * only, so a second World needs its own surface. Claimed by the first `sync` or `render`.
   */
  private owner: World | null = null;
  /** The `Graphics._version` last applied (ADR 0050), and what was applied. */
  private appliedQuality = -1;
  private quality = { tier: "", pixelRatio: 1, shadows: false, shadowMapSize: 0, anisotropy: 1 };
  /** Whether the context was created with MSAA (fixed for its lifetime). */
  private readonly msaa: boolean;
  private warnedAntialias = false;

  constructor(private readonly container: HTMLElement, private readonly settings: ProjectSettings, kind: WorldKind = "runtime") {
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    // Dev builds: every live three.js surface, for measuring it against the Babylon backend from the console.
    if (import.meta.env?.DEV) ((globalThis as { __mycoThreeSurfaces?: unknown[] }).__mycoThreeSurfaces ??= []).push(this);

    // MSAA is fixed at context creation, so the tier's antialias applies from the next start (ADR 0050).
    this.msaa = Graphics.tier.antialias === "msaa";
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: this.msaa });
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false; // counted over a whole frame (every camera and the UI), reset in `render`
    // Shadows are on unless the tier says "off" (applyQuality): then materials are compiled with
    // shadows and a light that starts casting them later shows them at once.
    this.renderer.shadowMap.type = PCFShadowMap;
    const sun = new DirectionalLight(0xffffff, 1);
    sun.position.set(4, 10, 6);
    this.defaultLights = [new AmbientLight(0xffffff, 0.35), sun];
    for (const l of this.defaultLights) {
      l.visible = false;
      this.scene.add(l);
    }
    this.clearColor = new ThreeColor(settings.display.backgroundColor);

    const { width, height } = settings.display;
    this.uiCamera = new OrthographicCamera(0, width, height, 0, -10, 10);

    // Editor Worlds fill their viewport panel and get a grid (1 m cells) and XYZ axes, so an
    // empty scene has a frame of reference.
    this.fill = kind === "editor";
    if (kind === "editor") {
      this.grid = makeGrid(1, this.editorColors);
      this.axes = new AxesHelper(1.5);
      this.scene.add(this.grid, this.axes);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.applyQuality();
  }

  /** @internal Tests and the editor: the quality settings this backend last applied. */
  qualityState(): { tier: string; pixelRatio: number; shadows: boolean; shadowMapSize: number; anisotropy: number; msaa: boolean } {
    return { ...this.quality, msaa: this.msaa };
  }

  /** Apply the active graphics quality tier (ADR 0050); runs again whenever `Graphics._version` changes. */
  private applyQuality(): void {
    const tier = Graphics.tier;
    const r = this.renderer;
    this.appliedQuality = Graphics._version;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * tier.renderScale);
    this.resize(); // setPixelRatio alone leaves the drawing buffer at the old size
    const shadows = tier.shadows !== "off";
    if (r.shadowMap.enabled !== shadows) {
      r.shadowMap.enabled = shadows;
      this.recompileMaterials(); // shadow code is compiled into the shaders
    }
    const anisotropy = Math.max(1, Math.min(tier.anisotropy, r.capabilities.getMaxAnisotropy() || 1));
    const textures = [...this.textures.values(), ...this.linearTextures.values()];
    for (const e of this.materialAssets.values()) textures.push(...e.textures);
    for (const t of textures) this.setAnisotropy(t, anisotropy);
    for (const e of this.lights.values()) this.applyShadowSize(e.light);
    this.quality = { tier: tier.name, pixelRatio: r.getPixelRatio(), shadows, shadowMapSize: SHADOW_MAP_SIZE[tier.shadows], anisotropy };
    if ((tier.antialias === "msaa") !== this.msaa && !this.warnedAntialias) {
      this.warnedAntialias = true;
      console.info("[myco] Anti-aliasing changes take effect the next time the game starts.");
    }
  }

  /** Flag every material in the scene (and the default one) to recompile. */
  private recompileMaterials(): void {
    this.defaultMaterial.needsUpdate = true;
    this.scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
      else if (m) m.needsUpdate = true;
    });
  }

  private setAnisotropy(t: Texture, a: number): void {
    if (t.anisotropy === a) return;
    t.anisotropy = a;
    t.needsUpdate = true;
  }

  /** Give a light's shadow map the active tier's size, dropping the old map if the size changed. */
  private applyShadowSize(light: LightEntry["light"]): void {
    if (light instanceof AmbientLight) return;
    const size = SHADOW_MAP_SIZE[Graphics.tier.shadows];
    if (!size || light.shadow.mapSize.x === size) return;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }

  private readonly fill: boolean;
  private grid: GridHelper | null = null;
  private axes: AxesHelper | null = null;
  private gridPlane: "xz" | "xy" = "xz";
  private gridCell = 1;
  private editorColors: EditorColors = { ...DEFAULT_EDITOR_COLORS };

  /** @internal Editor: recolour the overlays and (editor Worlds) the background (the editor's theme). */
  setEditorColors(colors: EditorColors): void {
    this.editorColors = { ...colors };
    if (this.fill) this.clearColor.setHex(colors.background);
    this.outlineMaterial?.color.setHex(colors.outline);
    if (this.grid) {
      // GridHelper bakes its colours into vertex colours: rebuild it, keeping its cell, plane and visibility.
      const old = this.grid;
      this.grid = makeGrid(this.gridCell, this.editorColors);
      this.grid.visible = old.visible;
      this.scene.remove(old);
      old.dispose();
      this.scene.add(this.grid);
      this.setEditorGridPlane(this.gridPlane);
    }
  }

  /** @internal Editor: lay the grid on the ground (XZ, 3D view) or facing the camera (XY, 2D view). */
  setEditorGridPlane(plane: "xz" | "xy"): void {
    this.gridPlane = plane;
    if (!this.grid) return;
    this.grid.rotation.x = plane === "xy" ? Math.PI / 2 : 0;
  }

  /** @internal Editor: the grid's cell size in metres, and whether it shows. */
  setEditorGrid(cellSize: number, visible: boolean): void {
    if (!this.grid) return;
    const cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
    if (cell !== this.gridCell) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as LineBasicMaterial).dispose();
      this.grid = makeGrid(cell, this.editorColors);
      this.gridCell = cell;
      this.scene.add(this.grid);
      this.setEditorGridPlane(this.gridPlane);
    }
    this.grid.visible = visible;
  }

  /** @internal Editor: the grid's cell size, line count and visibility (for tests). */
  editorGrid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.grid ? { cellSize: this.gridCell, visible: this.grid.visible, divisions: gridDivisions(this.gridCell) } : null;
  }

  /** Width / height that cameras render at: the canvas when filling, else the reference resolution. */
  private get aspect(): number {
    if (this.fill && this.canvas.clientHeight > 0) return this.canvas.clientWidth / this.canvas.clientHeight;
    return this.settings.display.width / this.settings.display.height;
  }

  /** Fit the canvas to the container: fill it (editor) or keep the reference aspect ratio (letterboxed). */
  private resize(): void {
    const { width, height } = this.settings.display;
    const cw = this.container.clientWidth || width;
    const ch = this.container.clientHeight || height;
    if (this.fill) {
      this.renderer.setSize(Math.floor(cw), Math.floor(ch), true);
      return;
    }
    const aspect = width / height;
    let w = cw, h = cw / aspect;
    if (h > ch) {
      h = ch;
      w = ch * aspect;
    }
    this.renderer.setSize(Math.floor(w), Math.floor(h), true);
  }

  /** ADR 0080 on three.js: not yet (three's `compileAsync` would do it); resolves at once. */
  async warmUp(_meshes: readonly WarmMesh[]): Promise<void> {}

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

  private texture(path: string, linear = false): Promise<Texture> {
    if (linear) {
      // Normal maps in shader graphs (ADR 0048): a copy that samples the same image without sRGB decoding.
      const copy = this.linearTextures.get(path);
      if (copy) return Promise.resolve(copy);
      return this.texture(path).then((tex) => {
        let t = this.linearTextures.get(path);
        if (!t) {
          t = tex.clone();
          t.colorSpace = NoColorSpace;
          t.anisotropy = this.quality.anisotropy;
          t.needsUpdate = true;
          this.linearTextures.set(path, t);
        }
        return t;
      });
    }
    const cached = this.textures.get(path);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(path);
    if (!p) {
      p = this.loader.loadAsync(Assets.url(path)).then((tex) => {
        tex.colorSpace = SRGBColorSpace;
        this.applySampling(path, tex);
        this.textures.set(path, tex);
        this.loading.delete(path);
        return tex;
      });
      this.loading.set(path, p);
    }
    return p;
  }

  /** Filtering, wrapping and mipmaps from the image's import settings (ADR 0040). */
  private applySampling(path: string, tex: Texture): void {
    this.textureMeta.set(path, sidecarValue(path));
    const settings: ImportSettings = Assets.importSettings(path);
    const point = settings.filter === "point";
    tex.magFilter = point ? NearestFilter : LinearFilter;
    tex.generateMipmaps = settings.mipmaps;
    tex.minFilter = settings.mipmaps ? (point ? NearestMipmapNearestFilter : LinearMipmapLinearFilter) : point ? NearestFilter : LinearFilter;
    const wrap = settings.wrap === "repeat" ? RepeatWrapping : settings.wrap === "mirror" ? MirroredRepeatWrapping : ClampToEdgeWrapping;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.anisotropy = this.quality.anisotropy;
    tex.needsUpdate = true;
  }

  /** @internal Release three.js objects for a removed component. */
  release(c: Component): void {
    if (isUIComponent(c)) {
      this.ui?.release(c);
      return;
    }
    if (c instanceof SpriteRenderer) {
      const e = this.sprites.get(c);
      if (e) {
        this.scene.remove(e.mesh);
        e.mesh.material.dispose();
        e.geometry?.dispose();
        this.sprites.delete(c);
      }
    } else if (c instanceof MeshRenderer) {
      const e = this.meshRenderers.get(c);
      if (e) {
        for (const o of e.objects) this.scene.remove(o);
        this.meshRenderers.delete(c);
      }
      this.releaseRendererMaterial(c);
    } else if (c instanceof Light) {
      const e = this.lights.get(c);
      if (e) {
        this.scene.remove(e.light);
        if (e.target) this.scene.remove(e.target);
        e.light.dispose();
        this.lights.delete(c);
      }
      const g = this.lightGizmos.get(c);
      if (g) {
        this.scene.remove(g);
        this.lightGizmos.delete(c);
      }
    } else if (c instanceof Camera) {
      this.cameras.delete(c);
      this.stacks.get(c)?.dispose();
      this.stacks.delete(c);
    } else if (c instanceof ParticleSystem) {
      this.particles?.release(c);
    } else if (c instanceof WaterSurface) {
      this.water?.release(c);
    } else if (c instanceof ReflectionProbe) {
      const p = this.probes.get(c);
      p?.capture?.dispose();
      if (p?.gizmo) {
        this.scene.remove(p.gizmo);
        p.gizmo.geometry.dispose();
      }
      this.probes.delete(c);
    } else if (c instanceof Text) {
      const e = this.texts.get(c);
      if (e) {
        this.uiScene.remove(e.mesh);
        e.mesh.material.dispose();
        e.texture.dispose();
        this.texts.delete(c);
      }
    }
  }

  // --- Environment (ADR 0053) ----------------------------------------------------------------------

  /** The loaded environment map: its path, the prefiltered lighting texture and the sky texture. */
  private envMap: { path: string; lighting: Texture | null; sky: Texture | null; loading: boolean } | null = null;

  /**
   * The World's first active Environment component sets lighting and sky: its map (loaded and
   * prefiltered on demand), intensities, blur and rotation. Without one, the built-in studio room
   * lights lit materials at 0.4 and there's no sky.
   */
  private syncEnvironment(world: World): void {
    let env: Environment | null = null;
    for (const e of world._componentsOfType(Environment)) {
      if (e.isActiveAndEnabled) {
        env = e;
        break;
      }
    }
    const path = env?.map.replace(/^asset:/, "") ?? "";
    if (path !== (this.envMap?.path ?? "")) this.loadEnvironmentMap(path);
    const map = this.envMap;
    const s = this.scene;
    s.environment = map?.lighting ?? this.environment;
    s.environmentIntensity = env ? Math.max(0, env.intensity) * (map?.lighting ? 1 : 0.4) : 0.4;
    const sky = env?.skybox && map ? (env.skyboxBlur > 0 ? map.lighting : map.sky) : null;
    s.background = sky ?? null;
    s.backgroundIntensity = env ? Math.max(0, env.skyboxIntensity) : 1;
    s.backgroundBlurriness = env ? Math.min(1, Math.max(0, env.skyboxBlur)) : 0;
    const turn = env ? (env.rotation * Math.PI) / 180 : 0;
    s.environmentRotation.set(0, turn, 0);
    s.backgroundRotation.set(0, turn, 0);
  }

  /** The World's first enabled Fog sets the scene's distance fog, after the environment has set the sky (ADR 0071). */
  private syncFog(world: World): void {
    let fog: Fog | null = null;
    for (const f of world._componentsOfType(Fog)) {
      if (f.isActiveAndEnabled) {
        fog = f;
        break;
      }
    }
    applyFog(this.scene, fog, this.clearColor);
  }

  private loadEnvironmentMap(path: string): void {
    this.envMap?.lighting?.dispose();
    this.envMap?.sky?.dispose();
    if (!path) {
      this.envMap = null;
      return;
    }
    const entry: NonNullable<RenderBackend["envMap"]> = { path, lighting: null, sky: null, loading: true };
    this.envMap = entry;
    let url: string;
    try {
      url = Assets.url(path);
    } catch {
      console.warn(`[myco] environment map "${path}" isn't in the project; using the built-in environment.`);
      return;
    }
    loadEquirectangular(url, path)
      .then((tex) => {
        if (this.envMap !== entry) return tex.dispose(); // replaced meanwhile
        entry.sky = tex;
        entry.lighting = prefilter(this.renderer, tex);
        entry.loading = false;
      })
      .catch((err) => console.error(`[myco] failed to load environment map "${path}":`, err));
  }

  // --- Cascaded shadows (ADR 0053) -------------------------------------------------------------------

  private cascades: CascadedShadows | null = null;
  private cascadesLoading = false;
  private cascadeLight: DirectionalLight | null = null;

  /**
   * On tiers with cascades, the first enabled directional light with shadows is drawn through
   * three's CSM following `camera`: the light itself is hidden and CSM's cascade lights take over.
   */
  private syncCascades(world: World, camera: ThreeCamera | null): void {
    const tier = Graphics.tier;
    let source: { l: Light; light: DirectionalLight } | null = null;
    if (camera && tier.shadowCascades > 1 && tier.shadows !== "off") {
      for (const l of world._componentsOfType(Light)) {
        const entry = this.lights.get(l);
        if (l.type === "directional" && l.castShadows && l.isActiveAndEnabled && entry?.light instanceof DirectionalLight) {
          source = { l, light: entry.light };
          break;
        }
      }
    }
    if (!source || !camera) {
      this.dropCascades();
      return;
    }
    tmpDir.setFromMatrixColumn(source.light.matrix, 3); // position
    const target = (source.light.target as Object3D).matrix;
    const dir = new ThreeVector3().setFromMatrixColumn(target, 3).sub(tmpDir).normalize();
    const settings: CascadeSettings = {
      cascades: tier.shadowCascades,
      distance: tier.shadowDistance,
      mapSize: SHADOW_MAP_SIZE[tier.shadows],
      color: source.light.color,
      intensity: source.light.intensity,
      direction: dir,
      castShadows: true,
    };
    if (this.cascades && (this.cascades.needsRebuild(camera, settings) || this.cascadeLight !== source.light)) this.dropCascades();
    if (!this.cascades) {
      if (!this.cascadesLoading) {
        this.cascadesLoading = true;
        const light = source.light;
        import("./cascadedShadows")
          .then((m) => m.CascadedShadows.create(camera, this.scene, settings))
          .then((c) => {
            this.cascadesLoading = false;
            this.cascades = c;
            this.cascadeLight = light;
          })
          .catch((err) => {
            this.cascadesLoading = false;
            console.error("[myco] cascaded shadows couldn't start:", err);
          });
      }
      return; // ordinary shadows until it's ready
    }
    source.light.visible = false; // the cascade lights replace it
    this.cascades.update(settings);
    const cascades = this.cascades;
    this.scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (!m || !(o as Mesh).isMesh) return;
      if (o.parent === this.particles?.root) return; // particle batches: quarks' own shaders, which CSM's patches don't fit
      for (const x of Array.isArray(m) ? m : [m]) if ((x as MeshStandardMaterial).isMeshStandardMaterial) cascades.setupMaterial(x);
    });
  }

  private dropCascades(): void {
    if (!this.cascades) return;
    this.cascades.dispose();
    this.cascades = null;
    if (this.cascadeLight) this.cascadeLight.visible = true;
    this.cascadeLight = null;
  }

  /** @internal Tests: whether cascaded shadows are active, and the environment map's state. */
  lightingState(): { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean } {
    return { cascades: !!this.cascades, environment: this.envMap?.path ?? "", environmentLoaded: !!this.envMap?.lighting, skybox: this.scene.background !== null };
  }

  /** Step 8: mirror engine components into three.js. */
  sync(world: World): void {
    this.claim(world);
    if (Graphics._version !== this.appliedQuality) this.applyQuality();
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s);
    for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    this.syncLights(world);
    this.syncEnvironment(world);
    this.syncFog(world);
    for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
    for (const t of world._componentsOfType(Text)) this.syncText(t);
    this.syncParticles(world);
    this.syncWater(world);
    this.syncUI(world);
    if (this.fill) {
      this.syncOutlines();
      this.syncCameraGizmos(world);
      this.syncLightGizmos(world);
      this.syncOverlay();
      this.syncGizmo(world);
    } else {
      if (this.overlayProvider || this.overlayLines?.visible || this.overlaySegments.length > 0) {
        this.syncOverlay(); // a game with a debug overlay (navigation, ADR 0065); one more pass clears it when removed
      }
      // Play mode's live Inspector selection (the editor outlines it); one more pass hides the outlines when cleared.
      if (this.outlined.size > 0 || this.outlines.some((o) => o.visible) || this.boxOutlines.some((o) => o.visible)) this.syncOutlines();
    }
  }

  private sortOrder(layer: string, order: number): number {
    let index = this.settings.render.sortingLayers.indexOf(layer);
    if (index < 0) {
      if (!this.warnedLayers.has(layer)) {
        this.warnedLayers.add(layer);
        console.warn(`[myco] unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`);
      }
      index = 0;
    }
    return index * 10000 + order;
  }

  private syncSprite(world: World, s: SpriteRenderer): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      const material = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const mesh = new Mesh(this.quad, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      entry = { mesh, spritePath: null, geometry: null, uvKey: "", size: null };
      this.sprites.set(s, entry);
    }
    const { mesh } = entry;
    const material = mesh.material;
    // `images/sheet.png#walk_0` draws the slice walk_0 of images/sheet.png (ADR 0040).
    const { path: image, slice } = splitSpriteRef(s.sprite);

    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = image ? this.textures.get(image) : null;
      material.map = tex ?? null;
      material.needsUpdate = true;
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
    if (material.map && image && this.textureMeta.get(image) !== sidecarValue(image)) this.applySampling(image, material.map);

    const ready = !s.sprite || !!material.map;
    mesh.visible = s.isActiveAndEnabled && ready;
    if (!mesh.visible) return;

    material.color.setRGB(s.color.r, s.color.g, s.color.b, SRGBColorSpace);
    material.opacity = s.color.a;
    mesh.renderOrder = this.sortOrder(s.sortingLayer, s.orderInLayer);

    let w = 1, h = 1, px = 0.5, py = 0.5;
    if (material.map) {
      const img = material.map.image as { width: number; height: number };
      const frame = spriteFrame(Assets.importSettings(image), slice, img.width, img.height, { component: s.pixelsPerUnit, project: this.settings.render.pixelsPerUnit }, s.size);
      [w, h] = frame.size;
      [px, py] = frame.pivot;
      if (frame.missingSlice && !this.warnedSlices.has(s.sprite)) {
        this.warnedSlices.add(s.sprite);
        console.warn(`[myco] ${image} has no slice named "${slice}" (in ${image}.meta.json); drawing the whole image.`);
      }
      this.setSpriteUVs(entry, frame.uv);
    } else if (s.size) {
      w = s.size.x;
      h = s.size.y;
    }
    entry.size = material.map || s.size ? [w, h] : null;
    const e = s.node.entity;
    tmpWorld.fromArray(world.worldMatrix(e), e * 16);
    // Scale the unit quad to size with the pivot at the node's origin (flips mirror about it).
    tmpScale.makeScale(s.flipX ? -w : w, s.flipY ? -h : h, 1);
    tmpPivot.makeTranslation(0.5 - px, 0.5 - py, 0);
    mesh.matrix.multiplyMatrices(tmpWorld, tmpScale).multiply(tmpPivot);
    mesh.matrixWorldNeedsUpdate = true;
  }

  /** Draw a slice's part of the texture (its own quad), or the whole texture (the shared quad). */
  private setSpriteUVs(entry: SpriteEntry, uv: [number, number, number, number] | null): void {
    const key = uv ? uv.join(",") : "";
    if (key === entry.uvKey) return;
    entry.uvKey = key;
    if (!uv) {
      entry.mesh.geometry = this.quad;
      entry.geometry?.dispose();
      entry.geometry = null;
      return;
    }
    entry.geometry ??= new PlaneGeometry(1, 1);
    const [u0, v0, u1, v1] = uv;
    // PlaneGeometry's vertices: top-left, top-right, bottom-left, bottom-right.
    entry.geometry.setAttribute("uv", new Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2));
    entry.mesh.geometry = entry.geometry;
  }

  // --- Meshes, materials and lights (ADR 0043) -----------------------------------------------------

  private syncMesh(world: World, r: MeshRenderer): void {
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { objects: [], sources: null, material: null };
      this.meshRenderers.set(r, entry);
    }
    if (!this.environmentLoading) this.environmentLoading = this.loadEnvironment();
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const e0 = r.node.entity;
    tmpWorld.fromArray(world.worldMatrix(e0), e0 * 16);
    const probe = this.probeFor(sources);
    // A mesh drawn with its model's own material (one, shared by all its meshes) or the default one
    // takes a reflection probe too (ADR 0054), through a copy of that material.
    const own = sources?.length && sources.every((m) => m.materials.length <= 1 && m.materials[0] === sources[0].materials[0]) ? (sources[0].materials[0] ? this.localMaterial(sources[0].materials[0]) : this.defaultMaterial) : null;
    const asset = this.materialAsset(r.material);
    const material = this.rendererMaterial(r, asset ?? (probe ? own : null), probe);
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    if (!same || entry.material !== material) {
      for (const o of entry.objects) this.scene.remove(o);
      entry.objects = (sources ?? []).map((m) => {
        // A model's own materials are shared by every World: draw this backend's copies of them, so
        // per-backend state (cascaded shadows' setup, ADR 0053) never lands on the shared objects.
        const own = m.materials.length > 1 && m.geometry.groups.length > 1 ? m.materials.map((x) => this.localMaterial(x)) : m.materials[0] && this.localMaterial(m.materials[0]);
        const mesh = new Mesh(m.geometry, material ?? own ?? this.defaultMaterial);
        mesh.matrixAutoUpdate = false;
        const shadows = material && this.graphShadows.get(material);
        if (shadows?.depth) mesh.customDepthMaterial = shadows.depth;
        if (shadows?.distance) mesh.customDistanceMaterial = shadows.distance;
        this.scene.add(mesh);
        return mesh;
      });
      entry.sources = sources;
      entry.material = material;
    }
    const visible = r.isActiveAndEnabled;
    if (!visible) {
      for (const o of entry.objects) o.visible = false;
      return;
    }
    const e = r.node.entity;
    tmpWorld.fromArray(world.worldMatrix(e), e * 16);
    for (const o of entry.objects) {
      o.visible = true;
      o.castShadow = r.castShadows;
      o.receiveShadow = r.receiveShadows;
      o.matrix.copy(tmpWorld);
      o.matrixWorldNeedsUpdate = true;
    }
  }

  private environmentLoading: Promise<void> | null = null;

  /**
   * A soft studio environment that lit materials reflect (ADR 0043), so metals and glossy
   * surfaces don't draw black. Loaded with the first mesh, so 2D games never load it.
   */
  private async loadEnvironment(): Promise<void> {
    try {
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      const pmrem = new PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.environment = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
      this.scene.environment = this.environment;
      this.scene.environmentIntensity = 0.4;
    } catch (err) {
      console.warn("[myco] couldn't make the default environment:", err);
    }
  }

  private environment: Texture | null = null;

  /**
   * The three.js material for a material asset, or null for none (empty, missing, or not a
   * material: warned once). Rebuilt when the asset's JSON changes (the editor's Material inspector).
   */
  private materialAsset(path: string): Material | null {
    if (!path) return null;
    const read = (p: string): unknown => {
      try {
        return Assets.has(p) ? Assets.json(p) : undefined;
      } catch {
        return undefined;
      }
    };
    const raw = read(path);
    // A material naming a shader graph, or a renderer naming the graph itself, depends on the graph's JSON too.
    let graphPath: string | null = isShaderGraphPath(path) ? path : null;
    if (!graphPath && raw !== undefined) graphPath = materialGraphOfJson(raw);
    const graphRaw = graphPath ? read(graphPath) : undefined;
    const cached = this.materialAssets.get(path);
    const levelOk = !cached?.level || cached.level === Graphics.tier.shaderLevel; // Quality Branch nodes (ADR 0050)
    if (cached && levelOk && cached.raw === raw && cached.graphRaw === graphRaw && (cached.deps ?? []).every(([p, v]) => read(p) === v)) return cached.material;
    cached?.material?.dispose();
    cached?.graph?.dispose();
    for (const t of cached?.textures ?? []) t.dispose();
    let material: Material | null = null;
    let graph: GraphMaterial | undefined;
    const owned: Texture[] = [];
    if (raw === undefined) {
      this.warnMaterial(path, `material "${path}" isn't in the project; using the default material.`);
    } else if (graphPath) {
      const where = path.replace(/^asset:/, "");
      try {
        const properties: Record<string, GraphValue> = graphPath === path ? {} : parseMaterial(raw, where).settings.properties;
        if (graphRaw === undefined) throw new Error(`shader graph "${graphPath.replace(/^asset:/, "")}" isn't in the project.`);
        graph = this.graphMaterial(graphRaw, graphPath.replace(/^asset:/, ""), properties);
        material = graph.material;
      } catch (err) {
        const message = `${where}: ${(err as Error).message} Using the default material.`;
        this.warnMaterial(message, message);
      }
    } else {
      try {
        const { settings, problems } = parseMaterial(raw, path.replace(/^asset:/, ""));
        for (const p of problems) this.warnMaterial(`${path}|${p}`, p);
        const color = new ThreeColor().setRGB(settings.color.r, settings.color.g, settings.color.b, SRGBColorSpace);
        const common = { color, transparent: settings.color.a < 1, opacity: settings.color.a, side: settings.doubleSided ? DoubleSide : FrontSide };
        const lit = {
          ...common,
          metalness: settings.metalness,
          roughness: settings.roughness,
          emissive: new ThreeColor().setRGB(settings.emission.r, settings.emission.g, settings.emission.b, SRGBColorSpace),
        };
        const m =
          settings.shader === "unlit"
            ? new MeshBasicMaterial(common)
            : settings.shader === "physical"
              ? new MeshPhysicalMaterial({
                  ...lit,
                  clearcoat: settings.clearcoat,
                  clearcoatRoughness: settings.clearcoatRoughness,
                  sheen: settings.sheen,
                  sheenColor: new ThreeColor().setRGB(settings.sheenColor.r, settings.sheenColor.g, settings.sheenColor.b, SRGBColorSpace),
                  sheenRoughness: settings.sheenRoughness,
                  transmission: settings.transmission,
                  thickness: settings.thickness,
                  ior: settings.ior,
                  iridescence: settings.iridescence,
                  iridescenceIOR: settings.iridescenceIOR,
                  anisotropy: settings.anisotropy,
                  anisotropyRotation: (settings.anisotropyRotation * Math.PI) / 180,
                  specularIntensity: settings.specularIntensity,
                  specularColor: new ThreeColor().setRGB(settings.specularColor.r, settings.specularColor.g, settings.specularColor.b, SRGBColorSpace),
                })
              : new MeshStandardMaterial(lit);
        const tiled = (tex: Texture, linear: boolean): Texture => {
          const [tx, ty] = settings.tiling;
          if (tx === 1 && ty === 1 && !linear) return tex;
          const t = tex.clone(); // its own repeat and colour space; shares the image
          t.anisotropy = this.quality.anisotropy;
          t.colorSpace = linear ? NoColorSpace : SRGBColorSpace;
          t.repeat.set(tx, ty);
          if (tx !== 1 || ty !== 1) t.wrapS = t.wrapT = RepeatWrapping;
          t.needsUpdate = true;
          owned.push(t);
          return t;
        };
        const load = (ref: string, apply: (tex: Texture) => void) => {
          const image = ref.replace(/^asset:/, "");
          if (!image) return;
          this.texture(image)
            .then((tex) => {
              if (this.materialAssets.get(path)?.material !== m) return; // replaced meanwhile
              apply(tex);
              m.needsUpdate = true;
            })
            .catch((err) => console.error(`[myco] failed to load texture "${image}" for ${path}:`, err));
        };
        load(settings.texture, (tex) => (m.map = tiled(tex, false)));
        if (m instanceof MeshStandardMaterial) load(settings.normalMap, (tex) => (m.normalMap = tiled(tex, true)));
        material = m;
      } catch (err) {
        this.warnMaterial(path, `${(err as Error).message} Using the default material.`);
      }
    }
    if (material && raw !== undefined) {
      try {
        (material as Material & { fog: boolean }).fog = parseMaterial(raw).settings.fog; // a material can opt out of the World's Fog (ADR 0071)
      } catch {
        /* already warned above */
      }
    }
    const deps = graph?.compiled.dependencies.map((p): [string, unknown] => [p, read(p)]);
    const level = graph?.compiled.usesShaderLevel ? Graphics.tier.shaderLevel : undefined;
    this.materialAssets.set(path, { raw, graphRaw, material, textures: owned, graph, deps, level });
    return material;
  }

  /**
   * The material a renderer draws with: its material asset's, or (with property overrides,
   * ADR 0049) its own copy, sharing the shader program, with the overrides applied.
   */
  private rendererMaterial(r: MeshRenderer, base: Material | null, probe: { texture: Texture; intensity: number } | null = null): Material | null {
    const overrides = r._materialProperties;
    let entry = this.rendererMaterials.get(r);
    // A reflection probe (ADR 0054) also needs the renderer's own copy, holding the probe's map.
    const env = base && (base as MeshStandardMaterial).isMeshStandardMaterial ? probe : null;
    if (!base || (overrides.size === 0 && !env)) {
      if (entry) this.releaseRendererMaterial(r);
      return base;
    }
    if (entry && entry.base !== base) {
      this.releaseRendererMaterial(r);
      entry = undefined;
    }
    const values: Record<string, GraphValue> = {};
    for (const [k, v] of overrides) values[k] = toGraphValue(v);
    const baseGraph = this.graphShadows.get(base);
    if (!entry) {
      if (baseGraph) {
        const graph = createGraphMaterial(baseGraph.compiled, { ...baseGraph.properties, ...values }, this.graphUniforms, (p, linear) => this.texture(p, linear));
        this.graphShadows.set(graph.material, graph);
        entry = { base, material: graph.material, graph, version: r._materialPropertiesVersion };
      } else {
        entry = { base, material: base.clone(), version: -1 };
      }
      this.rendererMaterials.set(r, entry);
      const known = baseGraph ? new Set(baseGraph.compiled.uniforms.flatMap((u) => (u.property ? [u.property] : []))) : BUILTIN_PROPERTIES;
      for (const k of overrides.keys()) if (!known.has(k)) this.warnMaterial(`${r.material}|prop|${k}`, `${r.node.name}: its material has no property "${k}"; setMaterialProperty ignores it.`);
    }
    if (entry.version !== r._materialPropertiesVersion) {
      entry.version = r._materialPropertiesVersion;
      if (entry.graph && baseGraph) entry.graph.setProperties({ ...baseGraph.properties, ...values });
      else {
        this.applyBuiltinProperties(entry.material, base, values);
        entry.probe = undefined; // the copy took the base's envMap: apply the probe again
      }
    }
    const lit = entry.material as MeshStandardMaterial;
    const tex = env?.texture ?? null;
    if (entry.probe !== tex) {
      const had = !!lit.envMap;
      lit.envMap = tex;
      if (had !== !!tex) lit.needsUpdate = true;
      entry.probe = tex;
    }
    lit.envMapIntensity = env ? env.intensity : 1;
    return entry.material;
  }

  /** A built-in material's copy: the base's values, then the overrides. */
  private applyBuiltinProperties(m: Material, base: Material, values: Record<string, GraphValue>): void {
    m.copy(base);
    const mat = m as MeshStandardMaterial;
    const color = (v: GraphValue, into: ThreeColor) => {
      const c = typeof v === "string" ? Color.from(v) : Array.isArray(v) ? Color.from(v) : null;
      if (c) into.setRGB(c.r, c.g, c.b, SRGBColorSpace);
      return c;
    };
    if (values.color !== undefined && mat.color) {
      const c = color(values.color, mat.color);
      if (c) {
        mat.opacity = c.a;
        mat.transparent = c.a < 1;
      }
    }
    if (values.emission !== undefined && mat.emissive) color(values.emission, mat.emissive);
    const phys = mat as unknown as Record<string, unknown>;
    for (const k of ["clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "transmission", "thickness", "ior", "iridescence", "iridescenceIOR", "anisotropy", "specularIntensity"]) {
      const v = values[k];
      if (typeof v === "number" && k in mat) phys[k] = v;
    }
    if (typeof values.anisotropyRotation === "number" && "anisotropyRotation" in mat) phys.anisotropyRotation = (values.anisotropyRotation * Math.PI) / 180;
    for (const k of ["sheenColor", "specularColor"]) {
      const v = values[k];
      const into = phys[k];
      if (v !== undefined && into instanceof ThreeColor) color(v, into);
    }
    if (typeof values.metalness === "number" && "metalness" in mat) mat.metalness = values.metalness;
    if (typeof values.roughness === "number" && "roughness" in mat) mat.roughness = values.roughness;
    if (typeof values.texture === "string") {
      const image = values.texture.replace(/^asset:/, "");
      if (!image) mat.map = null;
      else
        this.texture(image)
          .then((tex) => {
            if (this.rendererMaterialsHas(m)) {
              mat.map = tex;
              mat.needsUpdate = true;
            }
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
    }
    m.needsUpdate = true;
  }

  private rendererMaterialsHas(m: Material): boolean {
    for (const e of this.rendererMaterials.values()) if (e.material === m) return true;
    return false;
  }

  private releaseRendererMaterial(r: MeshRenderer): void {
    const e = this.rendererMaterials.get(r);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else e.material.dispose();
    this.rendererMaterials.delete(r);
  }

  /** A shader graph's JSON compiled into a material (ADR 0047); problems are warned once each. */
  private graphMaterial(graphRaw: unknown, where: string, properties: Record<string, GraphValue>): GraphMaterial {
    const { graph, problems } = parseShaderGraph(graphRaw, where);
    const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel });
    for (const p of [...problems, ...compiled.problems.map((q) => `${where}: ${q}`)]) this.warnMaterial(p, p);
    const made = createGraphMaterial(compiled, properties, this.graphUniforms, (p, linear) => this.texture(p, linear));
    this.graphShadows.set(made.material, made);
    return made;
  }

  private warnMaterial(key: string, message: string): void {
    if (this.warnedMaterials.has(key)) return;
    this.warnedMaterials.add(key);
    console.warn(`[myco] ${message}`);
  }

  private syncLights(world: World): void {
    let any = false;
    for (const l of world._componentsOfType(Light)) any = this.syncLight(world, l) || any;
    // A World with no Light of its own gets the default ones, so meshes never draw black.
    for (const d of this.defaultLights) d.visible = !any;
  }

  /** Mirror one Light; true if it lights the scene. */
  private syncLight(world: World, l: Light): boolean {
    let entry = this.lights.get(l);
    if (!entry || entry.type !== l.type) {
      if (entry) this.release(l);
      const light =
        l.type === "point" ? new PointLight() : l.type === "spot" ? new SpotLight() : l.type === "ambient" ? new AmbientLight() : new DirectionalLight();
      light.matrixAutoUpdate = false;
      let target: Object3D | null = null;
      if (light instanceof DirectionalLight || light instanceof SpotLight) {
        target = new Object3D();
        target.matrixAutoUpdate = false;
        light.target = target;
        this.scene.add(target);
        light.shadow.bias = -0.0005;
        light.shadow.normalBias = 0.02;
      }
      this.scene.add(light);
      entry = { light, type: l.type, target };
      this.lights.set(l, entry);
    }
    const { light, target } = entry;
    light.visible = l.isActiveAndEnabled;
    if (!light.visible) return false;
    light.color.setRGB(l.color.r, l.color.g, l.color.b, SRGBColorSpace);
    light.intensity = Math.max(0, l.intensity);
    const e = l.node.entity;
    tmpWorld.fromArray(world.worldMatrix(e), e * 16);
    tmpPoint.setFromMatrixPosition(tmpWorld);
    light.matrix.makeTranslation(tmpPoint.x, tmpPoint.y, tmpPoint.z);
    light.matrixWorldNeedsUpdate = true;
    if (target) {
      tmpDir.setFromMatrixColumn(tmpWorld, 2).normalize().negate(); // -Z, where cameras look too
      target.matrix.makeTranslation(tmpPoint.x + tmpDir.x, tmpPoint.y + tmpDir.y, tmpPoint.z + tmpDir.z);
      target.matrixWorldNeedsUpdate = true;
    }
    if (light instanceof PointLight || light instanceof SpotLight) {
      light.distance = Math.max(0, l.range);
      light.decay = 2;
    }
    if (light instanceof SpotLight) {
      light.angle = (Math.min(Math.max(l.spotAngle, 1), 179) / 2) * (Math.PI / 180);
      light.penumbra = Math.min(Math.max(l.spotSoftness, 0), 1);
    }
    if (!(light instanceof AmbientLight)) {
      light.castShadow = l.castShadows;
      if (light instanceof DirectionalLight) {
        const half = Math.max(1, l.shadowArea) / 2;
        const cam = light.shadow.camera;
        if (cam.right !== half) {
          cam.left = cam.bottom = -half;
          cam.right = cam.top = half;
          cam.near = -half * 2; // shadows from in front of and behind the light's node
          cam.far = half * 2;
          cam.updateProjectionMatrix();
        }
      }
      this.applyShadowSize(light);
    }
    return true;
  }

  private syncCamera(world: World, c: Camera): void {
    let entry = this.cameras.get(c);
    if (!entry || entry.projection !== c.projection) {
      const camera = c.projection === "perspective" ? new PerspectiveCamera() : new OrthographicCamera();
      camera.matrixAutoUpdate = false;
      entry = { camera, projection: c.projection };
      this.cameras.set(c, entry);
    }
    const { camera } = entry;
    // The camera's aspect ratio follows its viewport rectangle (ADR 0056).
    const vw = Math.max(0.001, Math.min(1, c.viewportSize.x)), vh = Math.max(0.001, Math.min(1, c.viewportSize.y));
    const aspect = this.aspect * (vw / vh);
    if (camera instanceof OrthographicCamera) {
      const s = c.orthographicSize;
      camera.left = -s * aspect;
      camera.right = s * aspect;
      camera.top = s;
      camera.bottom = -s;
    } else {
      camera.fov = c.fieldOfView;
      camera.aspect = aspect;
    }
    camera.near = c.near;
    camera.far = c.far;
    camera.updateProjectionMatrix();
    const e = c.node.entity;
    camera.matrix.fromArray(world.worldMatrix(e), e * 16);
    camera.updateMatrixWorld(true);
  }

  private syncText(t: Text): void {
    let entry = this.texts.get(t);
    if (!entry) {
      const canvas = document.createElement("canvas");
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      const material = new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
      const mesh = new Mesh(this.quad, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.uiScene.add(mesh);
      entry = { mesh, canvas, texture, signature: "", width: 0, height: 0 };
      this.texts.set(t, entry);
    }
    entry.mesh.visible = t.isActiveAndEnabled && t.text.length > 0;
    if (!entry.mesh.visible) return;

    const outline = t.outlineColor && t.outlineWidth > 0 ? `${t.outlineColor.toCss()}/${t.outlineWidth}` : "";
    const signature = [t.text, t.fontSize, t.fontFamily, t.fontWeight, t.color.toCss(), outline, t.align, t.lineHeight].join("|");
    if (signature !== entry.signature) {
      entry.signature = signature;
      this.drawText(t, entry);
    }

    const { width: W, height: H } = this.settings.display;
    const [ax, ay] = anchorFactors(t.anchor);
    // Anchor point on screen (UI camera space: origin bottom-left, +y up).
    const sx = ax * W + t.offset.x;
    const sy = (1 - ay) * H - t.offset.y;
    // Place the text box so its own anchor point sits at the screen anchor.
    const cx = sx + (0.5 - ax) * entry.width;
    const cy = sy - (0.5 - ay) * entry.height;
    entry.mesh.matrix.makeScale(entry.width, entry.height, 1).setPosition(cx, cy, 0);
    entry.mesh.matrixWorldNeedsUpdate = true;
  }

  private drawText(t: Text, entry: TextEntry): void {
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 2; // supersample for crisp edges
    const ctx = entry.canvas.getContext("2d")!;
    const font = `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
    ctx.font = font;
    const lines = t.text.split("\n");
    const pad = Math.ceil(t.outlineWidth + 2);
    const lineH = t.fontSize * t.lineHeight;
    const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
    const height = Math.ceil(lineH * lines.length + pad * 2);
    entry.canvas.width = width * scale;
    entry.canvas.height = height * scale;
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = t.align;
    ctx.lineJoin = "round";
    const x = t.align === "left" ? pad : t.align === "right" ? width - pad : width / 2;
    lines.forEach((line, i) => {
      const y = pad + lineH * (i + 0.5);
      if (t.outlineColor && t.outlineWidth > 0) {
        ctx.strokeStyle = t.outlineColor.toCss();
        ctx.lineWidth = t.outlineWidth * 2;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = t.color.toCss();
      ctx.fillText(line, x, y);
    });
    entry.width = width;
    entry.height = height;
    // Canvas size changed: replace the GPU texture.
    entry.texture.dispose();
    entry.texture = new CanvasTexture(entry.canvas);
    entry.texture.colorSpace = SRGBColorSpace;
    entry.mesh.material.map = entry.texture;
    entry.mesh.material.needsUpdate = true;
  }

  /** Step 9: render each enabled camera in depth order, then the UI. */
  render(world: World): void {
    this.claim(world);
    if (Graphics._version !== this.appliedQuality) this.applyQuality();
    const r = this.renderer;
    r.info.reset();
    this.overlayDraws.last = this.overlayDraws.count;
    this.overlayDraws.count = 0;
    this.graphUniforms.time.value = world.time.time;
    r.getDrawingBufferSize(this.graphUniforms.resolution.value);
    const cams = this.viewCameras(world);
    this.syncCascades(world, cams[0] ? (this.cameras.get(cams[0])!.camera as ThreeCamera) : null);
    this.syncProbes(world);
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    this.lastPost = null;
    if (!cams.length) {
      r.setClearColor(this.clearColor, 1);
      r.clear(true, true, true);
    }
    // Cameras in depth order, each in its viewport (ADR 0056). The first clears the canvas; a later
    // one with a background colour clears its rectangle, one without draws over (an overlay).
    cams.forEach((c, i) => {
      const camera = this.cameras.get(c)!.camera as ThreeCamera;
      const vp = cameraViewport(c, cw, ch);
      const full = vp.x <= 0 && vp.y <= 0 && vp.width >= cw && vp.height >= ch;
      // Post-processing (ADR 0051, 0056): each camera's own component, filtered by the tier; the editor's view previews the scene camera's.
      const resolved = resolvePostEffects(this.postSettings(c) ?? (i === 0 && this.fill ? this.scenePostSettings(world) : null), Graphics.tier);
      const frame = { resolved, composed: false };
      if (i === 0) this.lastPost = frame;
      r.toneMappingExposure = resolved.exposure;
      r.setClearColor(c.backgroundColor ? new ThreeColor(c.backgroundColor.toHex()) : this.clearColor, 1);
      const stack = resolved.composer ? this.stackFor(c) : null; // null while the libraries load
      if (stack && this.composeSafely(stack, resolved.composer!, camera, world.time.deltaTime, { overlay: i > 0 && !c.backgroundColor, viewport: full ? undefined : vp, helpers: i !== 0 ? "none" : this.fill ? "editor" : "overlays" })) {
        frame.composed = true;
        return;
      }
      // Directly: the renderer tone-maps, so a camera looks the same with or without the composer.
      r.toneMapping = TONE_MAPPING[resolved.toneMapping];
      this.setViewportRect(full ? null : vp);
      if (i === 0 || c.backgroundColor) r.clear(true, true, true);
      else r.clearDepth();
      r.render(this.scene, camera);
      this.setViewportRect(null);
    });
    r.clearDepth();
    r.toneMapping = NoToneMapping; // the UI is never tone mapped
    r.render(this.uiScene, this.uiCamera);
    this.ui?.render(r); // UI canvases (ADR 0069), over the interim Text
    if (this.fill) this.renderCameraPreview(world.time.deltaTime);
  }

  /** Draw (and clear) only inside `vp`, CSS pixels from the bottom-left; null: the whole canvas. */
  private setViewportRect(vp: PostViewport | null): void {
    const r = this.renderer;
    if (vp) {
      r.setScissorTest(true);
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
    } else {
      r.setScissorTest(false);
      r.setViewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    }
  }

  /** Render through a composer; a failure turns post-processing off (with an error) instead of losing the frame. False if it didn't draw. */
  private composeSafely(stack: PostProcessStack, effects: PostEffects, camera: ThreeCamera, dt: number, opts: { overlay: boolean; viewport?: PostViewport; helpers: ComposedHelpers }): boolean {
    try {
      this.renderComposed(stack, effects, camera, dt, opts);
      return true;
    } catch (err) {
      this.postFailed = true;
      for (const s of this.stacks.values()) s.dispose();
      this.stacks.clear();
      this.scene.overrideMaterial = null;
      this.setViewportRect(null);
      console.error("[myco] post-processing failed; rendering without it:", err);
      return false;
    }
  }

  // --- Post-processing (ADR 0051) ------------------------------------------------------------------

  /** Each camera's composer (ADR 0056), and the size each was last given. */
  private readonly stacks = new Map<Camera, PostProcessStack>();
  private readonly stacksLoading = new Set<Camera>();
  private readonly stackSizes = new WeakMap<PostProcessStack, string>();
  private postFailed = false;
  private depthOnly: MeshBasicMaterial | null = null;
  private lastPost: { resolved: ResolvedPost; composed: boolean } | null = null;

  /** @internal Tests and the editor: what the last frame resolved and whether the composer drew it. */
  postState(): { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } {
    return { composed: !!this.lastPost?.composed, loaded: this.stacks.size > 0, toneMapping: this.lastPost?.resolved.toneMapping ?? "none", effects: this.lastPost?.resolved.composer ?? null };
  }

  /** @internal Tests: how many cameras have a composer. */
  stackCount(): number {
    return this.stacks.size;
  }

  /** A camera's PostProcessing component, if it has an enabled one. */
  private postSettings(c: Camera): PostSettings | null {
    const p = c.node.getComponent(PostProcessing);
    return p && p.isActiveAndEnabled ? ({ ...p, enabled: true } as unknown as PostSettings) : null;
  }

  /**
   * Editor: the scene view previews the effects of the scene's first camera with a PostProcessing
   * component, minus depth of field (focused for the game's camera, it would blur the editor's view).
   */
  private scenePostSettings(world: World): PostSettings | null {
    for (const p of world._componentsOfType(PostProcessing)) {
      if (p.isActiveAndEnabled && p.node.getComponent(Camera)) return { ...(p as unknown as PostSettings), enabled: true, depthOfField: false };
    }
    return null;
  }

  /** A camera's composer, loading the libraries on first use (games without post-processing never download them). Null until ready. */
  private stackFor(c: Camera): PostProcessStack | null {
    if (this.postFailed) return null;
    const s = this.stacks.get(c);
    if (s || this.stacksLoading.has(c)) return s ?? null;
    this.stacksLoading.add(c);
    import("./PostProcessStack")
      .then((m) => m.PostProcessStack.create(this.renderer))
      .then((stack) => {
        this.stacksLoading.delete(c);
        if (this.cameras.has(c) || this.preview?.camera === c) this.stacks.set(c, stack);
        else stack.dispose(); // the camera went meanwhile
      })
      .catch((err) => {
        this.stacksLoading.delete(c);
        this.postFailed = true;
        console.error("[myco] post-processing couldn't start; rendering without it:", err);
      });
    return null;
  }

  /**
   * The main camera through the composer. Editor helpers never go through the effects; they draw afterwards:
   * - `"editor"` (the editor's own World): grid, gizmos, outlines and overlays, over a depth-only pass so meshes
   *   still hide the grid;
   * - `"overlays"` (a game or play World's first camera): its overlays and selection outlines, the debug drawing
   *   (navigation, ADR 0065) a game or play mode adds. They don't depth-test, so no depth pass is needed;
   * - `"none"` (other cameras, the camera preview): nothing.
   */
  private renderComposed(stack: PostProcessStack, effects: PostEffects, camera: ThreeCamera, dt: number, opts: { overlay: boolean; viewport?: PostViewport; helpers: ComposedHelpers }): void {
    const r = this.renderer;
    r.toneMapping = NoToneMapping; // the composer tone-maps at its end
    const hidden = this.editorHelpers(); // helpers never go through effects
    const helpers = opts.helpers === "editor" ? hidden : opts.helpers === "overlays" ? hidden.filter((o) => this.isGameOverlay(o)) : [];
    for (const o of hidden) o.visible = false;
    const w = opts.viewport?.width ?? this.canvas.clientWidth, h = opts.viewport?.height ?? this.canvas.clientHeight;
    const size = `${w}x${h}@${r.getPixelRatio()}`;
    if (this.stackSizes.get(stack) !== size) {
      this.stackSizes.set(stack, size);
      stack.setSize(w, h);
    }
    try {
      stack.configure(effects, this.scene, camera, { overlay: opts.overlay });
      stack.render(dt, opts.viewport);
    } finally {
      for (const o of hidden) o.visible = true;
    }
    if (!helpers.length) return;
    r.toneMapping = NoToneMapping;
    if (opts.helpers === "overlays") {
      this.renderOnly(helpers, camera);
      return;
    }
    r.clearDepth();
    this.depthOnly ??= new MeshBasicMaterial({ colorWrite: false });
    // Particles too: their batches draw instanced quads that only their own shader places, so under
    // an override material they'd write depth as one quad at the origin.
    const particles = this.particles?.root.visible ? this.particles.root : null;
    for (const o of helpers) o.visible = false;
    if (particles) particles.visible = false;
    this.scene.overrideMaterial = this.depthOnly;
    this.renderOverComposed(camera); // depth only, so meshes hide the grid
    this.scene.overrideMaterial = null;
    for (const o of helpers) o.visible = true;
    if (particles) particles.visible = true;
    this.renderOnly(helpers, camera);
  }

  /**
   * Render the scene over the composer's image without its background. three clears the canvas
   * whenever `scene.background` is a colour (autoClear or not), which a Fog with `affectsSkybox` sets
   * (ADR 0071), and draws a skybox texture as a fullscreen box: either would wipe the composed frame.
   */
  private renderOverComposed(camera: ThreeCamera): void {
    const background = this.scene.background;
    this.scene.background = null;
    try {
      this.renderer.render(this.scene, camera);
    } finally {
      this.scene.background = background;
    }
  }

  /** The editor's helpers in the scene that are showing: grid, axes, gizmos, outlines, overlays. */
  /** Overlays and selection outlines: what a game or play World can draw of the editor helpers. */
  private isGameOverlay(o: Object3D): boolean {
    return o === this.overlayLines || o === this.overlayHandles || this.overlaySegments.some((s) => s.object === o) || (this.outlines as Object3D[]).includes(o) || (this.boxOutlines as Object3D[]).includes(o);
  }

  /** Draws just `objects` (scene children) with `camera`, over what's already there. */
  private renderOnly(objects: readonly Object3D[], camera: ThreeCamera): void {
    const others = this.scene.children.filter((o) => o.visible && !objects.includes(o));
    for (const o of others) o.visible = false;
    this.renderOverComposed(camera);
    for (const o of others) o.visible = true;
  }

  private editorHelpers(): Object3D[] {
    const helpers: (Object3D | null)[] = [this.grid, this.axes, this.overlayLines, this.overlayHandles, ...this.overlaySegments.map((s) => s.object), this.gizmo?.getHelper() ?? null, this.lightWires, ...this.outlines, ...this.boxOutlines];
    for (const g of this.cameraGizmos.values()) helpers.push(g.icon, g.frustum);
    for (const icon of this.lightGizmos.values()) helpers.push(icon);
    for (const p of this.probes.values()) helpers.push(p.gizmo);
    return helpers.filter((o): o is Object3D => !!o && o.visible);
  }

  // --- UI (ADR 0069) ---------------------------------------------------------------------------------

  private ui: UIRuntime | null = null;
  private uiLoading = false;

  /**
   * Lays out and mirrors the World's UI components through pmndrs uikit, imported the first time the
   * World has a UICanvas (so games without UI never load it or Yoga). Screen canvases draw in the UI
   * pass after the cameras; world canvases join the scene. Pointer routing runs in `Input.beginFrame`.
   */
  private syncUI(world: World): void {
    if (!this.ui) {
      if (this.uiLoading || !world._componentsOfType(UICanvas).length) return;
      this.uiLoading = true;
      import("../ui/UIRuntime")
        .then((m) => {
          m.UIRuntime.prepare(this.renderer);
          this.ui = new m.UIRuntime({
            interactive: !this.fill, // the editor's own World: clicks select, they don't press buttons
            host: {
              scene: this.scene,
              camera: () => {
                const c = this.viewCameras(world)[0];
                return c ? (this.cameras.get(c)!.camera as ThreeCamera) : null;
              },
              texture: (ref) => this.texture(splitSpriteRef(ref).path),
            },
          });
        })
        .catch((err) => console.error("[myco] UI couldn't start:", err))
        .finally(() => (this.uiLoading = false));
      return;
    }
    this.ui.sync(world, this.canvas.clientWidth, this.canvas.clientHeight, world.time.unscaledDeltaTime);
  }

  /** @internal Tests and the editor: the UI runtime, once loaded. */
  uiRuntime(): UIRuntime | null {
    return this.ui;
  }

  // --- Particles (ADR 0057) -------------------------------------------------------------------------

  private particles: ParticleRenderer | null = null;
  private particlesLoading = false;
  /** Unlit particle materials for emitters without a material asset, by texture and blending. */
  private readonly particleMaterials = new Map<string, MeshBasicMaterial>();
  private particleDot: Texture | null = null;

  // --- Water (ADR 0072) ----------------------------------------------------------------------------

  /** Draws the World's WaterSurfaces; made the first time the World has one. */
  private water: WaterRenderer | null = null;

  private syncWater(world: World): void {
    const surfaces = world._componentsOfType(WaterSurface);
    if (!surfaces.length && !this.water) return;
    this.water ??= new WaterRenderer(this.scene, (x, y, z) => {
      const box = pickProbe({ x, y, z }, this.probeBoxes.map((p) => p.box));
      const hit = box && this.probeBoxes.find((p) => p.box === box);
      return hit ? { texture: hit.texture, intensity: hit.intensity } : null;
    });
    this.water.sync(world, surfaces);
  }

  /** @internal Tests: the water meshes drawn. */
  waterState(): { surfaces: number } {
    return { surfaces: this.water?.meshes().length ?? 0 };
  }

  /**
   * Plays the World's ParticleSystems through three.quarks, imported the first time the World has
   * one (so games without particles never load it).
   */
  private syncParticles(world: World): void {
    const systems = world._componentsOfType(ParticleSystem);
    if (!this.particles) {
      if (!systems.length || this.particlesLoading) return;
      this.particlesLoading = true;
      import("./particles/ParticleRenderer")
        .then((m) => {
          this.particles = new m.ParticleRenderer({
            scene: this.scene,
            editor: this.fill,
            material: (r) => this.particleMaterial(r),
            geometry: (mesh) => meshesIfLoaded(mesh)?.[0]?.geometry ?? null,
            worldMatrix: (c, out) => {
              const e = c.node.entity;
              out.fromArray((this.owner ?? world).worldMatrix(e), e * 16);
            },
            selected: (c) => this.isOutlined(c.node),
          });
          Object.assign(this.particles.preview, this.particlePreview); // what the editor set before it loaded
        })
        .catch((err) => console.error("[myco] particles couldn't start:", err))
        .finally(() => (this.particlesLoading = false));
      return;
    }
    this.particles.sync(systems, world.time.deltaTime, world.time.unscaledDeltaTime);
  }

  /** The material a particle emitter draws with: its material asset, or an unlit one with its texture (a soft dot by default). Null while a texture loads. */
  private particleMaterial(r: ParticleRendererSettings): Material | null {
    if (r.material) {
      const m = this.materialAsset(r.material);
      if (m) return m;
    }
    let map: Texture | null;
    if (r.texture) {
      map = this.textures.get(r.texture) ?? null;
      if (!map) {
        this.texture(r.texture).catch((err) => this.warnMaterial(`particles|${r.texture}`, `failed to load particle texture "${r.texture}": ${(err as Error).message}`));
        return null;
      }
    } else map = this.particleDot ??= makeParticleDot();
    const key = `${r.texture}|${r.blending}`;
    let m = this.particleMaterials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: r.blending === "additive" ? AdditiveBlending : NormalBlending, premultipliedAlpha: r.blending === "premultiplied" });
      this.particleMaterials.set(key, m);
    }
    return m;
  }

  /** @internal Editor: the scene view's particle preview (play/pause, speed, Simulate All). */
  setParticlePreview(preview: Partial<ParticlePreview>): void {
    this.particlePreview = { ...this.particlePreview, ...preview };
    if (this.particles) Object.assign(this.particles.preview, this.particlePreview);
  }

  private particlePreview: ParticlePreview = { playing: true, speed: 1, simulateAll: false };

  /** @internal Editor: restart the previewed particle effects. */
  restartParticlePreview(): void {
    this.particles?.restartAll();
  }

  /** @internal Tests and the editor: what the particle renderer is playing (null before it loads). */
  particleState(): ReturnType<ParticleRenderer["state"]> | null {
    return this.particles?.state() ?? null;
  }

  // --- Reflection probes (ADR 0054) ----------------------------------------------------------------

  private readonly probes = new Map<ReflectionProbe, { capture: ProbeCapture | null; captured: boolean; requests: number; box: ProbeBox; gizmo: LineSegments<BufferGeometry, LineBasicMaterial> | null }>();
  private probeBoxes: { box: ProbeBox; texture: Texture; intensity: number }[] = [];
  private probeIds = 0;
  private probeRound = 0;

  /**
   * Capture each active probe once the scene's meshes and textures have loaded (and again when
   * asked, or round-robin for `everyFrame` probes), at the tier's resolution; the boxes of the
   * captured ones decide which meshes reflect which probe.
   */
  private syncProbes(world: World): void {
    const resolution = PROBE_RESOLUTION[Graphics.tier.reflectionProbes];
    const seen = new Set<ReflectionProbe>();
    const live: [ReflectionProbe, NonNullable<ReturnType<RenderBackend["probes"]["get"]>>][] = [];
    for (const p of world._componentsOfType(ReflectionProbe)) {
      let entry = this.probes.get(p);
      if (!entry) {
        entry = { capture: null, captured: false, requests: p._captureRequests, box: { id: ++this.probeIds, center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }, gizmo: null };
        this.probes.set(p, entry);
      }
      seen.add(p);
      const e = p.node.entity;
      tmpWorld.fromArray(world.worldMatrix(e), e * 16);
      tmpPoint.setFromMatrixPosition(tmpWorld);
      const moved = entry.box.center.x !== tmpPoint.x || entry.box.center.y !== tmpPoint.y || entry.box.center.z !== tmpPoint.z;
      entry.box.center = { x: tmpPoint.x, y: tmpPoint.y, z: tmpPoint.z };
      entry.box.size = { x: Math.abs(p.size.x), y: Math.abs(p.size.y), z: Math.abs(p.size.z) };
      this.syncProbeGizmo(p, entry);
      if (!p.isActiveAndEnabled || !resolution) continue;
      if (entry.capture && entry.capture.resolution !== resolution) {
        entry.capture.dispose();
        entry.capture = null;
        entry.captured = false;
      }
      if (moved && entry.captured && p.refresh === "onLoad") entry.captured = false; // moved: recapture where it is now
      live.push([p, entry]);
    }
    for (const [p, entry] of [...this.probes]) {
      if (seen.has(p)) continue;
      entry.capture?.dispose();
      if (entry.gizmo) this.scene.remove(entry.gizmo);
      this.probes.delete(p);
    }
    const ready = this.loading.size === 0 && [...this.meshRenderers.values()].every((m) => m.sources !== null);
    if (ready) {
      const every = live.filter(([p]) => p.refresh === "everyFrame");
      for (const [p, entry] of live) {
        const asked = entry.requests !== p._captureRequests;
        if (!entry.captured || asked) this.captureProbe(p, entry);
      }
      // everyFrame probes: one recaptured per frame, round-robin.
      if (every.length) {
        const [p, entry] = every[this.probeRound++ % every.length];
        this.captureProbe(p, entry);
      }
    }
    this.probeBoxes = live.filter(([, e]) => e.captured && e.capture?.texture).map(([p, e]) => ({ box: e.box, texture: e.capture!.texture!, intensity: Math.max(0, p.intensity) }));
  }

  private captureProbe(p: ReflectionProbe, entry: NonNullable<ReturnType<RenderBackend["probes"]["get"]>>): void {
    entry.capture ??= new ProbeCapture(this.renderer, PROBE_RESOLUTION[Graphics.tier.reflectionProbes]);
    const c = entry.box.center;
    entry.capture.capture(this.scene, new ThreeVector3(c.x, c.y, c.z), this.editorHelpers());
    entry.captured = true;
    entry.requests = p._captureRequests;
  }

  /** Editor: a selected probe's box, as a wireframe. */
  private syncProbeGizmo(p: ReflectionProbe, entry: NonNullable<ReturnType<RenderBackend["probes"]["get"]>>): void {
    if (!this.fill) return;
    if (!entry.gizmo) {
      const box = new BufferGeometry();
      const v = [-1, -1, -1, 1, -1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, -1, 1, -1, -1, 1, -1, -1, -1, -1, -1, -1, 1, 1, -1, 1, 1, -1, 1, 1, 1, 1, 1, 1, 1, -1, 1, 1, -1, 1, 1, -1, -1, 1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1, -1, -1, 1, 1].map((n) => n / 2);
      box.setAttribute("position", new Float32BufferAttribute(v, 3));
      entry.gizmo = new LineSegments(box, new LineBasicMaterial({ fog: false, color: this.editorColors.outline, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }));
      entry.gizmo.matrixAutoUpdate = false;
      entry.gizmo.renderOrder = OUTLINE_ORDER;
      this.scene.add(entry.gizmo);
    }
    const g = entry.gizmo;
    g.visible = p.isActiveAndEnabled && this.isOutlined(p.node);
    g.matrix.makeScale(Math.max(entry.box.size.x, 0.001), Math.max(entry.box.size.y, 0.001), Math.max(entry.box.size.z, 0.001)).setPosition(entry.box.center.x, entry.box.center.y, entry.box.center.z);
    g.matrixWorldNeedsUpdate = true;
  }

  /** The probe a mesh reflects: the smallest box holding the centre of its bounds, if any. */
  private probeFor(sources: readonly ModelMesh[] | null): { texture: Texture; intensity: number } | null {
    if (!this.probeBoxes.length || !sources?.length) return null;
    const geo = sources[0].geometry;
    geo.boundingBox ?? geo.computeBoundingBox();
    geo.boundingBox!.getCenter(tmpCorner).applyMatrix4(tmpWorld);
    const box = pickProbe({ x: tmpCorner.x, y: tmpCorner.y, z: tmpCorner.z }, this.probeBoxes.map((p) => p.box));
    const hit = box && this.probeBoxes.find((p) => p.box === box);
    return hit ? { texture: hit.texture, intensity: hit.intensity } : null;
  }

  /** @internal Tests: each probe's state. */
  probeState(): { captured: number; probes: number; reflecting: number } {
    let reflecting = 0;
    for (const e of this.rendererMaterials.values()) if (e.probe) reflecting++;
    return { captured: this.probeBoxes.length, probes: this.probes.size, reflecting };
  }

  // --- Editor: camera preview (ADR 0022) --------------------------------------------------------

  private preview: { camera: Camera; frame: HTMLElement } | null = null;
  /** @internal Editor: true if the last frame drew a camera preview. */
  cameraPreviewDrawn = false;
  /** @internal Tests: true if the last camera preview went through the camera's composer (ADR 0056). */
  cameraPreviewComposed = false;

  /**
   * @internal Editor: draw what `camera` (a camera in the edited scene) sees into the part of the
   * canvas under `frame`, picture-in-picture, without the editor's grid, gizmos and overlays.
   * Null stops.
   */
  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void {
    this.preview = camera && frame ? { camera, frame } : null;
  }

  private renderCameraPreview(dt: number): void {
    this.cameraPreviewDrawn = false;
    const p = this.preview;
    const entry = p && p.camera.node.isValid && p.camera.isActiveAndEnabled ? this.cameras.get(p.camera) : undefined;
    if (!p || !entry) return;
    const canvasRect = this.canvas.getBoundingClientRect(), frame = p.frame.getBoundingClientRect();
    const x = frame.left - canvasRect.left, y = frame.top - canvasRect.top, w = frame.width, h = frame.height;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (w < 2 || h < 2 || cw <= 0 || ch <= 0) return;
    const camera = entry.camera;
    const aspect = w / h;
    if (camera instanceof OrthographicCamera) {
      const s = p.camera.orthographicSize;
      camera.left = -s * aspect;
      camera.right = s * aspect;
    } else {
      camera.aspect = aspect;
    }
    camera.updateProjectionMatrix(); // the next sync puts the editor's aspect back
    // The game's view has none of the editor's helpers.
    const shown = this.editorHelpers();
    for (const o of shown) o.visible = false;
    const r = this.renderer;
    const bottom = ch - y - h;
    const vp: PostViewport = { x, y: bottom, width: w, height: h };
    const bg = p.camera.backgroundColor;
    r.setClearColor(bg ? new ThreeColor(bg.toHex()) : this.clearColor, 1);
    // The previewed camera's own effects (ADR 0056), through its composer, drawn into the inset.
    const resolved = resolvePostEffects(this.postSettings(p.camera), Graphics.tier);
    r.toneMappingExposure = resolved.exposure;
    const stack = resolved.composer ? this.stackFor(p.camera) : null;
    const composed = !!stack && this.composeSafely(stack, resolved.composer!, camera, dt, { overlay: false, viewport: vp, helpers: "none" });
    this.setViewportRect(vp);
    if (!composed) {
      r.toneMapping = TONE_MAPPING[resolved.toneMapping];
      r.clear(true, true, true);
      r.render(this.scene, camera);
    }
    r.toneMapping = NoToneMapping;
    r.clearDepth();
    r.render(this.uiScene, this.uiCamera);
    this.setViewportRect(null);
    for (const o of shown) o.visible = true;
    this.cameraPreviewDrawn = true;
    this.cameraPreviewComposed = composed;
  }

  /**
   * @internal Free the surface for another World (ADR 0034), after its World was destroyed (which
   * released its objects). The Engine hands the view to the next World that wants it.
   */
  releaseWorld(): void {
    this.owner = null;
  }

  private claim(world: World): void {
    this.owner ??= world;
    if (this.owner !== world) throw new Error(`This render surface draws World "${this.owner.name}"; World "${world.name}" needs its own (ADR 0032).`);
  }

  /** Enabled cameras that draw the view, in depth order. */
  private viewCameras(world: World): Camera[] {
    return world
      ._componentsOfType(Camera)
      // A scene open in the editor keeps its cameras, but the editor's scene camera draws the view (ADR 0026).
      .filter((c) => c.isActiveAndEnabled && this.cameras.has(c) && !world.inEditMode(c.node.entity))
      .sort((a, b) => a.depth - b.depth);
  }

  // --- Editor: picking and selection outline (ADR 0022) ---------------------------------------

  private readonly outlined = new Set<GameObject>();
  private readonly outlines: LineLoop[] = [];
  private outlineGeometry: BufferGeometry | null = null;
  private outlineMaterial: LineBasicMaterial | null = null;

  /**
   * @internal Editor: nodes whose renderers lie under a canvas point (CSS pixels, origin
   * top-left), topmost first: screen-space text, then sprites by draw order (they draw without
   * depth testing), then nearest. Uses the camera that draws the view (the first in depth order).
   */
  pick(world: World, x: number, y: number): GameObject[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return [];
    const hits: { node: GameObject; order: number; distance: number }[] = [];

    // Screen-space text: the UI camera maps the reference resolution onto the canvas.
    const { width: W, height: H } = this.settings.display;
    const ux = (x / w) * W, uy = (1 - y / h) * H;
    for (const [t, entry] of this.texts) {
      if (!entry.mesh.visible) continue;
      const e = entry.mesh.matrix.elements; // scale (width, height) and position (cx, cy)
      if (Math.abs(ux - e[12]) <= e[0] / 2 && Math.abs(uy - e[13]) <= e[5] / 2) hits.push({ node: t.node, order: Infinity, distance: 0 });
    }

    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (camera) {
      ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      for (const [s, entry] of this.sprites) {
        if (!entry.mesh.visible) continue;
        entry.mesh.updateMatrixWorld();
        const distance = rayQuadDistance(raycaster.ray, entry.mesh.matrixWorld);
        if (distance !== null) hits.push({ node: s.node, order: entry.mesh.renderOrder, distance });
      }
    }

    // Meshes: depth-tested, so nearest first, below every sprite.
    if (camera) {
      for (const [r, entry] of this.meshRenderers) {
        for (const o of entry.objects) {
          if (!o.visible) continue;
          o.updateMatrixWorld();
          const hit = raycaster.intersectObject(o, false)[0];
          if (hit) hits.push({ node: r.node, order: MESH_ORDER, distance: hit.distance });
        }
      }
    }

    // Camera and light icons: a small circle on screen around each icon, above every sprite.
    if (camera) {
      const icons: [GameObject, ThreeSprite][] = [...[...this.cameraGizmos].map(([c, g]): [GameObject, ThreeSprite] => [c.node, g.icon]), ...[...this.lightGizmos].map(([l, icon]): [GameObject, ThreeSprite] => [l.node, icon])];
      for (const [node, icon] of icons) {
        if (!icon.visible) continue;
        tmpPoint.setFromMatrixPosition(icon.matrixWorld).project(camera);
        if (tmpPoint.z < -1 || tmpPoint.z > 1) continue; // behind the camera or beyond far
        const sx = ((tmpPoint.x + 1) / 2) * w, sy = ((1 - tmpPoint.y) / 2) * h;
        if (Math.hypot(sx - x, sy - y) <= CAMERA_ICON_PICK_RADIUS) hits.push({ node, order: OUTLINE_ORDER, distance: 0 });
      }
    }

    hits.sort((a, b) => b.order - a.order || a.distance - b.distance);
    const seen = new Set<number>();
    return hits.filter((h) => !seen.has(h.node.entity) && seen.add(h.node.entity)).map((h) => h.node);
  }

  /**
   * @internal Editor: a sprite's size in its node's units (before the node's scale): its `size`,
   * or its texture's pixel size over pixels-per-unit. Null while the texture hasn't loaded.
   */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.sprites.get(s)?.size ?? null;
  }

  /**
   * @internal Editor: the world-space box around the meshes of `node`'s MeshRenderers, or null if
   * it has none drawn (no MeshRenderer, or its model hasn't loaded).
   */
  meshBounds(node: GameObject): { min: [number, number, number]; max: [number, number, number] } | null {
    tmpBox.makeEmpty();
    for (const [r, entry] of this.meshRenderers) {
      if (r.node !== node) continue;
      for (const o of entry.objects) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        o.updateMatrixWorld();
        tmpBox.union(new Box3().copy(o.geometry.boundingBox!).applyMatrix4(o.matrixWorld));
      }
    }
    return tmpBox.isEmpty() ? null : { min: tmpBox.min.toArray(), max: tmpBox.max.toArray() };
  }

  /** @internal Editor: the ray under a canvas point (CSS pixels) through the camera that draws the view, or null. */
  rayAt(world: World, x: number, y: number): { origin: [number, number, number]; direction: [number, number, number] } | null {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!camera || w <= 0 || h <= 0) return null;
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return { origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() };
  }

  /** @internal Editor: a world point's place on the canvas (CSS pixels, origin top-left), or null if it's behind the camera. */
  worldToCanvas(world: World, p: readonly number[]): [number, number] | null {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!camera || w <= 0 || h <= 0) return null;
    tmpPoint.set(p[0], p[1], p[2] ?? 0).project(camera);
    if (tmpPoint.z < -1 || tmpPoint.z > 1) return null;
    return [((tmpPoint.x + 1) / 2) * w, ((1 - tmpPoint.y) / 2) * h];
  }

  /**
   * @internal Editor: where each active node under `root` with a Transform is on the canvas (CSS
   * pixels, origin top-left): the rectangle around its sprite or text, or (with neither) a point
   * at its origin. Nodes behind the camera are left out. Parents come before children.
   */
  screenBounds(world: World, root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!camera || w <= 0 || h <= 0) return [];
    const sprites = new Map<GameObject, Mesh>(), texts = new Map<GameObject, Mesh>(), meshes = new Map<GameObject, Mesh[]>();
    for (const [s, entry] of this.sprites) if (entry.mesh.visible) sprites.set(s.node, entry.mesh);
    for (const [r, entry] of this.meshRenderers) {
      const shown = entry.objects.filter((o) => o.visible);
      if (shown.length) meshes.set(r.node, [...(meshes.get(r.node) ?? []), ...shown]);
    }
    for (const [t, entry] of this.texts) if (entry.mesh.visible) texts.set(t.node, entry.mesh);
    const { width: W, height: H } = this.settings.display;

    /** Grow `rect` by a world point's place on the canvas; false if it's behind the camera. */
    const add = (rect: ScreenRect, p: ThreeVector3): boolean => {
      p.project(camera);
      if (p.z < -1 || p.z > 1) return false;
      const x = ((p.x + 1) / 2) * w, y = ((1 - p.y) / 2) * h;
      rect.left = Math.min(rect.left, x);
      rect.right = Math.max(rect.right, x);
      rect.top = Math.min(rect.top, y);
      rect.bottom = Math.max(rect.bottom, y);
      return true;
    };
    const boundsOf = (node: GameObject): ScreenRect | null => {
      const rect: ScreenRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      const text = texts.get(node);
      if (text) {
        // Screen-space text: the UI camera maps the reference resolution onto the canvas.
        const e = text.matrix.elements;
        return { left: ((e[12] - e[0] / 2) / W) * w, right: ((e[12] + e[0] / 2) / W) * w, top: (1 - (e[13] + e[5] / 2) / H) * h, bottom: (1 - (e[13] - e[5] / 2) / H) * h };
      }
      const sprite = sprites.get(node);
      if (sprite) {
        sprite.updateMatrixWorld();
        for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
          if (!add(rect, tmpPoint.set(cx, cy, 0).applyMatrix4(sprite.matrixWorld))) return null;
        }
        return rect;
      }
      const drawn = meshes.get(node);
      if (drawn) {
        for (const o of drawn) {
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          o.updateMatrixWorld();
          const { min, max } = o.geometry.boundingBox!;
          for (let i = 0; i < 8; i++) {
            tmpCorner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(o.matrixWorld);
            if (!add(rect, tmpPoint.copy(tmpCorner))) return null;
          }
        }
        return rect;
      }
      tmpWorld.fromArray(world.worldMatrix(node.entity), node.entity * 16);
      return add(rect, tmpPoint.setFromMatrixPosition(tmpWorld)) ? rect : null;
    };

    const out: { node: GameObject; rect: ScreenRect }[] = [];
    const visit = (node: GameObject): void => {
      if (world.isPendingDestroy(node.entity) || !node.activeInHierarchy) return;
      const rect = node.transform ? boundsOf(node) : null;
      if (rect) out.push({ node, rect });
      for (const c of node.children) visit(c);
    };
    visit(root);
    return out;
  }

  /**
   * @internal Editor: the world point on the plane z = `z` under a canvas point (CSS pixels),
   * seen through the camera that draws the view; null if the ray misses the plane (looking
   * along it or away from it).
   */
  pointOnPlaneZ(world: World, x: number, y: number, z = 0): [number, number, number] | null {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!camera || w <= 0 || h <= 0) return null;
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (z - origin.z) / direction.z;
    if (t < 0) return null;
    return [origin.x + direction.x * t, origin.y + direction.y * t, z];
  }

  /**
   * @internal Editor: the world point on a plane (through `point`, facing `normal`) under a canvas
   * point (CSS pixels); null if the ray misses it.
   */
  pointOnPlane(world: World, x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null {
    const ray = this.rayAt(world, x, y);
    if (!ray) return null;
    const [ox, oy, oz] = ray.origin, [dx, dy, dz] = ray.direction;
    const denom = normal[0] * dx + normal[1] * dy + normal[2] * dz;
    if (Math.abs(denom) < 1e-6) return null;
    const t = (normal[0] * (point[0] - ox) + normal[1] * (point[1] - oy) + normal[2] * (point[2] - oz)) / denom;
    if (t < 0) return null;
    return [ox + dx * t, oy + dy * t, oz + dz * t];
  }

  /** @internal Editor: outline the sprites and meshes of these nodes and their descendants, every frame. */
  setSelectionOutline(nodes: readonly GameObject[]): void {
    this.outlined.clear();
    for (const n of nodes) this.outlined.add(n);
  }

  private outlineShown = true;

  /** @internal Editor: show or hide the selection outline without forgetting what's selected (play mode's Gizmos menu). */
  setSelectionOutlineShown(shown: boolean): void {
    this.outlineShown = shown;
  }

  /**
   * @internal Editor: what the last frame drew for the whole view (every camera and the UI), from
   * the renderer's counters: draw calls, primitives, and the GPU resources alive now.
   */
  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number } {
    const { render, memory, programs } = this.renderer.info;
    return { drawCalls: render.calls, triangles: render.triangles, lines: render.lines, points: render.points, geometries: memory.geometries, textures: memory.textures, programs: programs?.length ?? 0 };
  }

  /** Overlay objects drawn: this frame so far, and in the whole last frame. */
  private readonly overlayDraws = { count: 0, last: 0 };

  /**
   * @internal Editor and tests: how much editor drawing is showing now: overlay line segments (lines and bulk groups),
   * handles, outlines, and how many overlay objects the last frame really drew (0 when something hid them, e.g. a
   * post-processing pass that didn't draw them back).
   */
  editorDrawingShown(): { segments: number; handles: number; outlines: number; drawnObjects: number } {
    const count = (o: { visible: boolean; geometry: BufferGeometry } | null): number => {
      if (!o?.visible) return 0;
      const n = o.geometry.drawRange.count; // Infinity: the whole buffer
      return Number.isFinite(n) ? n : (o.geometry.getAttribute("position")?.count ?? 0);
    };
    let segments = Math.floor(count(this.overlayLines) / 2);
    for (const s of this.overlaySegments) segments += Math.floor(count(s.object) / 2);
    const outlines = this.outlines.filter((o) => o.visible).length + this.boxOutlines.filter((o) => o.visible).length;
    return { segments, handles: count(this.overlayHandles), outlines, drawnObjects: this.overlayDraws.last };
  }

  /** Position one outline per selected sprite, and a box around each selected mesh (called from `sync`, after renderers). */
  private syncOutlines(): void {
    let used = 0, boxes = 0;
    if (this.outlined.size > 0 && this.outlineShown) {
      for (const [s, entry] of this.sprites) {
        if (!entry.mesh.visible || !this.isOutlined(s.node)) continue;
        const line = this.outlines[used] ?? this.createOutline();
        line.matrix.copy(entry.mesh.matrix);
        line.matrixWorldNeedsUpdate = true;
        line.visible = true;
        used++;
      }
      for (const [r, entry] of this.meshRenderers) {
        if (!this.isOutlined(r.node)) continue;
        for (const o of entry.objects) {
          if (!o.visible) continue;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const b = o.geometry.boundingBox!;
          const box = this.boxOutlines[boxes] ?? this.createBoxOutline();
          b.getCenter(tmpPoint);
          b.getSize(tmpCorner).max(new ThreeVector3(1e-4, 1e-4, 1e-4));
          box.matrix.copy(o.matrix).multiply(tmpScale.makeTranslation(tmpPoint.x, tmpPoint.y, tmpPoint.z)).multiply(tmpPivot.makeScale(tmpCorner.x, tmpCorner.y, tmpCorner.z));
          box.matrixWorldNeedsUpdate = true;
          box.visible = true;
          boxes++;
        }
      }
    }
    for (let i = used; i < this.outlines.length; i++) this.outlines[i].visible = false;
    for (let i = boxes; i < this.boxOutlines.length; i++) this.boxOutlines[i].visible = false;
  }

  private readonly boxOutlines: LineSegments[] = [];
  private boxOutlineGeometry: BufferGeometry | null = null;

  /** A unit cube's twelve edges in the selection colour, scaled onto a mesh's bounds. */
  private createBoxOutline(): LineSegments {
    if (!this.boxOutlineGeometry) {
      const c = (i: number) => [i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5];
      const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      this.boxOutlineGeometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(edges.flatMap(([a, b]) => [...c(a), ...c(b)]), 3));
    }
    this.outlineMaterial ??= new LineBasicMaterial({ fog: false, color: this.editorColors.outline, depthTest: false, depthWrite: false, transparent: true });
    const box = new LineSegments(this.boxOutlineGeometry, this.outlineMaterial);
    box.matrixAutoUpdate = false;
    box.frustumCulled = false;
    box.renderOrder = OUTLINE_ORDER;
    this.scene.add(box);
    this.boxOutlines.push(box);
    return box;
  }

  private isOutlined(node: GameObject): boolean {
    for (const n of this.outlined) {
      if (!n.isValid) continue;
      for (let p: GameObject | null = node; p; p = p.parent) if (p === n) return true;
    }
    return false;
  }

  private createOutline(): LineLoop {
    this.outlineGeometry ??= new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    this.outlineMaterial ??= new LineBasicMaterial({ fog: false, color: this.editorColors.outline, depthTest: false, depthWrite: false, transparent: true });
    const line = new LineLoop(this.outlineGeometry, this.outlineMaterial);
    line.matrixAutoUpdate = false;
    line.frustumCulled = false;
    line.renderOrder = OUTLINE_ORDER;
    this.scene.add(line);
    this.outlines.push(line);
    return line;
  }

  // --- Editor: overlay lines and handles (ADR 0022) ----------------------------------------------

  private overlayProvider: (() => EditorOverlay) | null = null;
  private overlayLines: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  private overlayHandles: Points<BufferGeometry, PointsMaterial> | null = null;
  private overlaySegments: { positions: Float32Array; color: number; object: LineSegments<BufferGeometry, LineBasicMaterial> }[] = [];
  private overlayHandleIds: string[] = [];

  /** @internal Editor: draw what `provider` returns every frame (null stops). */
  setOverlayProvider(provider: (() => EditorOverlay) | null): void {
    this.overlayProvider = provider;
  }

  /** @internal Editor: where each overlay handle is on the canvas (CSS pixels); handles behind the camera are left out. */
  overlayHandlesOnCanvas(world: World): { id: string; x: number; y: number }[] {
    const points = this.overlayHandles;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!points || !points.visible || !camera) return [];
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pos = points.geometry.getAttribute("position") as Float32BufferAttribute;
    const out: { id: string; x: number; y: number }[] = [];
    this.overlayHandleIds.forEach((id, i) => {
      tmpPoint.set(pos.getX(i), pos.getY(i), pos.getZ(i)).project(camera);
      if (tmpPoint.z >= -1 && tmpPoint.z <= 1) out.push({ id, x: ((tmpPoint.x + 1) / 2) * w, y: ((1 - tmpPoint.y) / 2) * h });
    });
    return out;
  }

  /**
   * @internal Editor: the id of the overlay handle under a canvas point (CSS pixels), nearest
   * within `radius` pixels, or null.
   */
  pickOverlayHandle(world: World, x: number, y: number, radius = 9): string | null {
    let best: string | null = null, bestDistance = radius;
    for (const h of this.overlayHandlesOnCanvas(world)) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = h.id;
      }
    }
    return best;
  }

  private syncOverlay(): void {
    const overlay = this.overlayProvider?.() ?? { lines: [], handles: [] };
    // Lines: one LineSegments with per-vertex colours, refilled each frame (a few hundred vertices).
    const segs: number[] = [], colors: number[] = [];
    const rgb = (c: number) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
    for (const line of overlay.lines) {
      const p = line.points, n = line.closed ? p.length : p.length - 1;
      const [r, g, b] = rgb(line.color);
      for (let i = 0; i < n; i++) {
        const a = p[i], q = p[(i + 1) % p.length];
        segs.push(a[0], a[1], a[2], q[0], q[1], q[2]);
        colors.push(r, g, b, r, g, b);
      }
    }
    this.syncOverlaySegments(overlay.segments ?? []);
    // Both are transparent so they draw after the (transparent) sprites, in render order.
    this.overlayLines ??= this.addOverlayObject(
      new LineSegments(new BufferGeometry(), new LineBasicMaterial({ fog: false, vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })),
      OUTLINE_ORDER - 2,
    );
    fillOverlayGeometry(this.overlayLines, segs, colors);
    // Handles: fixed-size squares (points without size attenuation), drawn above the lines.
    const hp: number[] = [], hc: number[] = [];
    for (const h of overlay.handles) {
      hp.push(...h.position);
      hc.push(...rgb(h.color));
    }
    this.overlayHandles ??= this.addOverlayObject(
      new Points(new BufferGeometry(), new PointsMaterial({ fog: false, size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, transparent: true })),
      OUTLINE_ORDER + 2,
    );
    fillOverlayGeometry(this.overlayHandles, hp, hc);
    this.overlayHandleIds = overlay.handles.map((h) => h.id);
  }

  /**
   * Bulk segment groups (navigation debug drawing, ADR 0065): one LineSegments per group, drawn straight from the
   * group's Float32Array. Providers hand back the same array while nothing changed (they memoise), so a group is
   * uploaded to the GPU only when its array or colour changes, not every frame.
   */
  private syncOverlaySegments(groups: readonly { positions: Float32Array; color: number }[]): void {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      let slot = this.overlaySegments[i];
      if (slot && slot.positions === group.positions && slot.color === group.color) continue;
      if (!slot) {
        const object = this.addOverlayObject(
          new LineSegments(new BufferGeometry(), new LineBasicMaterial({ fog: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })),
          OUTLINE_ORDER - 2,
        );
        slot = { positions: group.positions, color: group.color, object };
        this.overlaySegments.push(slot);
      }
      const usable = group.positions.length - (group.positions.length % 3);
      slot.object.geometry.dispose(); // frees the old GPU buffer
      slot.object.geometry = new BufferGeometry();
      slot.object.geometry.setAttribute("position", new Float32BufferAttribute(group.positions.subarray(0, usable), 3));
      const c = group.color;
      // Raw 0–1 channels like the vertex-coloured overlay lines (no sRGB conversion), so colours match.
      slot.object.material.color.setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, NoColorSpace);
      slot.object.visible = usable > 0;
      slot.positions = group.positions;
      slot.color = c;
    }
    for (const slot of this.overlaySegments.splice(groups.length)) {
      this.scene.remove(slot.object);
      slot.object.geometry.dispose();
      slot.object.material.dispose();
    }
  }

  private addOverlayObject<T extends LineSegments<BufferGeometry, LineBasicMaterial> | Points<BufferGeometry, PointsMaterial>>(object: T, renderOrder: number): T {
    object.frustumCulled = false;
    object.renderOrder = renderOrder;
    object.onAfterRender = () => void this.overlayDraws.count++; // what actually reached the screen (editorDrawingShown)
    this.scene.add(object);
    return object;
  }

  // --- Editor: camera gizmos (ADR 0022) --------------------------------------------------------

  private readonly cameraGizmos = new Map<Camera, { icon: ThreeSprite; frustum: LineSegments<BufferGeometry, LineBasicMaterial> }>();
  private cameraIconMaterial: SpriteMaterial | null = null;

  /**
   * Cameras inside the edited scene don't draw the editor's view (see `viewCameras`), so the
   * editor shows each as an icon (clickable, constant size on screen) and a wireframe of what it
   * sees at the game's aspect ratio; selected cameras are drawn in the selection colour.
   */
  private syncCameraGizmos(world: World): void {
    const seen = new Set<Camera>();
    const aspect = this.settings.display.width / this.settings.display.height;
    // Icons keep a constant size on screen. three.js does that itself for perspective views
    // (sizeAttenuation: false) but not orthographic ones, where the scale is in world units.
    const view = this.viewCameras(world)[0];
    const viewCamera = view && this.cameras.get(view)?.camera;
    const iconScale = viewCamera instanceof OrthographicCamera ? (CAMERA_ICON_SIZE * (viewCamera.top - viewCamera.bottom)) / viewCamera.zoom : CAMERA_ICON_SIZE;
    for (const c of world._componentsOfType(Camera)) {
      if (!world.inEditMode(c.node.entity)) continue; // the editor's own camera has no gizmo
      seen.add(c);
      const entry = this.cameraGizmos.get(c) ?? this.createCameraGizmo(c);
      const visible = c.node.activeInHierarchy;
      entry.icon.visible = entry.frustum.visible = visible;
      if (!visible) continue;
      const e = c.node.entity;
      tmpWorld.fromArray(world.worldMatrix(e), e * 16);
      entry.frustum.matrix.copy(tmpWorld);
      entry.frustum.matrixWorldNeedsUpdate = true;
      const positions = entry.frustum.geometry.getAttribute("position") as Float32BufferAttribute;
      positions.copyArray(frustumSegments({ projection: c.projection, orthographicSize: c.orthographicSize, fieldOfView: c.fieldOfView, aspect, near: c.near, far: c.far }));
      positions.needsUpdate = true;
      entry.frustum.geometry.computeBoundingSphere();
      entry.frustum.material.color.setHex(this.isOutlined(c.node) ? this.editorColors.outline : this.editorColors.cameraGizmo);
      entry.icon.position.setFromMatrixPosition(tmpWorld);
      entry.icon.scale.set(iconScale, iconScale, 1);
      entry.icon.updateMatrixWorld();
    }
    for (const [c, entry] of this.cameraGizmos) {
      if (seen.has(c) && c.node.isValid) continue;
      this.scene.remove(entry.icon, entry.frustum);
      entry.frustum.geometry.dispose();
      entry.frustum.material.dispose();
      this.cameraGizmos.delete(c);
    }
  }

  private createCameraGizmo(c: Camera): { icon: ThreeSprite; frustum: LineSegments<BufferGeometry, LineBasicMaterial> } {
    this.cameraIconMaterial ??= new SpriteMaterial({
      fog: false,
      map: cameraIconTexture(),
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const icon = new ThreeSprite(this.cameraIconMaterial);
    icon.scale.set(CAMERA_ICON_SIZE, CAMERA_ICON_SIZE, 1);
    icon.renderOrder = OUTLINE_ORDER;
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(24 * 3), 3));
    const frustum = new LineSegments(geometry, new LineBasicMaterial({ fog: false, color: this.editorColors.cameraGizmo, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }));
    frustum.matrixAutoUpdate = false;
    frustum.frustumCulled = false;
    frustum.renderOrder = OUTLINE_ORDER - 1;
    this.scene.add(frustum, icon);
    const entry = { icon, frustum };
    this.cameraGizmos.set(c, entry);
    return entry;
  }

  // --- Editor: light gizmos (ADR 0043) -----------------------------------------------------------

  private readonly lightGizmos = new Map<Light, ThreeSprite>();
  private readonly lightIconMaterials = new Map<string, SpriteMaterial>();
  private lightWires: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;

  /**
   * Lights in the edited scene show as clickable icons (constant size on screen) and wireframes:
   * a directional light's direction, a spot light's cone, and (selected) a point light's range.
   * Selected lights are drawn in the selection colour.
   */
  private syncLightGizmos(world: World): void {
    const seen = new Set<Light>();
    const view = this.viewCameras(world)[0];
    const viewCamera = view && this.cameras.get(view)?.camera;
    const iconScale = viewCamera instanceof OrthographicCamera ? (LIGHT_ICON_SIZE * (viewCamera.top - viewCamera.bottom)) / viewCamera.zoom : LIGHT_ICON_SIZE;
    const segs: number[] = [], colors: number[] = [];
    const rgb = (c: number) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
    for (const l of world._componentsOfType(Light)) {
      if (!world.inEditMode(l.node.entity)) continue;
      seen.add(l);
      let icon = this.lightGizmos.get(l);
      if (!icon) {
        icon = new ThreeSprite(this.lightIconMaterial(l.type));
        icon.renderOrder = OUTLINE_ORDER;
        this.scene.add(icon);
        this.lightGizmos.set(l, icon);
      }
      icon.material = this.lightIconMaterial(l.type);
      icon.visible = l.node.activeInHierarchy;
      if (!icon.visible) continue;
      const e = l.node.entity;
      tmpWorld.fromArray(world.worldMatrix(e), e * 16);
      icon.position.setFromMatrixPosition(tmpWorld);
      icon.scale.set(iconScale, iconScale, 1);
      icon.updateMatrixWorld();
      const selected = this.isOutlined(l.node);
      const [r, g, b] = rgb(selected ? this.editorColors.outline : this.editorColors.cameraGizmo);
      for (const [a, q] of lightSegments(l, tmpWorld, selected)) {
        segs.push(...a, ...q);
        colors.push(r, g, b, r, g, b);
      }
    }
    for (const [l, icon] of this.lightGizmos) {
      if (seen.has(l) && l.node.isValid) continue;
      this.scene.remove(icon);
      this.lightGizmos.delete(l);
    }
    this.lightWires ??= this.addOverlayObject(
      new LineSegments(new BufferGeometry(), new LineBasicMaterial({ fog: false, vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 })),
      OUTLINE_ORDER - 1,
    );
    fillOverlayGeometry(this.lightWires, segs, colors);
  }

  private lightIconMaterial(type: string): SpriteMaterial {
    let m = this.lightIconMaterials.get(type);
    if (!m) {
      m = new SpriteMaterial({ fog: false, map: lightIconTexture(type), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
      this.lightIconMaterials.set(type, m);
    }
    return m;
  }

  /** @internal Editor: where each light icon in the edited scene is on the canvas (for tests), by node name. */
  lightIconsOnCanvas(world: World): { node: GameObject; x: number; y: number }[] {
    const out: { node: GameObject; x: number; y: number }[] = [];
    for (const [l, icon] of this.lightGizmos) {
      if (!icon.visible) continue;
      const p = this.worldToCanvas(world, icon.position.toArray());
      if (p) out.push({ node: l.node, x: p[0], y: p[1] });
    }
    return out;
  }

  /** @internal Editor: how many light wireframe segments were drawn last frame (for tests). */
  lightWireCount(): number {
    return this.lightWires?.visible ? this.lightWires.geometry.drawRange.count / 2 : 0;
  }

  // --- Editor: transform gizmo (ADR 0022) ------------------------------------------------------

  private gizmo: TransformControls | null = null;
  private gizmoLoading: Promise<void> | null = null;
  /** Stand-in the gizmo moves; synced from the target nodes while not dragging. */
  private readonly gizmoProxy = new Object3D();
  private gizmoTargets: readonly GameObject[] = [];
  /** World matrices when the drag started: the proxy's and each target's. */
  private gizmoStart: { proxy: Matrix4; targets: Matrix4[] } | null = null;
  private gizmoOptions: GizmoOptions = { mode: "translate", planar: false, snap: false };
  private gizmoHandlers: GizmoHandlers | null = null;
  private gizmoDragging = false;
  private gizmoWorld: World | null = null;

  /**
   * @internal Editor: show a move/rotate/scale gizmo on `nodes` (none hides it). One node: the
   * gizmo sits on it, aligned with it. Several: it sits at their centre, aligned with the world,
   * and moves, turns or scales them all around that point. Drags report the nodes' new local
   * poses through `handlers`; the editor turns them into commands. Don't pass a node together
   * with one of its descendants, or the descendant moves twice.
   */
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmoTargets = nodes;
    this.gizmoOptions = options;
    this.gizmoHandlers = handlers;
    if (nodes.length > 0 && !this.gizmo && !this.gizmoLoading) this.gizmoLoading = this.loadGizmo();
    this.applyGizmoOptions();
  }

  /**
   * @internal Editor: true while dragging the gizmo, or if a canvas point (CSS pixels) is over
   * one of its handles. Hit-tests directly rather than trusting hover state, which is stale
   * when a press arrives without a preceding move.
   */
  gizmoActiveAt(x: number, y: number): boolean {
    const c = this.gizmo;
    if (!c || !c.enabled) return false;
    if (this.gizmoDragging) return true;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const pointer = { x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1, button: -1 };
    c.pointerHover(pointer as unknown as PointerEvent); // TransformControls takes {x, y, button} in NDC
    return c.axis !== null;
  }

  private async loadGizmo(): Promise<void> {
    // Loaded on first use so game bundles never include the editor's gizmo code.
    const { TransformControls } = await import("three/examples/jsm/controls/TransformControls.js");
    const controls = new TransformControls(new PerspectiveCamera(), this.canvas);
    this.gizmoProxy.matrixAutoUpdate = true;
    this.scene.add(this.gizmoProxy);
    const helper = controls.getHelper();
    helper.renderOrder = OUTLINE_ORDER + 1;
    this.scene.add(helper);
    controls.attach(this.gizmoProxy);
    controls.addEventListener("dragging-changed", (e) => {
      this.gizmoDragging = Boolean((e as { value?: unknown }).value);
      if (this.gizmoDragging) {
        this.gizmoStart = this.gizmoWorld ? this.gizmoMatrices(this.gizmoWorld) : null;
        this.gizmoHandlers?.onStart();
      } else {
        this.gizmoStart = null;
        this.gizmoHandlers?.onEnd();
      }
    });
    controls.addEventListener("objectChange", () => {
      const poses = this.gizmoDragging ? this.gizmoPoses() : null;
      if (poses) this.gizmoHandlers?.onChange(poses);
    });
    this.gizmo = controls;
    this.applyGizmoOptions();
  }

  private applyGizmoOptions(): void {
    const c = this.gizmo;
    if (!c) return;
    const { mode, planar, snap } = this.gizmoOptions;
    const steps = this.gizmoOptions.snapSteps ?? { move: 0.25, rotate: 15, scale: 0.1 };
    const step = (n: number) => (n > 0 && Number.isFinite(n) ? n : null);
    c.setMode(mode);
    c.setSpace(this.gizmoOptions.space === "local" ? "local" : "world");
    c.showX = !(planar && mode === "rotate");
    c.showY = !(planar && mode === "rotate");
    c.showZ = !planar || mode === "rotate";
    c.setTranslationSnap(snap ? step(steps.move) : null);
    c.setRotationSnap(snap && step(steps.rotate) ? (steps.rotate * Math.PI) / 180 : null);
    c.setScaleSnap(snap ? step(steps.scale) : null);
  }

  private gizmoMatrices(world: World): { proxy: Matrix4; targets: Matrix4[] } {
    this.gizmoProxy.updateMatrix();
    return {
      proxy: this.gizmoProxy.matrix.clone(),
      targets: this.gizmoTargets.map((n) => new Matrix4().fromArray(world.worldMatrix(n.entity), n.entity * 16)),
    };
  }

  /**
   * The targets' local poses implied by how the gizmo has moved the proxy since the drag began:
   * the same change (new proxy x inverse of the start proxy) applied to each target's start pose.
   */
  private gizmoPoses(): LocalPose[] | null {
    const start = this.gizmoStart, world = this.gizmoWorld;
    if (!start || !world || !this.gizmoTargets.every((n) => n.isValid)) return null;
    this.gizmoProxy.updateMatrix();
    const delta = this.gizmoProxy.matrix.clone().multiply(start.proxy.clone().invert());
    const position = new ThreeVector3(), quaternion = new Quaternion(), scale = new ThreeVector3();
    return this.gizmoTargets.map((node, i) => {
      if (this.gizmoTargets.length === 1) {
        // Exactly the proxy, so a single node never picks up rounding error.
        position.copy(this.gizmoProxy.position);
        quaternion.copy(this.gizmoProxy.quaternion);
        scale.copy(this.gizmoProxy.scale);
      } else {
        delta.clone().multiply(start.targets[i]).decompose(position, quaternion, scale);
      }
      const parent = node.parent;
      const parentWorld = parent ? new Matrix4().fromArray(world.worldMatrix(parent.entity), parent.entity * 16) : null;
      return localPoseFromWorld(parentWorld?.elements ?? null, position, quaternion, scale);
    });
  }

  private syncGizmo(world: World): void {
    const c = this.gizmo;
    if (!c) return;
    this.gizmoWorld = world;
    const nodes = this.gizmoTargets.filter((n) => n.isValid && n.transform && n.activeInHierarchy);
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    const show = !!camera && nodes.length > 0 && nodes.length === this.gizmoTargets.length;
    c.enabled = show;
    c.getHelper().visible = show;
    if (!show) return;
    c.camera = camera;
    if (!this.gizmoDragging) {
      const proxy = this.gizmoProxy;
      if (nodes.length === 1) {
        const e = nodes[0].entity;
        tmpWorld.fromArray(world.worldMatrix(e), e * 16);
        tmpWorld.decompose(proxy.position, proxy.quaternion, proxy.scale);
      } else {
        // Several: at their centre or on the active node's origin; turned like the active node in local space.
        const { pivot, space, activeIndex } = this.gizmoOptions;
        const active = nodes[Math.min(Math.max(activeIndex ?? nodes.length - 1, 0), nodes.length - 1)];
        tmpWorld.fromArray(world.worldMatrix(active.entity), active.entity * 16);
        tmpWorld.decompose(proxy.position, proxy.quaternion, proxy.scale);
        if (pivot !== "pivot") {
          proxy.position.set(0, 0, 0);
          for (const n of nodes) proxy.position.add(tmpPoint.setFromMatrixPosition(tmpWorld.fromArray(world.worldMatrix(n.entity), n.entity * 16)));
          proxy.position.divideScalar(nodes.length);
        }
        if (space !== "local") proxy.quaternion.identity();
        proxy.scale.set(1, 1, 1);
      }
      proxy.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    this.dropCascades();
    this.ui?.dispose();
    this.ui = null;
    this.particles?.dispose();
    this.water?.dispose();
    for (const m of this.particleMaterials.values()) m.dispose();
    this.particleDot?.dispose();
    for (const m of this.localMaterials.values()) m.dispose();
    this.localMaterials.clear();
    for (const s of this.stacks.values()) s.dispose();
    this.stacks.clear();
    for (const p of this.probes.values()) p.capture?.dispose();
    this.envMap?.lighting?.dispose();
    this.envMap?.sky?.dispose();
    this.depthOnly?.dispose();
    this.gizmo?.dispose();
    for (const m of [...this.meshRenderers.keys()]) this.release(m);
    for (const l of [...this.lights.keys()]) this.release(l);
    for (const e of this.materialAssets.values()) {
      e.material?.dispose();
      e.graph?.dispose();
      for (const t of e.textures) t.dispose();
    }
    for (const m of this.lightIconMaterials.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.lightWires?.geometry.dispose();
    this.lightWires?.material.dispose();
    this.boxOutlineGeometry?.dispose();
    this.environment?.dispose();
    this.defaultMaterial.dispose();
    for (const r of [...this.rendererMaterials.keys()]) this.releaseRendererMaterial(r);
    for (const t of this.linearTextures.values()) t.dispose();
    this.linearTextures.clear();
    this.overlayLines?.geometry.dispose();
    this.overlayLines?.material.dispose();
    this.overlayHandles?.geometry.dispose();
    this.overlayHandles?.material.dispose();
    for (const slot of this.overlaySegments) {
      slot.object.geometry.dispose();
      slot.object.material.dispose();
    }
    this.overlaySegments = [];
    this.cameraIconMaterial?.map?.dispose();
    this.cameraIconMaterial?.dispose();
    this.resizeObserver.disconnect();
    this.outlineGeometry?.dispose();
    this.outlineMaterial?.dispose();
    for (const s of [...this.sprites.keys()]) this.release(s);
    for (const t of [...this.texts.keys()]) this.release(t);
    for (const tex of this.textures.values()) tex.dispose();
    this.quad.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Grid lines per side for a cell size: about 40 m across, between 10 and 400 lines. */
function gridDivisions(cell: number): number {
  return Math.min(400, Math.max(10, Math.round(40 / cell)));
}

/** The editor grid: `cell` metres between lines. */
function makeGrid(cell: number, colors: EditorColors): GridHelper {
  const n = gridDivisions(cell);
  const grid = new GridHelper(n * cell, n, colors.gridCenter, colors.grid);
  (grid.material as LineBasicMaterial).fog = false; // editor chrome never takes fog (ADR 0071)
  return grid;
}

/** A small camera glyph for editor camera icons: a body and lens, light with a dark outline. */
function cameraIconTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.lineJoin = "round";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#1b1d21";
  ctx.fillStyle = "#e8eaed";
  const body = () => {
    ctx.beginPath();
    ctx.roundRect(6, 18, 36, 28, 5);
    ctx.moveTo(42, 27);
    ctx.lineTo(58, 18);
    ctx.lineTo(58, 46);
    ctx.lineTo(42, 37);
    ctx.closePath();
  };
  body();
  ctx.stroke();
  body();
  ctx.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A light's icon: a sun (directional), a bulb (point), a lamp shade (spot) or a soft disc (ambient), light with a dark outline. */
function lightIconTexture(type: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.strokeStyle = "#1b1d21";
  ctx.fillStyle = "#ffe08a";
  const both = (path: () => void, width = 6) => {
    ctx.lineWidth = width;
    path();
    ctx.stroke();
    path();
    ctx.fill();
  };
  if (type === "directional") {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(32 + c * 20, 32 + s * 20);
      ctx.lineTo(32 + c * 28, 32 + s * 28);
      ctx.stroke();
      ctx.strokeStyle = "#ffe08a";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = "#1b1d21";
    }
    both(() => (ctx.beginPath(), ctx.arc(32, 32, 13, 0, Math.PI * 2)));
  } else if (type === "spot") {
    both(() => {
      ctx.beginPath();
      ctx.moveTo(24, 10);
      ctx.lineTo(40, 10);
      ctx.lineTo(54, 46);
      ctx.lineTo(10, 46);
      ctx.closePath();
    });
    both(() => (ctx.beginPath(), ctx.arc(32, 52, 6, 0, Math.PI * 2)), 4);
  } else if (type === "ambient") {
    ctx.globalAlpha = 0.9;
    both(() => (ctx.beginPath(), ctx.arc(32, 32, 22, 0, Math.PI * 2)));
    ctx.fillStyle = "#1b1d21";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("A", 32, 33);
  } else {
    both(() => (ctx.beginPath(), ctx.arc(32, 26, 17, 0, Math.PI * 2)));
    both(() => (ctx.beginPath(), ctx.roundRect(24, 42, 16, 12, 3)), 4);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

type Seg = [[number, number, number], [number, number, number]];

/**
 * A light's wireframe in world space (the node's world matrix `m`): a directional light's arrow,
 * a spot light's cone, a point light's range (when selected).
 */
export function lightSegments(l: Pick<Light, "type" | "range" | "spotAngle">, m: Matrix4, selected: boolean): Seg[] {
  const p = new ThreeVector3().setFromMatrixPosition(m);
  const x = new ThreeVector3().setFromMatrixColumn(m, 0).normalize();
  const y = new ThreeVector3().setFromMatrixColumn(m, 1).normalize();
  const fwd = new ThreeVector3().setFromMatrixColumn(m, 2).normalize().negate();
  const at = (v: ThreeVector3): [number, number, number] => [v.x, v.y, v.z];
  const out: Seg[] = [];
  const circle = (center: ThreeVector3, u: ThreeVector3, v: ThreeVector3, r: number, n = 32) => {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const q0 = center.clone().addScaledVector(u, Math.cos(a0) * r).addScaledVector(v, Math.sin(a0) * r);
      const q1 = center.clone().addScaledVector(u, Math.cos(a1) * r).addScaledVector(v, Math.sin(a1) * r);
      out.push([at(q0), at(q1)]);
    }
  };
  if (l.type === "directional") {
    // Four parallel rays around the node and an arrowhead on the middle one.
    const tip = p.clone().addScaledVector(fwd, 2);
    out.push([at(p), at(tip)]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = p.clone().addScaledVector(x, dx * 0.3).addScaledVector(y, dy * 0.3);
      out.push([at(o), at(o.clone().addScaledVector(fwd, 1.2))]);
      out.push([at(tip), at(tip.clone().addScaledVector(fwd, -0.3).addScaledVector(x, dx * 0.12).addScaledVector(y, dy * 0.12))]);
    }
  } else if (l.type === "spot") {
    const d = l.range > 0 ? l.range : 5;
    const r = d * Math.tan((Math.min(Math.max(l.spotAngle, 1), 179) / 2) * (Math.PI / 180));
    const base = p.clone().addScaledVector(fwd, d);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push([at(p), at(base.clone().addScaledVector(x, dx * r).addScaledVector(y, dy * r))]);
    circle(base, x, y, r);
  } else if (l.type === "point" && selected && l.range > 0) {
    circle(p, x, y, l.range);
    circle(p, x, fwd, l.range);
    circle(p, y, fwd, l.range);
  }
  return out;
}

function anchorFactors(anchor: Anchor): [number, number] {
  // [x, y] with x: 0 left → 1 right, y: 0 top → 1 bottom.
  switch (anchor) {
    case "top-left": return [0, 0];
    case "top": return [0.5, 0];
    case "top-right": return [1, 0];
    case "left": return [0, 0.5];
    case "right": return [1, 0.5];
    case "bottom-left": return [0, 1];
    case "bottom": return [0.5, 1];
    case "bottom-right": return [1, 1];
    default: return [0.5, 0.5];
  }
}

/** Write positions and colours into an overlay object's geometry, growing its buffers only when they're too small. */
/** True if `array` starts with `values` (as 32-bit floats). */
function sameFloats(array: Float32Array, values: readonly number[]): boolean {
  for (let i = 0; i < values.length; i++) if (array[i] !== Math.fround(values[i])) return false;
  return true;
}

function fillOverlayGeometry(object: { geometry: BufferGeometry; visible: boolean }, positions: number[], colors: number[]): void {
  const g = object.geometry;
  const count = positions.length / 3;
  let pos = g.getAttribute("position") as Float32BufferAttribute | undefined;
  let col = g.getAttribute("color") as Float32BufferAttribute | undefined;
  const grow = !pos || pos.count < count;
  if (grow) {
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(count, 1))));
    g.dispose(); // frees the old GPU buffers
    pos = new Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    col = new Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    g.setAttribute("position", pos);
    g.setAttribute("color", col);
  }
  // Overlays are mostly the same frame to frame: upload only when they changed, and only the part in use.
  const p = pos!, c = col!;
  if (grow || count !== g.drawRange.count || !sameFloats(p.array as Float32Array, positions) || !sameFloats(c.array as Float32Array, colors)) {
    (p.array as Float32Array).set(positions);
    (c.array as Float32Array).set(colors);
    for (const a of [p, c]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * 3);
      a.needsUpdate = true;
    }
  }
  g.setDrawRange(0, count);
  object.visible = count > 0;
}

/** A soft round dot: the default particle texture (white, alpha falling off from the centre). */
function makeParticleDot(): Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
