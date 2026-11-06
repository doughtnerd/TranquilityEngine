/**
 * @internal Editor: the preview renderers on the renderer the dev flag picks (ADR 0075 stage 7). Each
 * has one name and one API; `rendererChoice()` decides whether it runs on three.js or
 * on Babylon.js, whose code is loaded with a dynamic `import()` so a three.js page never downloads it.
 *
 * - `createThumbnailRenderer`, `loadParticleEffectPreview`: already asynchronous, so they load the one chosen.
 * - `MaterialPreview`, `NodePreviewRenderer`: constructed synchronously by the shader graph panel. On
 *   Babylon they're thin wrappers that make the real preview when its module arrives and replay what was
 *   asked of them meanwhile.
 *
 * Babylon is imported nowhere in this file (the check in `babylonImports.test.ts`).
 */
import type { GraphValue, ShaderGraph } from "../scene/shaderGraph";
import { Graphics } from "./Graphics";
import { MaterialPreview as ThreeMaterialPreview, NodePreviewRenderer as ThreeNodePreviewRenderer, type PreviewMesh } from "./MaterialPreview";
import { rendererChoice } from "./createRenderSurface";
import type { ParticleEffectPreviewApi, ThumbnailRendererApi } from "./previewTypes";
import { compileShaderGraph, type CompiledShaderGraph } from "./shaderGraph/compile";

export type { PreviewMesh };

/** The editor's asset thumbnail renderer (one offscreen GPU context), loaded the first time it's needed. */
export async function createThumbnailRenderer(size?: number): Promise<ThumbnailRendererApi> {
  if (rendererChoice() === "babylon") {
    const { ThumbnailRenderer } = await import("./babylon/previews/ThumbnailRenderer");
    return ThumbnailRenderer.create(size);
  }
  const { ThumbnailRenderer } = await import("./ThumbnailRenderer");
  return new ThumbnailRenderer(size);
}

/** The particle graph editor's effect preview class, loaded on demand. */
export async function loadParticleEffectPreview(): Promise<{ ParticleEffectPreview: new (container: HTMLElement) => ParticleEffectPreviewApi }> {
  return rendererChoice() === "babylon" ? import("./babylon/previews/EffectPreview") : import("./particles/EffectPreview");
}

/** What a shader graph preview does, as both renderers' classes do it. */
interface MaterialPreviewImpl {
  readonly canvas: HTMLCanvasElement;
  onShaderError: ((message: string | null) => void) | null;
  setMesh(kind: PreviewMesh): void;
  setGraph(graph: ShaderGraph, properties?: Record<string, GraphValue>): CompiledShaderGraph;
  clearTextures(): void;
  readCenter(): [number, number, number, number] | null;
  dispose(): void;
}

/** A live preview of a shader graph on a built-in mesh in a canvas of its own (ADR 0046, 0047). */
export class MaterialPreview {
  readonly canvas: HTMLCanvasElement;
  private impl: MaterialPreviewImpl | null = null;
  private errorHandler: ((message: string | null) => void) | null = null;
  private mesh: PreviewMesh | null = null;
  private graph: { graph: ShaderGraph; properties: Record<string, GraphValue> } | null = null;
  private disposed = false;

  constructor(container: HTMLElement) {
    if (rendererChoice() === "babylon") {
      this.canvas = document.createElement("canvas");
      container.appendChild(this.canvas);
      void import("./babylon/previews/MaterialPreview").then(({ MaterialPreview: Babylon }) => {
        if (this.disposed) return;
        const impl: MaterialPreviewImpl = new Babylon(container, this.canvas);
        this.impl = impl;
        impl.onShaderError = this.errorHandler;
        if (this.mesh) impl.setMesh(this.mesh);
        if (this.graph) impl.setGraph(this.graph.graph, this.graph.properties);
      });
    } else {
      const impl = new ThreeMaterialPreview(container);
      this.impl = impl;
      this.canvas = impl.canvas;
    }
  }

  /** Called with the shader compiler's log when the generated shader fails to compile (a compiler bug), or null once one compiles. */
  get onShaderError(): ((message: string | null) => void) | null {
    return this.errorHandler;
  }

  set onShaderError(f: ((message: string | null) => void) | null) {
    this.errorHandler = f;
    if (this.impl) this.impl.onShaderError = f;
  }

  setMesh(kind: PreviewMesh): void {
    this.mesh = kind;
    this.impl?.setMesh(kind);
  }

  /** Draw `graph` (with a material's `properties`, if given). Returns the compiled graph. */
  setGraph(graph: ShaderGraph, properties: Record<string, GraphValue> = {}): CompiledShaderGraph {
    this.graph = { graph, properties };
    if (this.impl) return this.impl.setGraph(graph, properties);
    // The Babylon preview is still loading: compile as it will (the editor shows this graph's problems at once).
    return compileShaderGraph(graph, { shaderLevel: Graphics.tier.shaderLevel, language: "wgsl" });
  }

  /** Forget loaded textures (the project's images changed). */
  clearTextures(): void {
    this.impl?.clearTextures();
  }

  /** @internal Tests: render now and read the centre pixel as [r, g, b, a] (0–255), or null if the shader failed (or isn't drawn yet). */
  readCenter(): [number, number, number, number] | null {
    return this.impl?.readCenter() ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.impl?.dispose();
    this.impl = null;
    this.canvas.remove();
  }
}

interface NodePreviewImpl {
  begin(): void;
  draw(graph: ShaderGraph, target: HTMLCanvasElement): boolean;
  end(): void;
  dispose(): void;
}

/** Draws node previews (ADR 0048): one offscreen renderer for every node, copied into each node's 2D canvas. */
export class NodePreviewRenderer {
  private impl: NodePreviewImpl | null = null;
  private disposed = false;

  constructor(readonly size = 96) {
    if (rendererChoice() === "babylon") {
      void import("./babylon/previews/MaterialPreview").then(({ NodePreviewRenderer: Babylon }) => {
        if (!this.disposed) this.impl = new Babylon(size);
      });
    } else {
      this.impl = new ThreeNodePreviewRenderer(size);
    }
  }

  /** Start a pass over every preview: advances time. */
  begin(): void {
    this.impl?.begin();
  }

  /** Draw `graph` (a node's preview graph) into `target`. False if its shader didn't compile. */
  draw(graph: ShaderGraph, target: HTMLCanvasElement): boolean {
    return this.impl ? this.impl.draw(graph, target) : true; // still loading: the next pass draws
  }

  /** End a pass: free the materials of previews that weren't drawn. */
  end(): void {
    this.impl?.end();
  }

  dispose(): void {
    this.disposed = true;
    this.impl?.dispose();
    this.impl = null;
  }
}
