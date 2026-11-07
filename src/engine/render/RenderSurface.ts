/**
 * What the engine and editor ask of a render backend (ADR 0075): one World's drawing surface. The
 * three.js backend (`RenderBackend`) and the Babylon.js backend (`babylon/BabylonSurface`) both
 * implement it while the renderer migrates; `createRenderSurface` picks one. Internal: game code
 * never sees it, and no renderer type appears here (ADR 0010).
 */
import type { WarmMesh } from "../scene/warmUp";
import type { Component } from "../core/Component";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import type { LocalPose } from "./gizmoMath";
import type { Camera, SpriteRenderer } from "./components";
import type { PostEffects, ToneMappingName } from "./postEffects";
import type { UICoreLike } from "../ui/uiCoreTypes";

/** @internal Editor gizmo settings (ADR 0022). */
export interface GizmoOptions {
  mode: "translate" | "rotate" | "scale";
  /** 2D view: move/scale on X and Y only, rotate around Z only. */
  planar: boolean;
  /** Snap drags to `snapSteps` (default 0.25 m, 15° and 0.1 scale steps). */
  snap: boolean;
  /** Snap steps: metres for moves, degrees for turns, a factor for scaling. */
  snapSteps?: { move: number; rotate: number; scale: number };
  /** Move and turn along the world's axes (default) or the node's own (the active node's for several). */
  space?: "world" | "local";
  /** Several nodes: the gizmo sits at their centre (default) or on the active node's origin. */
  pivot?: "center" | "pivot";
  /** Which of the nodes is the active one (default: the last). */
  activeIndex?: number;
}

/** @internal Editor overlay (e.g. collider outlines and handles), supplied every frame by the editor. */
export interface EditorOverlay {
  /** Polylines in world space; `color` is 0xRRGGBB. */
  lines: { points: [number, number, number][]; closed: boolean; color: number }[];
  /** Handles drawn as fixed-size squares on top of everything; picked by `pickOverlayHandle`. */
  handles: { id: string; position: [number, number, number]; color: number }[];
  /** Many loose segments in one colour (6 floats each: a xyz, b xyz), for big overlays like navmesh debug drawing. */
  segments?: { positions: Float32Array; color: number }[];
}

/** @internal What the editor does with a gizmo drag: one start, many changes, one end. */
export interface GizmoHandlers {
  onStart(): void;
  /** Each target node's new local Transform values, in the order the nodes were given. */
  onChange(poses: LocalPose[]): void;
  onEnd(): void;
}

/** @internal A rectangle on the canvas in CSS pixels (origin top-left); a point when left = right and top = bottom. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * @internal Editor overlay colours (ADR 0022), 0xRRGGBB: the viewport background, the grid's lines
 * and centre lines, the selection outline and unselected camera wireframes. The editor sets them
 * from its theme (`setEditorColors`).
 */
export interface EditorColors {
  background: number;
  grid: number;
  gridCenter: number;
  outline: number;
  cameraGizmo: number;
}

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

/** @internal One World's drawing surface (ADR 0032, 0075). */
export interface RenderSurface {
  /** The canvas the World draws to; input listens to it. */
  readonly canvas: HTMLCanvasElement;
  /** Step 8 of the frame: mirror the World's render components into the renderer. */
  sync(world: World): void;
  /** Draw the World's cameras, then its UI. */
  render(world: World): void;
  /** Free the renderer objects of a removed component. */
  release(c: Component): void;
  /** Forget the World this surface draws, so another may claim it. */
  releaseWorld(): void;
  dispose(): void;
  /**
   * Resolves once the renderer has started (true) or failed to (false); frames before then draw
   * nothing. The desktop editor shows its window after this, so the scene view opens drawn (ADR 0082).
   */
  readonly started?: Promise<boolean>;
  /** Load textures ahead of time so sprites don't pop in. */
  preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void>;
  /**
   * Draw each mesh once, hidden, in every pass the frame would put it in, so its shader pipelines exist
   * before it's shown (ADR 0080). Resolves once they're drawn, or at once while the surface isn't
   * drawing frames (they're drawn when it starts).
   */
  warmUp(meshes: readonly WarmMesh[]): Promise<void>;
  /** @internal Editor play mode: log shader variants compiled after loading, naming their prefab (ADR 0080). */
  _setVariantReport?(on: boolean): void;

  // Tests and diagnostics.
  qualityState(): { tier: string; pixelRatio: number; shadows: boolean; shadowMapSize: number; anisotropy: number; msaa: boolean };
  lightingState(): { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean };
  postState(): { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null };
  stackCount(): number;
  waterState(): { surfaces: number };
  probeState(): { captured: number; probes: number; reflecting: number };
  particleState(): ParticleStats | null;
  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number };
  /** Tests and the editor: the UI core's layout and hit testing, once loaded. */
  uiRuntime(): Pick<UICoreLike, "rectOf" | "hitTest" | "pickAll" | "cornersOf"> | null;

  // Editor (ADR 0022 and later).
  setEditorColors(colors: EditorColors): void;
  setEditorGridPlane(plane: "xz" | "xy"): void;
  setEditorGrid(cellSize: number, visible: boolean): void;
  editorGrid(): { cellSize: number; visible: boolean; divisions: number } | null;
  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void;
  restartParticlePreview(): void;
  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void;
  /** True if the last frame drew a camera preview. */
  readonly cameraPreviewDrawn: boolean;
  pick(world: World, x: number, y: number): GameObject[];
  spriteSize(s: SpriteRenderer): [number, number] | null;
  meshBounds(node: GameObject): { min: [number, number, number]; max: [number, number, number] } | null;
  rayAt(world: World, x: number, y: number): { origin: [number, number, number]; direction: [number, number, number] } | null;
  worldToCanvas(world: World, p: readonly number[]): [number, number] | null;
  screenBounds(world: World, root: GameObject): { node: GameObject; rect: ScreenRect }[];
  pointOnPlaneZ(world: World, x: number, y: number, z?: number): [number, number, number] | null;
  pointOnPlane(world: World, x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null;
  setSelectionOutline(nodes: readonly GameObject[]): void;
  setSelectionOutlineShown(shown: boolean): void;
  editorDrawingShown(): { segments: number; handles: number; outlines: number; drawnObjects: number };
  setOverlayProvider(provider: (() => EditorOverlay) | null): void;
  overlayHandlesOnCanvas(world: World): { id: string; x: number; y: number }[];
  pickOverlayHandle(world: World, x: number, y: number, radius?: number): string | null;
  lightIconsOnCanvas(world: World): { node: GameObject; x: number; y: number }[];
  lightWireCount(): number;
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void;
  gizmoActiveAt(x: number, y: number): boolean;
}
