/**
 * Internal (ADR 0352 §7): plugin effects in offline sample renders. The render (`sampleRender.ts`) runs the chain in
 * `myco_audio_offline.wasm`, which calls plugin effects through its `myco_ext` import, the same five calls the core's
 * chains make. What answers them is a host the audio plugin installs (`effectPlugins/offline.ts`: the worklet's glue,
 * `effectGlue.ts`, over the validated and instrumented modules of the enabled plugins), so a plugin effect renders
 * offline exactly as it plays live, in Node and in the browser. The engine never imports the plugin: it only defines what
 * it needs and keeps the host the plugin set.
 *
 * Without a host (a page or worker where no plugin was loaded) a plugin effect passes through, with a warning that keeps
 * such a render out of the render cache (`renderCache.ts`), since its key names the plugin.
 */
import type { EffectParamSpec } from "../effects/types";

/** The `myco_ext` import's calls (`audio-core`'s `ext.rs`): pointers into the render's memory. */
export interface MycoExtCalls {
  acquire(e: number): number;
  release(handle: number): void;
  describe(e: number, what: number): number;
  process(handle: number, l: number, r: number, frames: number, p0: number, p1: number, flags: number, fuel: number): number;
  sweep(handles: number, n: number, last: number): void;
}

/** What a render's cache key holds of a plugin effect type: its plugin, version and module's content hash. */
export interface OfflineEffectIdentity {
  readonly plugin: string;
  readonly version: string;
  /** The module file's SHA-256, hex. */
  readonly hash: string;
}

/** The plugin effects of one render, loaded (`OfflineEffectHost.open`). */
export interface OfflinePluginSession {
  /** The import's calls for the render. */
  readonly imports: MycoExtCalls;
  /** The render module's memory, before the render (the glue reads and writes the blocks there). */
  attach(memory: WebAssembly.Memory): void;
  /** The effect index `e` a type runs as in this session (the spec writes `PLUGIN_BASE + e`), or -1 when it didn't load. */
  indexOf(type: string): number;
  /**
   * The parameters of a type the session runs, in its plugin's declared order (the spec's slots), or null. The render
   * reads them from here, not the catalogue, which may not know the plugin where it runs (a build's renders).
   */
  paramsOf(type: string): readonly EffectParamSpec[] | null;
  /** Lines for the render's warnings: modules that didn't load, faults while it ran. */
  readonly problems: readonly string[];
}

/** The audio plugin's side: which plugin effects it can run offline, and a session for one render. */
export interface OfflineEffectHost {
  /** The identity of `type`, or null when no enabled plugin's module holds it. */
  identity(type: string): OfflineEffectIdentity | null;
  /** Loads the modules holding `types` for a render at `rate` (types it doesn't hold are left out: `indexOf` -1). */
  open(types: readonly string[], rate: number): Promise<OfflinePluginSession>;
}

let host: OfflineEffectHost | null = null;

/** Installs (or with null removes) the host plugin effects render through. The audio plugin calls it. */
export function setOfflineEffectHost(next: OfflineEffectHost | null): void {
  host = next;
}

/** The installed host, or null. */
export const offlineEffectHost = (): OfflineEffectHost | null => host;

/** The spec's type value of plugin effect `e` (the core's `PLUGIN_BASE + e`, `audio_dsp::fx::kind::PLUGIN_BASE`). */
export const OFFLINE_PLUGIN_BASE = 0x100;
