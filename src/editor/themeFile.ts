// Theme files (ADR 0116): a theme as a small JSON file, to export from Settings, import from a
// friend, or keep in a project (`.myco/theme.json`). The format is versioned ("myco.theme@1") and
// read leniently: a missing or unreadable colour falls back to the built-in theme of the same
// kind, so a hand-written file with just a name and two colours still loads. Pure functions, no
// DOM; `projectTheme.ts` and the Settings dialog do the file and storage work.
import { BASE_KEYS, luminance, parseHex, PRESETS, mergeBase, type ThemeBase, type ThemeKind, type ThemePreset } from "./theme";

export const THEME_FORMAT = "myco.theme";
export const THEME_VERSION = 1;
export const THEME_FORMAT_ID = `${THEME_FORMAT}@${THEME_VERSION}`;

/** Where a project's own theme lives, relative to the project root. */
export const PROJECT_THEME_PATH = ".myco/theme.json";

const STATUS_KEYS = ["danger", "warning", "success"] as const;
const KINDS: readonly ThemeKind[] = ["dark", "light", "high-contrast"];

/** A theme file as written. */
export interface ThemeFile {
  format: string;
  name: string;
  kind: ThemeKind;
  base: ThemeBase;
  danger: string;
  warning: string;
  success: string;
}

export interface ParsedTheme {
  /** The theme, ready to use; null when the text isn't a theme at all. */
  theme: ThemePreset | null;
  /** What was wrong or replaced by a default (shown to the user; the theme may still be usable). */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const hexOf = (v: unknown): string | null => {
  const c = typeof v === "string" ? parseHex(v) : null;
  return c ? `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}` : null;
};

/** A name as stored: trimmed, single-line, at most 60 characters. */
export const cleanThemeName = (v: unknown, fallback = "Imported theme") => {
  const n = typeof v === "string" ? v.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return n || fallback;
};

/** A stable id for an imported theme: `custom-` and the name's slug. */
export const themeIdFor = (name: string) => `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme"}`;

/** The kind a theme's colours suggest (dark or light by the panel's luminance). */
export const kindOfBase = (base: ThemeBase): ThemeKind => (luminance(base.panel) > 0.4 ? "light" : "dark");

/** The built-in theme whose colours stand in for a kind's missing ones. */
const fallbackFor = (kind: ThemeKind): ThemePreset => PRESETS.find((p) => p.kind === kind) ?? PRESETS[0];

/** A theme as a file: its name, kind and (override-applied) key colours. */
export function toThemeFile(preset: ThemePreset, overrides?: Partial<Record<string, unknown>> | null, name = preset.name): ThemeFile {
  return { format: THEME_FORMAT_ID, name: cleanThemeName(name, preset.name), kind: preset.kind, base: mergeBase(preset, overrides), danger: preset.danger, warning: preset.warning, success: preset.success };
}

export const serializeThemeFile = (file: ThemeFile): string => `${JSON.stringify(file, null, 2)}\n`;

/**
 * Read a theme file's text. Lenient: unknown keys are ignored, bad colours are replaced by the
 * same-kind built-in's (and reported), a newer format version is read as far as it makes sense,
 * and a missing kind comes from the panel colour. Only text that isn't a JSON object (or has no
 * colours at all) gives no theme.
 */
export function parseThemeFile(text: string): ParsedTheme {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { theme: null, problems: ["The file isn't valid JSON."] };
  }
  if (!isRecord(raw)) return { theme: null, problems: ["The file doesn't hold a theme (expected a JSON object)."] };

  const format = typeof raw.format === "string" ? raw.format : undefined;
  const m = format ? /^myco\.theme@(\d+)$/.exec(format) : null;
  if (format !== undefined && !m) problems.push(`Unknown format "${format}"; reading it as a Myco theme.`);
  else if (m && Number(m[1]) > THEME_VERSION) problems.push(`The file is from a newer version of the editor (${format}); unknown parts are ignored.`);

  const baseIn = isRecord(raw.base) ? raw.base : isRecord(raw.colors) ? raw.colors : isRecord(raw.colours) ? raw.colours : undefined;
  if (!baseIn || !BASE_KEYS.some((k) => hexOf(baseIn[k]))) return { theme: null, problems: [...problems, "The file has no theme colours (expected a \"base\" object with bg, panel, text, accent and accent2)."] };

  // The kind: as written, else from the panel colour if there is one, else dark.
  const panelGuess = hexOf(baseIn.panel);
  let kind: ThemeKind;
  if (typeof raw.kind === "string" && (KINDS as readonly string[]).includes(raw.kind)) kind = raw.kind as ThemeKind;
  else {
    kind = panelGuess ? (luminance(panelGuess) > 0.4 ? "light" : "dark") : "dark";
    if (raw.kind !== undefined) problems.push(`Unknown kind "${String(raw.kind)}"; using ${kind}.`);
  }
  const fallback = fallbackFor(kind);

  const base = { ...fallback.base };
  for (const key of BASE_KEYS) {
    const c = hexOf(baseIn[key]);
    if (c) base[key] = c;
    else if (baseIn[key] !== undefined) problems.push(`"${key}" isn't a hex colour; using ${fallback.name}'s ${fallback.base[key]}.`);
  }
  const status = {} as Record<(typeof STATUS_KEYS)[number], string>;
  for (const key of STATUS_KEYS) {
    const c = hexOf(raw[key]);
    status[key] = c ?? fallback[key];
    if (!c && raw[key] !== undefined) problems.push(`"${key}" isn't a hex colour; using the default.`);
  }

  const name = cleanThemeName(raw.name);
  return { theme: { id: themeIdFor(name), name, kind, base, ...status }, problems };
}
