/**
 * The Babylon.js drawing surface (ADR 0075, 0081). It owns the canvas and its layout, and loads the
 * renderer (`BabylonRenderer`, which imports Babylon) on demand, so this file stays light and a page
 * downloads Babylon only when it draws. Until the renderer is ready, frames are skipped; sync mirrors
 * the whole World every frame, so nothing is lost.
 *
 * The editor's viewport (ADR 0128) is a `ViewportHandle` over the renderer's editor tools (the
 * Babylon adapter, `editorTools.ts`, loaded on demand): the handle keeps editor state set before they
 * load and hands it over once. An editor World's surface waits for the tools before it reports started.
 */
import type { WarmContent } from "../../scene/warmUp";
import type { Component } from "../../core/Component";
import { Graphics } from "../Graphics";
import { SHADOW_MAP_SIZE } from "../../core/graphics";
import type { ProjectSettings } from "../../core/settings";
import type { World, WorldKind } from "../../core/World";
import { CanvasCssSize } from "../canvasCssSize";
import { fitCanvas } from "../canvasFit";
import { ViewportHandle, type EditorViewport } from "../editorViewport";
import { appliedPixelRatio, noRenderDiagnostics, type PixelGrid, type RenderDiagnostics, type RenderSurface } from "../RenderSurface";
import { GAME_POLICY, previewInset, type RenderPolicy, type RenderPolicyPort } from "../renderPolicy";
import type { BabylonRenderer } from "./BabylonRenderer";

/** @internal The Babylon.js render surface (ADR 0075). */
export class BabylonSurface implements RenderSurface {
  readonly canvas: HTMLCanvasElement;
  private renderer: BabylonRenderer | null = null;
  private readonly resizeObserver: ResizeObserver;
  /** The canvas's CSS size, for the camera's maths without a layout read per call. */
  private readonly cssSize: CanvasCssSize;
  private readonly fill: boolean;
  private disposed = false;
  /** ADR 0080: whether the renderer logs shader variants compiled after loading (editor play mode). */
  private variantReport = false;
  private appliedQuality = -1;
  private pixelRatio = 1;
  private owner: World | null = null;
  /** The editor's viewport handle, once something asked (games never do). */
  private viewport: ViewportHandle | null = null;
  /** The device-pixel grid last handed out (`pixelGrid`), kept while the size and ratio stay the same. */
  private grid: PixelGrid = { width: 0, height: 0, pixelRatio: 1 };
  /**
   * Render policy (ADR 0129) the viewport handle set, the particle preview included (ADR 0154): kept for
   * the renderer until it has loaded, then handed over once.
   */
  private policy: RenderPolicy = { ...GAME_POLICY };
  /** What the viewport handle sets render policy through: live from the start. */
  private readonly policyPort: RenderPolicyPort = {
    setPolicy: (change) => {
      this.policy = { ...this.policy, ...change };
      this.starting?.setPolicy(change);
    },
  };
  /** The renderer from the moment it exists (while its editor tools load, before it draws): policy changes go straight to it. */
  private starting: BabylonRenderer | null = null;
  /** Resolves once the renderer has loaded and started (true), or couldn't (false). */
  readonly started: Promise<boolean>;

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
    this.cssSize = new CanvasCssSize(this.canvas);
    // Editor Worlds fill their viewport panel; games keep the reference aspect ratio, letterboxed.
    this.fill = kind === "editor";
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.started = import("./BabylonRenderer")
      .then((m) => m.BabylonRenderer.create(this.canvas, settings))
      .then(async (r) => {
        // Policy first (ADR 0129): the editor tools read it as they build (an editor World's grid). Handed
        // over once, the particle preview with it (ADR 0154); later changes reach the renderer directly.
        r.setPolicy(this.policy);
        this.starting = r;
        r.setPixelGrid(() => this.pixelGrid());
        // An editor World draws its grid and outlines from the first frame: wait for the editor tools too.
        if (this.fill) await r.loadEditorTools();
        return r;
      })
      .then((r) => {
        if (this.disposed) {
          this.starting = null;
          r.dispose();
          return false;
        }
        this.renderer = r;
        // Dev builds: every live Babylon scene, for inspecting the renderer from the console.
        if (import.meta.env?.DEV) {
          const g = globalThis as { __mycoBabylonScenes?: unknown[]; __mycoBabylonSurfaces?: unknown[] };
          (g.__mycoBabylonScenes ??= []).push(r.scene);
          (g.__mycoBabylonSurfaces ??= []).push(this);
        }
        r.setClearColor(settings.display.backgroundColor);
        r.setVariantReport(this.variantReport);
        this.viewport?.poll(); // hand the editor's state over before the first frame
        this.applyQuality();
        return true;
      })
      .catch((err) => {
        console.error("[myco] the Babylon.js renderer couldn't start:", err);
        return false;
      });
  }

  /** Fit the canvas to the container: fill it (editor) or keep the reference aspect ratio. */
  private resize(): void {
    const { width, height, scaleMode } = this.settings.display;
    const cw = this.container.clientWidth || width;
    const ch = this.container.clientHeight || height;
    const size = this.fill ? { width: Math.floor(cw), height: Math.floor(ch) } : fitCanvas(scaleMode ?? "fit", width, height, cw, ch);
    this.canvas.style.width = `${size.width}px`;
    this.canvas.style.height = `${size.height}px`;
    this.cssSize.invalidate();
    this.renderer?.resize(this.pixelRatio);
  }

  /** The view's device-pixel grid (ADR 0154): the canvas's CSS size at the pixel ratio the drawing buffer follows. */
  pixelGrid(): PixelGrid {
    const size = this.cssSize.get();
    const g = this.grid;
    if (g.width !== size.width || g.height !== size.height || g.pixelRatio !== this.pixelRatio) this.grid = { width: size.width, height: size.height, pixelRatio: this.pixelRatio };
    return this.grid;
  }

  /** The tier's render scale (ADR 0050); the rest of the tier arrives with later stages. */
  private applyQuality(): void {
    this.appliedQuality = Graphics._version;
    this.pixelRatio = appliedPixelRatio(Graphics.tier.renderScale);
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
    this.viewport?.measurePreview(); // the camera preview inset, measured once a frame (ADR 0163)
    this.renderer.sync(world);
    this.viewport?.poll(); // hand the editor's state over once the tools have loaded
  }

  editorViewport(): EditorViewport {
    return (this.viewport ??= new ViewportHandle(() => this.renderer?.editorTools() ?? null, this.policyPort, this.fill, (frame) => previewInset(this.canvas.getBoundingClientRect(), frame.getBoundingClientRect())));
  }

  diagnostics(): RenderDiagnostics {
    const tier = Graphics.tier;
    const quality = { tier: tier.name, pixelRatio: this.pixelRatio, shadows: tier.shadows !== "off", shadowMapSize: SHADOW_MAP_SIZE[tier.shadows], msaa: tier.antialias === "msaa" };
    return { ...(this.renderer ? { started: true, ...this.renderer.diagnostics() } : noRenderDiagnostics()), quality };
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
    this.cssSize.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.starting = null;
    this.canvas.remove();
  }

  async warmUp(set: WarmContent): Promise<void> {
    while (!this.renderer && !this.disposed) await new Promise((r) => setTimeout(r, 16));
    await this.renderer?.warmUp(set);
  }

  _setVariantReport(on: boolean): void {
    this.variantReport = on;
    this.renderer?.setVariantReport(on);
  }

  async preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void> {
    // Textures load into the renderer's scene, so wait for it (it's quick next to the textures).
    while (!this.renderer && !this.disposed) await new Promise((r) => setTimeout(r, 16));
    await this.renderer?.preloadTextures(paths, onProgress);
  }
}
