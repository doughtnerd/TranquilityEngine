/**
 * Pipeline readiness (ADR 0163): the rules of ADR 0080 (warm up the shader pipelines content will need,
 * warm them again when the tier's passes change or probes capture, report variants that weren't warmed)
 * and ADR 0120 (hold a World's first frames while their pipelines compile asynchronously), behind the few
 * calls the renderer makes around each frame. A World's renderer has one; a thumbnail renderer has none
 * (it never draws through `render`).
 */
import type { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { QualityTier } from "../../core/graphics";
import { Graphics } from "../Graphics";
import { AsyncPipelines } from "./asyncPipelines";
import { effectClock, PipelineWarmer, VariantReport, type ParticleSystemLike, type WarmDeps, type WarmItem, type WarmMaterials } from "./warmUp";

/**
 * @internal The tier settings that change the pipelines draws need (ADR 0080): the sample count, the
 * passes (post-processing, ambient occlusion, depth of field, bloom), shadow maps and cascades, the
 * shader level graph materials compile for, and probe captures. Not the render scale or particle budget.
 */
export function pipelineTierKey(t: Readonly<QualityTier>): string {
  return [t.antialias, t.shadows, t.shadowCascades, t.shaderLevel, t.postProcessing, t.bloom, t.ambientOcclusion, t.depthOfField, t.reflectionProbes].join("|");
}

/** How long, at most, a World's first frames are held while their pipelines compile. */
const HOLD_MS = 3000;

/** A warm-up only waits for its draws while frames are being drawn (one within this long). */
const DRAWING_MS = 500;

/** What readiness uses of the warmer (`PipelineWarmer`). */
export type ReadinessWarmer = Pick<PipelineWarmer, "drawing" | "onDrained" | "add" | "rewarm" | "beforeRender" | "afterRender" | "dispose">;
/** What readiness uses of the variant report (`VariantReport`). */
export type ReadinessReport = Pick<VariantReport, "quiet" | "afterRender" | "dispose">;

/** @internal The parts readiness is made from: `forScene` gives the real ones; tests give fakes. */
export interface ReadinessParts {
  readonly engine: AbstractEngine;
  /** The warmer, given what it needs from readiness (async compiles, the effect clock). */
  warmer(deps: Pick<WarmDeps, "compiling" | "effectMs">): ReadinessWarmer;
  /** A variant report (editor play mode), made when it's turned on. */
  report(): ReadinessReport;
  /** The quality tier now (default `Graphics.tier`). */
  tier?(): Readonly<QualityTier>;
  /** Milliseconds (default `performance.now`). */
  now?(): number;
  /** The first frames' hold limit (default 3 s). */
  holdMs?: number;
}

/** @internal What the renderer gives readiness for a real scene. */
export interface SceneReadinessDeps {
  readonly materials: WarmMaterials;
  /** The renderer's probe copies of a built-in material (`WarmDeps.probeVariants`). */
  probeVariants(base: PBRMaterial): PBRMaterial[];
  /** What a drawn object is, for the variant report. */
  describe(drawn: AbstractMesh | ParticleSystemLike): { what: string; prefab?: string } | null;
}

/** @internal ADR 0080 and 0120 for one World's renderer (ADR 0163). */
export class PipelineReadiness {
  private readonly warmer: ReadinessWarmer;
  /** WebGPU: missing pipelines compile asynchronously while the warmer draws or a first frame runs; null elsewhere. */
  private readonly asyncPipelines: AsyncPipelines | null;
  private readonly effects: { ms(): number; dispose(): void };
  private readonly firstFrames: FirstFrames;
  private readonly tier: () => Readonly<QualityTier>;
  private readonly now: () => number;
  /** True while the frame graph runs in a held first frame: every missing pipeline compiles asynchronously then. */
  private firstFrameDrawing = false;
  private report: ReadinessReport | null = null;
  /** The tier settings the warmed pipelines were made for. */
  private warmedTier: string;
  /** How many probes had captured when the warm-up last covered their copies. */
  private warmedProbes = 0;
  /** When a frame was last drawn. */
  private lastFrameAt = -Infinity;
  private disposed = false;

  /** Readiness for `scene` on `engine`: hooks the engine's pipeline cache (WebGPU) and effect creation. */
  static forScene(engine: AbstractEngine, scene: Scene, deps: SceneReadinessDeps): PipelineReadiness {
    return new PipelineReadiness({
      engine,
      warmer: (w) => new PipelineWarmer({ scene, materials: deps.materials, probeVariants: (base) => deps.probeVariants(base), ...w }),
      report: () => new VariantReport(engine, scene, (m) => deps.describe(m)),
    });
  }

  constructor(private readonly parts: ReadinessParts) {
    this.tier = parts.tier ?? (() => Graphics.tier);
    this.now = parts.now ?? (() => performance.now());
    this.firstFrames = new FirstFrames(parts.holdMs ?? HOLD_MS);
    this.warmedTier = pipelineTierKey(this.tier());
    // Only while the warmer is busy or a first frame runs: everywhere else a missing pipeline is made as
    // Babylon makes it, so what's drawn never skips a frame. The warmer's own skipped draws aren't "shown".
    let warmer: ReadinessWarmer | null = null;
    this.asyncPipelines = AsyncPipelines.install(parts.engine, () => (warmer?.drawing ?? false) || this.firstFrameDrawing, () => !(warmer?.drawing ?? false));
    this.effects = effectClock(parts.engine);
    const pipelines = this.asyncPipelines;
    warmer = this.warmer = parts.warmer({ ...(pipelines ? { compiling: () => pipelines.settled() } : {}), effectMs: () => this.effects.ms() });
    this.warmer.onDrained = () => this.report?.quiet();
  }

  /**
   * Draw `items`, and what `later` gives (lazy features' items once loaded), once each, hidden, so their
   * pipelines exist before they're shown. Resolves when they've drawn, or at once while no frames are
   * being drawn (a World's first scene, loaded before the engine starts): they're drawn over the first frames.
   */
  warm(items: readonly WarmItem[], later: readonly Promise<readonly WarmItem[] | null>[] = []): Promise<void> {
    const done = Promise.all([this.warmer.add(items), ...later.map((p) => p.then((more) => (more && !this.disposed ? this.warmer.add(more) : undefined)))]).then(() => undefined);
    return this.now() - this.lastFrameAt < DRAWING_MS ? done : Promise.resolve();
  }

  /** Editor play mode: log shader variants compiled after loading (ADR 0080). */
  setVariantReport(on: boolean): void {
    if (on === !!this.report) return;
    this.report?.dispose();
    this.report = on ? this.parts.report() : null;
  }

  /** Probes capture after the scene loads, after its warm-up: warm their material copies once they exist. */
  probesCaptured(count: number): void {
    if (count > this.warmedProbes) void this.warmer.rewarm();
    this.warmedProbes = count;
  }

  /** Before the frame graph runs: a tier change warms everything again in the new passes; the warmer places this frame's batch. */
  beforeFrame(camera: BabylonCamera | null, casters: AbstractMesh[]): void {
    const key = pipelineTierKey(this.tier());
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
   */
  drawFrame(graphReady: boolean, draw: () => boolean, loaded: () => boolean): boolean {
    const pipelines = this.asyncPipelines;
    const first = !!pipelines && this.firstFrames.begin(graphReady, this.now());
    const skipped = pipelines?.skippedShown ?? 0;
    this.firstFrameDrawing = first;
    let ready: boolean;
    try {
      ready = draw();
    } finally {
      this.firstFrameDrawing = false;
    }
    return first && ready ? this.firstFrames.end(pipelines!.skippedShown > skipped, loaded(), this.now()) : false;
  }

  /** After a frame the graph drew: the warmer's batch and the report move on. */
  afterFrame(): void {
    this.warmer.afterRender();
    this.report?.afterRender();
    this.lastFrameAt = this.now();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.warmer.dispose();
    this.asyncPipelines?.dispose();
    this.effects.dispose();
    this.report?.dispose();
    this.report = null;
  }
}

/**
 * ADR 0120: a World's first frames. Its frame graph's first runs compile every pipeline they need at once
 * (the scene's meshes in each pass, Babylon's post-process passes, the screen UI layer): blocking, that
 * was a frame of several hundred milliseconds as a new World appeared, and more as its textures, models
 * and UI arrived. Instead, until the World's content has loaded and a frame draws complete, every draw
 * whose pipeline is missing compiles asynchronously and is skipped (`AsyncPipelines`), and every frame is
 * covered with the clear colour, as the frames before its graph was ready were. A time limit ends it too,
 * after which pipelines compile as Babylon makes them. Rebuilding the graph later (a resize, a camera's
 * effects changing) doesn't hold: there's a picture on screen to keep.
 */
class FirstFrames {
  private started = -1;
  private over = false;

  constructor(private readonly maxMs: number) {}

  /** Before a frame: whether its graph runs with missing pipelines compiled asynchronously (`graphReady`: the frame graph will run this frame). */
  begin(graphReady: boolean, now: number): boolean {
    if (this.over) return false;
    if (this.started < 0) this.started = now;
    return graphReady;
  }

  /** After a frame `begin` said to run so: whether to cover it. `skipped`: a draw that would have shown was skipped. */
  end(skipped: boolean, loaded: boolean, now: number): boolean {
    if (this.over) return false;
    if (!skipped && loaded) {
      this.over = true; // complete: show it
      return false;
    }
    if (now - this.started < this.maxMs) return true;
    this.over = true; // give up holding: later frames compile as they draw
    return skipped;
  }
}
