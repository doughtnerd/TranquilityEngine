// The editor's appearance (ADR 0025): colour themes and fonts, per user. A theme is a preset's five
// key colours (background, panel, text, accent, secondary accent), with the user's overrides on
// top, from which every other token is derived (hover, borders, muted text, selection, status
// colours…, kept readable against the panels). Tokens become CSS custom properties on :root; the
// Code panel's Monaco theme and the viewport's overlay colours are made from the same tokens.
import { computed, effect, signal } from "@preact/signals";
import { alpha, ensureContrast, luminance, mix, parseHex, readableOn, rgb, toHex } from "./colorMath";
import { persisted } from "./preferences";
import { formatHex, parseHex as parseHexText } from "../engine/core/colorSpace";

export { alpha, contrast, luminance, mix, parseHex } from "./colorMath";


// --- Tokens and presets -----------------------------------------------------------------------

/** The colours a user can override; every other token is derived from them. */
export interface ThemeBase {
  /** The window background, behind panels. */
  bg: string;
  /** Panel and dock backgrounds. */
  panel: string;
  /** Body text. */
  text: string;
  /** Selection, focus, primary buttons. */
  accent: string;
  /** Secondary highlights (play mode, saved states, success). */
  accent2: string;
}

export const BASE_KEYS = ["accent", "accent2", "bg", "panel", "text"] as const satisfies readonly (keyof ThemeBase)[];

/** What the colour pickers are called in Settings. */
export const BASE_LABELS: Record<keyof ThemeBase, string> = {
  accent: "Accent",
  accent2: "Secondary accent",
  bg: "Background",
  panel: "Panels",
  text: "Text",
};

/** Every themed colour, as CSS custom properties (`--kebab-case` of each key). */
export interface ThemeTokens {
  bg: string;
  bgSunken: string;
  panel: string;
  surface: string;
  hover: string;
  active: string;
  border: string;
  borderStrong: string;
  text: string;
  textStrong: string;
  muted: string;
  faint: string;
  accent: string;
  accentHover: string;
  accentText: string;
  accentSoft: string;
  accentFaint: string;
  accent2: string;
  accent2Soft: string;
  link: string;
  selection: string;
  selectionText: string;
  focusRing: string;
  glow: string;
  button: string;
  buttonHover: string;
  buttonActive: string;
  inputBg: string;
  danger: string;
  dangerStrong: string;
  dangerText: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  successStrong: string;
  successText: string;
  playingBar: string;
  badge: string;
  badgeText: string;
  scrollbar: string;
  scrollbarHover: string;
  shadow: string;
  backdrop: string;
  viewport: string;
  viewportGrid: string;
  viewportGridCenter: string;
  viewportOutline: string;
  viewportGizmo: string;
  // Audio Studio colours (ADR 0349): marker types, reserved ranges of a sample's timeline and a series palette for
  // curve and value lanes. Derived from the preset like the rest, kept legible on the panels.
  markerExit: string;
  markerHit: string;
  markerCue: string;
  markerNote: string;
  rangeTrim: string;
  rangeLoop: string;
  rangePickup: string;
  rangeTail: string;
  "series-1": string;
  "series-2": string;
  "series-3": string;
  "series-4": string;
  "series-5": string;
  "series-6": string;
  "series-7": string;
  "series-8": string;
}

/** The hues the Audio Studio's colours start from beside the preset's own (blue notes, pink cues, salmon hits and pickups, violet tails, magenta). */
const STUDIO_HUES = { blue: "#6aa8ff", pink: "#f07ab4", salmon: "#e8907a", violet: "#b48cf0", magenta: "#e879c6" } as const;

export type ThemeKind = "dark" | "light" | "high-contrast";

export interface ThemePreset {
  id: string;
  name: string;
  kind: ThemeKind;
  base: ThemeBase;
  /** Status colours, adjusted for contrast against the panels. */
  danger: string;
  warning: string;
  success: string;
  /** Tokens set outright instead of derived. */
  tokens?: Partial<ThemeTokens>;
}

export const PRESETS: readonly ThemePreset[] = [
  {
    id: "myco-dark",
    name: "Myco Dark",
    kind: "dark",
    // Near-black with a teal cast, glowing cyan and moss green, warm off-white text (the Myco art).
    base: { bg: "#080c0d", panel: "#0f1517", text: "#f4efe6", accent: "#2ad4d4", accent2: "#8bd12a" },
    danger: "#ff6f6f",
    warning: "#f2b84b",
    success: "#9fd94a",
  },
  {
    id: "myco-light",
    name: "Myco Light",
    kind: "light",
    base: { bg: "#e9ede6", panel: "#f7f8f3", text: "#162221", accent: "#0b7f84", accent2: "#4c8a14" },
    danger: "#c42b2b",
    warning: "#9a5b00",
    success: "#3e7a10",
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    kind: "high-contrast",
    base: { bg: "#000000", panel: "#000000", text: "#ffffff", accent: "#00ffff", accent2: "#c6ff3d" },
    danger: "#ff7070",
    warning: "#ffd23f",
    success: "#c6ff3d",
    tokens: { border: "#a0a0a0", borderStrong: "#ffffff", muted: "#d8d8d8", faint: "#b8b8b8", hover: "#1f2a2a", selection: "#004d4d", selectionText: "#ffffff" },
  },
];

const DEFAULT_PRESET = "myco-dark";

/** Themes the user imported from files (ADR 0116), kept beside the built-in presets. */
export const customThemes = persisted<ThemePreset[]>("myco.editor.customThemes", []);

/** A built-in preset or an imported theme by id (anything unknown: Myco Dark). */
const presetById = (id: string): ThemePreset => PRESETS.find((p) => p.id === id) ?? (Array.isArray(customThemes.value) ? customThemes.value.find((p) => p?.id === id) : undefined) ?? PRESETS[0];

/** Every theme to choose from: the built-in presets, then imported ones. */
export const allPresets = computed<ThemePreset[]>(() => [...PRESETS, ...(Array.isArray(customThemes.value) ? customThemes.value : [])]);

/** Overrides that are real colours, as lower-case `#rrggbb`. */
function cleanOverrides(overrides: Partial<Record<string, unknown>> | null | undefined): Partial<ThemeBase> {
  const out: Partial<ThemeBase> = {};
  for (const key of BASE_KEYS) {
    const v = overrides?.[key];
    const c = typeof v === "string" ? parseHex(v) : null;
    if (c) out[key] = toHex(c);
  }
  return out;
}

/** A preset's key colours with the user's overrides on top. */
export const mergeBase = (preset: ThemePreset, overrides: Partial<Record<string, unknown>> | null | undefined): ThemeBase => ({ ...preset.base, ...cleanOverrides(overrides) });

/** Every token, from a preset and the user's overrides of its key colours. */
function resolveTheme(preset: ThemePreset, overrides?: Partial<Record<string, unknown>> | null): ThemeTokens {
  const base = mergeBase(preset, overrides);
  const { bg, panel, text, accent: accentIn, accent2: accent2In } = base;
  const light = luminance(panel) > 0.4;
  const hc = preset.kind === "high-contrast";
  // Dark themes lift surfaces toward the text colour (tinted with the accent, so greys keep the
  // theme's cast); light themes sink them toward it.
  const tint = light ? text : mix(text, accentIn, 0.3);
  const toward = (c: string, t: number) => mix(c, tint, t);
  const black = light ? "#0a1414" : "#000000";
  const white = "#ffffff";

  const accent = ensureContrast(accentIn, panel, 3, text);
  const accent2 = ensureContrast(accent2In, panel, 3, text);
  const muted = ensureContrast(mix(text, panel, 0.4), panel, 4.5, text);
  const selection = mix(panel, accent, light ? 0.2 : 0.3);
  const accentText = readableOn(accent, white, mix(bg, black, 0.5));
  const statusOn = (c: string) => ensureContrast(c, panel, 4.5, text);
  const danger = statusOn(preset.danger);
  const warning = statusOn(preset.warning);
  const success = statusOn(preset.success);
  const dangerStrong = light ? mix(danger, black, 0.05) : mix(danger, black, 0.45);
  // Studio hues kept legible against the panels (as graphics: 3:1, high contrast 4.5:1), so a light theme darkens them.
  const hue = (c: string) => ensureContrast(hc ? mix(c, white, 0.3) : c, panel, hc ? 4.5 : 3, text);
  const blue = hue(STUDIO_HUES.blue), pink = hue(STUDIO_HUES.pink), salmon = hue(STUDIO_HUES.salmon), violet = hue(STUDIO_HUES.violet), magenta = hue(STUDIO_HUES.magenta);
  const successStrong = light ? mix(accent2, black, 0.1) : mix(accent2, black, 0.35);

  const tokens: ThemeTokens = {
    bg,
    bgSunken: light ? mix(bg, white, 0.6) : mix(bg, black, 0.4),
    panel,
    surface: light ? mix(panel, white, 0.6) : toward(panel, 0.035),
    hover: toward(panel, light ? 0.07 : 0.07),
    active: toward(panel, light ? 0.11 : 0.1),
    border: toward(panel, light ? 0.17 : 0.15),
    borderStrong: toward(panel, light ? 0.3 : 0.24),
    text,
    textStrong: light ? mix(text, black, 0.5) : mix(text, white, 0.5),
    muted,
    faint: ensureContrast(mix(text, panel, 0.62), panel, 2.6, text),
    accent,
    accentHover: light ? mix(accent, black, 0.15) : mix(accent, white, 0.2),
    accentText,
    accentSoft: alpha(accent, light ? 0.18 : 0.22),
    accentFaint: alpha(accent, 0.08),
    accent2,
    accent2Soft: alpha(accent2, light ? 0.18 : 0.2),
    link: ensureContrast(mix(accent, text, light ? 0.15 : 0.35), panel, 4.5, text),
    selection,
    selectionText: ensureContrast(light ? mix(text, black, 0.5) : mix(text, white, 0.5), selection, 4.5, light ? black : white),
    focusRing: accent,
    glow: `0 0 0 1px ${alpha(accent, 0.55)}, 0 0 10px ${alpha(accent, light ? 0.25 : 0.45)}`,
    button: toward(panel, light ? 0.06 : 0.075),
    buttonHover: mix(toward(panel, light ? 0.08 : 0.1), accent, light ? 0.1 : 0.14),
    buttonActive: mix(panel, accent, light ? 0.22 : 0.3),
    inputBg: light ? mix(panel, white, 0.7) : mix(bg, black, 0.25),
    danger,
    dangerStrong,
    dangerText: readableOn(dangerStrong, white, black),
    dangerSoft: alpha(danger, light ? 0.12 : 0.16),
    warning,
    warningSoft: alpha(warning, light ? 0.14 : 0.16),
    success,
    successSoft: alpha(success, light ? 0.16 : 0.18),
    successStrong,
    successText: readableOn(successStrong, white, black),
    playingBar: mix(bg, accent2, light ? 0.16 : 0.12),
    badge: mix(panel, accent, light ? 0.16 : 0.22),
    badgeText: ensureContrast(mix(accent, text, 0.45), mix(panel, accent, light ? 0.16 : 0.22), 4.5, text),
    scrollbar: toward(panel, light ? 0.22 : 0.18),
    scrollbarHover: toward(panel, light ? 0.35 : 0.3),
    shadow: light ? "rgb(20 40 40 / 0.18)" : "rgb(0 0 0 / 0.55)",
    backdrop: light ? "rgb(30 50 50 / 0.3)" : "rgb(0 0 0 / 0.55)",
    viewport: light ? mix(bg, black, 0.06) : mix(bg, text, 0.045),
    viewportGrid: light ? mix(bg, black, 0.14) : mix(bg, text, 0.13),
    viewportGridCenter: light ? mix(bg, black, 0.3) : mix(bg, text, 0.26),
    viewportOutline: accent,
    viewportGizmo: mix(text, bg, 0.2),
    markerExit: accent2,
    markerHit: salmon,
    markerCue: pink,
    markerNote: blue,
    rangeTrim: warning,
    rangeLoop: accent,
    rangePickup: salmon,
    rangeTail: violet,
    "series-1": accent,
    "series-2": accent2,
    "series-3": warning,
    "series-4": blue,
    "series-5": magenta,
    "series-6": violet,
    "series-7": salmon,
    "series-8": ensureContrast(mix(text, panel, 0.3), panel, hc ? 4.5 : 3, text),
  };
  if (hc) Object.assign(tokens, { buttonHover: mix(panel, accent, 0.3), glow: `0 0 0 2px ${accent}` });
  return { ...tokens, ...preset.tokens };
}

/** `accentSoft` → `--accent-soft`. */
export const cssVar = (key: string) => `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;

// --- Fonts -------------------------------------------------------------------------------------

export interface FontChoice {
  label: string;
  value: string;
}

/** UI font families offered in Settings (anything else is typed in as Custom). */
export const UI_FONTS: readonly FontChoice[] = [
  { label: "System default", value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: "Inter (bundled)", value: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: "Segoe UI", value: '"Segoe UI", system-ui, sans-serif' },
  { label: "Helvetica / Arial", value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Georgia (serif)", value: 'Georgia, "Times New Roman", serif' },
  { label: "Monospace", value: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace' },
];

/** Code panel font families offered in Settings. */
export const CODE_FONTS: readonly FontChoice[] = [
  { label: "Default", value: 'Consolas, "Courier New", monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: "JetBrains Mono (bundled)", value: '"JetBrains Mono", Consolas, monospace' },
  { label: "Fira Code", value: '"Fira Code", Consolas, monospace' },
  { label: "Menlo / Monaco", value: 'Menlo, Monaco, "Courier New", monospace' },
  { label: "System monospace", value: "ui-monospace, monospace" },
];

export const DEFAULT_UI_FONT_SIZE = 13;
export const DEFAULT_CODE_FONT_SIZE = 13;
export const UI_FONT_SIZES = { min: 10, max: 20 };
export const CODE_FONT_SIZES = { min: 9, max: 28 };

/** A font size clamped to its range (non-numbers: the default). */
export function clampSize(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, Math.round(n))) : fallback;
}

/** A font family as stored: blank falls back to `fallback`; braces and semicolons can't break out of the CSS value. */
const cleanFamily = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.replace(/[;{}<>]/g, "").trim() : fallback);

// --- Per-user settings and applying them -------------------------------------------------------

/** The chosen theme preset's id. */
export const themePreset = persisted<string>("myco.editor.theme", DEFAULT_PRESET);
/** Overrides of the key colours, per preset id. */
const themeOverrides = persisted<Record<string, Partial<ThemeBase>>>("myco.editor.themeOverrides", {});
export const uiFontFamily = persisted<string>("myco.editor.uiFontFamily", UI_FONTS[0].value);
export const uiFontSize = persisted<number>("myco.editor.uiFontSize", DEFAULT_UI_FONT_SIZE);
export const codeFontFamily = persisted<string>("myco.editor.codeFontFamily", CODE_FONTS[0].value);
export const codeFontSize = persisted<number>("myco.editor.codeFontSize", DEFAULT_CODE_FONT_SIZE);

/** The open project's own theme (ADR 0116, `.myco/theme.json`), set by `projectTheme.ts`; null when it has none. */
export const projectTheme = signal<ThemePreset | null>(null);
/** Per user: keep my own theme even while a project brings one. */
export const ignoreProjectTheme = persisted<boolean>("myco.editor.ignoreProjectTheme", false);
/** Whether the project's theme is the one showing. */
export const projectThemeActive = computed(() => projectTheme.value !== null && !ignoreProjectTheme.value);

/** The preset in use: the project's theme while one applies, otherwise the user's choice. */
export const activePreset = computed(() => (projectThemeActive.value ? projectTheme.value! : presetById(themePreset.value)));
/** The user's overrides of the preset in use (none for a project's theme, which is used as written). */
export const activeOverrides = computed(() => (projectThemeActive.value ? {} : cleanOverrides(themeOverrides.value?.[activePreset.value.id])));
/** Whether the light variant of the logo art reads better here: the logo is art on black, so a light theme gets the dark-ink variant (ADR 0116). */
export const useLightLogo = computed(() => luminance(theme.value.panel) > 0.4);

/** Every token of the theme in use. */
export const theme = computed(() => resolveTheme(activePreset.value, activeOverrides.value));

/** Override one key colour of the preset in use (null: back to the preset's). */
export function setOverride(key: keyof ThemeBase, value: string | null): void {
  if (projectThemeActive.value) return; // a project's theme is used as written
  const id = activePreset.value.id;
  const current = { ...cleanOverrides(themeOverrides.value?.[id]) };
  if (value === null || value.toLowerCase() === presetById(id).base[key].toLowerCase()) delete current[key];
  else current[key] = value;
  themeOverrides.value = { ...themeOverrides.value, [id]: current };
}

/** Drop every override of the preset in use. */
export function resetOverrides(): void {
  const next = { ...themeOverrides.value };
  delete next[activePreset.value.id];
  themeOverrides.value = next;
}

/** Fonts in effect, cleaned. */
export const fonts = computed(() => ({
  ui: cleanFamily(uiFontFamily.value, UI_FONTS[0].value),
  uiSize: clampSize(uiFontSize.value, UI_FONT_SIZES, DEFAULT_UI_FONT_SIZE),
  code: cleanFamily(codeFontFamily.value, CODE_FONTS[0].value),
  codeSize: clampSize(codeFontSize.value, CODE_FONT_SIZES, DEFAULT_CODE_FONT_SIZE),
}));

/** Set the theme's tokens and the UI font as CSS custom properties on `el` (normally :root). */
function applyTheme(el: HTMLElement, tokens: ThemeTokens, kind: ThemeKind, font: { ui: string; uiSize: number; code: string; codeSize: number }): void {
  for (const [key, value] of Object.entries(tokens)) el.style.setProperty(cssVar(key), value);
  el.style.setProperty("--font-ui", font.ui);
  el.style.setProperty("--font-size-ui", `${font.uiSize}px`);
  el.style.setProperty("--ui-scale", String(font.uiSize / DEFAULT_UI_FONT_SIZE));
  el.style.setProperty("--font-code", font.code);
  el.style.setProperty("--font-size-code", `${font.codeSize}px`);
  // Native controls (checkboxes, selects, scrollbars) follow light or dark.
  el.style.colorScheme = kind === "light" ? "light" : "dark";
  el.dataset.theme = kind;
}

/** Keep :root in line with the theme and font settings. Returns a function that stops. */
export function installTheme(root: HTMLElement = document.documentElement): () => void {
  return effect(() => applyTheme(root, theme.value, activePreset.value.kind, fonts.value));
}

/** The theme and fonts the Code panel uses, for Monaco (see `code/monaco.ts`). */
export interface CodeAppearance {
  kind: ThemeKind;
  tokens: ThemeTokens;
  font: string;
  size: number;
}

export const codeAppearance = computed<CodeAppearance>(() => ({ kind: activePreset.value.kind, tokens: theme.value, font: fonts.value.code, size: fonts.value.codeSize }));

/** Monaco's colours for a theme. */
export function monacoColors(t: ThemeTokens): Record<string, string> {
  // Hex tokens normalised to #rrggbb[aa] (their own alpha kept, ADR 0461); anything else passes through as written.
  const hex = (c: string, a = 1) => {
    const p = parseHexText(c);
    return p ? formatHex(p, p[3] * a) : c;
  };
  const withAlpha = (c: string, a: number) => hex(c, a);
  return {
    "editor.background": hex(t.bgSunken),
    "editor.foreground": hex(t.text),
    "editor.lineHighlightBackground": withAlpha(t.text, 0.05),
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": hex(t.faint),
    "editorLineNumber.activeForeground": hex(t.muted),
    "editorGutter.background": hex(t.bgSunken),
    "editorCursor.foreground": hex(t.accent),
    "editor.selectionBackground": withAlpha(t.accent, 0.3),
    "editor.inactiveSelectionBackground": withAlpha(t.accent, 0.16),
    "editor.selectionHighlightBackground": withAlpha(t.accent, 0.14),
    "editor.findMatchBackground": withAlpha(t.accent2, 0.4),
    "editor.findMatchHighlightBackground": withAlpha(t.accent2, 0.2),
    "editorIndentGuide.background1": withAlpha(t.text, 0.08),
    "editorIndentGuide.activeBackground1": withAlpha(t.text, 0.22),
    "editorWhitespace.foreground": withAlpha(t.text, 0.15),
    "editorWidget.background": hex(t.surface),
    "editorWidget.border": hex(t.border),
    "editorSuggestWidget.background": hex(t.surface),
    "editorSuggestWidget.border": hex(t.border),
    "editorSuggestWidget.selectedBackground": hex(t.selection),
    "editorHoverWidget.background": hex(t.surface),
    "editorHoverWidget.border": hex(t.border),
    "editorError.foreground": hex(t.danger),
    "editorWarning.foreground": hex(t.warning),
    "scrollbarSlider.background": withAlpha(t.text, 0.14),
    "scrollbarSlider.hoverBackground": withAlpha(t.text, 0.24),
    "scrollbarSlider.activeBackground": withAlpha(t.accent, 0.4),
    focusBorder: hex(t.accent),
  };
}

/** Viewport overlay colours (grid, selection outline, camera gizmos, collider handles) as 0xRRGGBB numbers. */
export function viewportColors(t: ThemeTokens): { background: number; grid: number; gridCenter: number; outline: number; cameraGizmo: number; handle: number } {
  const n = (c: string) => parseInt(toHex(rgb(c)).slice(1), 16);
  return { background: n(t.viewport), grid: n(t.viewportGrid), gridCenter: n(t.viewportGridCenter), outline: n(t.viewportOutline), cameraGizmo: n(t.viewportGizmo), handle: n(t.accent) };
}
