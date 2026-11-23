// Loads the animation core (ADR 0370, "Instances and threads"): lazily, the first time a World needs animation, once per
// page (and once per Node process: the dedicated server and tests load the same wasm), as navigation's loader does
// (0065): browsers fetch `myco_anim_bg.wasm` (Vite serves and bundles it as an asset beside this module), Node reads it
// from disk. The core is built for `simd128` and has no scalar build, so a runtime without it never downloads the
// module: the loader warns once and reports `unsupported`, and Animators stay at their bind pose.
//
// `createAnimationCoreLoader` takes what varies by host (the feature check, how the module is instantiated, where
// warnings go); `loadAnimationCore` is the page's loader over the real ones. The glue keeps one instance per page,
// so only that loader starts the real module.
import { onEngineLifecycle } from "../../../../engine/core/engineLifecycle";
import { AnimationCore, DEFAULT_CORE_LIMITS, type AnimationCoreLimits, type AnimationWasm } from "./AnimationCore";
import { supportsSimd128 } from "./simd";

/** @internal The outcome of a load. */
export type AnimationCoreLoad = { readonly status: "ready"; readonly core: AnimationCore } | { readonly status: "unsupported" };

/** @internal The glue, instantiated, and its memory. */
export interface InstantiatedCore {
  readonly wasm: AnimationWasm;
  readonly memory: WebAssembly.Memory;
}

/** @internal What a loader depends on. */
export interface AnimationCoreLoaderDeps {
  /** Whether this runtime runs `simd128` code (`supportsSimd128` in production). */
  supportsSimd(): boolean;
  /** Fetches (or reads) and instantiates the module. */
  instantiate(): Promise<InstantiatedCore>;
  /** Where the loader's warnings go (`console.warn`). */
  warn(message: string): void;
}

/** @internal A loader: the first call loads (with its `limits`), later calls share the outcome; a failed load is tried again. */
export type AnimationCoreLoader = (limits?: Partial<AnimationCoreLimits>) => Promise<AnimationCoreLoad>;

const UNSUPPORTED: AnimationCoreLoad = Object.freeze({ status: "unsupported" });

/** @internal A loader over `deps`. */
export function createAnimationCoreLoader(deps: AnimationCoreLoaderDeps): AnimationCoreLoader {
  let loading: Promise<AnimationCoreLoad> | null = null;
  return (limits = {}) => {
    loading ??= start(deps, { ...DEFAULT_CORE_LIMITS, ...limits }).catch((err: unknown) => {
      loading = null; // a failed fetch or compile is tried again next time
      throw err;
    });
    return loading;
  };
}

async function start(deps: AnimationCoreLoaderDeps, limits: AnimationCoreLimits): Promise<AnimationCoreLoad> {
  if (!deps.supportsSimd()) {
    deps.warn("[myco] animation: this browser's WebAssembly has no SIMD (simd128), so animation can't run here; Animators stay at their bind pose.");
    return UNSUPPORTED;
  }
  const { wasm, memory } = await deps.instantiate();
  const sameAsDefaults = (Object.keys(DEFAULT_CORE_LIMITS) as (keyof AnimationCoreLimits)[]).every((k) => limits[k] === DEFAULT_CORE_LIMITS[k]);
  const core = AnimationCore.start(wasm, () => memory.buffer, sameAsDefaults ? DEFAULT_CORE_LIMITS : limits, deps.warn);
  // Idle assets go between editor play sessions and whenever an Engine is disposed (ADR 0370, "Assets"): by then its
  // Worlds have closed their namespaces, so nothing they loaded is referenced unless another Engine's World holds it.
  onEngineLifecycle((event) => {
    if (event === "disposed") core.releaseIdle();
  });
  return { status: "ready", core };
}

/** @internal Instantiates the committed module: fetched in browsers, read from disk in Node (the dedicated server, tests). */
async function instantiateCommittedCore(): Promise<InstantiatedCore> {
  const glue = await import("../wasm/myco_anim.js");
  const url = new URL("../wasm/myco_anim_bg.wasm", import.meta.url);
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
export const loadAnimationCore: AnimationCoreLoader = createAnimationCoreLoader({
  supportsSimd: supportsSimd128,
  instantiate: instantiateCommittedCore,
  warn: (message) => console.warn(message),
});
