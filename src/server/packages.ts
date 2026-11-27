// npm packages for project scripts in Node (ADR 0125): the dedicated server and `npm run export`
// read the project folder's node_modules from disk and bundle with esbuild-wasm's Node build, so
// the output matches what the editor bundles in its page.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EsbuildApi, PackageSource } from "../editor/packages";
import type { UIRuntimeSource } from "../projectCode/uiBundle";

let esbuild: Promise<EsbuildApi> | null = null;

/**
 * esbuild-wasm's Node build. Its service runs in a child `node` process, which inherits
 * `NODE_OPTIONS`; a preload there warms up the random generator first (esbuildPrewarm.cjs).
 */
function nodeEsbuild(): Promise<EsbuildApi> {
  return (esbuild ??= (async () => {
    const prewarm = fileURLToPath(new URL("./esbuildPrewarm.cjs", import.meta.url));
    const options = process.env.NODE_OPTIONS ?? "";
    if (!options.includes("esbuildPrewarm.cjs")) process.env.NODE_OPTIONS = `${options} --require ${JSON.stringify(prewarm)}`.trim();
    const module = await import("esbuild-wasm");
    return ((module as { default?: EsbuildApi }).default ?? module) as EsbuildApi;
  })());
}

/** The engine's checkout, which `npm run export` runs from. */
const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The engine's Svelte runtime and renderer, read from its checkout, which game builds bundle their UI code with (ADR 0425). */
export function nodeUIRuntimeSource(): UIRuntimeSource {
  return {
    files: { read: (path) => readFile(join(ENGINE_ROOT, ...path.split("/")), "utf8").catch(() => null) },
    esbuild: nodeEsbuild,
  };
}

/** The packages of the project folder `root`, bundled for `mode`. */
export function nodePackageSource(root: string, mode: PackageSource["mode"]): PackageSource {
  return {
    id: root,
    mode,
    files: {
      read: (path) => readFile(join(root, ...path.split("/")), "utf8").catch(() => null),
    },
    esbuild: nodeEsbuild,
  };
}
