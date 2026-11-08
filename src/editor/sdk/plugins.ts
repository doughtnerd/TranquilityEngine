// Plugins (ADR 0133): a manifest plus halves that register contributions. The editor half's
// `activate` registers through the context, which remembers every registration so deactivating the
// plugin removes them all.
import { assetFormats, assetKinds, panels, type AssetFormatContribution, type AssetKindContribution, type PanelContribution } from "./contributions";

export interface PluginManifest {
  /** Unique, e.g. "myco.sky". */
  readonly name: string;
  readonly version: string;
  /** Plugin names this one needs, with version ranges (first-party plugins: the engine's version). */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** False for a runtime half the dedicated server skips (drawing only). Default true. */
  readonly server?: boolean;
}

export interface EditorPluginContext {
  registerAssetKind(kind: AssetKindContribution): void;
  registerAssetFormat<T>(format: AssetFormatContribution<T>): void;
  registerPanel(panel: PanelContribution): void;
}

/** A plugin's editor half. */
export interface EditorPlugin {
  readonly manifest: PluginManifest;
  activate(context: EditorPluginContext): void;
}

const active = new Map<string, Array<() => void>>();

/** Plugins in dependency order (dependencies first). Throws on a missing dependency or a cycle. */
export function orderPlugins<P extends { manifest: PluginManifest }>(plugins: readonly P[]): P[] {
  const byName = new Map(plugins.map((p) => [p.manifest.name, p]));
  const out: P[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: P, chain: string[]) => {
    const name = p.manifest.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`Plugin dependency cycle: ${[...chain, name].join(" → ")}.`);
    state.set(name, "visiting");
    for (const dep of Object.keys(p.manifest.dependencies ?? {})) {
      const d = byName.get(dep);
      if (!d) throw new Error(`Plugin ${name} needs ${dep}, which isn't available.`);
      visit(d, [...chain, name]);
    }
    state.set(name, "done");
    out.push(p);
  };
  for (const p of plugins) visit(p, []);
  return out;
}

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
