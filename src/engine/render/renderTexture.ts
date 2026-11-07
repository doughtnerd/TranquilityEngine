/**
 * Render texture assets (ADR 0109): `*.rendertexture.json` files describing a texture a Camera draws
 * into (its `targetTexture`) and that materials, sprites and UI images name like any image.
 *
 * ```jsonc
 * { "width": 512, "height": 512, "format": "ldr", "depth": true, "filter": "linear", "wrap": "clamp" }
 * ```
 *
 * - `format`: `ldr` (8 bits a channel, tone mapped and sRGB-encoded by the camera, like the screen)
 *   or `hdr` (half float, linear and not tone mapped, for emissive screens and effects that need
 *   values above 1).
 * - `depth`: whether the camera draws with a depth buffer (off for flat 2D or UI captures).
 *
 * Pure: read leniently like other assets, so it's tested without a GPU.
 */

export type RenderTextureFormat = "ldr" | "hdr";
export type RenderTextureFilter = "linear" | "point";
export type RenderTextureWrap = "clamp" | "repeat" | "mirror";

export interface RenderTextureSettings {
  /** Pixels, 1–4096. */
  width: number;
  /** Pixels, 1–4096. */
  height: number;
  format: RenderTextureFormat;
  depth: boolean;
  filter: RenderTextureFilter;
  wrap: RenderTextureWrap;
}

/** The suffix render texture assets end with. */
export const RENDER_TEXTURE_SUFFIX = ".rendertexture.json";

/** Whether a project path (with or without `asset:`) names a render texture asset. */
export function isRenderTexturePath(path: string): boolean {
  return path.split(/[?#]/)[0]!.toLowerCase().endsWith(RENDER_TEXTURE_SUFFIX);
}

export const defaultRenderTexture = (): RenderTextureSettings => ({ width: 512, height: 512, format: "ldr", depth: true, filter: "linear", wrap: "clamp" });

const KEYS = ["width", "height", "format", "depth", "filter", "wrap"];

/** Read a render texture asset: bad values are reported and replaced by the defaults. */
export function parseRenderTexture(raw: unknown, where = "render texture"): { settings: RenderTextureSettings; problems: string[] } {
  const settings = defaultRenderTexture();
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${where} must be an object; using a 512×512 texture.`);
    return { settings, problems };
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!KEYS.includes(key)) problems.push(`${where}: unknown setting "${key}".`);
  for (const key of ["width", "height"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4096) settings[key] = v;
    else problems.push(`${where}: ${key} should be a whole number from 1 to 4096; using ${settings[key]}.`);
  }
  const choice = <K extends "format" | "filter" | "wrap">(key: K, options: readonly RenderTextureSettings[K][]) => {
    const v = r[key];
    if (v === undefined) return;
    if (options.includes(v as RenderTextureSettings[K])) settings[key] = v as RenderTextureSettings[K];
    else problems.push(`${where}: ${key} should be ${options.map((o) => `"${o}"`).join(" or ")}; using "${settings[key]}".`);
  };
  choice("format", ["ldr", "hdr"]);
  choice("filter", ["linear", "point"]);
  choice("wrap", ["clamp", "repeat", "mirror"]);
  if (r.depth !== undefined) {
    if (typeof r.depth === "boolean") settings.depth = r.depth;
    else problems.push(`${where}: depth should be true or false; using true.`);
  }
  return { settings, problems };
}

/** The file text for a render texture asset (keys in a fixed order). */
export function formatRenderTexture(s: RenderTextureSettings): string {
  return JSON.stringify({ width: s.width, height: s.height, format: s.format, depth: s.depth, filter: s.filter, wrap: s.wrap }, null, 2) + "\n";
}
