/**
 * Internal (ADR 0338 §8): what happens when a project's plugin with an `audio` section is enabled (or reloaded, or
 * turned off). One call per plugin: its effect specs join the catalogue (`registerPluginEffects`, so cards, menus,
 * parses and the runtime view know them), and each of its modules is read, validated and instrumented once per content
 * (`validate.ts`, cached in memory by hash) and registered with the active backend's `effectPlugins` capability. A
 * backend without the capability (the Babylon fallback) runs none: each effect type passes audio through with one
 * warning. A plugin turned off keeps its specs (state "off": its effects are kept in files and pass through) and leaves
 * the backend.
 *
 * The caller is whatever plans the plugin set (the editor and the Studio when it changes, the player before
 * `Engine.create`; `projectSet.ts` for a whole set); it supplies `read`, which returns a module file's bytes by its path
 * inside the plugin. Enabled plugins are remembered: every backend installed later (the core replacing the pending
 * stand-in, a backend switch) gets their modules too.
 *
 * The same validated modules go to offline sample renders (`offline.ts`, keyed by each module file's hash). Every
 * module load passes the engine gate first (`engineGate.ts`, 0344 §6): off a Chromium-based engine, unless the project
 * says otherwise, no module runs (live or offline) and one warning says why; the effects stay known and pass through.
 */
import { registerPluginEffects, unregisterPluginEffects } from "../../../../engine/audio/effects/catalogue";
import type { PluginAudio } from "../../../../engine/audio/effects/types";
import { audioBackend, hasAudioBackend, isPendingCoreBackend, onAudioBackendAttached, type AudioBackend, type EffectPluginLoad, type EffectPluginModule } from "../backend";
import { warnOnce } from "../core/handle";
import { effectPluginGate, scriptEngineOf, type EffectPluginEngines } from "./engineGate";
import { dropOfflineModules, setOfflineModules, type OfflineModule } from "./offline";
import { validateEffectModule, type EffectModuleValidation } from "./validate";

/** One plugin with an `audio` section, as the plugin set plans it. */
export interface EffectPluginPackage {
  readonly plugin: string;
  readonly title?: string;
  readonly version: string;
  /** False when Project Settings > Plugins has it off. */
  readonly enabled: boolean;
  /** The manifest's parsed `audio` section (`parsePluginAudio`). */
  readonly audio: PluginAudio;
  /** A module file's bytes by its path inside the plugin (`audio.modules[].wasm`); null when it is missing. */
  read(path: string): Promise<Uint8Array | null>;
  /** `project.json` `plugins.audioEffectEngines` (0344 §6): "all" runs the modules on any engine; default Chromium's only. */
  readonly engines?: EffectPluginEngines;
}

/** What one call did: problems (each one line, already warned once) and each module's load. */
export interface EffectPluginLoadReport {
  readonly problems: readonly string[];
  readonly modules: readonly { readonly module: string; readonly load: EffectPluginLoad | null }[];
}

/** One module read and validated: its instrumented bytes, file hash and effects, or null when it is missing or refused. */
interface Prepared {
  readonly module: string;
  readonly ready: { readonly bytes: Uint8Array; readonly hash: string; readonly effects: EffectPluginModule["effects"] } | null;
}

/** The enabled plugins, by name, with their prepared modules: each backend installed later registers them. */
const enabled = new Map<string, { readonly pkg: EffectPluginPackage; readonly prepared: readonly Prepared[] }>();
let hooked = false;

/** The installed backend, unless it is the pending stand-in (whose replacement registers through the attach hook). */
function installed(): AudioBackend | null {
  if (!hasAudioBackend()) return null;
  const b = audioBackend();
  return isPendingCoreBackend(b) ? null : b;
}

/** Validations by content (hex digest), so a module is checked and instrumented once however often it is loaded. */
const validated = new Map<string, Promise<EffectModuleValidation>>();

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `${bytes.length}:${bytes.reduce((h, b) => (Math.imul(h, 31) + b) >>> 0, 7)}`;
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Say = (key: string, line: string) => void;

/**
 * Registers `pkg`'s effects with the catalogue and its modules with `backend` (default: the installed one, and every one
 * installed after it) and with offline renders. Never throws; every problem is warned once and returned.
 */
export async function loadEffectPlugin(pkg: EffectPluginPackage, backend?: AudioBackend | null): Promise<EffectPluginLoadReport> {
  const problems: string[] = [];
  const say: Say = (key, line) => {
    problems.push(line);
    warnOnce(key, line);
  };
  for (const line of registerPluginEffects({ plugin: pkg.plugin, version: pkg.version, enabled: pkg.enabled, effects: pkg.audio.effects, ...(pkg.title !== undefined && { title: pkg.title }) })) say(`plugin-register:${line}`, `audio: ${line}`);
  const gate = effectPluginGate(scriptEngineOf(), pkg.engines);
  if (pkg.enabled && !gate.open) say("plugin-engine-gate", gate.warning);
  const runs = pkg.enabled && gate.open;
  const prepared = runs ? await prepare(pkg, say) : [];
  if (runs) setOfflineModules(pkg.plugin, prepared.flatMap((p): OfflineModule[] => (p.ready ? [{ plugin: pkg.plugin, version: pkg.version, module: p.module, ...p.ready }] : [])));
  else dropOfflineModules(pkg.plugin);
  if (backend === undefined) {
    if (!hooked) {
      hooked = true;
      onAudioBackendAttached((b) => {
        for (const p of enabled.values()) void registerModules(p.pkg, p.prepared, b, []);
      });
    }
    if (runs) enabled.set(pkg.plugin, { pkg, prepared });
    else enabled.delete(pkg.plugin);
    backend = installed();
    if (!backend && runs) return { problems, modules: [] };
  }
  if (pkg.enabled && !gate.open) {
    backend?.effectPlugins?.unregister(pkg.plugin);
    return { problems, modules: [] };
  }
  return registerModules(pkg, prepared, backend, problems);
}

/** Reads and validates (once per content) each of `pkg`'s modules that holds an effect. */
async function prepare(pkg: EffectPluginPackage, say: Say): Promise<Prepared[]> {
  const out: Prepared[] = [];
  for (const m of pkg.audio.modules) {
    const effects = pkg.audio.effects.filter((e) => e.module === m.id);
    if (effects.length === 0) continue;
    const bytes = await pkg.read(m.wasm).catch(() => null);
    if (!bytes) {
      say(`plugin-missing:${pkg.plugin}:${m.wasm}`, `audio: the plugin ${pkg.plugin}'s module ${m.id} (${m.wasm}) is missing; its effects pass audio through.`);
      out.push({ module: m.id, ready: null });
      continue;
    }
    const hash = await digest(bytes);
    const key = `${hash}:${m.memoryMB}`;
    let check = validated.get(key);
    if (!check) {
      check = validateEffectModule(bytes, { memoryMB: m.memoryMB });
      validated.set(key, check);
    }
    const result = await check;
    if (!result.ok) {
      say(`plugin-invalid:${pkg.plugin}:${m.id}`, `audio: the plugin ${pkg.plugin}'s module ${m.id} was refused (${result.problems.join("; ")}); its effects pass audio through.`);
      out.push({ module: m.id, ready: null });
      continue;
    }
    out.push({ module: m.id, ready: { bytes: result.bytes, hash, effects } });
  }
  return out;
}

/** `pkg`'s prepared modules on `backend` (its specs are in the catalogue already). */
async function registerModules(pkg: EffectPluginPackage, prepared: readonly Prepared[], backend: AudioBackend | null, problems: string[]): Promise<EffectPluginLoadReport> {
  const say: Say = (key, line) => {
    problems.push(line);
    warnOnce(key, line);
  };
  const plugins = backend?.effectPlugins;
  if (!pkg.enabled) {
    plugins?.unregister(pkg.plugin);
    return { problems, modules: [] };
  }
  if (!plugins) {
    for (const e of pkg.audio.effects) say(`plugin-backend:${backend?.name ?? "none"}:${e.spec.type}`, `audio: the plugin effect ${e.spec.type} (${pkg.plugin}) needs the audio core; on the ${backend?.name ?? "current"} audio backend it passes audio through (ADR 0338).`);
    return { problems, modules: [] };
  }
  const modules: { module: string; load: EffectPluginLoad | null }[] = [];
  for (const p of prepared) {
    if (!p.ready) {
      modules.push({ module: p.module, load: null });
      continue;
    }
    const load = await plugins.register({ plugin: pkg.plugin, version: pkg.version, module: p.module, bytes: p.ready.bytes, effects: p.ready.effects });
    if (!load.ok) problems.push(`audio: the plugin ${pkg.plugin}'s module ${p.module} didn't load (${load.error}).`);
    modules.push({ module: p.module, load });
  }
  return { problems, modules };
}

/** Removes `plugin`'s effects from the catalogue, the backend and offline renders (it was uninstalled): files keep them; they pass through. */
export function unloadEffectPlugin(plugin: string, backend: AudioBackend | null = installed()): void {
  enabled.delete(plugin);
  unregisterPluginEffects(plugin);
  dropOfflineModules(plugin);
  backend?.effectPlugins?.unregister(plugin);
}
