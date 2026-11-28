// Third-party node modules at run time (ADR 0370 "Third-party graph and rig nodes"; T45t): a graph's plugin modules are
// loaded page-wide by project path, then registered with each World's core.
//
// - **Load** (`loadNodeModule`, once per path and content): the file's bytes through `Assets`, metered unless they are
//   already (games ship metered modules: the export step meters them, `src/export/animationNodes.ts`; the editor and
//   the exporters give the loader the editor module's fuel pass with `setNodeModuleMeter`, and metered bytes are cached
//   by content hash), instantiated with no imports, the ABI version checked and the descriptor read (`./module.ts`).
//   The descriptor goes to the node catalogue's registry (`engine/animation/graphNodes/plugin.ts`), so graphs compile
//   the module's nodes with named parameters and the graph editor lists them.
// - **Budget:** the module's `budget` from its plugin's `plugin.json` (`animationNodes`, read through `Assets` like any
//   project JSON, `engine/animation/pluginNodes.ts`); a module the manifest doesn't list runs with the default budget,
//   with one warning; a module of a plugin the project turned off isn't loaded. Editing `plugin.json` updates loaded
//   modules' budgets; editing a module reloads it.
// - **Per World** (`acquireNodeModule`): the descriptor registered with the core (`plugin_register`, an arena asset
//   reference-counted like clips: the graph binds its string id to the handle, `features/graph/asset.ts`), and the
//   handle bound to the module in the host the core calls (`./host.ts`).
//
// Every failure is one warning; the graph's plugin nodes then pass their input through. Internal to the animation plugin.
import { registerPluginNodeModule } from "../../../../../engine/animation/graphNodes/plugin";
import { parseAnimationNodes, NODE_FUEL } from "../../../../../engine/animation/pluginNodes";
import { Assets, fetchAssetBytes } from "../../../../../engine/scene/Assets";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { bindNodeModule } from "./host";
import { isMeteredModule, NodeModule } from "./module";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

/** @internal The fuel pass: unmetered module bytes → metered ones; rejects with the reason a module is refused. */
export type NodeModuleMeter = (bytes: Uint8Array) => Promise<Uint8Array>;

/** @internal A loaded module. */
export interface LoadedNodeModule {
  /** The project path. */
  readonly path: string;
  readonly module: NodeModule;
  /** Distinguishes reloads of one path (a content change): part of compile and asset keys. */
  readonly id: number;
}

let meter: NodeModuleMeter | null = null;
/** Content hash of unmetered bytes → their metered bytes. */
const metered = new Map<string, Promise<Uint8Array>>();
/** Path → its load, and the registry entry it made. */
const loads = new Map<string, { readonly promise: Promise<LoadedNodeModule | null>; unregister: (() => void) | null }>();
let nextId = 1;
let watching = false;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * @internal Sets the fuel pass the loader meters unmetered modules with (the editor module's `meter_node_module`), or
 * none (games: modules arrive metered, and an unmetered one is refused).
 */
export function setNodeModuleMeter(fn: NodeModuleMeter | null): void {
  meter = fn;
}

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `bytes` metered (as they are when they already are), or why not. */
async function meteredBytes(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array } | { readonly error: string }> {
  try {
    if (isMeteredModule(await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>))) return { bytes };
  } catch (err) {
    return { error: `it isn't a valid wasm module (${err instanceof Error ? err.message : String(err)})` };
  }
  const pass = meter;
  if (!pass) return { error: "it isn't metered: export the game (exports meter node modules) or run it in the editor" };
  const key = await contentHash(bytes);
  let pending = metered.get(key);
  if (!pending) {
    pending = pass(bytes);
    metered.set(key, pending);
    pending.catch(() => metered.get(key) === pending && metered.delete(key));
  }
  try {
    return { bytes: await pending };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The plugin folder of a module path (`plugins/acme/nodes/sway.wasm` → `plugins/acme`), or null. */
const folderOf = (path: string): string | null => /^(plugins\/[^/]+)\//.exec(path)?.[1] ?? null;

function jsonAsset(path: string): unknown {
  try {
    if (!Assets.has(path)) return undefined;
    const v = Assets.get(path);
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch {
    return undefined;
  }
}

/** What the module's plugin declares for it: its budget, or `off` when the project turned the plugin off. */
function declaration(path: string): { readonly budget: number } | "off" {
  const folder = folderOf(path);
  const manifest = folder ? jsonAsset(`${folder}/plugin.json`) : undefined;
  if (!folder || typeof manifest !== "object" || manifest === null) {
    warnOnce(`undeclared:${path}`, `[myco] animation: the node module "${path}" isn't in a plugin folder with a plugin.json (plugins/<name>/plugin.json, "animationNodes"); it runs with the default budget.`);
    return { budget: NODE_FUEL.default };
  }
  const m = manifest as { name?: unknown; animationNodes?: unknown };
  const disabled = (jsonAsset("project.json") as { plugins?: { disabled?: unknown } } | undefined)?.plugins?.disabled;
  if (typeof m.name === "string" && Array.isArray(disabled) && disabled.includes(m.name)) return "off";
  const decl = parseAnimationNodes(m.animationNodes).modules.find((d) => `${folder}/${d.module}` === path);
  if (!decl) {
    warnOnce(`undeclared:${path}`, `[myco] animation: ${folder}/plugin.json doesn't list the node module "${path.slice(folder.length + 1)}" in "animationNodes"; it runs with the default budget.`);
    return { budget: NODE_FUEL.default };
  }
  return { budget: decl.budget };
}

async function load(path: string, entry: { unregister: (() => void) | null }): Promise<LoadedNodeModule | null> {
  const decl = declaration(path);
  if (decl === "off") {
    warnOnce(`off:${path}`, `[myco] animation: the node module "${path}" belongs to a plugin the project turned off; its nodes pass their input through.`);
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await fetchAssetBytes(Assets.url(path));
  } catch (err) {
    warnOnce(`fetch:${path}`, `[myco] animation: couldn't load the node module "${path}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const ready = await meteredBytes(bytes);
  const made = "error" in ready ? ready : await NodeModule.create(ready.bytes, decl.budget);
  if ("error" in made) {
    warnOnce(`refused:${path}:${bytes.length}`, `[myco] animation: the node module "${path}" was refused: ${made.error}. Its nodes pass their input through.`);
    return null;
  }
  entry.unregister = registerPluginNodeModule(path, made.module.descriptor);
  return { path, module: made.module, id: nextId++ };
}

/** Project file changes: a module reloads on its next use; a `plugin.json` edit updates its modules' budgets. */
function watch(): void {
  if (watching) return;
  watching = true;
  Assets.onChanged((changed) => {
    if (loads.has(changed)) unloadNodeModule(changed);
    if (/^plugins\/[^/]+\/plugin\.json$/.test(changed)) {
      const folder = changed.slice(0, -"/plugin.json".length);
      for (const [path, entry] of loads) {
        if (!path.startsWith(`${folder}/`)) continue;
        void entry.promise.then((loaded) => {
          const decl = declaration(path);
          if (loaded && decl !== "off") loaded.module.budget = decl.budget;
        });
      }
    }
  });
}

/**
 * @internal The module at `ref` (a project path or asset reference), loaded once per page (see the file header); null,
 * with one warning, when it can't be loaded.
 */
export function loadNodeModule(ref: string): Promise<LoadedNodeModule | null> {
  watch();
  const path = normalizeAssetPath(ref);
  const known = loads.get(path);
  if (known) return known.promise;
  const entry: { promise: Promise<LoadedNodeModule | null>; unregister: (() => void) | null } = { promise: Promise.resolve(null), unregister: null };
  entry.promise = load(path, entry).then((loaded) => {
    if (!loaded && loads.get(path) === entry) loads.delete(path); // tried again on the next use
    return loaded;
  });
  loads.set(path, entry);
  return entry.promise;
}

/** @internal Forgets a loaded module (its descriptor leaves the catalogue); the next use loads it again. */
export function unloadNodeModule(ref: string): void {
  const path = normalizeAssetPath(ref);
  const entry = loads.get(path);
  if (!entry) return;
  loads.delete(path);
  entry.unregister?.();
  void entry.promise.then(() => entry.unregister?.());
}

/**
 * @internal One reference to the module at `ref` registered with `ns`'s core, bound for the core's calls: its handle
 * (what a graph binds), or 0 when it can't be loaded or the core refused its descriptor (one warning).
 */
export async function acquireNodeModule(ns: AnimationWorldCore, ref: string): Promise<number> {
  const loaded = await loadNodeModule(ref);
  if (!loaded || !ns.open) return 0;
  const handle = ns.acquire(`${loaded.path}\u0000${loaded.id}`, "plugin", () => ({ kind: "plugin", bytes: loaded.module.descriptorBytes }));
  if (!handle) {
    warnOnce(`register:${loaded.path}:${loaded.id}`, `[myco] animation: the core refused the node module "${loaded.path}"'s descriptor (status ${ns.core.lastStatus()}); its nodes pass their input through.`);
    return 0;
  }
  bindNodeModule(ns.core, handle, loaded.module, loaded.path);
  return handle;
}

/**
 * @internal Loads the modules a graph source's plugin nodes name with a descriptor node (`module` + `node`), so the
 * compiler packs their named parameters. Resolves to a key of what loaded, for the compile cache.
 */
export async function loadGraphNodeModules(source: unknown): Promise<string> {
  const nodes = (source as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return "";
  const paths = new Set<string>();
  for (const n of nodes as { family?: unknown; params?: { module?: unknown; node?: unknown } }[]) {
    if (n?.family === "plugin" && typeof n.params?.module === "string" && typeof n.params.node === "string" && n.params.module !== "") paths.add(normalizeAssetPath(n.params.module));
  }
  if (!paths.size) return "";
  const loaded = await Promise.all([...paths].sort().map(async (p) => `${p}:${(await loadNodeModule(p))?.id ?? 0}`));
  return loaded.join(",");
}
