/**
 * What the engine asks of a renderer (ADR 0032, 0075, 0128): one World's drawing surface. Babylon.js
 * (`babylon/BabylonSurface`) is the only implementation today; `createRenderSurface` picks it.
 * Internal: game code never sees it, and no renderer type appears here or in anything it returns
 * (ADR 0010), so another renderer can implement it without touching the engine or the editor.
 *
 * Three parts: the runtime core the Engine drives each frame, one diagnostics snapshot (tests,
 * play mode's Stats), and the editor's viewport handle (`editorViewport.ts`), which games never ask for.
 */
import type { WarmContent } from "../scene/warmUp";
import type { Component } from "../core/Component";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import type { Camera } from "./components";
import type { EditorViewport } from "./editorViewport";
import type { PostEffects, ToneMappingName } from "./postEffects";

/** @internal Particle preview controls (ADR 0057). */
export interface ParticlePreviewSettings {
  playing: boolean;
  speed: number;
  simulateAll: boolean;
}

/** @internal Particle counts, for tests and the editor (ADR 0057). */
export interface ParticleStats {
  systems: number;
  emitters: number;
  particles: number;
  batches: number;
  previewed: { time: number; count: number } | null;
}

/** @internal What the last frame drew and the GPU resources the surface holds (play mode's Stats). */
export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly lines: number;
  readonly points: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

/** @internal A material as a drawn mesh uses it, in the engine's material terms (ADR 0044, 0084). */
export interface DrawnMaterial {
  /** Unlit shading (no lights). */
  unlit: boolean;
  /** Physical clearcoat strength, 0 when off. */
  clearcoat: number;
  /** Physical transmission, 0 when off. */
  transmission: number;
}

/**
 * @internal A renderer's state as engine facts (ADR 0128), for tests and the editor. A snapshot:
 * computed when asked, never kept up to date. Nothing in it is a renderer object or name.
 */
export interface RenderDiagnostics {
  /** The renderer has started; before then every other field reports nothing. */
  started: boolean;
  /** The graphics tier as applied (ADR 0050). */
  quality: { tier: string; pixelRatio: number; shadows: boolean; shadowMapSize: number; msaa: boolean };
  lighting: { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean };
  /** The procedural sky (ADR 0112): drawn, bakes made, whether a bake lights the scene, its time of day, the last bake's CPU time. */
  sky: { active: boolean; drawn: boolean; bakes: number; baked: boolean; time: number; lastBakeMs: number };
  /** Post-processing (ADR 0051, 0056): what the first camera ran, and how many canvas cameras composed effects. */
  post: { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null; composedCameras: number };
  water: { surfaces: number };
  probes: { captured: number; probes: number; reflecting: number };
  /** The render texture assets made so far (ADR 0109), by path. */
  renderTextures: Record<string, { width: number; height: number; format: string }>;
  /** Null until the particle renderer has loaded. */
  particles: ParticleStats | null;
  stats: RenderStats;
  /** The cameras that drew the last frame: to the canvas (depth order), into a render texture, or the editor's preview inset. */
  cameras: { camera: Camera; target: "canvas" | "texture" | "preview" }[];
  /** The nodes whose renderers are drawn (visible, loaded), once each: meshes with their materials, and sprites. */
  drawn: { meshes: { node: GameObject; materials: DrawnMaterial[] }[]; sprites: GameObject[] };
}

/** @internal One World's drawing surface (ADR 0032, 0075, 0128). */
export interface RenderSurface {
  /** The canvas the World draws to; input listens to it. */
  readonly canvas: HTMLCanvasElement;
  /**
   * Resolves once the renderer has started (true) or failed to (false); frames before then draw
   * nothing. The desktop editor shows its window after this, so the scene view opens drawn (ADR 0082).
   */
  readonly started: Promise<boolean>;
  /** Step 8 of the frame: mirror the World's render components into the renderer. */
  sync(world: World): void;
  /** Draw the World's cameras, then its UI. */
  render(world: World): void;
  /** Free the renderer objects of a removed component. */
  release(c: Component): void;
  /** Forget the World this surface draws, so another may claim it. */
  releaseWorld(): void;
  dispose(): void;
  /** Load textures ahead of time so sprites don't pop in. */
  preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void>;
  /**
   * Draw a warm set's meshes, particle effects and world-space UI once, hidden, in every pass the frame
   * would put them in, so their shader pipelines exist before they're shown (ADR 0080). Resolves once
   * they're drawn, or at once while the surface isn't drawing frames (they're drawn when it starts).
   */
  warmUp(set: WarmContent): Promise<void>;
  /** @internal Editor play mode: log shader variants compiled after loading, naming their prefab (ADR 0080). */
  _setVariantReport?(on: boolean): void;
  /** The renderer's state now, as engine facts (tests, play mode's Stats). */
  diagnostics(): RenderDiagnostics;
  /** The editor's handle on this surface's viewport (ADR 0128), made on first ask; asking loads the editor tools. */
  editorViewport(): EditorViewport;
}
