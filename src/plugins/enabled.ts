// Per-project plugin enabling (ADR 0133): `project.json`'s `plugins.disabled` lists only what's off, so
// new first-party plugins default on and old projects need no change. Pure helpers, shared by the
// player, the server, the editor and the Project settings' Plugins category.
import type { PluginManifest } from "./manifest";

type Named = Pick<PluginManifest, "name" | "dependencies">;

const depsOf = (m: Named) => Object.keys(m.dependencies ?? {});

/**
 * Plugins that were renamed or merged, old name → new (ADR 0137: the 2D and 3D physics plugins became
 * `myco.physics`). A `plugins.disabled` entry naming an old plugin turns off the new one.
 */
export const RENAMED_PLUGINS: Readonly<Record<string, string>> = {
  "myco.physics2d": "myco.physics",
  "myco.physics3d": "myco.physics",
};

/** `disabled` with old plugin names replaced by their new ones (each once, in order). */
export function migrateDisabledPlugins(disabled: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of disabled) {
    const now = RENAMED_PLUGINS[name] ?? name;
    if (!out.includes(now)) out.push(now);
  }
  return out;
}

/**
 * The names of the enabled plugins: every one that isn't listed in `disabled` and doesn't depend
 * (directly or not) on a plugin that is off. Unknown names in `disabled` are ignored.
 */
export function resolveEnabledPlugins(manifests: readonly Named[], disabled: Iterable<string> = []): Set<string> {
  const off = new Set(migrateDisabledPlugins(disabled));
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const state = new Map<string, boolean>();
  const isOn = (name: string, chain: readonly string[]): boolean => {
    const known = state.get(name);
    if (known !== undefined) return known;
    const m = byName.get(name);
    // A missing dependency can't be satisfied; a cycle is treated as on for the cycle's members (orderPlugins reports it).
    if (!m) return false;
    if (off.has(name)) return remember(name, false);
    if (chain.includes(name)) return true;
    return remember(name, depsOf(m).every((d) => isOn(d, [...chain, name])));
  };
  const remember = (name: string, on: boolean) => (state.set(name, on), on);
  return new Set(manifests.map((m) => m.name).filter((n) => isOn(n, [])));
}

/** Plugins that need `name`, directly or through others (what turning it off turns off). */
export function pluginDependents(manifests: readonly Named[], name: string): string[] {
  const out = new Set<string>();
  const visit = (target: string) => {
    for (const m of manifests) if (!out.has(m.name) && depsOf(m).includes(target)) (out.add(m.name), visit(m.name));
  };
  visit(name);
  return manifests.map((m) => m.name).filter((n) => out.has(n));
}

/** Plugins `name` needs, directly or through others (what turning it on turns on). */
export function pluginDependencies(manifests: readonly Named[], name: string): string[] {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const out = new Set<string>();
  const visit = (n: string) => {
    for (const d of depsOf(byName.get(n) ?? { name: n })) if (byName.has(d) && !out.has(d)) (out.add(d), visit(d));
  };
  visit(name);
  return manifests.map((m) => m.name).filter((n) => out.has(n));
}

/** Names in `disabled` that no plugin has (a plugin that was removed, or a typo). Old names of renamed plugins count as known. */
export function unknownPlugins(manifests: readonly Named[], disabled: readonly string[] = []): string[] {
  const known = new Set(manifests.map((m) => m.name));
  return disabled.filter((n) => !known.has(RENAMED_PLUGINS[n] ?? n));
}

/**
 * The `disabled` list after turning `name` on or off. Off lists the plugin and everything that needs
 * it; on removes the plugin and everything it needs. Other entries (unknown names included) are kept.
 * `affected` is what changed besides `name`. Old names of renamed plugins are replaced by the new ones.
 */
export function setPluginEnabled(manifests: readonly Named[], disabledBefore: readonly string[], name: string, on: boolean): { disabled: string[]; affected: string[] } {
  const disabled = migrateDisabledPlugins(disabledBefore);
  if (on) {
    const turnOn = new Set([name, ...pluginDependencies(manifests, name)]);
    const affected = [...turnOn].filter((n) => n !== name && disabled.includes(n));
    return { disabled: disabled.filter((n) => !turnOn.has(n)), affected };
  }
  const turnOff = [name, ...pluginDependents(manifests, name)];
  const affected = turnOff.filter((n) => n !== name && !disabled.includes(n));
  return { disabled: [...disabled, ...turnOff.filter((n) => !disabled.includes(n))], affected };
}
