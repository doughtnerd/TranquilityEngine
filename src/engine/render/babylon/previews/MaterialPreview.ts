/**
 * @internal Editor: shader graph previews on the Babylon backend (ADR 0046–0048, 0075 stage 7), with the
 * API `render/previewRouting.ts` routes to. `MaterialPreview` is a live preview of a graph on a
 * built-in mesh in a canvas of its own, lit like a default scene (a sun, soft ambient light and the studio
 * environment); drag to turn the mesh. `NodePreviewRenderer` draws every node's preview with one offscreen
 * engine, copied into each node's 2D canvas. Graphs compile to WGSL. Both draw on a preview stage (ADR 0300), which
 * owns the engine, scene, orbit, loop and context loss; they keep the meshes and graph materials they put on it.
 *
 * The engine starts asynchronously (WebGPU needs `initAsync`), so the constructors return at once and
 * the first frames appear a moment later; calls made before that are applied when it's up.
 */
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { meshesIfLoaded, type BuiltinMesh } from "../../../scene/models";
import type { GraphValue, NodePreviewShape, ShaderGraph } from "../../../scene/shaderGraph";
import { Graphics } from "../../Graphics";
import { compileShaderGraph, type CompiledShaderGraph } from "../../shaderGraph/compile";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "../graphMaterial";
import { meshOf } from "../materials";
import type { BabylonMaterialLibrary } from "../materialLibrary";
import { createStudioTexture, previewMaterials, renderFrame, renderFrameChecked, useWhenReady } from "./common";
import { PreviewStage } from "./previewStage";

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
  private readonly stage: PreviewStage;
  private mesh: Mesh | null = null;
  private studio: HDRCubeTexture | null = null;
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };
  private graph: BabylonGraphMaterial | null = null;
  /** The textures the graph loaded (ADR 0127), freed when it's rebuilt, so changed images load anew. */
  private library: BabylonMaterialLibrary | null = null;
  private kind: PreviewMesh = "sphere";
  /** What `setGraph` last drew, to rebuild when the quality tier changes a Quality Branch. */
  private last: { graph: ShaderGraph; properties: Record<string, GraphValue>; compiled: CompiledShaderGraph; usesShaderLevel: boolean; version: number } | null = null;
  private readonly start = performance.now();
  /** The graph was rebuilt and no frame has been checked for shader errors yet. */
  private unchecked = false;
  private disposed = false;

  constructor(container: HTMLElement, canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.stage = new PreviewStage(this.canvas, {
      name: "shader graph preview",
      host: container,
      // Turned around the origin from in front, a little to the right and above (ADR 0300's orbit; no zoom).
      orbit: { fov: 35, near: 0.1, far: 50, target: [0, 0, 0], start: { yaw: Math.PI - 0.6, pitch: 0.35, distance: 3.4 } },
      onUp: (stage) => {
        this.studio = createStudioTexture(stage.scene!);
        void useWhenReady(stage.scene!, this.studio).catch(() => undefined); // no reflections until it's ready (or ever, if it can't)
        this.applyMesh();
        if (this.last) this.build(this.last.compiled, this.last.properties);
      },
      frame: () => this.render(),
    });
  }

  setMesh(kind: PreviewMesh): void {
    this.kind = kind;
    this.applyMesh();
  }

  private applyMesh(): void {
    const scene = this.stage.scene;
    if (!scene) return;
    const material = this.mesh?.material ?? null;
    this.mesh?.dispose();
    const mesh = meshOf(scene, `preview.${this.kind}`, meshesIfLoaded(`builtin:${this.kind}`)![0]);
    // The plane leans back 60° about X so it shows its face to the camera's tilt.
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
    this.onShaderError?.(null);
    if (this.stage.scene) this.build(compiled, properties);
    return compiled;
  }

  private build(compiled: CompiledShaderGraph, properties: Record<string, GraphValue>): void {
    const scene = this.stage.scene;
    if (!scene) return;
    this.graph?.dispose();
    this.unchecked = true;
    this.onShaderError?.(null);
    this.library?.dispose();
    const library = (this.library = previewMaterials(scene, this.shared));
    this.graph = createGraphMaterial(scene, "preview.graph", compiled, properties, this.shared, (p, linear) => library.loadTexture(p, linear ? "graphData" : "graphColor"));
    watchShaderErrors(this.graph, (message) => {
      this.onShaderError?.(message);
    });
    if (this.mesh) this.mesh.material = this.graph.material;
  }

  /** Forget loaded textures (the project's images changed): the graph loads them again. */
  clearTextures(): void {
    if (this.last && this.stage.scene) this.build(this.last.compiled, this.last.properties);
  }

  private render(): void {
    const engine = this.stage.engine;
    if (!engine || this.disposed) return;
    if (this.last && this.last.usesShaderLevel && this.last.version !== Graphics._version) this.setGraph(this.last.graph, this.last.properties);
    this.shared.time = (performance.now() - this.start) / 1000;
    this.shared.resolution = [engine.getRenderWidth(), engine.getRenderHeight()];
    // The first frame a new graph is ready to draw is watched for WGSL errors (see renderFrameChecked).
    if (this.unchecked && this.mesh?.material?.isReady(this.mesh)) {
      this.unchecked = false;
      this.stage.draw((message) => {
        if (this.disposed) return;
        this.onShaderError?.(message);
      });
    } else this.stage.draw();
  }

  dispose(): void {
    this.disposed = true;
    this.graph?.dispose();
    this.library?.dispose();
    this.studio?.dispose();
    this.stage.dispose();
  }
}

/**
 * @internal Editor: draws node previews (ADR 0048), each a quad with an unlit graph material, with
 * one offscreen engine for every node, copied into each node's 2D canvas, so a large graph doesn't
 * need a GPU context per node.
 */
export class NodePreviewRenderer {
  private readonly stage: PreviewStage;
  private mesh: Mesh | null = null;
  /** The sphere and cube a node's preview can be drawn on, made on first use (ADR 0117). */
  private readonly shapes = new Map<NodePreviewShape, Mesh>();
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };
  /** Compiled graphs, their materials and textures (ADR 0127) by the graph's JSON; ones not drawn in a pass are freed. */
  private readonly entries = new Map<string, { compiled: CompiledShaderGraph; graph: BabylonGraphMaterial; library: BabylonMaterialLibrary; used: boolean; failed: boolean; checked: boolean }>();
  private readonly start = performance.now();
  private disposed = false;

  constructor(readonly size = 96) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    this.stage = new PreviewStage(canvas, {
      name: "node previews",
      antialias: false,
      scene: "unlit",
      onUp: ({ engine, scene }) => {
        engine!.setSize(this.size, this.size);
        const camera = new TargetCamera("preview.camera", new Vector3(0, 0, -1), scene!, false); // looking along +Z
        camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        camera.orthoLeft = -0.5;
        camera.orthoRight = 0.5;
        camera.orthoTop = 0.5;
        camera.orthoBottom = -0.5;
        camera.minZ = 0.1;
        camera.maxZ = 10;
        camera.rotationQuaternion = Quaternion.Identity();
        scene!.activeCamera = camera;
        const mesh = new Mesh("preview.quad", scene!);
        const data = new VertexData();
        data.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
        data.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
        data.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
        data.indices = [0, 1, 2, 0, 2, 3];
        data.applyToMesh(mesh, false);
        this.mesh = mesh;
      },
    });
  }

  /** Start a pass over every preview: advances time. */
  begin(): void {
    this.shared.time = (performance.now() - this.start) / 1000;
    this.shared.resolution = [this.size, this.size];
    for (const e of this.entries.values()) e.used = false;
  }

  /** The mesh for a preview shape: the quad, or a sphere or cube fitted to the same square view. */
  private meshFor(shape: NodePreviewShape): Mesh | null {
    const scene = this.stage.scene;
    if (shape === "quad" || !scene) return this.mesh;
    let m = this.shapes.get(shape);
    if (!m) {
      const src = meshesIfLoaded(`builtin:${shape}`)?.[0];
      if (!src) return this.mesh;
      m = meshOf(scene, `preview.${shape}`, src);
      if (shape === "sphere") m.scaling.setAll(0.92);
      else {
        m.scaling.setAll(0.62);
        m.rotationQuaternion = Quaternion.FromEulerAngles(-0.5, -0.7, 0);
      }
      m.setEnabled(false);
      this.shapes.set(shape, m);
    }
    return m;
  }

  /** Draw `graph` (a node's preview graph) into `target`, on `shape`. False if its shader didn't compile. */
  draw(graph: ShaderGraph, target: HTMLCanvasElement, shape: NodePreviewShape = "quad"): boolean {
    const scene = this.stage.scene, engine = this.stage.engine, mesh = this.meshFor(shape);
    if (!scene || !engine || !mesh || this.disposed) return true; // still starting: the next pass draws
    const level = Graphics.tier.shaderLevel;
    const key = `${level}|${JSON.stringify(graph)}`;
    let e = this.entries.get(key);
    if (!e) {
      const compiled = compileShaderGraph(graph, { shaderLevel: level });
      // A library per entry, freed with it: a new preview graph loads the project's images afresh (as it did
      // before ADR 0127), instead of one renderer-long cache that never sees an image change.
      const library = previewMaterials(scene, this.shared);
      const made = createGraphMaterial(scene, "preview.node", compiled, {}, this.shared, (p, linear) => library.loadTexture(p, linear ? "graphData" : "graphColor"));
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
    if (!e.failed) ctx.drawImage(this.stage.canvas, 0, 0, this.size, this.size, 0, 0, target.width, target.height);
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
    this.stage.dispose();
  }
}
