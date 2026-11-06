/**
 * The Babylon.js backend's drawing surface (ADR 0075). It owns the canvas and its layout, and loads
 * the renderer (`BabylonRenderer`, which imports Babylon) on demand, so this file stays light and a
 * page on the three.js backend never downloads Babylon. Until the renderer is ready, frames are
 * skipped; sync mirrors the whole World every frame, so nothing is lost.
 *
 * Stage 1 draws cameras, meshes, sprites and material assets; stage 2 adds lights, shadows and the
 * environment. Editor helpers and later stages' state
 * report "nothing" here.
 */
import type { Component } from "../../core/Component";
import { Graphics } from "../Graphics";
import { SHADOW_MAP_SIZE } from "../../core/graphics";
import type { ProjectSettings } from "../../core/settings";
import type { World, WorldKind } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { Camera, SpriteRenderer } from "../components";
import type { UIRuntime } from "../../ui/UIRuntime";
import type { PostEffects, ToneMappingName } from "../PostProcessStack";
import type {
  EditorColors,
  EditorOverlay,
  GizmoHandlers,
  GizmoOptions,
  ParticlePreviewSettings,
  ParticleStats,
  RenderSurface,
  ScreenRect,
} from "../RenderSurface";
import type { BabylonRenderer } from "./BabylonRenderer";

/** @internal The Babylon.js render surface (ADR 0075). */
export class BabylonSurface implements RenderSurface {
  readonly canvas: HTMLCanvasElement;
  private renderer: BabylonRenderer | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly fill: boolean;
  private disposed = false;
  private appliedQuality = -1;
  private pixelRatio = 1;
  private owner: World | null = null;
  private background: string | number;
  /** Editor state set before the renderer loaded, applied once it has. */
  private readonly particlePreview: Partial<ParticlePreviewSettings> = {};
  private selection: GameObject[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly settings: ProjectSettings,
    kind: WorldKind = "runtime",
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    // Editor Worlds fill their viewport panel; games keep the reference aspect ratio, letterboxed.
    this.fill = kind === "editor";
    this.background = settings.display.backgroundColor;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    void import("./BabylonRenderer")
      .then((m) => m.BabylonRenderer.create(this.canvas, settings, this.fill))
      .then((r) => {
        if (this.disposed) return r.dispose();
        this.renderer = r;
        // Dev builds: every live Babylon scene, for inspecting the migration from the console.
        if (import.meta.env?.DEV) ((globalThis as { __mycoBabylonScenes?: unknown[] }).__mycoBabylonScenes ??= []).push(r.scene);
        r.setClearColor(this.background);
        r.setParticlePreview(this.particlePreview);
        r.setSelected(this.selection);
        this.applyQuality();
      })
      .catch((err) => console.error("[myco] the Babylon.js renderer couldn't start:", err));
  }

  /** Fit the canvas to the container: fill it (editor) or keep the reference aspect ratio. */
  private resize(): void {
    const { width, height } = this.settings.display;
    const cw = this.container.clientWidth || width;
    const ch = this.container.clientHeight || height;
    let w = cw, h = ch;
    if (!this.fill) {
      const aspect = width / height;
      w = cw;
      h = cw / aspect;
      if (h > ch) {
        h = ch;
        w = ch * aspect;
      }
    }
    this.canvas.style.width = `${Math.floor(w)}px`;
    this.canvas.style.height = `${Math.floor(h)}px`;
    this.renderer?.resize(this.pixelRatio);
  }

  /** The tier's render scale (ADR 0050); the rest of the tier arrives with later stages. */
  private applyQuality(): void {
    this.appliedQuality = Graphics._version;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * Graphics.tier.renderScale;
    this.resize();
  }

  private claim(world: World): void {
    this.owner ??= world;
    if (this.owner !== world) throw new Error(`This render surface draws World "${this.owner.name}"; World "${world.name}" needs its own (ADR 0032).`);
  }

  sync(world: World): void {
    this.claim(world);
    if (!this.renderer) return;
    if (Graphics._version !== this.appliedQuality) this.applyQuality();
    this.renderer.sync(world);
  }

  render(world: World): void {
    this.claim(world);
    this.renderer?.render(world);
  }

  release(c: Component): void {
    this.renderer?.release(c);
  }

  releaseWorld(): void {
    this.owner = null;
    this.renderer?.releaseWorld();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }

  async preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void> {
    // Textures load into the renderer's scene, so wait for it (it's quick next to the textures).
    while (!this.renderer && !this.disposed) await new Promise((r) => setTimeout(r, 16));
    await this.renderer?.preloadTextures(paths, onProgress);
  }

  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.renderer?.spriteSize(s) ?? null;
  }

  renderStats(): { drawCalls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number } {
    return this.renderer?.renderStats() ?? { drawCalls: 0, triangles: 0, lines: 0, points: 0, geometries: 0, textures: 0, programs: 0 };
  }

  qualityState(): { tier: string; pixelRatio: number; shadows: boolean; shadowMapSize: number; anisotropy: number; msaa: boolean } {
    const tier = Graphics.tier;
    return { tier: tier.name, pixelRatio: this.pixelRatio, shadows: tier.shadows !== "off", shadowMapSize: SHADOW_MAP_SIZE[tier.shadows], anisotropy: 1, msaa: true };
  }

  setEditorColors(colors: EditorColors): void {
    if (!this.fill) return;
    this.background = colors.background;
    this.renderer?.setClearColor(colors.background);
  }

  // --- Later stages (ADR 0075): nothing to report yet --------------------------------------------

  lightingState(): { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean } {
    return this.renderer?.lightingState() ?? { cascades: false, environment: "", environmentLoaded: false, skybox: false };
  }
  postState(): { composed: boolean; loaded: boolean; toneMapping: ToneMappingName; effects: PostEffects | null } {
    return this.renderer?.postState() ?? { composed: false, loaded: false, toneMapping: "none", effects: null };
  }
  stackCount(): number {
    return 0;
  }
  waterState(): { surfaces: number } {
    return { surfaces: 0 };
  }
  probeState(): { captured: number; probes: number; reflecting: number } {
    return { captured: 0, probes: 0, reflecting: 0 };
  }
  particleState(): ParticleStats | null {
    return this.renderer?.particleState() ?? null;
  }
  uiRuntime(): UIRuntime | null {
    return null;
  }
  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    Object.assign(this.particlePreview, preview);
    this.renderer?.setParticlePreview(preview);
  }
  restartParticlePreview(): void {
    this.renderer?.restartParticlePreview();
  }

  // --- Editor helpers (stage 8) -----------------------------------------------------------------

  setEditorGridPlane(_plane: "xz" | "xy"): void {}
  setEditorGrid(_cellSize: number, _visible: boolean): void {}
  editorGrid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return null;
  }
  setCameraPreview(_camera: Camera | null, _frame: HTMLElement | null): void {}
  readonly cameraPreviewDrawn = false;
  pick(_world: World, _x: number, _y: number): GameObject[] {
    return [];
  }
  meshBounds(_node: GameObject): { min: [number, number, number]; max: [number, number, number] } | null {
    return null;
  }
  rayAt(_world: World, _x: number, _y: number): { origin: [number, number, number]; direction: [number, number, number] } | null {
    return null;
  }
  worldToCanvas(_world: World, _p: readonly number[]): [number, number] | null {
    return null;
  }
  screenBounds(_world: World, _root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    return [];
  }
  pointOnPlaneZ(_world: World, _x: number, _y: number, _z = 0): [number, number, number] | null {
    return null;
  }
  pointOnPlane(_world: World, _x: number, _y: number, _normal: readonly number[], _point: readonly number[]): [number, number, number] | null {
    return null;
  }
  /** Stage 8 draws the outline; until then the selection only steers the particle preview. */
  setSelectionOutline(nodes: readonly GameObject[]): void {
    this.selection = [...nodes];
    this.renderer?.setSelected(nodes);
  }
  setSelectionOutlineShown(_shown: boolean): void {}
  editorDrawingShown(): { segments: number; handles: number; outlines: number; drawnObjects: number } {
    return { segments: 0, handles: 0, outlines: 0, drawnObjects: 0 };
  }
  setOverlayProvider(_provider: (() => EditorOverlay) | null): void {}
  overlayHandlesOnCanvas(_world: World): { id: string; x: number; y: number }[] {
    return [];
  }
  pickOverlayHandle(_world: World, _x: number, _y: number, _radius = 9): string | null {
    return null;
  }
  lightIconsOnCanvas(_world: World): { node: GameObject; x: number; y: number }[] {
    return [];
  }
  lightWireCount(): number {
    return 0;
  }
  setGizmo(_nodes: readonly GameObject[], _options: GizmoOptions, _handlers: GizmoHandlers | null): void {}
  gizmoActiveAt(_x: number, _y: number): boolean {
    return false;
  }
}
