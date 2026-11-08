// Plugin dependency order (ADR 0134, 0135), shared by the editor's and the runtime's activation, so
// it lives outside both halves.
import type { PluginManifest } from "./manifest";

/**
 * Plugins in dependency order (dependencies first). Throws on a missing dependency or a cycle. A
 * dependency named in `provided` (already active, outside the list: a first-party plugin a third-party
 * half needs, ADR 0139) counts as present.
 */
export function orderPlugins<P extends { manifest: PluginManifest }>(plugins: readonly P[], provided: ReadonlySet<string> = new Set()): P[] {
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
      if (!d && provided.has(dep)) continue;
      if (!d) throw new Error(`Plugin ${name} needs ${dep}, which isn't available.`);
      visit(d, [...chain, name]);
    }
    state.set(name, "done");
    out.push(p);
  };
  for (const p of plugins) visit(p, []);
  return out;
}
