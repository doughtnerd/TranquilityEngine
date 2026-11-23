/**
 * The content-hash cache of sample renders (ADR 0342 "Baked effects are rendered offline": "the render cached by content
 * hash in `.myco/cache/samples/`"). A render is keyed by what it is made of: the source file's bytes and the edits the
 * render bakes (the chain, its automation and the normalisation gain; `renderSample`), plus the render's own version.
 * Equal inputs give the same key, so Re-flatten of unchanged edits, the export and the Studio's audition read one file
 * instead of rendering again. The cache is per machine (`.myco/` is never a project file) and safe to delete.
 *
 * The caller says how to read and write the cache (`RenderStore`) and how to render (`renderSample` itself, or a worker
 * that runs it). Works in the browser and in Node (Web Crypto's SHA-256).
 */
import { effectsToJson, isPluginEffectType } from "../effects/catalogue";
import { curveToJson } from "../lenientRead";
import { offlineEffectHost, type OfflineEffectHost } from "./offlinePlugins";
import { PLUGIN_NOT_RENDERED, type RenderedSample, type SamplePcm } from "./sampleRender";
import type { SampleEdits } from "./types";
import { encodeWavFloat32 } from "./wavEncode";

/** Where renders are cached, relative to the project folder. */
export const RENDER_CACHE_DIR = ".myco/cache/samples";

/** Bumped when the render's output changes for the same inputs (a kernel fix, a new spec field), so old renders miss. */
export const RENDER_VERSION = 1;

/** Read and write access to the cache folder, by path relative to the project folder. */
export interface RenderStore {
  /** The cached bytes, or null when there are none (or they can't be read). */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** Renders a sample (`renderSample`, or a worker running it). */
export type SampleRenderer = (pcm: SamplePcm, edits: SampleEdits) => Promise<RenderedSample>;

/**
 * The edits a render depends on, as canonical JSON (what `renderSample` reads, nothing else). ADR 0352 §7: each enabled
 * plugin effect type adds its plugin's name, version and module hash as `plugins` knows them (default: the installed
 * offline host), or `null` when none holds it, so a plugin update or install renders again.
 */
export function renderInputs(edits: SampleEdits, plugins: OfflineEffectHost | null = offlineEffectHost()): string {
  const types = [...new Set(edits.effects.filter((f) => f.on && isPluginEffectType(f.type)).map((f) => f.type))].sort();
  const identities = types.map((type) => {
    const id = plugins?.identity(type) ?? null;
    return { type, plugin: id && { name: id.plugin, version: id.version, hash: id.hash } };
  });
  return JSON.stringify({
    v: RENDER_VERSION,
    effects: effectsToJson(edits.effects),
    automation: edits.automation.filter((a) => !a.bypass).map((a) => ({ target: a.target, curve: curveToJson(a.curve) })),
    gain: edits.normalize.mode === "off" ? 0 : edits.normalize.gainDb,
    ...(identities.length > 0 && { plugins: identities }),
  });
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The cache key of rendering `source` (the audio file's bytes) with `edits`: SHA-256, 64 hex digits. */
export async function renderKey(source: Uint8Array, edits: SampleEdits, plugins: OfflineEffectHost | null = offlineEffectHost()): Promise<string> {
  const head = new TextEncoder().encode(`${renderInputs(edits, plugins)}\n`);
  const all = new Uint8Array(head.length + source.length);
  all.set(head, 0);
  all.set(source, head.length);
  return hex(await crypto.subtle.digest("SHA-256", all));
}

/** The cached render's path for `key`. */
export const renderCachePath = (key: string): string => `${RENDER_CACHE_DIR}/${key}.wav`;

export interface CachedRender {
  /** The render as a 32-bit float WAV file. */
  readonly bytes: Uint8Array;
  /** True when it came from the cache (nothing was rendered). */
  readonly hit: boolean;
  readonly key: string;
  /** The render's warnings (none for a cache hit: they were shown when it was made). */
  readonly warnings: readonly string[];
}

/**
 * The render of `source` with `edits`: from the cache when it holds one, else decoded (`pcm`, only called on a miss),
 * rendered and stored. A store that fails to write still returns the render. A render in which a plugin effect passed
 * through for want of its module (a renderer where it wasn't loaded) isn't stored: it isn't what its key names.
 */
export async function cachedRender(
  store: RenderStore,
  source: Uint8Array,
  edits: SampleEdits,
  pcm: () => Promise<SamplePcm>,
  render: SampleRenderer,
  /** Where `render` runs plugin effects, for the key (default: the installed offline host). */
  plugins: OfflineEffectHost | null = offlineEffectHost(),
): Promise<CachedRender> {
  const key = await renderKey(source, edits, plugins);
  const path = renderCachePath(key);
  const cached = await store.read(path).catch(() => null);
  if (cached && cached.length > 0) return { bytes: cached, hit: true, key, warnings: [] };
  const out = await render(await pcm(), edits);
  const bytes = encodeWavFloat32(out.pcm, out.channels, out.rate);
  if (!out.warnings.some((w) => w.includes(PLUGIN_NOT_RENDERED))) await store.write(path, bytes).catch(() => undefined);
  return { bytes, hit: false, key, warnings: out.warnings };
}
