// Project scripts in the editor (ADR 0030): the `.ts` files under a project's `scripts/` folder and
// its enabled plugins' files, linked by the project code linker (ADR 0329) into its memory target, so
// they load as ES modules sharing the editor's own engine: one registry and one World. This module is
// the editor's policy over the linker: a problem is reported (the status line shows it) and the rest
// still load; a reload replaces what the last load registered; the loaded code's asset references
// warm up with every scene load (ADR 0080).
import * as engine from "../myco"; // the public module scripts import (ADR 0135)
import { setScriptAssetRefs, unregisterScripts, withScriptRegistrations, type ScriptRegistrations } from "../engine/editor";
import type { PackageSource } from "./packages";
import { isScriptPath } from "./projectPaths";
import type { FoundPlugin } from "../plugins/thirdParty";
import type { ScriptProblem } from "../projectCode/compile";
import { link, type Linked } from "../projectCode/linker";
import { MemoryTarget } from "../projectCode/memoryTarget";
import { isSvelteComponentPath } from "../projectCode/uiModules";


export { isScriptPath };
export type { PackageSource, ScriptProblem };

/** The editor's link target: the last load's modules. Creating it publishes the engine as `globalThis.__myco`, as the player does. */
const target = new MemoryTarget(engine);

export interface LoadResult {
  /** Scripts that loaded, in load order. */
  readonly loaded: readonly string[];
  readonly problems: readonly ScriptProblem[];
  /** The component, data component and system ids the scripts registered. */
  readonly registered: ScriptRegistrations;
}

/** The package specifiers the last load bundled. */
let lastSpecifiers: readonly string[] = [];
/** The Svelte components the last load served as their files' asset values (ADR 0419), by path. */
let lastComponents = new Map<string, unknown>();


/**
 * Compile and load `scripts` (project path → source), registering their components, data
 * components and systems. They can import the project's `json` files (project path → text), and npm
 * packages from `packages`; `extraPackages` are npm plugin entries to bundle with them (ADR 0139).
 * Registrations replace any with the same id or name (from the editor build or an earlier load). A
 * script that fails to compile or throws while loading is reported, as is anything importing it and a
 * plugin entry that can't be bundled; the others still load. `ui` is the project's UI code (ADR 0419:
 * Svelte components, rune modules and `.css` files), compiled and loaded with the scripts; each component
 * that loads becomes its `.svelte` file's asset value (what `UIView` mounts), so a `UIView` showing one
 * mounts the new version in its next frame (hot reload).
 */
export async function loadScripts(
  scripts: ReadonlyMap<string, string>,
  json: ReadonlyMap<string, string> = new Map(),
  packages?: PackageSource,
  extraPackages: readonly string[] = [],
  ui: ReadonlyMap<string, string> = new Map(),
): Promise<LoadResult> {
  let linked: Linked<void> | undefined;
  const registered = await withScriptRegistrations(async () => {
    linked = await link({ code: scripts, json, ui, packages, extraEntries: extraPackages, isAsset: (p) => engine.Assets.has(p) || engine.Assets.has(`asset:${p}`) }, target);
  });
  const { loaded, problems, assetRefs, specifiers } = linked!;
  // A component that doesn't compile now keeps its last version, so a view showing it stays up while it's fixed.
  const components = new Map<string, unknown>();
  const failed = new Set(problems.map((p) => p.path));
  for (const [path, module] of lastComponents) if (failed.has(path) && ui.has(path)) components.set(path, module);
  for (const path of loaded) if (isSvelteComponentPath(path)) components.set(path, await target.scriptModule(path));
  lastComponents = components;
  engine.Assets.setCompiledModules(components);

  setScriptAssetRefs(assetRefs);

  lastSpecifiers = specifiers;
  return { loaded, problems, registered };
}

/** The npm package specifiers the loaded scripts import (ADR 0125), for the TypeScript service's package types. */
export const loadedPackageSpecifiers = (): readonly string[] => lastSpecifiers;

/**
 * The module of a script the last load loaded (`import()` of its URL again gives the same module
 * instance without running it again), e.g. a code bootstrap for play mode. Throws if the script
 * didn't load.
 */
export const loadedScriptModule = (path: string): Promise<Record<string, unknown>> => target.scriptModule(path);

/**
 * A found plugin's half's entry module the last load loaded (ADR 0139, 0275): a project plugin's from
 * its scripts, an npm plugin's from the bundled packages. Undefined when the plugin has no such half;
 * throws when the entry didn't load.
 */
export const loadedPluginModule = (plugin: FoundPlugin, half: "runtime" | "editor"): Promise<Record<string, unknown> | undefined> => target.pluginModule(plugin, half);

/** What the current project's scripts registered (the last `replaceScripts`). */
let current: ScriptRegistrations = { components: [], data: [], systems: [], inputs: [] };

/** What the current project's scripts registered: what a reload during play swaps from (ADR 0125). */
export const loadedRegistrations = (): ScriptRegistrations => current;

/**
 * Load `scripts` in place of the scripts loaded before (a reload, or another project): their
 * types replace the old ones, and types the old scripts registered that the new ones don't (a
 * deleted script, a renamed id, one that failed to load) are unregistered, so scenes show them as
 * missing. Pass an empty map to unload everything.
 */
export async function replaceScripts(
  scripts: ReadonlyMap<string, string>,
  json: ReadonlyMap<string, string> = new Map(),
  packages?: PackageSource,
  extraPackages: readonly string[] = [],
  ui: ReadonlyMap<string, string> = new Map(),
): Promise<LoadResult> {
  const result = await loadScripts(scripts, json, packages, extraPackages, ui);

  const gone = (old: string[], now: string[]) => old.filter((id) => !now.includes(id));
  unregisterScripts({
    components: gone(current.components, result.registered.components),
    data: gone(current.data, result.registered.data),
    systems: gone(current.systems, result.registered.systems),
    inputs: gone(current.inputs, result.registered.inputs),
  });
  current = result.registered;
  return result;
}
