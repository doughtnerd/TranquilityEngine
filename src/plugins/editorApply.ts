// Applies a project's plugin settings (ADR 0133) to the editor: the enabled plugins' editor and runtime
// halves are active, the others are deactivated (their Components unregister, so scenes show them as
// missing; their asset kinds, formats and panels go, so their files show as generic). Called at boot
// with nothing disabled, when a project opens, and when its `plugins` setting changes. Editor code only.
import { errorStatus } from "../editor/messages";
import { parseLayout } from "../editor/layout/model";
import { layout, reloadLayout } from "../editor/layout/store";
import { activatePlugins, deactivatePlugin, isPluginActive, type EditorPlugin } from "../editor/sdk/plugins";
import { status } from "../editor/state";
import { EDITOR_PLUGINS } from "./editor";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { orderPlugins } from "./order";
import { RUNTIME_PLUGINS, syncRuntimePlugins } from "./runtime";

/** Every first-party plugin's manifest, once (a plugin with both halves shares one). */
export function pluginManifests(): PluginManifest[] {
  const byName = new Map<string, PluginManifest>();
  for (const p of [...RUNTIME_PLUGINS, ...EDITOR_PLUGINS]) if (!byName.has(p.manifest.name)) byName.set(p.manifest.name, p.manifest);
  return [...byName.values()];
}

const report = (name: string, err: unknown) => {
  console.error(`Plugin ${name} failed to activate`, err);
  status.value = errorStatus(`Plugin ${name} failed to activate`, err);
};

/**
 * Make the enabled plugins' halves (per `disabled`, `project.json`'s `plugins.disabled`) the active
 * ones. A plugin that throws is rolled back and left out; the rest still start. With `live`, the open
 * layout is checked against the panels now registered instead of read again from the startup layout.
 */
export function applyEnabledPlugins(disabled: Iterable<string> | undefined, options: { live?: boolean } = {}): void {
  const enabled = resolveEnabledPlugins(pluginManifests(), disabled);

  // The runtime halves first (ADR 0135): the editor's own World draws with them (the sky), and Play uses them.
  try {
    syncRuntimePlugins(RUNTIME_PLUGINS, enabled);
  } catch (err) {
    report("(runtime)", err);
  }

  for (const plugin of orderPlugins(EDITOR_PLUGINS).reverse()) if (!enabled.has(plugin.manifest.name)) deactivatePlugin(plugin.manifest.name);
  // All together, so dependencies order correctly. A failing plugin is rolled back and left out, then
  // the rest are tried again (already-active plugins are skipped).
  let remaining: readonly EditorPlugin[] = EDITOR_PLUGINS.filter((p) => enabled.has(p.manifest.name));
  while (remaining.length > 0) {
    try {
      activatePlugins(remaining);
      break;
    } catch (err) {
      const failed = remaining.find((p) => !isPluginActive(p.manifest.name));
      if (!failed) {
        report("(unknown)", err);
        break;
      }
      report(failed.manifest.name, err);
      remaining = remaining.filter((p) => p !== failed);
    }
  }

  if (!options.live) return reloadLayout();
  try {
    layout.value = parseLayout(JSON.parse(JSON.stringify(layout.value))) ?? layout.value;
  } catch {
    reloadLayout();
  }
}
