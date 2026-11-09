// The editor's plugin set (ADR 0144): one set for the whole editor, driving both halves (the runtime
// activator and the editor activator, this host's two adapters). The editor applies it at boot with the
// first-party plugins and nothing disabled, when a project opens (first-party before its code loads,
// then first- and third-party once it has), when the project's `plugins` setting changes, on every
// script reload, before Play, and when the project closes (third-party plugins go). Applying again is
// cheap: unchanged halves stay. Editor code only.
import { errorStatus } from "../editor/messages";
import { parseLayout } from "../editor/layout/model";
import { layout, reloadLayout } from "../editor/layout/store";
import type { EditorPlugin } from "../editor/sdk/plugins";
import { status } from "../editor/state";
import { EDITOR_PLUGINS } from "./editor";
import { editorActivator } from "./editorActivator";
import type { PluginManifest } from "./manifest";
import { createPluginSet, type ApplyResult, type PluginSetProblem, type SetPlugin } from "./pluginSet";
import { RUNTIME_PLUGINS } from "./runtime";
import { runtimeActivator, type RuntimePlugin } from "./runtimeContext";

/** A plugin as the editor's set takes it. */
export type EditorSetPlugin = SetPlugin<RuntimePlugin, EditorPlugin>;

const editorPlugins = createPluginSet<RuntimePlugin, EditorPlugin>({ runtime: runtimeActivator, editor: editorActivator });

/**
 * The first-party plugins: runtime halves in `RUNTIME_PLUGINS`' order (render features and systems
 * break ties by it), editor halves in `EDITOR_PLUGINS`' order (panels, settings sections).
 */
export const firstPartyPlugins = (): EditorSetPlugin[] => [...RUNTIME_PLUGINS.map((p) => ({ manifest: p.manifest, runtime: p })), ...EDITOR_PLUGINS.map((p) => ({ manifest: p.manifest, editor: p }))];

/** Every first-party plugin's manifest, once (a plugin with both halves shares one). */
export function pluginManifests(): PluginManifest[] {
  const byName = new Map<string, PluginManifest>();
  for (const p of [...RUNTIME_PLUGINS, ...EDITOR_PLUGINS]) if (!byName.has(p.manifest.name)) byName.set(p.manifest.name, p.manifest);
  return [...byName.values()];
}

/** The open project's loaded third-party plugins (`thirdPartyEditor.ts` hands them over), kept for re-applying. */
let thirdParty: readonly EditorSetPlugin[] = [];

export interface EditorApplyOptions {
  /** The open project's third-party plugins, replacing the ones kept from the last apply (`[]` when it closes). */
  readonly thirdParty?: readonly EditorSetPlugin[];
  /** Leave runtime halves as they are (during Play: the game keeps its plugins until Stop). */
  readonly keepRuntime?: boolean;
  /** Read the layout again ("reload": from the startup layout) or check the open one ("live") against the panels now registered. */
  readonly layout?: "reload" | "live";
}

/**
 * Make the enabled plugins' halves (per `disabled`, `project.json`'s `plugins.disabled`) the active
 * ones: the first-party plugins and the open project's third-party ones. A plugin that fails is rolled
 * back and the rest still start; the result lists the problems for the caller to show.
 */
export function applyEditorPlugins(disabled: Iterable<string> | undefined, options: EditorApplyOptions = {}): ApplyResult {
  if (options.thirdParty) thirdParty = options.thirdParty;
  const result = editorPlugins.apply({ plugins: [...firstPartyPlugins(), ...thirdParty], disabled, host: { editor: true }, keepRuntime: options.keepRuntime });
  for (const p of result.problems) console.error(`[editor] ${p.message}`);
  if (options.layout === "reload") reloadLayout();
  else if (options.layout === "live") {
    try {
      layout.value = parseLayout(JSON.parse(JSON.stringify(layout.value))) ?? layout.value;
    } catch {
      reloadLayout();
    }
  }
  return result;
}

/** Show plugin problems in the status bar (when no script load reports them with the script problems). */
export function reportPluginProblems(problems: readonly PluginSetProblem[]): void {
  if (problems.length === 0) return;
  const text = problems.map((p) => p.message).join("; ");
  status.value = errorStatus(problems.length === 1 ? "A plugin failed to activate" : `${problems.length} plugins failed to activate`, new Error(text));
}

/** Whether the editor's set has the plugin's `half` (default: either) active. */
export const isEditorPluginActive = (name: string, half?: "runtime" | "editor"): boolean => editorPlugins.isActive(name, half);
