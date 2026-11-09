/**
 * ADR 0080 on WebGPU: compile the warm-up's render pipelines asynchronously, so warming a scene never
 * stalls a frame.
 *
 * A pipeline Babylon makes with `createRenderPipeline` blocks the first frame that draws with it while
 * the GPU process compiles it (40–85 ms each in the pirates sample). WebGPU's `createRenderPipelineAsync`
 * compiles it without blocking. Babylon 9.32 has the async path (`WebGPUCacheRenderPipeline.preWarmPipeline`),
 * but it needs each pass's exact state, which the warmer gets right only by drawing its meshes for real.
 * So while `active()` says so (the warmer is busy), a draw whose pipeline isn't cached yet starts an
 * async compile with the state Babylon has just set up for it, and that one draw is skipped; once the
 * pipeline is in Babylon's cache, draws with that state find it there.
 *
 * A World's first frames (ADR 0120, `pipelineReadiness.ts`) use the same path for every draw of the frame graph,
 * Babylon's own post-process passes and the screen UI layer included, and are held on the clear colour
 * while any was skipped.
 *
 * Relies on Babylon internals (`_cacheRenderPipeline`, `_lookupRenderPipeline`, `_buildRenderPipelineDescriptor`,
 * `_setRenderPipeline`, `_parameter.token`, `WebGPUEngine._draw`): re-check on each Babylon upgrade.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";

// The WebGPU shapes used here (the project builds without WebGPU's type declarations).
type GPURenderPipeline = object;
type GPURenderPipelineDescriptor = object;
type GPUPrimitiveTopology = string;
interface GPUDevice {
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline>;
}

let enabled = true;

/** @internal Measurements only: off, Worlds made after this compile warm-up pipelines as Babylon does (stalling). */
export function _setAsyncPipelines(on: boolean): void {
  enabled = on;
}

/** Thrown from the pipeline lookup to skip a draw whose pipeline is compiling. */
const SKIP = Symbol("myco.skipDraw");

interface PipelineCache {
  _lookupRenderPipeline(fillMode: number, effect: Effect, sampleCount: number, textureState: number): GPURenderPipeline | null;
  _buildRenderPipelineDescriptor(effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
  _setRenderPipeline(param: { token: unknown; pipeline: GPURenderPipeline | null }): void;
  _parameter: { token: unknown; pipeline: GPURenderPipeline | null };
  getRenderPipeline(fillMode: number, effect: Effect, sampleCount: number, textureState?: number): GPURenderPipeline;
  disabled: boolean;
  constructor: { _GetTopology(fillMode: number): GPUPrimitiveTopology };
}

interface WebGPUInternals {
  _cacheRenderPipeline?: PipelineCache;
  _device?: GPUDevice;
  _draw?: (...args: unknown[]) => void;
}

/** @internal Async pipeline compiles while `active()`; null where the engine can't (WebGL2, NullEngine, a Babylon without the internals). */
export class AsyncPipelines {
  /** Compiles started and not finished, by cache token (one per distinct state). */
  private readonly pending = new Map<unknown, Promise<void>>();
  private readonly restore: () => void;
  /** Pipelines compiled asynchronously so far (for the check page and tests). */
  compiled = 0;
  /** Draws skipped while their pipeline compiled. */
  skipped = 0;
  /** Of those, draws that weren't the warmer's own (`shown()`): content a held first frame (`PipelineReadiness`) would have shown. */
  skippedShown = 0;

  private constructor(cache: PipelineCache, device: GPUDevice, engine: WebGPUInternals, active: () => boolean, shown: () => boolean) {
    const lookupOriginal = cache.getRenderPipeline;
    const drawOriginal = engine._draw!;
    // Only a mesh draw (`_draw`) can be skipped. Babylon asks the cache from elsewhere too (the clear
    // quad that clears a viewport inside a pass): a skip thrown there escaped mid-clear and broke the
    // frame graph for good (the view stayed black).
    let inDraw = false;
    cache.getRenderPipeline = (fillMode, effect, sampleCount, textureState = 0) => {
      if (!inDraw || !active() || cache.disabled) return lookupOriginal.call(cache, fillMode, effect, sampleCount, textureState);
      const samples = sampleCount > 1 ? 4 : 1; // WebGPU takes 1 or 4 (`WebGPUTextureHelper.GetSample`)
      const cached = cache._lookupRenderPipeline(fillMode, effect, samples, textureState);
      if (cached) return cached;
      const token = cache._parameter.token;
      if (!this.pending.has(token)) {
        // Built now, while the cache holds this draw's state.
        const descriptor = cache._buildRenderPipelineDescriptor(effect, cache.constructor._GetTopology(fillMode), samples);
        const param = { token, pipeline: null as GPURenderPipeline | null };
        const done = device
          .createRenderPipelineAsync(descriptor)
          .then((pipeline) => {
            param.pipeline = pipeline;
            cache._setRenderPipeline(param);
            this.compiled++;
          })
          .catch((err: Error) => console.warn(`[myco] a warm-up pipeline didn't compile: ${err.message}`))
          .finally(() => this.pending.delete(token));
        this.pending.set(token, done);
      }
      this.skipped++;
      if (shown()) this.skippedShown++;
      throw SKIP;
    };
    engine._draw = (...args: unknown[]) => {
      inDraw = true;
      try {
        drawOriginal.apply(engine, args);
      } catch (err) {
        if (err !== SKIP) throw err;
      } finally {
        inDraw = false;
      }
    };
    this.restore = () => {
      cache.getRenderPipeline = lookupOriginal;
      engine._draw = drawOriginal;
    };
  }

  /** Hook `engine`'s pipeline cache; null where it can't be (the warmer then compiles as Babylon does, stalling). */
  static install(engine: AbstractEngine, active: () => boolean, shown: () => boolean = () => false): AsyncPipelines | null {
    const e = engine as unknown as WebGPUInternals;
    const cache = e._cacheRenderPipeline;
    if (!enabled || !engine.isWebGPU || !cache || !e._device || typeof e._draw !== "function") return null;
    if (typeof cache._lookupRenderPipeline !== "function" || typeof cache._buildRenderPipelineDescriptor !== "function" || typeof cache._setRenderPipeline !== "function") return null;
    return new AsyncPipelines(cache, e._device, e, active, shown);
  }

  /** Compiles still running. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** Resolves once every compile started so far has finished. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()]);
  }

  dispose(): void {
    this.restore();
  }
}
