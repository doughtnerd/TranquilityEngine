// Third-party plugins in the editor (ADR 0139). Opening a project and every script reload go through
// `loadProjectCode`: find and check the project's plugins (`thirdParty.ts`), load the scripts plus the
// enabled plugins' code (both halves) through the script loader, then activate the plugins' halves
// again from the fresh modules, so saving an editor-half file re-registers its contributions live.
// Editor code only.
import { signal } from "@preact/signals";
import * as editorSdk from "../editor/sdk";
import { packageSourceFor } from "../editor/projectPackages";
import { jsonFiles, type EditorProject } from "../editor/projects";
import { loadedPackageModule, loadedScriptModule, replaceScripts, type LoadResult, type ScriptProblem } from "../editor/scriptLoader";
import { activatePlugins, deactivatePlugin, type EditorPlugin, type EditorPluginContext } from "../editor/sdk/plugins";
import { pluginManifests } from "./editorApply";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { activateRuntimePlugins, deactivateRuntimePlugin } from "./runtimeContext";
import { activateOf, checkPlugins, discoverPlugins, npmPluginEntries, selectPluginCode, toRuntimePlugin, type FoundPlugin, type PluginProblem } from "./thirdParty";

// What `import … from "myco/editor"` gives a plugin's editor half (the script loader's shim reads it).
(globalThis as { __mycoEditor?: unknown }).__mycoEditor = editorSdk;

export interface ProjectPluginsState {
  /** Every third-party plugin found with a valid manifest, refused ones included. */
  readonly found: readonly FoundPlugin[];
  /** The ones that can load, in dependency order. */
  readonly usable: readonly FoundPlugin[];
  /** Why plugins were refused (bad manifests, SDK or dependency mismatches) or failed to activate. */
  readonly problems: readonly PluginProblem[];
}

const EMPTY: ProjectPluginsState = { found: [], usable: [], problems: [] };

/** The open project's third-party plugins, for the Plugins settings category. */
export const projectPlugins = signal<ProjectPluginsState>(EMPTY);

/** Every plugin manifest the Plugins category lists: first-party, then the project's usable third-party ones. */
export const allPluginManifests = (): PluginManifest[] => [...pluginManifests(), ...projectPlugins.value.usable.map((p) => p.manifest)];

/** Third-party halves active now, in activation order. */
let activeRuntime: string[] = [];
let activeEditor: string[] = [];

/** Deactivate every third-party editor half (and runtime half, with `runtime`), dependents first. */
function deactivateThirdParty(runtime: boolean): void {
  for (const name of [...activeEditor].reverse()) deactivatePlugin(name);
  activeEditor = [];
  if (!runtime) return;
  for (const name of [...activeRuntime].reverse()) deactivateRuntimePlugin(name);
  activeRuntime = [];
}

/**
 * An editor half from its entry module (or none: a plugin with only static asset kinds). Static kinds
 * from plugin.json register unless the half registers a kind with the same id itself.
 */
function toEditorPlugin(plugin: FoundPlugin, module: Record<string, unknown> | undefined): EditorPlugin {
  const activate = module ? (activateOf(module) as ((context: EditorPluginContext) => void) | undefined) : undefined;
  if (module && !activate) throw new Error(`${plugin.manifest.name}: its editor entry (${plugin.editor}) exports no activate(context) function`);
  return {
    manifest: plugin.manifest,
    activate(context) {
      const own = new Set<string>();
      activate?.({ ...context, registerAssetKind: (kind) => (own.add(kind.id), context.registerAssetKind(kind)) });
      for (const kind of plugin.manifest.assetKinds ?? []) if (!own.has(kind.id)) context.registerAssetKind({ id: kind.id, extensions: kind.extensions, label: kind.label, icon: kind.icon });
    },
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Activate the enabled plugins' halves from the loaded modules, in order; returns what failed. */
async function activateThirdParty(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>, runtime: boolean): Promise<PluginProblem[]> {
  const problems: PluginProblem[] = [];
  const failed = new Set<string>();
  const load = (p: FoundPlugin, entry: string) => (p.source.kind === "project" ? loadedScriptModule(entry) : loadedPackageModule(entry));
  for (const p of plugins) {
    const name = p.manifest.name;
    if (!enabled.has(name)) continue;
    const blocked = Object.keys(p.manifest.dependencies ?? {}).find((d) => failed.has(d));
    if (blocked) {
      failed.add(name);
      problems.push({ plugin: name, where: p.where, message: `${name} needs ${blocked}, which failed to activate` });
      continue;
    }
    try {
      if (runtime && p.runtime) {
        activateRuntimePlugins([toRuntimePlugin(p, await load(p, p.runtime))], { provided: enabled });
        activeRuntime.push(name);
      }
      const editorModule = p.editor ? await load(p, p.editor) : undefined;
      if (editorModule || p.manifest.assetKinds?.length) {
        activatePlugins([toEditorPlugin(p, editorModule)], { provided: enabled });
        activeEditor.push(name);
      }
    } catch (err) {
      failed.add(name);
      if (activeRuntime.includes(name)) {
        deactivateRuntimePlugin(name);
        activeRuntime = activeRuntime.filter((n) => n !== name);
      }
      problems.push({ plugin: name, where: p.where, message: `${name} failed to activate: ${message(err)}` });
    }
  }
  return problems;
}

const asScriptProblem = (p: PluginProblem): ScriptProblem => ({ path: p.where, message: p.message });

/**
 * Load the project's code (ADR 0030, 0125, 0139): its scripts and the enabled third-party plugins'
 * halves, replacing what was loaded. Plugin problems join the script problems. With `runtime: false`
 * (a reload during Play) runtime halves stay as they are; only editor halves re-activate.
 */
export async function loadProjectCode(project: EditorProject, options: { runtime?: boolean } = {}): Promise<LoadResult> {
  const runtime = options.runtime ?? true;
  const json = jsonFiles(project);
  const packages = packageSourceFor(project);
  const builtIn = pluginManifests();
  let found: Awaited<ReturnType<typeof discoverPlugins>>;
  try {
    found = await discoverPlugins({ json, code: project.scripts.keys(), packages: packages?.files });
  } catch (err) {
    found = { plugins: [], problems: [{ plugin: "(plugins)", where: "plugins/", message: `couldn't look for plugins: ${message(err)}` }] };
  }
  const checked = checkPlugins(found.plugins, builtIn);
  const enabled = resolveEnabledPlugins([...builtIn, ...checked.plugins.map((p) => p.manifest)], project.settings.plugins?.disabled);
  deactivateThirdParty(runtime);
  const code = selectPluginCode(project.scripts, checked.plugins, enabled, { editor: true });
  const result = await replaceScripts(code, json, packages, npmPluginEntries(checked.plugins, enabled, { editor: true }));
  const failed = await activateThirdParty(checked.plugins, enabled, runtime);
  const problems = [...found.problems, ...checked.problems, ...failed];
  projectPlugins.value = { found: found.plugins, usable: checked.plugins, problems };
  return { ...result, problems: [...result.problems, ...problems.map(asScriptProblem)] };
}

/** The project closed: deactivate every third-party half. */
export function unloadThirdPartyPlugins(): void {
  deactivateThirdParty(true);
  projectPlugins.value = EMPTY;
}
