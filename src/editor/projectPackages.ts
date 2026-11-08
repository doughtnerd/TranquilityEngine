// npm packages of the open project (ADR 0125): read from the project folder's node_modules through
// its FileSystem (Tauri's fs plugin, or the browser's File System Access handle, ADR 0038), and
// bundled with esbuild's WebAssembly build, loaded the first time a project imports a package.
import type { EsbuildApi, PackageSource } from "./packages";
import { joinPath, type EditorProject } from "./projects";

let esbuild: Promise<EsbuildApi> | null = null;
/** Headless tests run in Node, where esbuild comes from src/server/packages.ts (`useEsbuild`). */
let override: (() => Promise<EsbuildApi>) | null = null;

/** Use `provider` for esbuild instead of the page's WebAssembly build (headless tests in Node). */
export function useEsbuild(provider: (() => Promise<EsbuildApi>) | null): void {
  override = provider;
}

/** esbuild, initialised: the WebAssembly build, in a worker. */
function editorEsbuild(): Promise<EsbuildApi> {
  if (override) return override();
  return (esbuild ??= (async () => {
    if (typeof document === "undefined") throw new Error("esbuild runs in the editor's page; headless code passes one with useEsbuild()");
    const module = await import("esbuild-wasm");
    const api = ((module as { default?: EsbuildApi }).default ?? module) as EsbuildApi;
    const { default: wasmURL } = await import("esbuild-wasm/esbuild.wasm?url");
    await api.initialize({ wasmURL, worker: true });
    return api;
  })().catch((err: unknown) => {
    esbuild = null; // try again next time
    throw err;
  }));
}

/** Where `project`'s packages come from, or undefined for a project that isn't a folder. */
export function packageSourceFor(project: EditorProject, mode: PackageSource["mode"] = "development"): PackageSource | undefined {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return undefined;
  return {
    id: root,
    mode,
    files: { read: (path) => fs.readText(joinPath(root, path)).catch(() => null) },
    esbuild: editorEsbuild,
  };
}
