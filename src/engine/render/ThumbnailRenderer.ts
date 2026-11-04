/**
 * @internal Editor: asset thumbnails (ADR 0061). One offscreen WebGL context renders still images
 * of models, materials, shader graphs, environments, particle effects and prefabs, with a
 * transparent background so tiles follow the editor theme, and animates one hovered tile at a
 * time (particle effects, shader graphs that use Time). Reached through `src/engine/editor`;
 * three.js stays out of the public API (ADR 0010).
 */
import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  Color as ThreeColor,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Euler,
  FrontSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  NormalBlending,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import { Assets } from "../scene/Assets";
import { materialGraph, parseMaterial, type MaterialSettings } from "../scene/material";
import { loadMeshes, meshesIfLoaded } from "../scene/models";
import { parseShaderGraph, type GraphValue, type ShaderGraph } from "../scene/shaderGraph";
import { Graphics } from "./Graphics";
import { compileShaderGraph } from "./shaderGraph/compile";
import { createGraphMaterial, createSharedGraphUniforms, type GraphMaterial } from "./shaderGraph/threeMaterial";
import { colorFromHex, frameView, moveOrbit, orbitOf, orbitPosition, previewPixels, seededRandom, type Bounds, type Orbit } from "./thumbnailMath";

export { frameView, seededRandom } from "./thumbnailMath";

/** What gets a rendered thumbnail. */
export type ThumbnailKind = "model" | "material" | "shadergraph" | "environment" | "particles" | "prefab";

/** Thumbnails are this many pixels square: about twice the Assets panel's largest tile. */
export const THUMBNAIL_SIZE = 256;

/** Hover animation: frames per second, and the longest step a slow frame simulates. */
const ANIMATION_FPS = 30;
const MAX_STEP = 0.1;
/** Particle effects are shown this many seconds in, simulated at this rate. */
const PARTICLE_TIME = 1;
const PARTICLE_DT = 1 / 30;
/** Sprites without a size: pixels per unit (the project default, ADR 0014). */
const SPRITE_PPU = 100;

/** A scene ready to draw: what to render, from where, what to free, and how to advance it (animations). */
interface Prepared {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Advance by `dt` seconds (time-based graphs, particles). */
  step?: (dt: number) => void;
  dispose(): void;
}

/**
 * A live, orbitable preview drawn into a canvas (the Inspector's): it redraws when the view changes,
 * and continuously while the asset animates. One at a time; while one is open, tiles show stills.
 */
export interface ThumbnailPreview {
  /** Resolves true once the asset is drawn, false if it can't be (or the preview stopped first). */
  readonly ready: Promise<boolean>;
  /** Turn the view around the asset by `dyaw` (about the vertical) and `dpitch` radians. */
  orbit(dyaw: number, dpitch: number): void;
  /** Move closer (below 1) or further away (above 1). */
  zoom(factor: number): void;
  /** Back to the starting view. */
  reset(): void;
  /** Redraw at the canvas's current size (after it was resized). */
  redraw(): void;
  stop(): void;
}

/** Previews draw at most this many pixels across, so a large Inspector doesn't cost a large buffer. */
const MAX_PREVIEW_PIXELS = 768;

const DIRECTION_3D = new Vector3(1, 0.75, 1.15).normalize();
const DIRECTION_FRONT = new Vector3(0, 0, 1);

export class ThumbnailRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly loader = new TextureLoader();
  /** Loaded textures by path (and colour space), with the URL each was loaded from: a rewritten file has a new URL. */
  private readonly textures = new Map<string, { url: string; texture: Promise<Texture> }>();
  private studio: Texture | null = null;
  private studioLoading: Promise<void> | null = null;
  private animation: { stop(): void } | null = null;
  private live: { stop(): void } | null = null;
  /**
   * The drawing buffer's size. It only grows while a preview is open (thumbnails draw into its
   * bottom-left corner with the viewport and scissor), so switching between a preview and
   * thumbnails never reallocates it; it shrinks back to `size` when the preview closes.
   */
  private drawn: [number, number];
  /** A `size` x `size` 2D canvas thumbnails are copied into for encoding. */
  private readonly still: HTMLCanvasElement;
  private disposed = false;
  private lostListeners: (() => void)[] = [];
  /** True once the browser has taken the WebGL context away (too many contexts, a GPU reset). */
  lost = false;

  constructor(readonly size = THUMBNAIL_SIZE) {
    this.canvas = document.createElement("canvas");
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setScissorTest(true);
    this.drawn = [size, size];
    this.still = document.createElement("canvas");
    this.still.width = this.still.height = size;
    // A lost context can't draw again; whoever owns this renderer makes a new one (`onContextLost`).
    this.canvas.addEventListener("webglcontextlost", () => {
      this.lost = true;
      this.live?.stop();
      this.animation?.stop();
      for (const f of this.lostListeners.splice(0)) f();
    });
  }

  /** Run `f` once if the WebGL context is lost (the renderer is then useless: make another). */
  onContextLost(f: () => void): void {
    if (this.lost) f();
    else this.lostListeners.push(f);
  }

  /**
   * Draw the scene into the buffer's bottom-left `w` x `h` corner, growing the buffer if it's too
   * small. Returns where that corner is in the canvas image (its origin is top-left).
   */
  private draw(scene: Object3D, camera: PerspectiveCamera, w: number, h: number): { sx: number; sy: number; w: number; h: number } {
    if (w > this.drawn[0] || h > this.drawn[1]) {
      const nw = Math.max(w, this.drawn[0]), nh = Math.max(h, this.drawn[1]);
      this.renderer.setSize(nw, nh, false);
      this.drawn = [nw, nh];
    }
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setScissor(0, 0, w, h);
    this.renderer.render(scene, camera);
    return { sx: 0, sy: this.drawn[1] - h, w, h };
  }

  /** Back to a `size` x `size` buffer (a preview closed). */
  private shrink(): void {
    if (this.drawn[0] === this.size && this.drawn[1] === this.size) return;
    this.renderer.setSize(this.size, this.size, false);
    this.drawn = [this.size, this.size];
  }

  /** Copy a drawn region into a 2D canvas, filling it. */
  private copy(from: { sx: number; sy: number; w: number; h: number }, target: HTMLCanvasElement): void {
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(this.canvas, from.sx, from.sy, from.w, from.h, 0, 0, target.width, target.height);
  }

  /** A still image of the asset (WebP where the browser encodes it, else PNG), or null if it can't be shown. */
  async render(kind: ThumbnailKind, path: string): Promise<Blob | null> {
    const prepared = await this.prepare(kind, path, false);
    if (!prepared || this.disposed || this.lost) {
      prepared?.dispose();
      return null;
    }
    try {
      this.copy(this.draw(prepared.scene, prepared.camera, this.size, this.size), this.still);
      // toBlob takes its snapshot now, before any other render can draw over the canvas.
      return await new Promise<Blob | null>((resolve) => this.still.toBlob(resolve, "image/webp", 0.9));
    } finally {
      prepared.dispose();
    }
  }

  /** Whether the asset animates on hover: particle effects, and shader graphs (or their materials) that use Time. */
  canAnimate(kind: ThumbnailKind, path: string): boolean {
    if (kind === "particles") return true;
    if (kind === "shadergraph") return usesTime(readGraph(path));
    if (kind === "material") {
      const settings = readMaterial(path);
      const graph = settings && materialGraph(settings);
      return !!graph && usesTime(readGraph(graph));
    }
    return false;
  }

  /**
   * Draw the asset live into `target` (a 2D canvas) at about 30 fps, until the returned function
   * is called, another animation starts, or `target` leaves the document. One at a time.
   * `onFrame` runs after the first frame is drawn (nothing is drawn while a preview is open).
   */
  animate(kind: ThumbnailKind, path: string, target: HTMLCanvasElement, onFrame?: () => void): () => void {
    if (this.live || this.lost) return () => undefined; // the Inspector's preview has the renderer: tiles stay stills
    this.animation?.stop();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prepared: Prepared | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      prepared?.dispose();
      prepared = null;
      if (this.animation === handle) this.animation = null;
    };
    const handle = { stop };
    this.animation = handle;
    void this.prepare(kind, path, true).then((p) => {
      if (stopped || !p) {
        p?.dispose();
        return;
      }
      prepared = p;
      let last = performance.now();
      let first = true;
      const frame = () => {
        if (stopped || !prepared) return;
        if (!target.isConnected) return stop();
        const now = performance.now();
        prepared.step?.(Math.min(MAX_STEP, (now - last) / 1000));
        last = now;
        this.copy(this.draw(prepared.scene, prepared.camera, this.size, this.size), target);
        if (first) {
          first = false;
          onFrame?.();
        }
        timer = setTimeout(frame, 1000 / ANIMATION_FPS);
      };
      frame();
    });
    return stop;
  }

  /**
   * An orbitable preview of the asset in `target` (a 2D canvas, sized by the caller to its pixels).
   * It takes the renderer from any hover animation, and replaces another preview.
   */
  preview(kind: ThumbnailKind, path: string, target: HTMLCanvasElement): ThumbnailPreview {
    this.live?.stop();
    this.animation?.stop();
    let stopped = false;
    let prepared: Prepared | null = null;
    let center: [number, number, number] = [0, 0, 0];
    let start: Orbit = { yaw: 0, pitch: 0, distance: 1 };
    let view: Orbit = start;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let queued = false;
    let last = performance.now();
    const animates = this.canAnimate(kind, path);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      prepared?.dispose();
      prepared = null;
      if (this.live === handle) {
        this.live = null;
        if (!this.lost) this.shrink();
      }
    };
    const handle = { stop };
    this.live = handle;
    const draw = () => {
      queued = false;
      if (stopped || !prepared) return;
      if (!target.isConnected) return stop();
      const [w, h] = previewPixels(target.width, target.height, MAX_PREVIEW_PIXELS);
      const camera = prepared.camera;
      camera.position.set(...orbitPosition(center, view));
      camera.lookAt(...center);
      camera.aspect = w / h;
      camera.near = Math.max(1e-3, view.distance / 100);
      camera.far = view.distance * 100;
      camera.updateProjectionMatrix();
      const now = performance.now();
      if (animates) prepared.step?.(Math.min(MAX_STEP, (now - last) / 1000));
      last = now;
      this.copy(this.draw(prepared.scene, camera, w, h), target);
      // Animated assets keep drawing; others wait for the next change.
      if (animates) timer = setTimeout(draw, 1000 / ANIMATION_FPS);
    };
    const request = () => {
      if (queued || stopped || !prepared || animates) return; // animating: the next frame picks it up
      queued = true;
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16))(draw);
    };
    const ready = this.prepare(kind, path, true).then((p) => {
      if (stopped || !p || this.lost) {
        p?.dispose();
        stop(); // nothing to show: hovered tiles may animate again
        return false;
      }
      prepared = p;
      center = (p.camera.userData.target as [number, number, number] | undefined) ?? [0, 0, 0];
      start = view = orbitOf(p.camera.position.toArray(), center);
      draw();
      return true;
    });
    const near = () => start.distance * 0.25, far = () => start.distance * 4;
    return {
      ready,
      orbit: (dyaw, dpitch) => {
        view = moveOrbit(view, dyaw, dpitch, 1, near(), far());
        request();
      },
      zoom: (factor) => {
        view = moveOrbit(view, 0, 0, factor, near(), far());
        request();
      },
      reset: () => {
        view = start;
        request();
      },
      redraw: request,
      stop,
    };
  }

  /**
   * Forget every loaded texture (another project opened: the same path can be another file). The
   * next thumbnail loads what it needs again.
   */
  clearCaches(): void {
    for (const t of this.textures.values()) void t.texture.then((x) => x.dispose(), () => undefined);
    this.textures.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.live?.stop();
    this.animation?.stop();
    this.clearCaches();
    this.studio?.dispose();
    this.renderer.dispose();
    this.lostListeners = [];
  }

  // --- scenes ---------------------------------------------------------------------------------------

  private async prepare(kind: ThumbnailKind, path: string, live: boolean): Promise<Prepared | null> {
    try {
      await this.loadStudio();
      switch (kind) {
        case "model":
          return await this.prepareModel(path);
        case "material":
        case "shadergraph":
          return await this.prepareMaterial(kind, path);
        case "environment":
          return await this.prepareEnvironment(path, live);
        case "particles":
          return await this.prepareParticles(path, live);
        case "prefab":
          return await this.preparePrefab(path);
      }
    } catch (err) {
      console.warn(`[myco] thumbnail: couldn't draw ${path}:`, err);
      return null;
    }
  }

  /** A scene lit like the editor's default: soft ambient, a sun, and the studio room's reflections. */
  private litScene(): Scene {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 10, 6);
    scene.add(new AmbientLight(0xffffff, 0.45), sun);
    if (this.studio) {
      scene.environment = this.studio;
      scene.environmentIntensity = 0.5;
    }
    return scene;
  }

  private camera(bounds: Bounds | null, direction: Vector3, fallback: Bounds): PerspectiveCamera {
    const camera = new PerspectiveCamera(30, 1, 0.01, 1000);
    const view = frameView(bounds ?? fallback, camera.fov, [direction.x, direction.y, direction.z]);
    camera.position.set(...view.position);
    camera.near = view.near;
    camera.far = view.far;
    camera.lookAt(...view.target);
    camera.updateProjectionMatrix();
    camera.userData.target = view.target; // what a preview orbits around
    return camera;
  }

  private async prepareModel(path: string): Promise<Prepared> {
    const meshes = await loadMeshes(path);
    const scene = this.litScene();
    const group = new Group();
    for (const m of meshes) group.add(new Mesh(m.geometry, m.materials.length > 1 && m.geometry.groups.length > 1 ? [...m.materials] : (m.materials[0] ?? defaultMaterial())));
    scene.add(group);
    await this.awaitMaterialTextures(group);
    return { scene, camera: this.camera(boundsOf(group), DIRECTION_3D, UNIT), dispose: () => undefined };
  }

  private async prepareMaterial(kind: "material" | "shadergraph", path: string): Promise<Prepared> {
    const shared = createSharedGraphUniforms();
    const built = await this.buildMaterial(kind === "shadergraph" ? { graph: path, properties: {} } : path, shared);
    const sphere = meshesIfLoaded("builtin:sphere")![0].geometry;
    const scene = this.litScene();
    scene.add(new Mesh(sphere, built.material));
    let time = 0;
    return {
      scene,
      camera: this.camera({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, DIRECTION_FRONT.clone().add(new Vector3(0, 0.35, 0)).normalize(), UNIT),
      step: (dt) => {
        time += dt;
        shared.time.value = time;
      },
      dispose: () => built.dispose(),
    };
  }

  /** A chrome sphere reflecting the map; a live preview also shows the map itself behind it. */
  private async prepareEnvironment(path: string, live: boolean): Promise<Prepared> {
    const { loadEquirectangular, prefilter } = await import("./environmentMap");
    const source = await loadEquirectangular(Assets.url(path), path);
    const lighting = prefilter(this.renderer, source);
    const scene = new Scene();
    scene.environment = lighting;
    if (live) scene.background = source;
    else source.dispose();
    const chrome = new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 });
    scene.add(new Mesh(meshesIfLoaded("builtin:sphere")![0].geometry, chrome));
    return {
      scene,
      camera: this.camera({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, DIRECTION_FRONT, UNIT),
      dispose: () => {
        chrome.dispose();
        lighting.dispose();
        if (live) source.dispose();
      },
    };
  }

  private async prepareParticles(path: string, live: boolean): Promise<Prepared> {
    const [{ parseParticleGraph }, { compileParticleGraph }, { ProgramRunner }, { buildEffect }, { BatchedRenderer }] = await Promise.all([
      import("../scene/particleGraphFormat"),
      import("../scene/particleCompile"),
      import("./particles/programRunner"),
      import("./particles/quarksEffect"),
      import("three.quarks"),
    ]);
    const program = compileParticleGraph(parseParticleGraph(Assets.json(path), path).graph);
    // Everything the emitters draw with, loaded first, so the build doesn't wait on a texture.
    const textures = new Map<string, Texture>();
    for (const e of program.effect.emitters) {
      const r = e.renderer;
      if (r.texture && !textures.has(r.texture)) textures.set(r.texture, await this.texture(r.texture, false));
      if (r.mode === "mesh" && r.mesh) await loadMeshes(r.mesh).catch(() => undefined);
    }
    const dot = makeDot();
    const materials: Material[] = [];
    const scene = new Scene();
    const batch = new BatchedRenderer();
    scene.add(batch);
    const random = seededRandom(1);
    const runner = withRandom(random, () => new ProgramRunner(program));
    const built = withRandom(random, () =>
      buildEffect(runner.effect(), {
        material: (r) => {
          const m = new MeshBasicMaterial({
            map: (r.texture && textures.get(r.texture)) || dot,
            transparent: true,
            depthWrite: false,
            blending: r.blending === "additive" ? AdditiveBlending : NormalBlending,
            premultipliedAlpha: r.blending === "premultiplied",
          });
          materials.push(m);
          return m;
        },
        geometry: (mesh) => meshesIfLoaded(mesh)?.[0]?.geometry ?? null,
        scale: { value: 1 },
        tint: { value: [1, 1, 1, 1] },
        live: runner.live,
      }),
    );
    if (!built) throw new Error("its emitters couldn't be built.");
    for (const e of built) {
      e.system.emitter.matrixAutoUpdate = false;
      e.system.emitter.matrix.copy(e.shapeMatrix);
      e.system.emitter.matrixWorldNeedsUpdate = true;
      scene.add(e.system.emitter);
      batch.addSystem(e.system);
    }
    scene.updateMatrixWorld(true);
    const autoStart = program.autoStart;
    let time = 0;
    const duration = program.effect.emitters[0]?.duration ?? 0;
    const restart = () => {
      time = 0;
      for (const e of built) {
        e.system.looping = e.looping;
        e.system.restart();
        // Systems started by events (not On Play) wait for them.
        const index = program.systems.indexOf(e.name);
        if (index >= 0 && !autoStart[index]) {
          e.system.looping = false;
          e.system.endEmit();
        }
      }
    };
    const step = (dt: number) => {
      time += dt;
      runner.update(time, dt, duration > 0 ? time % duration : time);
      for (const e of built) if (time >= e.startDelay) (e.system as unknown as { update(dt: number): void }).update(dt);
      for (const b of batch.batches) b.update();
      // A finished one-shot effect starts again, so a hovered tile keeps showing something.
      if (live && built.every((e) => e.system.particleNum === 0) && time > 0.5 && !built.some((e) => e.looping)) restart();
    };
    withRandom(random, () => {
      restart();
      for (let t = 0; t < PARTICLE_TIME; t += PARTICLE_DT) step(PARTICLE_DT);
    });
    // Frame what's alive now (emitters sit at the origin, so local and world space agree).
    const box = new Box3();
    for (const e of built) for (let i = 0; i < e.system.particleNum; i++) box.expandByPoint(e.system.particles[i].position as unknown as Vector3);
    const bounds: Bounds | null = box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
    return {
      scene,
      camera: this.camera(bounds && padded(bounds, 0.4), DIRECTION_3D, { min: [-1, 0, -1], max: [1, 2, 1] }),
      step: live ? (dt) => withRandom(random, () => step(dt)) : undefined,
      dispose: () => {
        for (const e of built) e.system.dispose();
        // Removing its systems leaves each batch's own instanced geometry and shader material behind.
        for (const b of batch.batches) {
          b.geometry.dispose();
          (Array.isArray(b.material) ? b.material : [b.material]).forEach((m) => m.dispose());
        }
        for (const m of materials) m.dispose();
        dot.dispose();
      },
    };
  }

  private async preparePrefab(path: string): Promise<Prepared> {
    const raw = Assets.json(path) as { nodes?: PrefabNode[] };
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const worlds = new Map<string, Matrix4>();
    const worldOf = (n: PrefabNode, depth = 0): Matrix4 => {
      const have = worlds.get(n.id);
      if (have) return have;
      const local = localMatrix(n);
      const parent = n.parent ? byId.get(n.parent) : undefined;
      const m = parent && depth < 64 ? new Matrix4().multiplyMatrices(worldOf(parent, depth + 1), local) : local;
      worlds.set(n.id, m);
      return m;
    };
    const scene = this.litScene();
    const owned: { dispose(): void }[] = [];
    let meshes = 0;
    let sprites = 0;
    for (const n of nodes) {
      for (const c of n.components ?? []) {
        const data = (c.data ?? {}) as Record<string, unknown>;
        if (c.type === "engine.MeshRenderer") {
          const ref = typeof data.mesh === "string" ? data.mesh : "builtin:cube";
          const parts = await loadMeshes(ref).catch(() => []);
          let material: Material | null = null;
          if (typeof data.material === "string" && data.material) {
            const built = await this.buildMaterial(data.material.replace(/^asset:/, ""), createSharedGraphUniforms()).catch(() => null);
            if (built) {
              owned.push(built);
              material = built.material;
            }
          }
          for (const part of parts) {
            const mesh = new Mesh(part.geometry, material ?? part.materials[0] ?? defaultMaterial());
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(worldOf(n));
            scene.add(mesh);
            meshes++;
          }
        } else if (c.type === "engine.SpriteRenderer" && typeof data.sprite === "string" && data.sprite) {
          const texture = await this.texture(data.sprite.split("#")[0].replace(/^asset:/, ""), false).catch(() => null);
          if (!texture) continue;
          const image = texture.image as { width?: number; height?: number } | undefined;
          const size = Array.isArray(data.size) ? (data.size as number[]) : [(image?.width ?? SPRITE_PPU) / SPRITE_PPU, (image?.height ?? SPRITE_PPU) / SPRITE_PPU];
          const geometry = new PlaneGeometry(size[0], size[1]);
          const material = new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.01, side: DoubleSide, color: typeof data.color === "string" ? colorFromHex(data.color) : 0xffffff });
          owned.push(geometry, material);
          const sprite = new Mesh(geometry, material);
          sprite.matrixAutoUpdate = false;
          sprite.matrix.copy(worldOf(n));
          scene.add(sprite);
          sprites++;
        }
      }
    }
    if (!meshes && !sprites) throw new Error("it has nothing to draw.");
    scene.updateMatrixWorld(true);
    await this.awaitMaterialTextures(scene);
    // Sprites only: a 2D prefab, seen from the front.
    return { scene, camera: this.camera(boundsOf(scene), meshes ? DIRECTION_3D : DIRECTION_FRONT, UNIT), dispose: () => owned.forEach((o) => o.dispose()) };
  }

  // --- materials and textures -----------------------------------------------------------------------

  /** A material asset (by path) or a shader graph with property values, built for this renderer, textures loaded. */
  private async buildMaterial(source: string | { graph: string; properties: Record<string, GraphValue> }, shared: ReturnType<typeof createSharedGraphUniforms>): Promise<{ material: Material; dispose(): void }> {
    let graphPath: string | null;
    let properties: Record<string, GraphValue>;
    let settings: MaterialSettings | null = null;
    if (typeof source === "string") {
      settings = readMaterial(source);
      if (!settings) throw new Error(`"${source}" isn't a material.`);
      graphPath = materialGraph(settings);
      properties = settings.properties;
    } else {
      graphPath = source.graph;
      properties = source.properties;
    }
    if (graphPath) {
      const graph = readGraph(graphPath.replace(/^asset:/, ""));
      if (!graph) throw new Error(`shader graph "${graphPath}" can't be read.`);
      const pending: Promise<unknown>[] = [];
      const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel });
      const made: GraphMaterial = createGraphMaterial(compiled, properties, shared, (p, linear) => {
        const t = this.texture(p, linear);
        pending.push(t.catch(() => undefined));
        return t;
      });
      await Promise.all(pending);
      // The material's textures are set when their promises settle; give them a turn to.
      await Promise.resolve();
      return { material: made.material, dispose: () => made.dispose() };
    }
    const s = settings!;
    const color = new ThreeColor().setRGB(s.color.r, s.color.g, s.color.b, SRGBColorSpace);
    const common = { color, transparent: s.color.a < 1, opacity: s.color.a, side: s.doubleSided ? DoubleSide : FrontSide };
    const material =
      s.shader === "unlit"
        ? new MeshBasicMaterial(common)
        : s.shader === "physical"
          ? new MeshPhysicalMaterial({
              ...common,
              metalness: s.metalness,
              roughness: s.roughness,
              emissive: new ThreeColor().setRGB(s.emission.r, s.emission.g, s.emission.b, SRGBColorSpace),
              clearcoat: s.clearcoat,
              clearcoatRoughness: s.clearcoatRoughness,
              sheen: s.sheen,
              sheenColor: new ThreeColor().setRGB(s.sheenColor.r, s.sheenColor.g, s.sheenColor.b, SRGBColorSpace),
              sheenRoughness: s.sheenRoughness,
              transmission: s.transmission,
              thickness: s.thickness,
              ior: s.ior,
              iridescence: s.iridescence,
              iridescenceIOR: s.iridescenceIOR,
            })
          : new MeshStandardMaterial({ ...common, metalness: s.metalness, roughness: s.roughness, emissive: new ThreeColor().setRGB(s.emission.r, s.emission.g, s.emission.b, SRGBColorSpace) });
    const owned: Texture[] = [];
    const tiled = (t: Texture) => {
      const copy = t.clone();
      copy.wrapS = copy.wrapT = RepeatWrapping;
      copy.repeat.set(s.tiling[0], s.tiling[1]);
      copy.needsUpdate = true;
      owned.push(copy);
      return copy;
    };
    if (s.texture) (material as MeshStandardMaterial).map = tiled(await this.texture(s.texture.replace(/^asset:/, ""), false));
    if (s.normalMap && !(material instanceof MeshBasicMaterial)) (material as MeshStandardMaterial).normalMap = tiled(await this.texture(s.normalMap.replace(/^asset:/, ""), true));
    return {
      material,
      dispose: () => {
        material.dispose();
        owned.forEach((t) => t.dispose());
      },
    };
  }

  /**
   * A project texture, cached while its URL stays the same (the editor serves a rewritten file at a
   * new URL, so an edited image is loaded afresh); linear (no sRGB decoding) for normal maps.
   */
  private texture(path: string, linear: boolean): Promise<Texture> {
    const key = `${linear ? "L" : "S"}${path}`;
    const url = Assets.url(path);
    const have = this.textures.get(key);
    if (have && have.url === url) return have.texture;
    if (have) void have.texture.then((t) => t.dispose(), () => undefined);
    const texture = this.loader.loadAsync(url).then((tex) => {
      tex.colorSpace = linear ? NoColorSpace : SRGBColorSpace;
      return tex;
    });
    const entry = { url, texture };
    texture.catch(() => this.textures.get(key) === entry && this.textures.delete(key));
    this.textures.set(key, entry);
    return texture;
  }

  /** Model materials load their textures on their own; wait (briefly) until they have. */
  private async awaitMaterialTextures(root: Object3D): Promise<void> {
    const images: Promise<void>[] = [];
    root.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) {
        const map = (x as MeshStandardMaterial).map;
        const img = map?.image as HTMLImageElement | undefined;
        if (img && "complete" in img && !img.complete) images.push(new Promise((r) => img.addEventListener("load", () => r(), { once: true })));
      }
    });
    if (images.length) await Promise.race([Promise.all(images), new Promise((r) => setTimeout(r, 3000))]);
  }

  private loadStudio(): Promise<void> {
    this.studioLoading ??= (async () => {
      try {
        const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
        const pmrem = new PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this.studio = pmrem.fromScene(room, 0.04).texture;
        room.dispose();
        pmrem.dispose();
      } catch {
        // Thumbnails just have no reflections.
      }
    })();
    return this.studioLoading;
  }
}

// --- helpers ------------------------------------------------------------------------------------------

interface PrefabNode {
  id: string;
  parent?: string;
  components?: { type: string; data?: unknown }[];
}

const UNIT: Bounds = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };

let fallbackMaterial: MeshStandardMaterial | null = null;
const defaultMaterial = () => (fallbackMaterial ??= new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 }));

function readMaterial(path: string): MaterialSettings | null {
  try {
    return parseMaterial(Assets.json(path), path).settings;
  } catch {
    return null;
  }
}

function readGraph(path: string): ShaderGraph | null {
  try {
    return parseShaderGraph(Assets.json(path), path).graph;
  } catch {
    return null;
  }
}

/** True if a shader graph reads the Time node, so its preview moves. */
const usesTime = (graph: ShaderGraph | null) => !!graph?.nodes.some((n) => n.type === "time");

/** A node's local matrix from its Transform data: position, rotation (Euler degrees, or a quaternion) and scale. */
function localMatrix(n: PrefabNode): Matrix4 {
  const t = n.components?.find((c) => c.type === "engine.Transform")?.data as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
  const p = t?.position ?? [0, 0, 0];
  const r = t?.rotation ?? [0, 0, 0];
  const s = t?.scale ?? [1, 1, 1];
  const q = r.length === 4 ? new Quaternion(r[0], r[1], r[2], r[3]) : new Quaternion().setFromEuler(new Euler(((r[0] ?? 0) * Math.PI) / 180, ((r[1] ?? 0) * Math.PI) / 180, ((r[2] ?? 0) * Math.PI) / 180));
  return new Matrix4().compose(new Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0), q, new Vector3(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1));
}

function boundsOf(root: Object3D): Bounds | null {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
}

const padded = (b: Bounds, by: number): Bounds => ({ min: [b.min[0] - by, b.min[1] - by, b.min[2] - by], max: [b.max[0] + by, b.max[1] + by, b.max[2] + by] });

/** Run `fn` with `Math.random` replaced, so particle effects simulate the same way every time. */
function withRandom<T>(random: () => number, fn: () => T): T {
  const original = Math.random;
  Math.random = random;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** The default particle texture: a soft round dot. */
function makeDot(): Texture {
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

