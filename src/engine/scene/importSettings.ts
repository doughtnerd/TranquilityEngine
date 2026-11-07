/**
 * Per-asset import settings (ADR 0040): a sidecar file beside each asset, `<asset>.meta.json`
 * (`images/player.png` → `images/player.png.meta.json`), read through the same asset sources as
 * the asset itself. A missing sidecar means the defaults.
 *
 * ```jsonc
 * {
 *   "format": "myco.import@1",
 *   "pixelsPerUnit": 16,          // images: 0 or absent = the SpriteRenderer's, else the project's
 *   "filter": "point",            // "linear" (default) | "point"
 *   "wrap": "clamp",              // "clamp" (default) | "repeat" | "mirror"
 *   "mipmaps": false,             // default true
 *   "maxSize": 1024,              // images: largest side in pixels, 0 or absent = no limit (ADR 0115)
 *   "compression": "normal",      // images: "none" (default) | "low" | "normal" | "high" quality (ADR 0115)
 *   "platforms": {                // images: per-platform overrides of filter, wrap, mipmaps, maxSize, compression
 *     "web": { "maxSize": 512, "compression": "high" },
 *     "desktop": { "mipmaps": false }
 *   },
 *   "pivot": [0.5, 0],            // the whole image's pivot, 0..1 from the bottom-left (default centre)
 *   "sprites": [                  // named slices: rect in pixels from the top-left, pivot as above
 *     { "name": "walk_0", "rect": [0, 0, 16, 16], "pivot": [0.5, 0], "border": [2, 2, 2, 2] }
 *   ],
 *   "volume": 0.8,                // audio: multiplies every playback's volume (default 1)
 *   "stream": true,               // audio: stream (HTML5 audio) instead of decoding up front (default false)
 *   "scale": 0.01,                // models: multiplies the model's size (default 1)
 *   "upAxis": "z",                // models: the axis that is up in the file, "y" (default) or "z" (ADR 0044)
 *   "normals": "calculate",       // models: "import" (default; calculated when the file has none) or "calculate"
 *   "materials": {                // models: a material asset for each of the model's own materials, by name (ADR 0089)
 *     "Paint": "asset:materials/car-paint.material.json"
 *   }
 * }
 * ```
 *
 * A slice is referenced as `asset:<image path>#<slice name>` (`asset:images/hero.png#walk_0`).
 */

export const IMPORT_FORMAT = "myco.import@1";
export const SIDECAR_SUFFIX = ".meta.json";

export type TextureFilter = "linear" | "point";
export type TextureWrap = "clamp" | "repeat" | "mirror";
/** How hard a texture is compressed on its way to the GPU: `none` keeps it as authored; `high` is smallest and lowest quality (ADR 0115). */
export type TextureCompression = "none" | "low" | "normal" | "high";
export const TEXTURE_COMPRESSIONS: readonly TextureCompression[] = ["none", "low", "normal", "high"];
/** A build target an import setting can differ on (ADR 0115). */
export type ImportPlatform = "web" | "desktop";
export const IMPORT_PLATFORMS: readonly ImportPlatform[] = ["web", "desktop"];
/** The image settings a platform can override. */
export interface PlatformOverrides {
  filter?: TextureFilter;
  wrap?: TextureWrap;
  mipmaps?: boolean;
  maxSize?: number;
  compression?: TextureCompression;
}
export const PLATFORM_OVERRIDE_KEYS = ["filter", "wrap", "mipmaps", "maxSize", "compression"] as const;
/** The axis that points up in a model file (ADR 0044); the engine's up is +Y. */
export type ModelUpAxis = "y" | "z";
/** A model's normals: the file's (calculated when it has none), or always calculated smooth. */
export type ModelNormals = "import" | "calculate";

/** A named rectangle of an image, drawn as its own sprite. */
export type SpriteFill = "stretch" | "tile";
export const SPRITE_FILLS: readonly SpriteFill[] = ["stretch", "tile"];

export interface SpriteSlice {
  /** Unique within the image; no `#`, `/` or quotes. */
  name: string;
  /** `[x, y, width, height]` in pixels, from the image's top-left corner. */
  rect: [number, number, number, number];
  /** The point the sprite is placed and turned about, 0..1 across the rect from its bottom-left. */
  pivot: [number, number];
  /** 9-slice borders in pixels, `[left, bottom, right, top]` (drawn 9-sliced by SpriteRenderer, ADR 0115). */
  border?: [number, number, number, number];
  /** How the edges and centre fill their area: `stretch` (default) or `tile` (repeat at pixel size; ADR 0115). Written only when `tile`. */
  fill?: SpriteFill;
}

export interface ImportSettings {
  pixelsPerUnit: number;
  filter: TextureFilter;
  wrap: TextureWrap;
  mipmaps: boolean;
  /** Largest side in pixels; 0 = no limit (ADR 0115). */
  maxSize: number;
  compression: TextureCompression;
  /** Images in a game build (ADR 0119): the authored size `[width, height]` of an image the export shrank, so sprites, tiles and slices keep their authored size. Never written by the editor. */
  sourceSize: [number, number] | null;
  /** Per-platform overrides of the image settings above; applied by `resolveImportSettings`. */
  platforms: Partial<Record<ImportPlatform, PlatformOverrides>>;
  pivot: [number, number];
  sprites: SpriteSlice[];
  volume: number;
  stream: boolean;
  /** Models (ADR 0044): multiplies the model's size. */
  scale: number;
  upAxis: ModelUpAxis;
  normals: ModelNormals;
  /** Models (ADR 0089): a material asset (`asset:` path) drawn in place of each of the model's own materials, by the material's name. */
  materials: Record<string, string>;
}

export const DEFAULT_IMPORT_SETTINGS: Readonly<ImportSettings> = Object.freeze<ImportSettings>({
  pixelsPerUnit: 0,
  filter: "linear",
  wrap: "clamp",
  mipmaps: true,
  maxSize: 0,
  compression: "none",
  sourceSize: null,
  platforms: {},
  pivot: [0.5, 0.5],
  sprites: [],
  volume: 1,
  stream: false,
  scale: 1,
  upAxis: "y",
  normals: "import",
  materials: Object.freeze({}) as Record<string, string>,
});

/** A copy of the defaults (safe to change). */
export const defaultImportSettings = (): ImportSettings => ({ ...DEFAULT_IMPORT_SETTINGS, pivot: [0.5, 0.5], sprites: [], materials: {}, platforms: {} });

/** `images/a.png` → `images/a.png.meta.json`. */
export const sidecarPath = (assetPath: string): string => `${assetPath}${SIDECAR_SUFFIX}`;
/** True for a sidecar file (`*.meta.json`). */
export const isSidecarPath = (path: string): boolean => path.toLowerCase().endsWith(SIDECAR_SUFFIX);
/** The asset a sidecar belongs to: `images/a.png.meta.json` → `images/a.png`. */
export const sidecarAsset = (path: string): string => path.slice(0, -SIDECAR_SUFFIX.length);

/**
 * Split a sprite reference into the image path and slice name: `asset:images/a.png#walk_0` →
 * `{ path: "images/a.png", slice: "walk_0" }`; without `#`, `slice` is null.
 */
export function splitSpriteRef(ref: string): { path: string; slice: string | null } {
  const p = ref.replace(/^asset:/, "").replace(/^\.?\//, "");
  const i = p.indexOf("#");
  return i < 0 ? { path: p, slice: null } : { path: p.slice(0, i), slice: p.slice(i + 1) };
}

/** Why `name` can't name a slice (given the other names), or null if it can. */
export function whyNotSliceName(name: string, others: readonly string[] = []): string | null {
  if (name.trim() === "") return "a name can't be empty";
  if (name !== name.trim()) return "a name can't start or end with a space";
  if (/[#/\\"']/.test(name)) return "a name can't contain # / \\ or quotes";
  if (others.includes(name)) return `there's already a slice named "${name}"`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumberArray = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

const isMaxSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isCompression = (v: unknown): v is TextureCompression => (TEXTURE_COMPRESSIONS as readonly unknown[]).includes(v);

/**
 * Read a sidecar's parsed JSON into settings, with defaults for anything missing. Values of the
 * wrong type are skipped and listed in `problems` (a bad sidecar never stops an asset loading).
 * Throws for a sidecar of another format, such as a newer version.
 */
export function parseImportSettings(raw: unknown, where = "import settings"): { settings: ImportSettings; problems: string[] } {
  const settings = defaultImportSettings();
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { settings, problems };
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${IMPORT_FORMAT}".`);
  if (raw.format !== IMPORT_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${IMPORT_FORMAT}".`);
  const bad = (key: string, expected: string) => problems.push(`${where}: "${key}" should be ${expected}; using the default.`);

  if (raw.pixelsPerUnit !== undefined) {
    if (typeof raw.pixelsPerUnit === "number" && raw.pixelsPerUnit >= 0 && Number.isFinite(raw.pixelsPerUnit)) settings.pixelsPerUnit = raw.pixelsPerUnit;
    else bad("pixelsPerUnit", "a number ≥ 0");
  }
  if (raw.filter !== undefined) {
    if (raw.filter === "linear" || raw.filter === "point") settings.filter = raw.filter;
    else bad("filter", '"linear" or "point"');
  }
  if (raw.wrap !== undefined) {
    if (raw.wrap === "clamp" || raw.wrap === "repeat" || raw.wrap === "mirror") settings.wrap = raw.wrap;
    else bad("wrap", '"clamp", "repeat" or "mirror"');
  }
  if (raw.mipmaps !== undefined) {
    if (typeof raw.mipmaps === "boolean") settings.mipmaps = raw.mipmaps;
    else bad("mipmaps", "true or false");
  }
  if (raw.maxSize !== undefined) {
    if (isMaxSize(raw.maxSize)) settings.maxSize = raw.maxSize;
    else bad("maxSize", "a whole number ≥ 0");
  }
  if (raw.compression !== undefined) {
    if (isCompression(raw.compression)) settings.compression = raw.compression;
    else bad("compression", '"none", "low", "normal" or "high"');
  }
  if (raw.sourceSize !== undefined) {
    const v = raw.sourceSize;
    if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0)) settings.sourceSize = [v[0], v[1]];
    else bad("sourceSize", "[width, height] in whole pixels");
  }
  if (raw.platforms !== undefined) {
    if (!isObject(raw.platforms)) bad("platforms", "an object keyed by platform");
    else {
      for (const [name, value] of Object.entries(raw.platforms)) {
        if (!(IMPORT_PLATFORMS as readonly string[]).includes(name)) {
          problems.push(`${where}: unknown platform "${name}" in "platforms" (expected ${IMPORT_PLATFORMS.join(" or ")}); skipped.`);
          continue;
        }
        if (!isObject(value)) {
          problems.push(`${where}: platforms.${name} should be an object; skipped.`);
          continue;
        }
        const o: PlatformOverrides = {};
        const badOverride = (key: string, expected: string) => problems.push(`${where}: platforms.${name}.${key} should be ${expected}; ignored.`);
        for (const [key, v] of Object.entries(value)) {
          if (key === "filter") (v === "linear" || v === "point" ? (o.filter = v) : badOverride(key, '"linear" or "point"'));
          else if (key === "wrap") (v === "clamp" || v === "repeat" || v === "mirror" ? (o.wrap = v) : badOverride(key, '"clamp", "repeat" or "mirror"'));
          else if (key === "mipmaps") (typeof v === "boolean" ? (o.mipmaps = v) : badOverride(key, "true or false"));
          else if (key === "maxSize") (isMaxSize(v) ? (o.maxSize = v) : badOverride(key, "a whole number ≥ 0"));
          else if (key === "compression") (isCompression(v) ? (o.compression = v) : badOverride(key, '"none", "low", "normal" or "high"'));
          else problems.push(`${where}: platforms.${name}.${key} can't differ per platform (expected ${PLATFORM_OVERRIDE_KEYS.join(", ")}); ignored.`);
        }
        if (Object.keys(o).length > 0) settings.platforms[name as ImportPlatform] = o;
      }
    }
  }
  if (raw.pivot !== undefined) {
    if (isNumberArray(raw.pivot, 2)) settings.pivot = [raw.pivot[0], raw.pivot[1]];
    else bad("pivot", "[x, y]");
  }
  if (raw.volume !== undefined) {
    if (typeof raw.volume === "number" && raw.volume >= 0 && Number.isFinite(raw.volume)) settings.volume = raw.volume;
    else bad("volume", "a number ≥ 0");
  }
  if (raw.stream !== undefined) {
    if (typeof raw.stream === "boolean") settings.stream = raw.stream;
    else bad("stream", "true or false");
  }
  if (raw.scale !== undefined) {
    if (typeof raw.scale === "number" && raw.scale > 0 && Number.isFinite(raw.scale)) settings.scale = raw.scale;
    else bad("scale", "a number > 0");
  }
  if (raw.upAxis !== undefined) {
    if (raw.upAxis === "y" || raw.upAxis === "z") settings.upAxis = raw.upAxis;
    else bad("upAxis", '"y" or "z"');
  }
  if (raw.normals !== undefined) {
    if (raw.normals === "import" || raw.normals === "calculate") settings.normals = raw.normals;
    else bad("normals", '"import" or "calculate"');
  }
  if (raw.materials !== undefined) {
    if (!isObject(raw.materials)) bad("materials", "an object of material asset paths by material name");
    else {
      for (const [name, path] of Object.entries(raw.materials)) {
        if (typeof path === "string") {
          if (path) settings.materials[name] = path;
        } else problems.push(`${where}: materials["${name}"] should be a material asset path; ignored.`);
      }
    }
  }
  if (raw.sprites !== undefined) {
    if (!Array.isArray(raw.sprites)) bad("sprites", "a list");
    else {
      const names: string[] = [];
      raw.sprites.forEach((s, i) => {
        const at = `sprites[${i}]`;
        if (!isObject(s) || typeof s.name !== "string" || !isNumberArray(s.rect, 4)) {
          problems.push(`${where}: ${at} needs a "name" and a "rect" [x, y, width, height]; skipped.`);
          return;
        }
        const why = whyNotSliceName(s.name, names);
        if (why) {
          problems.push(`${where}: ${at}: ${why}; skipped.`);
          return;
        }
        if (s.rect[2] <= 0 || s.rect[3] <= 0) {
          problems.push(`${where}: ${at} ("${s.name}") has no area; skipped.`);
          return;
        }
        names.push(s.name);
        const slice: SpriteSlice = { name: s.name, rect: [s.rect[0], s.rect[1], s.rect[2], s.rect[3]], pivot: isNumberArray(s.pivot, 2) ? [s.pivot[0], s.pivot[1]] : [...settings.pivot] };
        if (s.border !== undefined) {
          if (isNumberArray(s.border, 4)) slice.border = [s.border[0], s.border[1], s.border[2], s.border[3]];
          else problems.push(`${where}: ${at}.border should be [left, bottom, right, top]; ignored.`);
        }
        if (s.fill !== undefined) {
          if (s.fill === "stretch" || s.fill === "tile") slice.fill = s.fill;
          else problems.push(`${where}: ${at}.fill should be "stretch" or "tile"; ignored.`);
        }
        settings.sprites.push(slice);
      });
    }
  }
  return { settings, problems };
}

const samePair = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

/** The `platforms` object to write: only overrides that differ from the base settings, or null for none. */
function platformsJSON(settings: ImportSettings): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  for (const platform of IMPORT_PLATFORMS) {
    const o = settings.platforms[platform];
    if (!o) continue;
    const kept: Record<string, unknown> = {};
    for (const key of PLATFORM_OVERRIDE_KEYS) if (o[key] !== undefined && o[key] !== settings[key]) kept[key] = o[key];
    if (Object.keys(kept).length > 0) out[platform] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `settings` with one platform override set (`value` undefined clears it, dropping an emptied platform). Doesn't change `settings`. */
export function withPlatformOverride<K extends keyof PlatformOverrides>(settings: ImportSettings, platform: ImportPlatform, key: K, value: PlatformOverrides[K] | undefined): ImportSettings {
  const next: PlatformOverrides = { ...settings.platforms[platform] };
  if (value === undefined) delete next[key];
  else next[key] = value;
  const platforms = { ...settings.platforms };
  if (Object.keys(next).length > 0) platforms[platform] = next;
  else delete platforms[platform];
  return { ...settings, platforms };
}

/**
 * The settings as one platform sees them: its overrides applied over the base, with `platforms`
 * emptied. Returns `settings` itself when the platform overrides nothing (ADR 0115).
 */
export function resolveImportSettings(settings: ImportSettings, platform: ImportPlatform): ImportSettings {
  const o = settings.platforms[platform];
  if (!o || Object.keys(o).length === 0) return settings;
  const out: ImportSettings = { ...settings, platforms: {} };
  for (const key of PLATFORM_OVERRIDE_KEYS) {
    const v = o[key];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

/**
 * A texture's size after `maxSize` (the longest side is clamped, aspect kept, never below 1 px).
 * Game exports apply it (ADR 0119; `compression` changes the encoding, not the size).
 */
export function clampTextureSize(width: number, height: number, maxSize: number): [number, number] {
  const longest = Math.max(width, height);
  if (maxSize <= 0 || longest <= maxSize) return [width, height];
  const k = maxSize / longest;
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

/** An image's authored size: the sidecar's `sourceSize` when the build shrank it (ADR 0119), else the texture's own. */
export function authoredSize(settings: ImportSettings, width: number, height: number): [number, number] {
  return settings.sourceSize ? [settings.sourceSize[0], settings.sourceSize[1]] : [width, height];
}

/** The sidecar JSON for `settings`: the format, then only what differs from the defaults. */
export function importSettingsJSON(settings: ImportSettings): Record<string, unknown> {
  const d = DEFAULT_IMPORT_SETTINGS;
  const out: Record<string, unknown> = { format: IMPORT_FORMAT };
  if (settings.pixelsPerUnit !== d.pixelsPerUnit) out.pixelsPerUnit = settings.pixelsPerUnit;
  if (settings.filter !== d.filter) out.filter = settings.filter;
  if (settings.wrap !== d.wrap) out.wrap = settings.wrap;
  if (settings.mipmaps !== d.mipmaps) out.mipmaps = settings.mipmaps;
  if (settings.maxSize !== d.maxSize) out.maxSize = settings.maxSize;
  if (settings.compression !== d.compression) out.compression = settings.compression;
  if (settings.sourceSize) out.sourceSize = [...settings.sourceSize];
  const platforms = platformsJSON(settings);
  if (platforms) out.platforms = platforms;
  if (!samePair(settings.pivot, d.pivot)) out.pivot = [...settings.pivot];
  if (settings.volume !== d.volume) out.volume = settings.volume;
  if (settings.stream !== d.stream) out.stream = settings.stream;
  if (settings.scale !== d.scale) out.scale = settings.scale;
  if (settings.upAxis !== d.upAxis) out.upAxis = settings.upAxis;
  if (settings.normals !== d.normals) out.normals = settings.normals;
  const materials = Object.entries(settings.materials ?? {}).filter(([, v]) => v);
  if (materials.length) out.materials = Object.fromEntries(materials);
  if (settings.sprites.length > 0) {
    out.sprites = settings.sprites.map((s) => ({ name: s.name, rect: [...s.rect], pivot: [...s.pivot], ...(s.border && s.border.some((b) => b !== 0) ? { border: [...s.border] } : {}), ...(s.fill === "tile" ? { fill: "tile" } : {}) }));
  }
  return out;
}

/** Sidecar text: two-space JSON with number lists on one line, one slice per line. */
export function formatImportSettings(settings: ImportSettings): string {
  const json = importSettingsJSON(settings);
  const { sprites, ...rest } = json;
  let text = JSON.stringify(rest, null, 2).replace(/\[\s+([-\d.e+,\s]+?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s*/).join(", ")}]`);
  if (Array.isArray(sprites)) {
    const lines = (sprites as Record<string, unknown>[]).map(
      (s) => `    { ${Object.entries(s).map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.join(", ")}]` : JSON.stringify(v)}`).join(", ")} }`,
    );
    text = `${text.slice(0, -2)},\n  "sprites": [\n${lines.join(",\n")}\n  ]\n}`;
  }
  return `${text}\n`;
}

/** The slice named `name`, or undefined. */
export const findSlice = (settings: ImportSettings, name: string): SpriteSlice | undefined => settings.sprites.find((s) => s.name === name);
