// Third-party plugins in the editor (ADR 0139). Opening a project and every script reload go through
// `loadProjectCode`: plan the project's code as every host does (`planPluginCode`, ADR 0275), link the
// scripts plus the enabled plugins' code (both halves) through the script loader (the project code
// linker's memory target, ADR 0329), then hand the halves from the fresh
// modules to the editor's plugin set (ADR 0144), which re-activates the ones whose module changed, so
// saving an editor-half file re-registers its contributions live. Editor code only.
import { signal } from "@preact/signals";
import * as editorSdk from "../editor/sdk";
import { packageSourceFor } from "../editor/projectPackages";
import { jsonFiles, uiFiles, type EditorProject } from "../editor/projects";

import { loadedPluginModule, replaceScripts, type LoadResult, type ScriptProblem } from "../editor/scriptLoader";
import type { EditorPlugin, EditorPluginContext } from "../editor/sdk/plugins";
import { FIRST_PARTY_MANIFESTS } from "./catalogue";
import { applyEditorPlugins, type EditorSetPlugin } from "./editorPlugins";
import type { PluginManifest } from "./manifest";
import type { PluginSetProblem } from "./pluginSet";
import { builtinUIReady } from "./builtinUILoads";
import { applyProjectAnimationNodes, clearProjectAnimationNodes } from "./projectAnimationNodes";
import { applyProjectAudioEffects, clearProjectAudioEffects } from "./projectAudioEffects";
import { activateOf, planPluginCode, toRuntimePlugin, type FoundPlugin, type PluginProblem, type ThirdPartyManifest } from "./thirdParty";

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
export const allPluginManifests = (): PluginManifest[] => [...FIRST_PARTY_MANIFESTS, ...projectPlugins.value.usable.map((p) => p.manifest)];

/**
 * An editor half from its manifest, its entry (for the message) and the entry's module (or none: a
 * plugin with only static asset kinds). Static kinds from plugin.json register unless the half
 * registers a kind with the same id itself.
 */
function toEditorPlugin(manifest: ThirdPartyManifest, entry: string | undefined, module: Record<string, unknown> | undefined): EditorPlugin {
  const activate = module ? (activateOf(module) as ((context: EditorPluginContext) => void) | undefined) : undefined;
  if (module && !activate) throw new Error(`${manifest.name}: its editor entry (${entry}) exports no activate(context) function`);
  return {
    manifest,
    activate(context) {
      const own = new Set<string>();
      activate?.({ ...context, registerAssetKind: (kind) => (own.add(kind.id), context.registerAssetKind(kind)) });
      for (const kind of manifest.assetKinds ?? []) if (!own.has(kind.id)) context.registerAssetKind({ id: kind.id, extensions: kind.extensions, label: kind.label, icon: kind.icon });
    },
  };
}

/**
 * The plan's loaded plugins as the plugin set takes them: each half built from its freshly loaded
 * module. A plugin whose code didn't load (the link already reported why: a script problem, or an npm
 * entry that can't be bundled) gets a runtime half that throws the error, so the set reports it as
 * failing to activate and skips the plugins that need it.
 */
async function toSetPlugins(plugins: readonly FoundPlugin[]): Promise<EditorSetPlugin[]> {
  const out: EditorSetPlugin[] = [];
  for (const p of plugins) {
    try {
      const runtimeModule = await loadedPluginModule(p, "runtime");
      const editorModule = await loadedPluginModule(p, "editor");
      const hasEditor = !!editorModule || !!p.manifest.assetKinds?.length;
      out.push({
        manifest: p.manifest,
        ...(runtimeModule ? { runtime: toRuntimePlugin(p.manifest, p.runtime!, runtimeModule) } : {}),
        ...(hasEditor ? { editor: toEditorPlugin(p.manifest, p.editor, editorModule) } : {}),
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
  const disabled = project.settings.plugins?.disabled;
  const plan = await planPluginCode({ json, code: project.scripts, packages: packages?.files, disabled, assets: project.files }, { editor: true });
  // ADR 0352 §8: the plugins' audio effects (catalogue, core, offline renders), before Play can start on this code.
  await applyProjectAudioEffects(project, plan);
  // ADR 0370 (T45t): the plugins' animation node modules, metered and in the node catalogue before Play or a graph compiles.
  await applyProjectAnimationNodes(plan);
  const result = await replaceScripts(plan.code, json, packages, plan.npmEntries, uiFiles(project)); // Svelte UI compiles with the scripts (ADR 0419)

  const applied = applyEditorPlugins(disabled, { thirdParty: await toSetPlugins(plan.loaded), keepRuntime: !runtime });
  // ADR 0419 wave B: the built-in UI components the active plugins' editor halves started loading, before Play can start.
  await builtinUIReady();
  const whereOf = (problem: PluginSetProblem) => plan.plugins.find((p) => p.manifest.name === problem.plugin)?.where ?? `plugins (${problem.plugin})`;
  const failed = applied.problems.map((p): PluginProblem => ({ plugin: p.plugin, where: whereOf(p), message: p.message }));
  const problems = [...plan.problems, ...failed];
  projectPlugins.value = { found: plan.found, usable: plan.plugins, problems };
  return { ...result, problems: [...result.problems, ...problems.map(asScriptProblem)] };
}

/** The project closed: deactivate every third-party half (the first-party ones go back to all enabled). */
export function unloadThirdPartyPlugins(): void {
  applyEditorPlugins(undefined, { thirdParty: [] });
  void clearProjectAudioEffects();
  clearProjectAnimationNodes();
  projectPlugins.value = EMPTY;
}
