// The core's code (ADR 0157; architecture §3.1): fetches `myco_audio.wasm` and compiles it on main (0.5–4 ms),
// which validates it before a context exists, and resolves the worklet module's URL. The bytes go to the worklet,
// which instantiates them synchronously (a compiled Module can't be posted to a worklet in WebKit). A1.3a adds the
// clip decode path to this file; B6 removes it again.

/** @internal The core's wasm, fetched and compiled. */
export interface CoreWasm {
  /** For `processorOptions` (structured-cloned into the worklet). */
  readonly bytes: ArrayBuffer;
  /** Compiled on main: proof the bytes are a module this engine accepts (`simd128` included). */
  readonly module: WebAssembly.Module;
}

/** @internal Where `myco_audio.wasm` is served: beside this module in the dev server and the app builds. */
export function coreWasmUrl(): URL {
  return new URL("../wasm/myco_audio.wasm", import.meta.url);
}

/** @internal Fetches and compiles the core. Throws on a fetch or compile failure (the host falls back, architecture §2.1). */
export async function loadCoreWasm(fetchImpl: typeof fetch = fetch): Promise<CoreWasm> {
  const response = await fetchImpl(coreWasmUrl());
  if (!response.ok) throw new Error(`audio core: fetching myco_audio.wasm failed (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  return { bytes, module };
}

/** @internal The URL of the bundled worklet module (`worklet/processor.ts` with `coreDriver.ts`) for `audioWorklet.addModule`. */
export async function workletModuleUrl(): Promise<string> {
  // Vite bundles the processor and what it imports as one ES module (the worker pipeline); dynamic, so Node
  // tests that import this file never resolve it.
  const { default: url } = await import("../worklet/processor.ts?worker&url");
  return url;
}
