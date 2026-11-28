/**
 * Pipeline readiness (ADR 0240): the rules of ADR 0080 (warm up the shader pipelines content will need,
 * warm them again when the tier's passes change or probes capture, report variants that weren't warmed)
 * and ADR 0120 (hold a World's first frames while their pipelines compile asynchronously), behind the few
 * calls the renderer makes around each frame. A World's renderer has one; a thumbnail renderer has none
 * (it never draws through `render`, and its engine is shared, so it's never hooked).
 */
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { pipelineTierKey } from "../../core/graphics";
import { Graphics } from "../Graphics";
import { AsyncPipelines, FirstFrames } from "./asyncPipelines";
import { effectClock, PipelineWarmer, VariantReport, type WarmItem, type WarmMaterials } from "./warmUp";

/** A warm-up only waits for its draws while frames are being drawn (one within this long). */
const DRAWING_MS = 500;

/** @internal What the renderer gives readiness for its scene. */
export interface ReadinessDeps {
  /** The scene's material library, so warm draws use the materials the scene's draws use. */
  readonly materials: WarmMaterials;
  /** The renderer's probe copies of a built-in material (`WarmDeps.probeVariants`). */
  probeVariants(base: PBRMaterial): PBRMaterial[];
  /** Whether the World applies levels per view (`WarmDeps.levelsApplied`). */
  levelsApplied?(): boolean;
  /** What a drawn object is, for the variant report. */
  describe(drawn: AbstractMesh): { what: string; prefab?: string } | null;
}

/** @internal ADR 0080 and 0120 for one World's renderer (ADR 0240). */
export class PipelineReadiness {
  /** ADR 0080: draws queued meshes once, hidden, so their shader pipelines exist before they're shown. */
  private readonly warmer: PipelineWarmer;
  /** WebGPU: missing pipelines compile asynchronously while the warmer draws or a first frame runs; null elsewhere. */
  private readonly asyncPipelines: AsyncPipelines | null;
  /** Time spent creating effects, which sizes the warm-up's batches. */
  private readonly effects: { ms(): number; dispose(): void };
  /** A World's first frames, held while their pipelines compile asynchronously (ADR 0120). */
  private readonly firstFrames = new FirstFrames();
  /** True while the frame graph runs in a held first frame: every missing pipeline compiles asynchronously then. */
  private firstFrameDrawing = false;
  /** ADR 0080: editor play mode's log of shader variants compiled after loading; null when off. */
  private report: VariantReport | null = null;
  /** The tier settings the warmed pipelines were made for (`pipelineTierKey`). */
  private warmedTier = pipelineTierKey(Graphics.tier);
  /** How many probes had captured when the warm-up last covered their copies. */
  private warmedProbes = 0;
  /** When a frame was last drawn. */
  private lastFrameAt = -Infinity;
  private disposed = false;

  /** Readiness for `scene` on `engine`, which it hooks (the WebGPU pipeline cache, effect creation) until disposed. */
  constructor(
    private readonly engine: AbstractEngine,
    private readonly scene: Scene,
    private readonly deps: ReadinessDeps,
  ) {
    // Before the warmer, which asks whether compiles are async. Only while it's busy or a first frame
    // runs: everywhere else a missing pipeline is made as Babylon makes it, so what's drawn never skips a
    // frame. The warmer's own skipped draws aren't "shown".
    this.asyncPipelines = AsyncPipelines.install(engine, () => (this.warmer?.drawing ?? false) || this.firstFrameDrawing, () => !(this.warmer?.drawing ?? false));
    this.effects = effectClock(engine);
    const pipelines = this.asyncPipelines;
    this.warmer = new PipelineWarmer({
      scene,
      materials: deps.materials,
      ...(pipelines ? { compiling: () => pipelines.settled() } : {}),
      effectMs: () => this.effects.ms(),
      probeVariants: (base) => deps.probeVariants(base),
      levelsApplied: () => deps.levelsApplied?.() ?? false,
    });
    this.warmer.onDrained = () => this.report?.quiet();
  }

  /**
   * Draw `items`, and what `later` gives (lazy features' items once loaded), once each, hidden, so their
   * pipelines exist before they're shown. Resolves when they've drawn, or at once while no frames are
   * being drawn (a World's first scene, loaded before the engine starts): they're drawn over the first frames.
   */
  warm(items: readonly WarmItem[], later: readonly Promise<readonly WarmItem[] | null>[] = []): Promise<void> {
    const done = Promise.all([this.warmer.add(items), ...later.map((p) => p.then((more) => (more && !this.disposed ? this.warmer.add(more) : undefined)))]).then(() => undefined);
    return performance.now() - this.lastFrameAt < DRAWING_MS ? done : Promise.resolve();
  }

  /** Editor play mode: log shader variants compiled after loading (ADR 0080). */
  setVariantReport(on: boolean): void {
    if (on === !!this.report || this.disposed) return;
    this.report?.dispose();
    this.report = on ? new VariantReport(this.engine, this.scene, (m) => this.deps.describe(m)) : null;
  }

  /** Probes capture after the scene loads, after its warm-up: warm their material copies once more of them exist. */
  probesCaptured(count: number): void {
    if (count > this.warmedProbes) void this.warmer.rewarm();
    this.warmedProbes = count;
  }

  /** Before the frame graph runs: a tier change warms everything again in the new passes; the warmer places this frame's batch. */
  beforeFrame(camera: BabylonCamera | null, casters: AbstractMesh[]): void {
    const key = pipelineTierKey(Graphics.tier);
    if (key !== this.warmedTier) {
      this.warmedTier = key;
      void this.warmer.rewarm();
    }
    this.warmer.beforeRender(camera, casters);
  }

  /**
   * Run the frame graph (`draw`, which returns whether the graph is ready after running: a layout change
   * rebuilds it instead, and that frame doesn't count). `graphReady`: it was ready before. `loaded`: the
   * World's textures, models and UI have loaded. Returns whether to cover the frame with the clear colour:
   * a World's first frames (ADR 0120) are held while a draw that would show was skipped or content loads.
   * Where pipelines can't compile asynchronously (WebGL2) nothing is ever held.
   */
  drawFrame(graphReady: boolean, draw: () => boolean, loaded: () => boolean): boolean {
    const pipelines = this.asyncPipelines;
    const first = !!pipelines && this.firstFrames.begin(graphReady, performance.now());
    const skipped = pipelines?.skippedShown ?? 0;
    this.firstFrameDrawing = first;
    let ready: boolean;
    try {
      ready = draw();
    } finally {
      this.firstFrameDrawing = false;
    }
    return first && ready ? this.firstFrames.end(pipelines!.skippedShown > skipped, loaded(), performance.now()) : false;
  }

  /** After a frame the graph drew: the warmer's batch and the report move on. */
  afterFrame(): void {
    this.warmer.afterRender();
    this.report?.afterRender();
    this.lastFrameAt = performance.now();
  }

  /** Unhook the engine and drop what's queued. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.warmer.dispose();
    this.report?.dispose();
    this.report = null;
    this.asyncPipelines?.dispose();
    this.effects.dispose();
  }
}
