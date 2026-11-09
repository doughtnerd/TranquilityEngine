// Third-party plugins in the editor (ADR 0139). Opening a project and every script reload go through
// `loadProjectCode`: find and check the project's plugins (`thirdParty.ts`), load the scripts plus the
// enabled plugins' code (both halves) through the script loader, then hand the halves from the fresh
// modules to the editor's plugin set (ADR 0144), which re-activates the ones whose module changed, so
// saving an editor-half file re-registers its contributions live. Editor code only.
import { signal } from "@preact/signals";
import * as editorSdk from "../editor/sdk";
import { packageSourceFor } from "../editor/projectPackages";
import { jsonFiles, type EditorProject } from "../editor/projects";
import { loadedPackageModule, loadedScriptModule, replaceScripts, type LoadResult, type ScriptProblem } from "../editor/scriptLoader";
import type { EditorPlugin, EditorPluginContext } from "../editor/sdk/plugins";
import { applyEditorPlugins, pluginManifests, type EditorSetPlugin } from "./editorPlugins";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import type { PluginSetProblem } from "./pluginSet";
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

/**
 * An editor half from its entry module (or none: a plugin with only static asset kinds). Static kinds
 * from plugin.json register unless the half registers a kind with the same id itself.
 */
export function toEditorPlugin(plugin: FoundPlugin, module: Record<string, unknown> | undefined): EditorPlugin {
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

/**
 * The enabled plugins as the plugin set takes them: each half built from its freshly loaded module. A
 * plugin whose code doesn't load gets a runtime half that throws the error, so the set reports it as
 * failing to activate and skips the plugins that need it.
 */
async function toSetPlugins(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>): Promise<EditorSetPlugin[]> {
  const load = (p: FoundPlugin, entry: string) => (p.source.kind === "project" ? loadedScriptModule(entry) : loadedPackageModule(entry));
  const out: EditorSetPlugin[] = [];
  for (const p of plugins) {
    if (!enabled.has(p.manifest.name)) continue;
    try {
      const runtimeModule = p.runtime ? await load(p, p.runtime) : undefined;
      const editorModule = p.editor ? await load(p, p.editor) : undefined;
      const hasEditor = !!editorModule || !!p.manifest.assetKinds?.length;
      out.push({
        manifest: p.manifest,
        ...(runtimeModule ? { runtime: toRuntimePlugin(p, runtimeModule) } : {}),
        ...(hasEditor ? { editor: toEditorPlugin(p, editorModule) } : {}),
        modules: { runtime: runtimeModule, editor: editorModule ?? (hasEditor ? p.manifest : undefined) },
      });
    } catch (err) {
      out.push({ manifest: p.manifest, runtime: { manifest: p.manifest, activate: () => { throw err; } } });
    }
  }
  return out;
}

const asScriptProblem = (p: PluginProblem): ScriptProblem => ({ path: p.where, message: p.message });

/**
 * Load the project's code (ADR 0030, 0125, 0139): its scripts and the enabled third-party plugins'
 * halves, replacing what was loaded, then apply the editor's plugin set with them. Plugin problems join
 * the script problems. With `runtime: false` (a reload during Play) runtime halves stay as they are;
 * only editor halves re-activate.
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
  const disabled = project.settings.plugins?.disabled;
  const enabled = resolveEnabledPlugins([...builtIn, ...checked.plugins.map((p) => p.manifest)], disabled);
  const code = selectPluginCode(project.scripts, checked.plugins, enabled, { editor: true });
  const result = await replaceScripts(code, json, packages, npmPluginEntries(checked.plugins, enabled, { editor: true }));
  const applied = applyEditorPlugins(disabled, { thirdParty: await toSetPlugins(checked.plugins, enabled), keepRuntime: !runtime });
  const whereOf = (problem: PluginSetProblem) => checked.plugins.find((p) => p.manifest.name === problem.plugin)?.where ?? `plugins (${problem.plugin})`;
  const failed = applied.problems.map((p): PluginProblem => ({ plugin: p.plugin, where: whereOf(p), message: p.message }));
  const problems = [...found.problems, ...checked.problems, ...failed];
  projectPlugins.value = { found: found.plugins, usable: checked.plugins, problems };
  return { ...result, problems: [...result.problems, ...problems.map(asScriptProblem)] };
}

/** The project closed: deactivate every third-party half (the first-party ones go back to all enabled). */
export function unloadThirdPartyPlugins(): void {
  applyEditorPlugins(undefined, { thirdParty: [] });
  projectPlugins.value = EMPTY;
}
