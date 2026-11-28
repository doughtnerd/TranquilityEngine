/**
 * The occlusion core over `native/visibility`'s `vis-wasm` module (ADR 0460 §2): the TypeScript side owns the views over
 * wasm memory. Per view it writes the header, the occluder triangles, their errors and edge neighbours and the occludee
 * boxes into the module's regions, runs it, and reads back one byte per occludee (layout: `vis-wasm/src/lib.rs`).
 *
 * The module loads lazily, the first time a view with occlusion on is drawn, once per page (and once per Node process),
 * as the animation core's does: browsers fetch `myco_visibility_bg.wasm` (Vite serves and bundles it beside this
 * module), Node reads it from disk. It is built for `simd128` with no scalar build, so a runtime without it never
 * downloads the module: the loader warns once and occlusion stays off. Not public API.
 */
import { supportsSimd128 } from "../../../wasm/simd";
import type { OcclusionCamera, OcclusionCore, VisibilityView } from "../types";

/** The glue's exports this module uses (`wasm/myco_visibility.d.ts`). */
export interface VisibilityWasm {
  init(width: number, height: number, maxTriangles: number, maxBoxes: number): number;
  occlude(nTriangles: number, nBoxes: number): number;
  view_ptr(): number;
  view_len(): number;
  triangles_ptr(): number;
  errors_ptr(): number;
  neighbors_ptr(): number;
  boxes_ptr(): number;
  hidden_ptr(): number;
  stats_ptr(): number;
  stats_len(): number;
  depth_ptr(): number;
  shutdown(): void;
}

/** `init` and `occlude` results (`vis-wasm`'s constants). */
const OK = 0;

/** The view header's layout: matrix (16), eye (3), near, far, sx, sy. */
const VIEW_LEN = 23;

/** A view's counters after a run: status, then `vis_raster::Stats` in field order. */
export interface OcclusionRun {
  /** Occluder triangles given, and those that reached the buffer. */
  readonly triangles: number;
  readonly rasterised: number;
  /** Occludees tested in the frustum, and proven hidden. */
  readonly tested: number;
  readonly culled: number;
}

/** @internal The core over an instantiated module. One per page: the module keeps one buffer. */
export class WasmOcclusionCore implements OcclusionCore {
  private triangleCapacity = 0;
  private boxCapacity = 0;
  private ready = false;

  constructor(
    private readonly wasm: VisibilityWasm,
    private readonly buffer: () => ArrayBuffer,
    private width: number,
    private height: number,
  ) {}

  /** The buffer's size in pixels (the tier's `occlusionBuffer`); changing it allocates the core again. */
  get size(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.ready = false;
  }

  occlude(view: VisibilityView, camera: OcclusionCamera, occluders: Float32Array, errors: Float32Array, neighbors: Uint32Array, occludees: Float32Array, hidden: Uint8Array): OcclusionRun {
    const n = errors.length, m = occludees.length / 6;
    if (!this.reserve(n, m)) return { triangles: n, rasterised: 0, tested: 0, culled: 0 };
    const w = this.wasm, mem = this.buffer();
    const header = new Float32Array(mem, w.view_ptr(), VIEW_LEN);
    header.set(view.viewProjection, 0);
    header[16] = camera.eye[0];
    header[17] = camera.eye[1];
    header[18] = camera.eye[2];
    header[19] = camera.near;
    header[20] = camera.far;
    header[21] = camera.sx;
    header[22] = camera.sy;
    new Float32Array(mem, w.triangles_ptr(), n * 9).set(occluders.subarray(0, n * 9));
    new Float32Array(mem, w.errors_ptr(), n).set(errors);
    new Uint32Array(mem, w.neighbors_ptr(), n * 3).set(neighbors.subarray(0, n * 3));
    new Float32Array(mem, w.boxes_ptr(), m * 6).set(occludees);
    const status = w.occlude(n, m);
    const stats = new Uint32Array(this.buffer(), w.stats_ptr(), w.stats_len());
    if (status !== OK) return { triangles: n, rasterised: 0, tested: 0, culled: 0 };
    const out = new Uint8Array(this.buffer(), w.hidden_ptr(), m);
    let culled = 0;
    for (let i = 0; i < m; i++) {
      if (out[i]) {
        hidden[i] = 1;
        culled++;
      }
    }
    // Stats: [status, triangles, invalid, facing_away, near_skipped, clipped, rasterised, tested, outside, near_visible, culled].
    return { triangles: stats[1], rasterised: stats[6], tested: stats[7], culled };
  }

  /** The last view's buffer (1/w per pixel, 0 where nothing was drawn), row by row from the top, for the debug image. */
  depth(): { readonly width: number; readonly height: number; readonly data: Float32Array } | null {
    if (!this.ready) return null;
    return { width: this.width, height: this.height, data: new Float32Array(this.buffer(), this.wasm.depth_ptr(), this.width * this.height).slice() };
  }

  dispose(): void {
    this.wasm.shutdown();
    this.ready = false;
  }

  /** Room for `n` triangles and `m` boxes, growing (and allocating the core again) by doubling. */
  private reserve(n: number, m: number): boolean {
    if (this.ready && n <= this.triangleCapacity && m <= this.boxCapacity) return true;
    const tc = Math.max(this.triangleCapacity, 1024), bc = Math.max(this.boxCapacity, 1024);
    let t = tc, b = bc;
    while (t < n) t *= 2;
    while (b < m) b *= 2;
    if (this.wasm.init(this.width, this.height, t, b) !== OK) {
      this.ready = false;
      return false;
    }
    this.triangleCapacity = t;
    this.boxCapacity = b;
    this.ready = true;
    return true;
  }
}

/** @internal The outcome of a load. */
export type OcclusionCoreLoad = { readonly status: "ready"; readonly core: WasmOcclusionCore } | { readonly status: "unsupported" };

/** @internal What a loader depends on. */
export interface OcclusionCoreLoaderDeps {
  supportsSimd(): boolean;
  instantiate(): Promise<{ readonly wasm: VisibilityWasm; readonly memory: WebAssembly.Memory }>;
  warn(message: string): void;
}

/** @internal A loader: the first call loads, later calls share the outcome; a failed load warns once and stays off. */
export type OcclusionCoreLoader = (width: number, height: number) => Promise<OcclusionCoreLoad>;

const UNSUPPORTED: OcclusionCoreLoad = Object.freeze({ status: "unsupported" });

/** @internal A loader over `deps`. */
export function createOcclusionCoreLoader(deps: OcclusionCoreLoaderDeps): OcclusionCoreLoader {
  let loading: Promise<OcclusionCoreLoad> | null = null;
  return (width, height) =>
    (loading ??= (async () => {
      if (!deps.supportsSimd()) {
        deps.warn("[myco] occlusion culling: this browser's WebAssembly has no SIMD (simd128), so occlusion culling stays off.");
        return UNSUPPORTED;
      }
      try {
        const { wasm, memory } = await deps.instantiate();
        return { status: "ready" as const, core: new WasmOcclusionCore(wasm, () => memory.buffer, width, height) };
      } catch (err) {
        deps.warn(`[myco] occlusion culling: the occlusion core didn't load (${(err as Error)?.message ?? err}), so occlusion culling stays off.`);
        return UNSUPPORTED;
      }
    })());
}

/** Instantiates the committed module: fetched in browsers, read from disk in Node (the dedicated server, tests). */
async function instantiateCommittedCore(): Promise<{ wasm: VisibilityWasm; memory: WebAssembly.Memory }> {
  const glue = await import("./wasm/myco_visibility.js");
  const url = new URL("./wasm/myco_visibility_bg.wasm", import.meta.url);
  let source: URL | Uint8Array = url;
  if (url.protocol === "file:") {
    // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
    source = await readFile(url);
  }
  const out = await glue.default({ module_or_path: source });
  return { wasm: glue, memory: out.memory };
}

/** @internal The page's loader. */
export const loadOcclusionCore: OcclusionCoreLoader = createOcclusionCoreLoader({
  supportsSimd: supportsSimd128,
  instantiate: instantiateCommittedCore,
  warn: (message) => console.warn(message),
});
