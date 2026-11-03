/**
 * Asset lookup by path (ADR 0013: assets are referenced by path in v1, e.g.
 * `"asset:images/bird.png"`, relative to the game's asset root).
 *
 * The game registers one or more sources at startup, usually `Assets.fromGlob` over a Vite
 * `import.meta.glob` of its asset folder (ADR 0015). Import settings sidecars (`*.meta.json`,
 * ADR 0040) are JSON assets like any other, so the same glob carries them.
 */
import { defaultImportSettings, parseImportSettings, sidecarPath, splitSpriteRef, type ImportSettings } from "./importSettings";

export interface AssetSource {
  has(path: string): boolean;
  /** Parsed JSON for `.json` files, a URL string for binary assets. */
  get(path: string): unknown;
}

const sources: AssetSource[] = [];

/** Strip the `asset:` prefix and leading `./` or `/`. */
export function normalizeAssetPath(path: string): string {
  return path.replace(/^asset:/, "").replace(/^\.?\//, "");
}

const defaults: ImportSettings = Object.freeze({ ...defaultImportSettings(), pivot: Object.freeze([0.5, 0.5]) as [number, number], sprites: Object.freeze([]) as unknown as [] });
/** Parsed sidecars by their raw JSON value, so a sidecar rewritten in the editor is parsed again. */
const parsedSidecars = new WeakMap<object, ImportSettings>();

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

export const Assets = {
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

  has(path: string): boolean {
    const p = normalizeAssetPath(path);
    return sources.some((s) => s.has(p));
  },

  /** Raw lookup. Throws if no source has the asset. */
  get(path: string): unknown {
    const p = normalizeAssetPath(path);
    for (const s of sources) if (s.has(p)) return s.get(p);
    throw new Error(`Asset not found: "${p}". Is it inside the asset root registered with Assets.addSource?`);
  },

  /** URL for a binary asset (image, audio). */
  url(path: string): string {
    const v = Assets.get(path);
    if (typeof v === "string") return v;
    if (v && typeof (v as { default?: unknown }).default === "string") return (v as { default: string }).default;
    throw new Error(`Asset "${normalizeAssetPath(path)}" is not a binary asset.`);
  },

  /**
   * An asset's import settings (ADR 0040), read from its sidecar `<path>.meta.json`; the defaults
   * when it has none. A slice reference (`images/a.png#walk_0`) reads its image's. Problems in
   * the sidecar are reported once each as warnings, and the defaults used for those values.
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
    return cached;
  },

  /** Parsed JSON asset (scenes, prefabs, project settings). */
  json<T = unknown>(path: string): T {
    const v = Assets.get(path);
    if (typeof v === "string") throw new Error(`Asset "${normalizeAssetPath(path)}" is not JSON.`);
    return v as T;
  },

  /**
   * Wrap the result of a Vite glob import made from the game's asset folder:
   * `import.meta.glob("./**\/*.{png,mp3,json}", { eager: true, import: "default" })`.
   * Keys are paths relative to that folder; values are URLs or parsed JSON.
   */
  fromGlob(modules: Record<string, unknown>): AssetSource {
    const map = new Map(Object.entries(modules).map(([key, value]) => [normalizeAssetPath(key), value]));
    return {
      has: (path) => map.has(path),
      get: (path) => map.get(path),
    };
  },

  /** A source backed by a plain object, handy for tests: `{ "scenes/a.json": {...} }`. */
  fromObject(map: Record<string, unknown>): AssetSource {
    return {
      has: (path) => Object.prototype.hasOwnProperty.call(map, path),
      get: (path) => map[path],
    };
  },
};
