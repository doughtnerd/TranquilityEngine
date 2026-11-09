/**
 * @internal The one way a Babylon engine is made (ADR 0156): for a World's surface (`BabylonRenderer.create`)
 * and for every editor preview. WebGPU where the browser has it, with the adapter's limits rather than
 * WebGPU's minimums (a material with clustered lights, ADR 0079, cascaded shadows and two-sided lighting
 * passes more than the minimum 16 values between its stages). If WebGPU is advertised but can't start
 * (`initAsync` throws: a blocklisted adapter, a lost device), it warns and falls back to the WebGL2 engine,
 * loaded only then: a game starts on the slower backend rather than not at all.
 */
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";

export interface EngineOptions {
  /** Multisampling (default on). */
  antialias?: boolean;
  /**
   * A canvas that stays transparent where nothing is drawn and keeps its drawing buffer (previews, which copy
   * it into 2D canvases). WebGPU canvases are always premultiplied-alpha and readable right after drawing.
   */
  transparent?: boolean;
}

/** A Babylon engine drawing into `canvas`. Rejects only if neither WebGPU nor WebGL2 starts. */
export async function createBabylonEngine(canvas: HTMLCanvasElement, options: EngineOptions = {}): Promise<AbstractEngine> {
  const antialias = options.antialias ?? true;
  if (await WebGPUEngine.IsSupportedAsync) {
    try {
      const gpu = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: false, setMaximumLimits: true });
      await gpu.initAsync();
      return gpu;
    } catch (err) {
      console.warn("[myco] WebGPU couldn't start; using WebGL2:", err);
    }
  }
  const { Engine } = await import("@babylonjs/core/Engines/engine.js");
  return new Engine(canvas, antialias, { adaptToDeviceRatio: false, ...(options.transparent ? { alpha: true, preserveDrawingBuffer: true } : {}) });
}
