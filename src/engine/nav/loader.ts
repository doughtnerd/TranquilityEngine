/**
 * Internal (ADR 0065): loads the navigation WebAssembly module (`native/nav`, built into ./wasm by
 * `npm run build:nav`) the first time a World needs it, like Rapier 3D (ADR 0045), so games without
 * navigation never download it. Browsers fetch the `.wasm` file (Vite bundles it as an asset);
 * Node (the dedicated server, tests) reads it from disk.
 */
import type * as NavModule from "./wasm/myco_nav.js";

export type NavigationModule = typeof NavModule;

let loading: Promise<NavigationModule> | null = null;

/** @internal The navigation module, loaded and instantiated once. */
export function loadNavigation(): Promise<NavigationModule> {
  loading ??= instantiate().catch((err: unknown) => {
    loading = null; // a failed fetch or compile is tried again next time
    throw err;
  });
  return loading;
}

async function instantiate(): Promise<NavigationModule> {
  const mod = await import("./wasm/myco_nav.js");
  const url = new URL("./wasm/myco_nav_bg.wasm", import.meta.url);
  let source: URL | Uint8Array = url;
  if (url.protocol === "file:") {
    // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as typeof import("node:fs/promises");
    source = await readFile(url);
  }
  await mod.default({ module_or_path: source });
  return mod;
}
