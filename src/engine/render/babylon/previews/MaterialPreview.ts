/**
 * @internal Editor: shader graph previews on the Babylon backend (ADR 0046–0048, 0075 stage 7), with the
 * same API as `render/MaterialPreview.ts` (three.js). `MaterialPreview` is a live preview of a graph on a
 * built-in mesh in a canvas of its own, lit like a default scene (a sun, soft ambient light and the studio
 * environment); drag to turn the mesh. `NodePreviewRenderer` draws every node's preview with one offscreen
 * engine, copied into each node's 2D canvas. Graphs compile to WGSL.
 *
 * The engine starts asynchronously (WebGPU needs `initAsync`), so the constructors return at once and
 * the first frames appear a moment later; calls made before that are applied when it's up.
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded, type BuiltinMesh } from "../../../scene/models";
import type { GraphValue, NodePreviewShape, ShaderGraph } from "../../../scene/shaderGraph";
import { Graphics } from "../../Graphics";
import { compileShaderGraph, type CompiledShaderGraph } from "../../shaderGraph/compile";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "../graphMaterial";
import { meshOf } from "../materials";
import type { BabylonMaterialLibrary } from "../materialLibrary";
import { appliedPixelRatio } from "../../RenderSurface";
import {
  addDefaultLights,
  aimCamera,
  createPreviewScene,
  createStudioTexture,
  previewMaterials,
  renderFrame,
  renderFrameChecked,
  STUDIO_INTENSITY,
  useWhenReady,
} from "./common";
import { createBabylonEngine } from "../createEngine";

export type PreviewMesh = Extract<BuiltinMesh, "sphere" | "cube" | "capsule" | "plane" | "quad">;

/** Watch a graph material's shader programs: `onError` gets the compiler's message when one fails. */
function watchShaderErrors(g: BabylonGraphMaterial, onError: (message: string) => void): void {
  g.material.onEffectCreatedObservable.add(({ effect }) => {
    if (!effect) return;
    effect.onErrorObservable.add(() => onError(effect.getCompilationError() || "the shader didn't compile"));
  });
}

export class MaterialPreview {
  readonly canvas: HTMLCanvasElement;
  /** Called with the shader compiler's log when the generated shader fails to compile (a compiler bug), or null once one compiles. */
  onShaderError: ((message: string | null) => void) | null = null;
  private engine: AbstractEngine | null = null;
  private scene: Scene | null = null;
  private camera: TargetCamera | null = null;
  private mesh: Mesh | null = null;
  private studio: HDRCubeTexture | null = null;
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };
  private readonly resizeObserver: ResizeObserver;
  private graph: BabylonGraphMaterial | null = null;
  /** The textures the graph loaded (ADR 0127), freed when it's rebuilt, so changed images load anew. */
  private library: BabylonMaterialLibrary | null = null;
  private kind: PreviewMesh = "sphere";
  /** What `setGraph` last drew, to rebuild when the quality tier changes a Quality Branch. */
  private last: { graph: ShaderGraph; properties: Record<string, GraphValue>; compiled: CompiledShaderGraph; usesShaderLevel: boolean; version: number } | null = null;
  private frame = 0;
  private yaw = 0.6;
  private pitch = 0.35;
  private readonly distance = 3.4;
  private readonly start = performance.now();
  private shaderFailed = false;
  /** The graph was rebuilt and no frame has been checked for shader errors yet. */
  private unchecked = false;
  private disposed = false;

  constructor(private readonly container: HTMLElement, canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    if (!this.canvas.isConnected) container.appendChild(this.canvas);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const engine = await createBabylonEngine(this.canvas, { transparent: true });
      if (this.disposed) {
        engine.dispose();
        return;
      }
      this.engine = engine;
      engine.setHardwareScalingLevel(1 / appliedPixelRatio()); // the World surface's pixel ratio, at render scale 1 (ADR 0154)
      const scene = createPreviewScene(engine);
      addDefaultLights(scene);
      const camera = new TargetCamera("preview.camera", Vector3.Zero(), scene, false);
      camera.fov = (35 * Math.PI) / 180;
      camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
      camera.minZ = 0.1;
      camera.maxZ = 50;
      camera.rotationQuaternion = Quaternion.Identity();
      scene.activeCamera = camera;
      this.scene = scene;
      this.camera = camera;
      this.studio = createStudioTexture(scene);
      void useWhenReady(scene, this.studio, STUDIO_INTENSITY).catch(() => undefined); // no reflections until it's ready (or ever, if it can't)
      this.resize();
      this.applyMesh();
      if (this.last) this.build(this.last.compiled, this.last.properties);
      const loop = () => {
        this.frame = requestAnimationFrame(loop);
        this.render();
      };
      this.frame = requestAnimationFrame(loop);
    } catch (err) {
      console.warn("[myco] shader graph preview couldn't start:", err);
    }
  }

  setMesh(kind: PreviewMesh): void {
    this.kind = kind;
    this.applyMesh();
  }

  private applyMesh(): void {
    const scene = this.scene;
    if (!scene) return;
    const material = this.mesh?.material ?? null;
    this.mesh?.dispose();
    const mesh = meshOf(scene, `preview.${this.kind}`, meshesIfLoaded(`builtin:${this.kind}`)![0]);
    // The plane leans back (three's mesh.rotation.x = -60°) so it shows its face to the camera's tilt.
    const a = this.kind === "plane" ? -Math.PI / 3 : 0;
    const c = Math.cos(a), s = Math.sin(a);
    mesh.freezeWorldMatrix(Matrix.FromArray([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]));
    mesh.material = material ?? this.graph?.material ?? null;
    this.mesh = mesh;
  }

  /** Draw `graph` (with a material's `properties`, if given). Returns the compiled graph. */
  setGraph(graph: ShaderGraph, properties: Record<string, GraphValue> = {}): CompiledShaderGraph {
    const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel });
    this.last = { graph, properties, compiled, usesShaderLevel: compiled.usesShaderLevel, version: Graphics._version };
    this.shaderFailed = false;
    this.onShaderError?.(null);
    if (this.scene) this.build(compiled, properties);
    return compiled;
  }

  private build(compiled: CompiledShaderGraph, properties: Record<string, GraphValue>): void {
    const scene = this.scene;
    if (!scene) return;
    this.graph?.dispose();
    this.shaderFailed = false;
    this.unchecked = true;
    this.onShaderError?.(null);
    this.library?.dispose();
    const library = (this.library = previewMaterials(scene, this.shared));
    this.graph = createGraphMaterial(scene, "preview.graph", compiled, properties, this.shared, (p, linear) => library.texture(p, linear ? "graphData" : "graphColor"));
    watchShaderErrors(this.graph, (message) => {
      this.shaderFailed = true;
      this.onShaderError?.(message);
    });
    if (this.mesh) this.mesh.material = this.graph.material;
  }

  /** Forget loaded textures (the project's images changed): the graph loads them again. */
  clearTextures(): void {
    if (this.last && this.scene) this.build(this.last.compiled, this.last.properties);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, yaw = this.yaw, pitch = this.pitch;
    this.canvas.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      this.yaw = yaw + (m.clientX - x0) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, pitch + (m.clientY - y0) * 0.01));
    };
    const up = () => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
    };
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
  };

  private resize(): void {
    this.engine?.resize();
  }

  private render(): void {
    const engine = this.engine, scene = this.scene, camera = this.camera;
    if (!engine || !scene || !camera || this.disposed) return;
    if (this.last && this.last.usesShaderLevel && this.last.version !== Graphics._version) this.setGraph(this.last.graph, this.last.properties);
    this.shared.time = (performance.now() - this.start) / 1000;
    this.shared.resolution = [engine.getRenderWidth(), engine.getRenderHeight()];
    const r = this.distance;
    aimCamera(camera, [Math.sin(this.yaw) * Math.cos(this.pitch) * r, Math.sin(this.pitch) * r, Math.cos(this.yaw) * Math.cos(this.pitch) * r], [0, 0, 0]);
    // The first frame a new graph is ready to draw is watched for WGSL errors (see renderFrameChecked).
    if (this.unchecked && this.mesh?.material?.isReady(this.mesh)) {
      this.unchecked = false;
      renderFrameChecked(engine, scene, (message) => {
        if (this.disposed) return;
        this.shaderFailed = true;
        this.onShaderError?.(message);
      });
    } else renderFrame(engine, scene);
  }

  /**
   * @internal Tests: render now and read the centre pixel as [r, g, b, a] (0–255), or null if the shader
   * failed or hasn't compiled yet. The frame is copied into a 2D canvas in the same task, since a WebGPU
   * canvas can't be read after it's presented.
   */
  readCenter(): [number, number, number, number] | null {
    this.render();
    const mesh = this.mesh;
    if (this.shaderFailed || !this.engine || !mesh?.material || !mesh.material.isReady(mesh)) return null;
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.canvas, Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2), 1, 1, 0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, 1, 1).data;
    return [px[0], px[1], px[2], px[3]];
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.graph?.dispose();
    this.library?.dispose();
    this.studio?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
    this.canvas.remove();
  }
}

/**
 * @internal Editor: draws node previews (ADR 0048), each a quad with an unlit graph material, with
 * one offscreen engine for every node, copied into each node's 2D canvas, so a large graph doesn't
 * need a GPU context per node.
 */
export class NodePreviewRenderer {
  private engine: AbstractEngine | null = null;
  private scene: Scene | null = null;
  private mesh: Mesh | null = null;
  /** The sphere and cube a node's preview can be drawn on, made on first use (ADR 0117). */
  private readonly shapes = new Map<NodePreviewShape, Mesh>();
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };
  private readonly canvas: HTMLCanvasElement;
  /** Compiled graphs, their materials and textures (ADR 0127) by the graph's JSON; ones not drawn in a pass are freed. */
  private readonly entries = new Map<string, { compiled: CompiledShaderGraph; graph: BabylonGraphMaterial; library: BabylonMaterialLibrary; used: boolean; failed: boolean; checked: boolean }>();
  private readonly start = performance.now();
  private disposed = false;

  constructor(readonly size = 96) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const engine = await createBabylonEngine(this.canvas, { antialias: false, transparent: true });
      if (this.disposed) {
        engine.dispose();
        return;
      }
      this.engine = engine;
      engine.setSize(this.size, this.size);
      const scene = createPreviewScene(engine);
      const camera = new TargetCamera("preview.camera", new Vector3(0, 0, 1), scene, false);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -0.5;
      camera.orthoRight = 0.5;
      camera.orthoTop = 0.5;
      camera.orthoBottom = -0.5;
      camera.minZ = 0.1;
      camera.maxZ = 10;
      camera.rotationQuaternion = Quaternion.Identity();
      scene.activeCamera = camera;
      const mesh = new Mesh("preview.quad", scene);
      const data = new VertexData();
      data.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
      data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
      data.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      data.indices = [0, 1, 2, 0, 2, 3];
      data.applyToMesh(mesh, false);
      this.scene = scene;
      this.mesh = mesh;
    } catch (err) {
      console.warn("[myco] node previews couldn't start:", err);
    }
  }

  /** Start a pass over every preview: advances time. */
  begin(): void {
    this.shared.time = (performance.now() - this.start) / 1000;
    this.shared.resolution = [this.size, this.size];
    for (const e of this.entries.values()) e.used = false;
  }

  /** The mesh for a preview shape: the quad, or a sphere or cube fitted to the same square view. */
  private meshFor(shape: NodePreviewShape): Mesh | null {
    if (shape === "quad" || !this.scene) return this.mesh;
    let m = this.shapes.get(shape);
    if (!m) {
      const src = meshesIfLoaded(`builtin:${shape}`)?.[0];
      if (!src) return this.mesh;
      m = meshOf(this.scene, `preview.${shape}`, src);
      if (shape === "sphere") m.scaling.setAll(0.92);
      else {
        m.scaling.setAll(0.62);
        m.rotationQuaternion = Quaternion.FromEulerAngles(0.5, 0.7, 0);
      }
      m.setEnabled(false);
      this.shapes.set(shape, m);
    }
    return m;
  }

  /** Draw `graph` (a node's preview graph) into `target`, on `shape`. False if its shader didn't compile. */
  draw(graph: ShaderGraph, target: HTMLCanvasElement, shape: NodePreviewShape = "quad"): boolean {
    const scene = this.scene, engine = this.engine, mesh = this.meshFor(shape);
    if (!scene || !engine || !mesh || this.disposed) return true; // still starting: the next pass draws
    const level = Graphics.tier.shaderLevel;
    const key = `${level}|${JSON.stringify(graph)}`;
    let e = this.entries.get(key);
    if (!e) {
      const compiled = compileShaderGraph(graph, { shaderLevel: level });
      // A library per entry, freed with it: a new preview graph loads the project's images afresh (as it did
      // before ADR 0127), instead of one renderer-long cache that never sees an image change.
      const library = previewMaterials(scene, this.shared);
      const made = createGraphMaterial(scene, "preview.node", compiled, {}, this.shared, (p, linear) => library.texture(p, linear ? "graphData" : "graphColor"));
      const entry = { compiled, graph: made, library, used: true, failed: false, checked: false };
      watchShaderErrors(made, () => (entry.failed = true));
      this.entries.set(key, entry);
      e = entry;
    }
    e.used = true;
    if (e.failed) return false;
    const material = e.graph.material;
    if (!material.isReady(mesh)) return true; // still compiling: leave the canvas as it is
    if (this.mesh) this.mesh.setEnabled(mesh === this.mesh);
    for (const m of this.shapes.values()) m.setEnabled(m === mesh);
    mesh.material = material;
    if (e.checked) renderFrame(engine, scene);
    else {
      e.checked = true;
      const entry = e;
      renderFrameChecked(engine, scene, () => (entry.failed = true));
    }
    const ctx = target.getContext("2d");
    if (!ctx) return !e.failed;
    ctx.clearRect(0, 0, target.width, target.height);
    if (!e.failed) ctx.drawImage(this.canvas, 0, 0, this.size, this.size, 0, 0, target.width, target.height);
    return !e.failed;
  }

  /** End a pass: free the materials of previews that weren't drawn. */
  end(): void {
    for (const [k, e] of this.entries) {
      if (e.used) continue;
      e.graph.dispose();
      e.library.dispose();
      this.entries.delete(k);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.graph.dispose();
      e.library.dispose();
    }
    this.entries.clear();
    this.scene?.dispose();
    this.engine?.dispose();
  }
}
