/**
 * 2D lighting project settings (ADR 0399): `project.json`'s `lighting2D` section, the light blend styles. A top-level
 * section, so the Lights 2D plugin's Project settings category owns it (ADR 0151); the engine reads it (the lit 2D
 * material and the light pass), so it's declared in core with the other runtime sections (ADR 0272).
 *
 * ```jsonc
 * "lighting2D": {
 *   "blendStyles": [
 *     { "name": "Multiply", "mask": "none", "multiply": 1, "add": 0 },
 *     { "name": "Rim",      "mask": "r",    "multiply": 0, "add": 1 }
 *   ]
 * }
 * ```
 *
 * For a lit fragment of albedo `a`: `colour = a·Σ(L·m·multiply) + Σ(L·m·add)`, over the styles in use, where `L` is the
 * style's light and `m` the mask map's channel (1 for `"none"`).
 */

/** Which mask map channel scales a blend style's light (`"none"`: 1). */
export type BlendStyleMask = "none" | "r" | "g" | "b" | "a";
export const BLEND_STYLE_MASKS: readonly BlendStyleMask[] = ["none", "r", "g", "b", "a"];

/** One light blend style (URP's: a multiplicative and an additive weight, and a mask channel). */
export interface LightBlendStyle {
  name: string;
  mask: BlendStyleMask;
  /** How much the light multiplies the sprite's colour (0–4). */
  multiply: number;
  /** How much the light adds to it (0–4). */
  add: number;
}

export interface Lighting2DSettings {
  /** 1 to `MAX_BLEND_STYLES` styles; lights name one, the first when they name none that exists. */
  blendStyles: LightBlendStyle[];
}

/** At most this many blend styles (each is a light texture per layer batch). */
export const MAX_BLEND_STYLES = 4;

export const DEFAULT_BLEND_STYLE: Readonly<LightBlendStyle> = Object.freeze({ name: "Multiply", mask: "none", multiply: 1, add: 0 });

export const defaultLighting2D = (): Lighting2DSettings => ({ blendStyles: [{ ...DEFAULT_BLEND_STYLE }] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const weight = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 4;

/**
 * Read a `lighting2D` section leniently: a bad style is dropped (a bad field takes the default style's value), a fifth
 * style and duplicate names are reported and dropped, and a section without a usable style gets the default.
 */
export function parseLighting2D(raw: unknown, where = "lighting2D"): { settings: Lighting2DSettings; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined) return { settings: defaultLighting2D(), problems };
  if (!isRecord(raw)) return { settings: defaultLighting2D(), problems: [`${where} must be an object with "blendStyles"; using the default.`] };
  for (const key of Object.keys(raw)) if (key !== "blendStyles") problems.push(`${where}: unknown setting "${key}".`);
  const styles: LightBlendStyle[] = [];
  const list = raw.blendStyles;
  if (Array.isArray(list)) {
    list.forEach((s: unknown, i) => {
      const at = `${where}.blendStyles[${i}]`;
      if (!isRecord(s) || typeof s.name !== "string" || !s.name.trim()) return void problems.push(`${at}: a blend style needs a name; skipped.`);
      if (styles.some((t) => t.name === s.name)) return void problems.push(`${at}: another blend style is already named "${s.name}"; skipped.`);
      if (styles.length >= MAX_BLEND_STYLES) return void problems.push(`${at}: there can be at most ${MAX_BLEND_STYLES} blend styles; "${s.name}" is skipped.`);
      const style: LightBlendStyle = { ...DEFAULT_BLEND_STYLE, name: s.name };
      for (const key of Object.keys(s)) if (!["name", "mask", "multiply", "add"].includes(key)) problems.push(`${at} ("${s.name}"): unknown setting "${key}".`);
      if (s.mask !== undefined) {
        if ((BLEND_STYLE_MASKS as readonly unknown[]).includes(s.mask)) style.mask = s.mask as BlendStyleMask;
        else problems.push(`${at} ("${s.name}"): mask should be one of ${BLEND_STYLE_MASKS.map((m) => `"${m}"`).join(", ")}; using "none".`);
      }
      for (const key of ["multiply", "add"] as const) {
        if (s[key] === undefined) continue;
        if (weight(s[key])) style[key] = s[key];
        else problems.push(`${at} ("${s.name}"): ${key} should be a number from 0 to 4; using ${DEFAULT_BLEND_STYLE[key]}.`);
      }
      styles.push(style);
    });
  } else if (list !== undefined) problems.push(`${where}.blendStyles must be a list of blend styles; using the default.`);
  if (styles.length === 0) {
    if (Array.isArray(list)) problems.push(`${where}.blendStyles has no usable blend style; using the default.`);
    styles.push({ ...DEFAULT_BLEND_STYLE });
  }
  return { settings: { blendStyles: styles }, problems };
}

/** The index of the blend style named `name`, or 0 (the first) when none is. */
export function blendStyleIndex(settings: Lighting2DSettings, name: string): number {
  const i = settings.blendStyles.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
}
