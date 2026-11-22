/**
 * Internal (ADR 0338 §7): plugin effects in offline sample renders. The enabled plugins' modules, validated and
 * instrumented once (`load.ts`), are kept here with their content hash; this is the engine's offline host
 * (`engine/audio/sample/offlinePlugins.ts`), installed the first time a plugin loads. Each render opens a session: a
 * fresh `EffectGlue` (the worklet's own glue, so the calls, the copies, the fuel, the output scan and the fault rules
 * are the live ones) at the render's rate, with the modules holding the render's plugin types loaded and warmed up.
 * Runs wherever the render does (the page, Node; a worker only if it loads plugins itself).
 */
import type { PluginEffectDecl } from "../../../../engine/audio/effects/types";
import { setOfflineEffectHost, type OfflineEffectHost, type OfflineEffectIdentity, type OfflinePluginSession } from "../../../../engine/audio/sample/offlinePlugins";
import { EffectGlue, type FxEffectEntry, type FxShellEvent } from "../worklet/effectGlue";
import { glideModes } from "./host";
import { validateEffectModule } from "./validate";

/** One module offline renders can run. */
export interface OfflineModule {
  readonly plugin: string;
  readonly version: string;
  readonly module: string;
  /** The module file's SHA-256 (hex): the render cache key's. */
  readonly hash: string;
  /** Validated and instrumented. */
  readonly bytes: Uint8Array;
  readonly effects: readonly PluginEffectDecl[];
}

/** Instances per effect a session creates: one per channel pair per use; renders are rarely wider than this. */
const SESSION_INSTANCES = 8;

class OfflineModules implements OfflineEffectHost {
  /** By `plugin:module`. */
  private readonly modules = new Map<string, OfflineModule>();

  set(plugin: string, modules: readonly OfflineModule[]): void {
    this.drop(plugin);
    for (const m of modules) this.modules.set(`${m.plugin}:${m.module}`, m);
  }

  drop(plugin: string): void {
    for (const [key, m] of this.modules) if (m.plugin === plugin) this.modules.delete(key);
  }

  private holder(type: string): { module: OfflineModule; decl: PluginEffectDecl } | null {
    for (const module of this.modules.values()) {
      const decl = module.effects.find((d) => d.spec.type === type);
      if (decl) return { module, decl };
    }
    return null;
  }

  identity(type: string): OfflineEffectIdentity | null {
    const at = this.holder(type);
    return at ? { plugin: at.module.plugin, version: at.module.version, hash: at.module.hash } : null;
  }

  async open(types: readonly string[], rate: number): Promise<OfflinePluginSession> {
    const glue = new EffectGlue(rate);
    const problems: string[] = [];
    const indices = new Map<string, number>();
    const loads = new Map<OfflineModule, FxEffectEntry[]>();
    for (const type of types) {
      const at = this.holder(type);
      if (!at) continue;
      const e = indices.size;
      indices.set(type, e);
      const entries = loads.get(at.module) ?? [];
      entries.push({ e, type, kind: at.decl.kind, budget: at.decl.instructionsPerFrame, maxInstances: Math.min(at.decl.maxInstances, SESSION_INSTANCES), modes: glideModes(at.decl) });
      loads.set(at.module, entries);
    }
    const loaded = new Map<number, Extract<FxShellEvent, { type: "fxLoaded" }>>();
    glue.setPost((event) => {
      if (event.type === "fxLoaded") loaded.set(event.id, event);
    });
    let id = 0;
    for (const [module, effects] of loads) {
      const at = ++id;
      await glue.onControl({ type: "fxLoad", id: at, plugin: module.plugin, bytes: Uint8Array.from(module.bytes).buffer, effects });
      const result = loaded.get(at);
      if (!result || !result.ok) {
        problems.push(`The plugin ${module.plugin}'s module ${module.module} didn't load for the render (${result && !result.ok ? result.error : "no answer"}); its effects passed through.`);
        for (const entry of effects) indices.delete(entry.type);
      }
    }
    return {
      imports: glue.imports,
      attach: (memory) => {
        glue.attach(memory);
        glue.beginQuantum(0);
      },
      indexOf: (type) => indices.get(type) ?? -1,
      problems,
    };
  }
}

/** A module file as a build ships it (`game.json`'s `audioEffects` entry and its bytes), for `offlineHostOf`. */
export interface OfflineModuleFile {
  readonly plugin: string;
  readonly version: string;
  readonly module: string;
  readonly memoryMB: number;
  readonly effects: readonly PluginEffectDecl[];
  /** The module file's bytes, as written (validated and instrumented here). */
  readonly bytes: Uint8Array;
}

/**
 * A host of its own over `files` (the export's renders: the build's modules, whatever the page has loaded), each
 * validated and instrumented as `load.ts` does. Modules that are refused are left out, with a line in `problems`.
 */
export async function offlineHostOf(files: readonly OfflineModuleFile[]): Promise<{ host: OfflineEffectHost; problems: string[] }> {
  const host = new OfflineModules();
  const problems: string[] = [];
  const byPlugin = new Map<string, OfflineModule[]>();
  for (const f of files) {
    const result = await validateEffectModule(f.bytes, { memoryMB: f.memoryMB });
    if (!result.ok) {
      problems.push(`The plugin ${f.plugin}'s module ${f.module} was refused (${result.problems.join("; ")}); its effects pass audio through in renders.`);
      continue;
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", f.bytes as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, "0")).join("");
    const list = byPlugin.get(f.plugin) ?? [];
    list.push({ plugin: f.plugin, version: f.version, module: f.module, hash, bytes: result.bytes, effects: f.effects });
    byPlugin.set(f.plugin, list);
  }
  for (const [plugin, list] of byPlugin) host.set(plugin, list);
  return { host, problems };
}

let modules: OfflineModules | null = null;

/** Sets the modules offline renders run for `plugin` (replacing what it had), installing the host on first use. */
export function setOfflineModules(plugin: string, list: readonly OfflineModule[]): void {
  if (!modules) {
    modules = new OfflineModules();
    setOfflineEffectHost(modules);
  }
  modules.set(plugin, list);
}

/** `plugin`'s modules leave offline renders (it was turned off, uninstalled or reloaded without them). */
export function dropOfflineModules(plugin: string): void {
  modules?.drop(plugin);
}
