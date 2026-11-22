/**
 * Internal (ADR 0338 §8): a project's whole set of plugin effects, applied at once. The hosts that plan a project's
 * plugins (the editor on every load and script reload, the Studio when it opens a project and when a plugin's files
 * change, the player from `game.json`) hand the usable plugins with an `audio` section here; each goes through
 * `loadEffectPlugin` (catalogue, validation, the backend's `effectPlugins` capability, offline renders), a plugin that
 * left the set is unloaded, and one whose manifest, enabled state and module bytes are all unchanged is left alone, so a
 * script reload doesn't re-create its instances. A changed module file (a rebuilt `.wasm`) re-registers: the worklet
 * swaps the module and its instances are re-created.
 */
import type { PluginAudio } from "../../../../engine/audio/effects/types";
import { pluginModulePath, type FoundPlugin } from "../../../thirdParty";
import type { EffectPluginEngines } from "./engineGate";
import { loadEffectPlugin, unloadEffectPlugin, type EffectPluginPackage } from "./load";

/** What was applied per plugin: a signature of what it was loaded from. */
const applied = new Map<string, string>();

const fingerprint = (bytes: Uint8Array | null): string => {
  if (!bytes) return "-";
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
};

/**
 * Applies `set` (every usable plugin with an `audio` section, enabled or not): loads what is new or changed, unloads
 * what left. Resolves to the problems, each one line (already warned once). Never throws.
 */
export async function applyEffectPluginSet(set: readonly EffectPluginPackage[]): Promise<string[]> {
  const problems: string[] = [];
  const names = new Set(set.map((p) => p.plugin));
  for (const name of [...applied.keys()]) {
    if (names.has(name)) continue;
    applied.delete(name);
    unloadEffectPlugin(name);
  }
  for (const pkg of set) {
    // Read each module once: its bytes are part of the signature, and the load reads them again from this copy.
    const bytes = new Map<string, Uint8Array | null>();
    for (const m of pkg.audio.modules) bytes.set(m.wasm, await pkg.read(m.wasm).catch(() => null));
    const signature = JSON.stringify([pkg.version, pkg.title ?? null, pkg.enabled, pkg.engines ?? "chromium", pkg.audio, [...bytes].map(([path, b]) => [path, fingerprint(b)])]);
    if (applied.get(pkg.plugin) === signature) continue;
    applied.set(pkg.plugin, signature);
    const report = await loadEffectPlugin({ ...pkg, read: async (path) => (bytes.has(path) ? bytes.get(path)! : pkg.read(path)) });
    problems.push(...report.problems);
  }
  return problems;
}

/** Reads a project file's bytes by its project-relative path; null when it isn't there. */
export type ReadProjectBytes = (path: string) => Promise<Uint8Array | null>;

/**
 * The set to apply from a plan of the project's plugins (`planPluginCode`'s `plugins` and `enabled`): each usable plugin
 * with an `audio` section, its module files read through `read`.
 */
export function effectPluginSetOf(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>, read: ReadProjectBytes, engines?: EffectPluginEngines): EffectPluginPackage[] {
  const out: EffectPluginPackage[] = [];
  for (const p of plugins) {
    const audio: PluginAudio | undefined = p.manifest.audio;
    if (!audio || audio.effects.length === 0) continue;
    out.push({
      plugin: p.manifest.name,
      version: p.manifest.version,
      ...(p.manifest.title !== undefined && { title: p.manifest.title }),
      enabled: enabled.has(p.manifest.name),
      audio,
      read: (wasm) => read(pluginModulePath(p, wasm)),
      ...(engines !== undefined && { engines }),
    });
  }
  return out;
}
