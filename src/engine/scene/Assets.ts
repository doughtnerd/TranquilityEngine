/**
 * Asset lookup by path (ADR 0013: assets are referenced by path in v1, e.g.
 * `"asset:images/bird.png"`, relative to the game's asset root).
 *
 * The game registers one or more sources at startup, usually `Assets.fromGlob` over a Vite
 * `import.meta.glob` of its asset folder (ADR 0015). Import settings sidecars (`*.meta.json`,
 * ADR 0040) are JSON assets like any other, so the same glob carries them.
 *
 * What a source holds for a path follows the path's project-file kind (ADR 0254, `projectFiles.ts`):
 * parsed JSON for `.json` files, the text of text files (`.xml`, `.css`, `.wgsl`, `.md`...), a URL
 * for every other file. The typed reads (`json`, `text`, `url`) check the kind, so they answer the
 * same on every host.
 */
import { projectFileKind } from "./projectFiles";
import { normalizeAssetPath } from "./assetPath";
import { localisedParts, variantPath } from "../localisation/variants";
import { defaultImportSettings, parseImportSettings, resolveImportSettings, sidecarPath, splitSpriteRef, type ImportPlatform, type ImportSettings } from "./importSettings";

export interface AssetSource {
  has(path: string): boolean;
  /** The asset value for `path` by its kind (ADR 0254): parsed JSON for `.json` files, the text of text files, a URL otherwise. */
  get(path: string): unknown;
  /**
   * Every path the source holds, when it can list them (ADR 0356: string tables are found by name). A source without
   * it still serves lookups; what it holds just isn't discovered.
   */
  paths?(): Iterable<string>;
}

const sources: AssetSource[] = [];
/** Files the engine provides (the input glyphs, ADR 0337): looked up after the game's sources, and kept by `clearSources`. */
const builtinSources: AssetSource[] = [];

export { normalizeAssetPath } from "./assetPath";

const defaults: ImportSettings = Object.freeze({ ...defaultImportSettings(), pivot: Object.freeze([0.5, 0.5]) as [number, number], sprites: Object.freeze([]) as unknown as [], platforms: Object.freeze({}) });
/** Parsed sidecars by their raw JSON value, so a sidecar rewritten in the editor is parsed again. */
const parsedSidecars = new WeakMap<object, ImportSettings>();
/** The parsed sidecars resolved for each platform (ADR 0115). */
const resolvedSidecars = new WeakMap<ImportSettings, Partial<Record<ImportPlatform, ImportSettings>>>();
let platformOverride: ImportPlatform | null = null;
/**
 * Under Tauri: "android" on Tauri mobile's Android webview (its user agent names Android, ADR 0351 §1), else "desktop";
 * in a browser: "web".
 */
const detectPlatform = (): ImportPlatform => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return "web";
  return typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent ?? "") ? "android" : "desktop";
};

/**
 * @internal The raw JSON of the sidecar for `path` (a slice reference reads its image's), or
 * undefined if there's none. The same object until the sidecar changes, so it can be compared.
 */
export function sidecarValue(path: string): object | undefined {
  const p = sidecarPath(splitSpriteRef(path).path);
  for (const s of sources) {
    if (!s.has(p)) continue;
    const v = s.get(p);
    return typeof v === "object" && v !== null ? v : undefined;
  }
  return undefined;
}

/**
 * Localised textures and fonts (ADR 0356 §10): under a `languages.assetRoots` folder the first folder is a language
 * code, a reference names the reference language's file, and `Assets.url` serves the variant the current language's
 * fallback chain finds (`variantPath`). The localisation runtime sets the roots and the chain on every language change
 * (`setAssetLanguage`); references resolved so far are remembered so a switch can preload and announce theirs.
 */
const LOCALISED_FILE = /\.(png|jpe?g|webp|gif|avif|bmp|tga|ktx2|svg|ttf|otf|woff2?)$/i;
let assetLanguage: { roots: readonly string[]; chain: readonly string[] } | null = null;
const localisedRefs = new Set<string>();

/**
 * @internal The localisation runtime (ADR 0356 §10): the asset roots and the current language's fallback chain textures
 * and fonts resolve through (empty roots: nothing is localised).
 */
export function setAssetLanguage(roots: readonly string[], chain: readonly string[]): void {
  assetLanguage = roots.length ? { roots: [...roots], chain: [...chain] } : null;
}

/** @internal The localised texture and font references `Assets.url` has resolved (for a language switch's preload). */
export function localisedAssetRefs(): readonly string[] {
  return [...localisedRefs];
}

/** The file a texture or font reference loads in the current language (the reference itself outside the asset roots). */
function localisedPath(p: string): string {
  if (!assetLanguage || !LOCALISED_FILE.test(p) || localisedParts(p, assetLanguage.roots) === null) return p;
  localisedRefs.add(p);
  return variantPath(p, assetLanguage.chain, assetLanguage.roots, (c) => sources.some((s) => s.has(c)))?.path ?? p;
}

/** Listeners of `Assets.onChanged`. */
const changeListeners = new Set<(path: string) => void>();

/** Compiled modules served as their source files' values (ADR 0423: a `.svelte` component's module), by path. */
let compiledModules: ReadonlyMap<string, unknown> = new Map();


export const Assets = {
  /**
   * @internal The editor saved or replaced the project file at `path` (its source already serves the new content):
   * runtimes that cache what an asset held (audio's clips and music events) drop it. Each listener's error is logged, not thrown.
   */
  notifyChanged(path: string): void {
    const p = normalizeAssetPath(path);
    for (const listener of [...changeListeners]) {
      try {
        listener(p);
      } catch (err) {
        console.warn(`[myco] An asset-change listener failed for "${p}":`, err);
      }
    }
  },

  /** @internal Calls `listener(path)` whenever `notifyChanged` reports a changed asset; returns the unsubscribe. */
  onChanged(listener: (path: string) => void): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  },

  addSource(source: AssetSource): void {
    sources.unshift(source);
  },

  removeSource(source: AssetSource): void {
    const i = sources.indexOf(source);
    if (i >= 0) sources.splice(i, 1);
  },

  clearSources(): void {
    sources.length = 0;
  },

  /** @internal Add files the engine itself provides (`@myco/…` paths): looked up after the game's sources, and never cleared. */
  addBuiltinSource(source: AssetSource): void {
    if (!builtinSources.includes(source)) builtinSources.push(source);
  },

  /**
   * @internal A host linked the project's code: serve each compiled module (a Svelte component's, ADR 0423) as
   * the asset value of its source file, in place of the file's text, replacing what the last link set.
   */
  setCompiledModules(modules: ReadonlyMap<string, unknown>): void {
    compiledModules = new Map([...modules].map(([p, m]) => [normalizeAssetPath(p), m]));
  },

  has(path: string): boolean {
    const p = normalizeAssetPath(path);
    return compiledModules.has(p) || sources.some((s) => s.has(p)) || builtinSources.some((s) => s.has(p));
  },


  /** @internal Every path the registered sources list (`AssetSource.paths`), each once, in source order. */
  paths(): string[] {
    const out = new Set<string>();
    for (const s of sources) for (const p of s.paths?.() ?? []) out.add(normalizeAssetPath(p));
    return [...out];
  },

  /**
   * The raw asset value (see `AssetSource.get`), for comparing what a file held; read values
   * through `json`, `text` or `url`. Throws if no source has the asset.
   */
  get(path: string): unknown {
    const p = normalizeAssetPath(path);
    if (compiledModules.has(p)) return compiledModules.get(p);
    for (const s of sources) if (s.has(p)) return s.get(p);

    for (const s of builtinSources) if (s.has(p)) return s.get(p);
    throw new Error(`Asset not found: "${p}". Is it inside the asset root registered with Assets.addSource?`);
  },

  /**
   * The URL serving a file's bytes (images, audio, models, fonts, LUTs). Throws for JSON and text
   * files, which load as their contents.
   */
  url(path: string): string {
    const p = normalizeAssetPath(path);
    const kind = projectFileKind(p);
    if (kind !== "url") throw new Error(`Asset "${p}" is a ${kind === "json" ? "JSON" : "text"} file, which loads as its contents, not a URL: read it with Assets.${kind}().`);
    // ADR 0356 §10: a texture or font under an asset root serves the current language's variant.
    const v = Assets.get(localisedPath(p));
    if (typeof v !== "string") throw new Error(`Asset "${p}" has no URL.`);
    return v;
  },

  /** A file's bytes, fetched from its URL (`Assets.url`); read from disk for the dedicated server's `file:` URLs. */
  bytes(path: string): Promise<Uint8Array> {
    return fetchAssetBytes(Assets.url(path));
  },

  /**
   * The platform per-platform import overrides resolve for (ADR 0115): "android" under Tauri mobile on Android, "desktop"
   * under Tauri elsewhere, else "web" (ADR 0351 §1); settable (null = detect).
   */
  get platform(): ImportPlatform {
    return platformOverride ?? detectPlatform();
  },
  set platform(value: ImportPlatform | null) {
    platformOverride = value;
  },

  /**
   * An asset's import settings (ADR 0040), read from its sidecar `<path>.meta.json`; the defaults
   * when it has none. A slice reference (`images/a.png#walk_0`) reads its image's. Problems in
   * the sidecar are reported once each as warnings, and the defaults used for those values.
   * Per-platform overrides are resolved for `Assets.platform` (ADR 0115).
   */
  importSettings(path: string): ImportSettings {
    const raw = sidecarValue(path);
    if (raw === undefined) return defaults;
    let cached = parsedSidecars.get(raw);
    if (!cached) {
      const where = sidecarPath(splitSpriteRef(path).path);
      try {
        const { settings, problems } = parseImportSettings(raw, where);
        for (const p of problems) console.warn(`[myco] ${p}`);
        cached = settings;
      } catch (err) {
        console.warn(`[myco] ${(err as Error).message} Using the defaults.`);
        cached = defaults;
      }
      parsedSidecars.set(raw, cached);
    }
    const platform = Assets.platform;
    let byPlatform = resolvedSidecars.get(cached);
    if (!byPlatform) resolvedSidecars.set(cached, (byPlatform = {}));
    return (byPlatform[platform] ??= resolveImportSettings(cached, platform));
  },

  /** A JSON file's parsed contents (scenes, prefabs, project settings). Throws for other files. */
  json<T = unknown>(path: string): T {
    const p = normalizeAssetPath(path);
    if (projectFileKind(p) !== "json") throw new Error(`Asset "${p}" is not a JSON file.`);
    return Assets.get(p) as T;
  },

  /**
   * A text file's contents (`.xml`, `.css`, `.wgsl`, `.glsl`, `.md`, `.txt`, JavaScript). Throws for
   * other files: one that loads as a URL (a `.cube` LUT, an `.obj`) is read with `Assets.bytes`.
   */
  text(path: string): string {
    const p = normalizeAssetPath(path);
    const kind = projectFileKind(p);
    if (kind !== "text") throw new Error(`Asset "${p}" is not a text file${kind === "url" ? ": read its bytes with Assets.bytes()" : ": read it with Assets.json()"}.`);
    const v = Assets.get(p);
    if (typeof v !== "string") throw new Error(`Asset "${p}" doesn't hold text.`);
    return v;
  },

  /**
   * Wrap the result of a Vite glob import made from the game's asset folder:
   * `import.meta.glob("./**\/*.{png,mp3,json}", { eager: true, import: "default" })`.
   * Keys are paths relative to that folder; values are URLs or parsed JSON. Text files (ADR 0254)
   * must hold their contents, so glob those with `query: "?raw"`.
   */
  fromGlob(modules: Record<string, unknown>): AssetSource {
    const map = new Map(Object.entries(modules).map(([key, value]) => [normalizeAssetPath(key), value]));
    return {
      has: (path) => map.has(path),
      get: (path) => map.get(path),
      paths: () => map.keys(),
    };
  },

  /** A source backed by a plain object, handy for tests: `{ "scenes/a.json": {...} }`. */
  fromObject(map: Record<string, unknown>): AssetSource {
    return {
      has: (path) => Object.prototype.hasOwnProperty.call(map, path),
      get: (path) => map[path],
      paths: () => Object.keys(map),
    };
  },
};

/**
 * @internal A binary asset's bytes from its URL (`Assets.url`): fetched in browsers (http, blob and data URLs),
 * read from disk for the `file:` URLs the dedicated server (Node) gives project files.
 */
export async function fetchAssetBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("file:") && typeof window === "undefined") {
    // A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fs = (await import(/* @vite-ignore */ ["node", "fs/promises"].join(":"))) as { readFile(path: URL): Promise<Uint8Array> };
    return new Uint8Array(await fs.readFile(new URL(url)));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
