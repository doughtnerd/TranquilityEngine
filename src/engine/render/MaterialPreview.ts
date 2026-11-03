/**
 * @internal Editor: a live preview of a shader graph (ADR 0046, 0047) on a built-in mesh, in a
 * canvas of its own, lit like a default scene (a sun, soft ambient light and the studio
 * environment). Drag to turn the mesh. Reached through `src/engine/editor`, never the public API.
 */
import {
  AmbientLight,
  DirectionalLight,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  WebGLRenderer,
} from "three";
import { Assets } from "../scene/Assets";
import { meshesIfLoaded, type BuiltinMesh } from "../scene/models";
import type { GraphValue, ShaderGraph } from "../scene/shaderGraph";
import { Graphics } from "./Graphics";
import { compileShaderGraph, type CompiledShaderGraph } from "./shaderGraph/compile";
import { createGraphMaterial, createSharedGraphUniforms, type GraphMaterial, type LoadTexture } from "./shaderGraph/threeMaterial";

/** Load project textures for previews, cached; linear copies for normal maps. */
function previewTextures(): { load: LoadTexture; clear(): void } {
  const loader = new TextureLoader();
  const cache = new Map<string, Promise<Texture>>();
  const load: LoadTexture = (path, linear) => {
    const key = `${linear ? "L" : "S"}${path}`;
    let p = cache.get(key);
    if (!p) {
      p = loader.loadAsync(Assets.url(path)).then((tex) => {
        tex.colorSpace = linear ? NoColorSpace : SRGBColorSpace;
        return tex;
      });
      cache.set(key, p);
    }
    return p;
  };
  return {
    load,
    clear() {
      for (const p of cache.values()) void p.then((t) => t.dispose(), () => undefined);
      cache.clear();
    },
  };
}

export type PreviewMesh = Extract<BuiltinMesh, "sphere" | "cube" | "capsule" | "plane" | "quad">;

export class MaterialPreview {
  readonly canvas: HTMLCanvasElement;
  /** Called with WebGL's log when the generated shader fails to compile (a compiler bug), or null once one compiles. */
  onShaderError: ((message: string | null) => void) | null = null;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.1, 50);
  private readonly mesh = new Mesh();
  private readonly shared = createSharedGraphUniforms();
  private readonly textures = previewTextures();
  private readonly resizeObserver: ResizeObserver;
  private graph: GraphMaterial | null = null;
  /** What `setGraph` last drew, to rebuild when the quality tier changes a Quality Branch. */
  private last: { graph: ShaderGraph; properties: Record<string, GraphValue>; usesShaderLevel: boolean; version: number } | null = null;
  private frame = 0;
  private yaw = 0.6;
  private pitch = 0.35;
  private readonly start = performance.now();
  private shaderFailed = false;

  constructor(private readonly container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.debug.onShaderError = (gl, _program, vs, fs) => {
      const log = [gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join("\n").trim();
      this.shaderFailed = true;
      this.onShaderError?.(log || "the shader didn't compile");
    };
    const sun = new DirectionalLight(0xffffff, 1);
    sun.position.set(4, 10, 6);
    this.scene.add(new AmbientLight(0xffffff, 0.35), sun, this.mesh);
    this.camera.position.set(0, 0, 3.4);
    this.setMesh("sphere");
    void this.loadEnvironment();
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.render();
    };
    this.frame = requestAnimationFrame(loop);
  }

  private async loadEnvironment(): Promise<void> {
    try {
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      const pmrem = new PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(room, 0.04).texture;
      this.scene.environmentIntensity = 0.4;
      room.dispose();
      pmrem.dispose();
    } catch {
      // The preview just has no reflections.
    }
  }

  setMesh(kind: PreviewMesh): void {
    this.mesh.geometry = meshesIfLoaded(`builtin:${kind}`)![0].geometry;
    this.mesh.rotation.set(kind === "plane" ? -Math.PI / 3 : 0, 0, 0);
  }

  /** Draw `graph` (with a material's `properties`, if given). Returns the compiled graph. */
  setGraph(graph: ShaderGraph, properties: Record<string, GraphValue> = {}): CompiledShaderGraph {
    const compiled = compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel });
    this.last = { graph, properties, usesShaderLevel: compiled.usesShaderLevel, version: Graphics._version };
    this.graph?.dispose();
    this.shaderFailed = false;
    this.onShaderError?.(null);
    this.graph = createGraphMaterial(compiled, properties, this.shared, this.textures.load);
    this.mesh.material = this.graph.material;
    return compiled;
  }

  /** Forget loaded textures (the project's images changed). */
  clearTextures(): void {
    this.textures.clear();
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
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private render(): void {
    if (this.last && this.last.usesShaderLevel && this.last.version !== Graphics._version) this.setGraph(this.last.graph, this.last.properties);
    this.shared.time.value = (performance.now() - this.start) / 1000;
    this.renderer.getDrawingBufferSize(this.shared.resolution.value);
    const r = this.camera.position.length();
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * r, Math.sin(this.pitch) * r, Math.cos(this.yaw) * Math.cos(this.pitch) * r);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  /** @internal Tests: render now and read the centre pixel as [r, g, b, a] (0–255), or null if the shader failed. */
  readCenter(): [number, number, number, number] | null {
    this.render();
    if (this.shaderFailed) return null;
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2], px[3]];
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.graph?.dispose();
    this.clearTextures();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/**
 * @internal Editor: draws node previews (ADR 0048), each a quad with an unlit graph material, with
 * one offscreen WebGL renderer for every node, copied into each node's 2D canvas, so a large
 * graph doesn't need a WebGL context per node.
 */
export class NodePreviewRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
  private readonly mesh = new Mesh(new PlaneGeometry(1, 1));
  private readonly shared = createSharedGraphUniforms();
  private readonly textures = previewTextures();
  /** Compiled graphs and their materials by the graph's JSON; ones not drawn in a pass are freed. */
  private readonly entries = new Map<string, { compiled: CompiledShaderGraph; graph: GraphMaterial; used: boolean; failed: boolean }>();
  private readonly start = performance.now();
  private failed = false;

  constructor(readonly size = 96) {
    const canvas = document.createElement("canvas");
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.debug.onShaderError = () => (this.failed = true);
    this.camera.position.set(0, 0, 1);
    this.scene.add(this.mesh);
  }

  /** Start a pass over every preview: advances time. */
  begin(): void {
    this.shared.time.value = (performance.now() - this.start) / 1000;
    this.shared.resolution.value.set(this.size, this.size);
    for (const e of this.entries.values()) e.used = false;
  }

  /** Draw `graph` (a node's preview graph) into `target`. False if its shader didn't compile. */
  draw(graph: ShaderGraph, target: HTMLCanvasElement): boolean {
    const level = Graphics.tier.shaderLevel;
    const key = `${level}|${JSON.stringify(graph)}`;
    let e = this.entries.get(key);
    if (!e) {
      const compiled = compileShaderGraph(graph, { shaderLevel: level });
      e = { compiled, graph: createGraphMaterial(compiled, {}, this.shared, this.textures.load), used: true, failed: false };
      this.entries.set(key, e);
    }
    e.used = true;
    this.mesh.material = e.graph.material;
    this.failed = false;
    this.renderer.render(this.scene, this.camera);
    // three.js reports a broken program once, when it first compiles; remember it.
    if (this.failed) e.failed = true;
    const ctx = target.getContext("2d");
    if (!ctx) return !e.failed;
    ctx.clearRect(0, 0, target.width, target.height);
    if (!e.failed) ctx.drawImage(this.renderer.domElement, 0, 0, target.width, target.height);
    return !e.failed;
  }

  /** End a pass: free the materials of previews that weren't drawn. */
  end(): void {
    for (const [k, e] of this.entries) {
      if (e.used) continue;
      e.graph.dispose();
      this.entries.delete(k);
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.graph.dispose();
    this.entries.clear();
    this.textures.clear();
    this.mesh.geometry.dispose();
    this.renderer.dispose();
  }
}
