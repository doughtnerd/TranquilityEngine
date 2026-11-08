// Plugins (ADR 0133): a manifest plus halves that register contributions. The editor half's
// `activate` registers through the context, which remembers every registration so deactivating the
// plugin removes them all.
import type { PluginManifest } from "../../plugins/manifest";
import { orderPlugins } from "../../plugins/order";
import { assetFormats, assetKinds, panels, viewportTools, type AssetFormatContribution, type AssetKindContribution, type PanelContribution, type ViewportToolContribution } from "./contributions";
import { registerInspectorSection, type InspectorSectionOptions, type InspectorSectionProps } from "../ui/inspectorSections";
import type { LoadComponent } from "./contributions";


export interface EditorPluginContext {
  registerAssetKind(kind: AssetKindContribution): void;
  registerAssetFormat<T>(format: AssetFormatContribution<T>): void;
  registerPanel(panel: PanelContribution): void;
  /** Extra UI under a Component type's fields in the Inspector (ADR 0131), loaded on first use. */
  registerInspectorSection(type: string, view: LoadComponent<InspectorSectionProps>, options?: InspectorSectionOptions): void;
  /** A scene-view tool (ADR 0137), installed on every scene view while the plugin is active. */
  registerViewportTool(tool: ViewportToolContribution): void;
}

/** A plugin's editor half. */
export interface EditorPlugin {
  readonly manifest: PluginManifest;
  activate(context: EditorPluginContext): void;
}

const active = new Map<string, Array<() => void>>();

/** Activate editor halves in dependency order; already-active plugins are skipped. */
export function activatePlugins(plugins: readonly EditorPlugin[]): void {
  for (const plugin of orderPlugins(plugins)) {
    const name = plugin.manifest.name;
    if (active.has(name)) continue;
    const undo: Array<() => void> = [];
    active.set(name, undo);
    const context: EditorPluginContext = {
      registerAssetKind: (k) => void undo.push(assetKinds.register(k)),
      registerAssetFormat: (f) => void undo.push(assetFormats.register(f)),
      registerPanel: (p) => void undo.push(panels.register(p)),
      registerInspectorSection: (type, view, options) => void undo.push(registerInspectorSection(type, view, options)),
      registerViewportTool: (t) => void undo.push(viewportTools.register(t)),
    };
    try {
      plugin.activate(context);
    } catch (err) {
      deactivatePlugin(name);
      throw err;
    }
  }
}

/** Remove everything a plugin registered. */
export function deactivatePlugin(name: string): void {
  const undo = active.get(name);
  if (!undo) return;
  active.delete(name);
  for (const u of undo.reverse()) u();
}

export const isPluginActive = (name: string): boolean => active.has(name);

export type { PluginManifest };
export { orderPlugins };
