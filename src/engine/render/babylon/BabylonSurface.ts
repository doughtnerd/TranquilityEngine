/**
 * The Babylon.js backend's drawing surface (ADR 0075). It owns the canvas and its layout, and loads
 * the renderer (`BabylonRenderer`, which imports Babylon) on demand, so this file stays light and a
 * page on the three.js backend never downloads Babylon. Until the renderer is ready, frames are
 * skipped; sync mirrors the whole World every frame, so nothing is lost.
 *
 * Editor helpers (stage 8) live in the renderer's `editorTools`, loaded on demand; editor state set
 * before they load (grid, colours, selection, overlay, gizmo) is kept here and handed over once they
 * have. Until then queries answer "nothing".
 */
import type { Component } from "../../core/Component";
import { Graphics } from "../Graphics";
import { SHADOW_MAP_SIZE } from "../../core/graphics";
import type { ProjectSettings } from "../../core/settings";
import type { World, WorldKind } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { Camera, SpriteRenderer } from "../components";
import type { UICoreLike } from "../../ui/uiCoreTypes";
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
import type { BabylonEditorTools } from "./editorTools";

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
  private outlineShown = true;
  private editorColors: EditorColors | null = null;
  private gridPlane: "xz" | "xy" | null = null;
  private grid: { cellSize: number; visible: boolean } | null = null;
  private overlayProvider: (() => EditorOverlay) | null = null;
  private gizmo: { nodes: readonly GameObject[]; options: GizmoOptions; handlers: GizmoHandlers | null } | null = null;
  private cameraPreview: { camera: Camera | null; frame: HTMLElement | null } | null = null;
  /** The editor helpers the state above was handed to. */
  private toolsSeen: BabylonEditorTools | null = null;
  /** Something asked for an editor helper (games never do, so they never load the gizmos). */
  private toolsWanted = false;

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
        if (import.meta.env?.DEV) {
          const g = globalThis as { __mycoBabylonScenes?: unknown[]; __mycoBabylonSurfaces?: unknown[] };
          (g.__mycoBabylonScenes ??= []).push(r.scene);
          (g.__mycoBabylonSurfaces ??= []).push(this);
        }
        r.setClearColor(this.background);
        r.setParticlePreview(this.particlePreview);
        r.setSelected(this.selection);
        if (this.cameraPreview) r.setCameraPreview(this.cameraPreview.camera, this.cameraPreview.frame);
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
    // Hand pending editor state over once the helpers have loaded (an editor World, or a game World an editor query reached).
    if (this.fill || this.toolsWanted) this.tools();
  }

  /** The renderer's editor helpers once loaded (asking starts loading them), with this surface's editor state applied. */
  private tools(): BabylonEditorTools | null {
    this.toolsWanted = true;
    const t = this.renderer?.editorTools() ?? null;
    if (t && t !== this.toolsSeen) {
      this.toolsSeen = t;
      if (this.editorColors) t.overlays.setEditorColors(this.editorColors);
      if (this.gridPlane) t.overlays.setEditorGridPlane(this.gridPlane);
      if (this.grid) t.overlays.setEditorGrid(this.grid.cellSize, this.grid.visible);
      t.overlays.setSelectionOutline(this.selection);
      t.overlays.setSelectionOutlineShown(this.outlineShown);
      t.overlays.setOverlayProvider(this.overlayProvider);
      if (this.gizmo) t.gizmo.setGizmo(this.gizmo.nodes, this.gizmo.options, this.gizmo.handlers);
    }
    return t;
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
    this.editorColors = colors;
    this.toolsSeen?.overlays.setEditorColors(colors);
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
    return this.renderer?.waterState() ?? { surfaces: 0 };
  }
  probeState(): { captured: number; probes: number; reflecting: number } {
    return this.renderer?.probeState() ?? { captured: 0, probes: 0, reflecting: 0 };
  }
  particleState(): ParticleStats | null {
    return this.renderer?.particleState() ?? null;
  }
  uiRuntime(): Pick<UICoreLike, "rectOf" | "hitTest"> | null {
    return this.renderer?.uiState() ?? null;
  }
  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    Object.assign(this.particlePreview, preview);
    this.renderer?.setParticlePreview(preview);
  }
  restartParticlePreview(): void {
    this.renderer?.restartParticlePreview();
  }

  // --- Editor helpers (stage 8) -----------------------------------------------------------------

  setEditorGridPlane(plane: "xz" | "xy"): void {
    this.gridPlane = plane;
    this.toolsSeen?.overlays.setEditorGridPlane(plane);
  }
  setEditorGrid(cellSize: number, visible: boolean): void {
    this.grid = { cellSize, visible };
    this.toolsSeen?.overlays.setEditorGrid(cellSize, visible);
  }
  editorGrid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.tools()?.overlays.editorGrid() ?? null;
  }
  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void {
    this.cameraPreview = { camera, frame };
    this.renderer?.setCameraPreview(camera, frame);
  }
  get cameraPreviewDrawn(): boolean {
    return this.renderer?.cameraPreviewDrawn ?? false;
  }
  pick(world: World, x: number, y: number): GameObject[] {
    return this.tools()?.queries.pick(world, x, y) ?? [];
  }
  meshBounds(node: GameObject): { min: [number, number, number]; max: [number, number, number] } | null {
    return this.tools()?.queries.meshBounds(node) ?? null;
  }
  rayAt(world: World, x: number, y: number): { origin: [number, number, number]; direction: [number, number, number] } | null {
    return this.tools()?.queries.rayAt(world, x, y) ?? null;
  }
  worldToCanvas(world: World, p: readonly number[]): [number, number] | null {
    return this.tools()?.queries.worldToCanvas(world, p) ?? null;
  }
  screenBounds(world: World, root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    return this.tools()?.queries.screenBounds(world, root) ?? [];
  }
  pointOnPlaneZ(world: World, x: number, y: number, z = 0): [number, number, number] | null {
    return this.tools()?.queries.pointOnPlaneZ(world, x, y, z) ?? null;
  }
  pointOnPlane(world: World, x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null {
    return this.tools()?.queries.pointOnPlane(world, x, y, normal, point) ?? null;
  }
  setSelectionOutline(nodes: readonly GameObject[]): void {
    this.selection = [...nodes];
    this.renderer?.setSelected(nodes); // the particle preview plays the selection's effects
    this.toolsSeen?.overlays.setSelectionOutline(nodes);
  }
  setSelectionOutlineShown(shown: boolean): void {
    this.outlineShown = shown;
    this.toolsSeen?.overlays.setSelectionOutlineShown(shown);
  }
  editorDrawingShown(): { segments: number; handles: number; outlines: number; drawnObjects: number } {
    return this.tools()?.overlays.editorDrawingShown() ?? { segments: 0, handles: 0, outlines: 0, drawnObjects: 0 };
  }
  setOverlayProvider(provider: (() => EditorOverlay) | null): void {
    this.overlayProvider = provider;
    this.toolsSeen?.overlays.setOverlayProvider(provider);
  }
  overlayHandlesOnCanvas(world: World): { id: string; x: number; y: number }[] {
    return this.tools()?.overlays.overlayHandlesOnCanvas(world) ?? [];
  }
  pickOverlayHandle(world: World, x: number, y: number, radius = 9): string | null {
    return this.tools()?.overlays.pickOverlayHandle(world, x, y, radius) ?? null;
  }
  lightIconsOnCanvas(world: World): { node: GameObject; x: number; y: number }[] {
    return this.tools()?.overlays.lightIconsOnCanvas(world) ?? [];
  }
  lightWireCount(): number {
    return this.tools()?.overlays.lightWireCount() ?? 0;
  }
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmo = { nodes: [...nodes], options, handlers };
    this.toolsSeen?.gizmo.setGizmo(nodes, options, handlers);
  }
  gizmoActiveAt(x: number, y: number): boolean {
    return this.tools()?.gizmo.gizmoActiveAt(x, y) ?? false;
  }
}
