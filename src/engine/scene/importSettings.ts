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
 *   "pivot": [0.5, 0],            // the whole image's pivot, 0..1 from the bottom-left (default centre)
 *   "sprites": [                  // named slices: rect in pixels from the top-left, pivot as above
 *     { "name": "walk_0", "rect": [0, 0, 16, 16], "pivot": [0.5, 0], "border": [2, 2, 2, 2] }
 *   ],
 *   "volume": 0.8,                // audio: multiplies every playback's volume (default 1)
 *   "stream": true                // audio: stream (HTML5 audio) instead of decoding up front (default false)
 * }
 * ```
 *
 * A slice is referenced as `asset:<image path>#<slice name>` (`asset:images/hero.png#walk_0`).
 */

export const IMPORT_FORMAT = "myco.import@1";
export const SIDECAR_SUFFIX = ".meta.json";

export type TextureFilter = "linear" | "point";
export type TextureWrap = "clamp" | "repeat" | "mirror";

/** A named rectangle of an image, drawn as its own sprite. */
export interface SpriteSlice {
  /** Unique within the image; no `#`, `/` or quotes. */
  name: string;
  /** `[x, y, width, height]` in pixels, from the image's top-left corner. */
  rect: [number, number, number, number];
  /** The point the sprite is placed and turned about, 0..1 across the rect from its bottom-left. */
  pivot: [number, number];
  /** 9-slice borders in pixels, `[left, bottom, right, top]` (stored for later; not drawn yet). */
  border?: [number, number, number, number];
}

export interface ImportSettings {
  pixelsPerUnit: number;
  filter: TextureFilter;
  wrap: TextureWrap;
  mipmaps: boolean;
  pivot: [number, number];
  sprites: SpriteSlice[];
  volume: number;
  stream: boolean;
}

export const DEFAULT_IMPORT_SETTINGS: Readonly<ImportSettings> = Object.freeze<ImportSettings>({
  pixelsPerUnit: 0,
  filter: "linear",
  wrap: "clamp",
  mipmaps: true,
  pivot: [0.5, 0.5],
  sprites: [],
  volume: 1,
  stream: false,
});

/** A copy of the defaults (safe to change). */
export const defaultImportSettings = (): ImportSettings => ({ ...DEFAULT_IMPORT_SETTINGS, pivot: [0.5, 0.5], sprites: [] });

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
        settings.sprites.push(slice);
      });
    }
  }
  return { settings, problems };
}

const samePair = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

/** The sidecar JSON for `settings`: the format, then only what differs from the defaults. */
export function importSettingsJSON(settings: ImportSettings): Record<string, unknown> {
  const d = DEFAULT_IMPORT_SETTINGS;
  const out: Record<string, unknown> = { format: IMPORT_FORMAT };
  if (settings.pixelsPerUnit !== d.pixelsPerUnit) out.pixelsPerUnit = settings.pixelsPerUnit;
  if (settings.filter !== d.filter) out.filter = settings.filter;
  if (settings.wrap !== d.wrap) out.wrap = settings.wrap;
  if (settings.mipmaps !== d.mipmaps) out.mipmaps = settings.mipmaps;
  if (!samePair(settings.pivot, d.pivot)) out.pivot = [...settings.pivot];
  if (settings.volume !== d.volume) out.volume = settings.volume;
  if (settings.stream !== d.stream) out.stream = settings.stream;
  if (settings.sprites.length > 0) {
    out.sprites = settings.sprites.map((s) => ({ name: s.name, rect: [...s.rect], pivot: [...s.pivot], ...(s.border && s.border.some((b) => b !== 0) ? { border: [...s.border] } : {}) }));
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
