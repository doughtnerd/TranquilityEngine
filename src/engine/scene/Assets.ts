/**
 * Asset lookup by path (ADR 0013: assets are referenced by path in v1, e.g.
 * `"asset:images/bird.png"`, relative to the game's asset root).
 *
 * The game registers one or more sources at startup, usually `Assets.fromGlob` over a Vite
 * `import.meta.glob` of its asset folder (ADR 0015).
 */
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
