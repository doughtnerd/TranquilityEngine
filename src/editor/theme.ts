// The editor's appearance (ADR 0025): colour themes and fonts, per user. A theme is a preset's five
// key colours (background, panel, text, accent, secondary accent), with the user's overrides on
// top, from which every other token is derived (hover, borders, muted text, selection, status
// colours…, kept readable against the panels). Tokens become CSS custom properties on :root; the
// Code panel's Monaco theme and the viewport's overlay colours are made from the same tokens.
import { computed, effect } from "@preact/signals";
import { persisted } from "./preferences";

// --- Colour maths -----------------------------------------------------------------------------

type RGB = [number, number, number];

/** `#rgb` or `#rrggbb` to 0–255 channels (anything else: null). */
export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

const rgb = (hex: string): RGB => parseHex(hex) ?? [0, 0, 0];

/** `a` moved `t` (0–1) of the way to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** A colour with alpha, as CSS `rgb(r g b / a)`. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
}

/** WCAG relative luminance (0 black – 1 white). */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg`, moved toward `toward` in small steps until it has `min` contrast against `bg` (or reaches it). */
export function ensureContrast(fg: string, bg: string, min: number, toward: string): string {
  let c = fg;
  for (let t = 0.1; contrast(c, bg) < min && t <= 1.001; t += 0.1) c = mix(fg, toward, t);
  return c;
}

/** Whichever of `light` and `dark` reads better on `bg`. */
const readableOn = (bg: string, light: string, dark: string) => (contrast(light, bg) >= contrast(dark, bg) ? light : dark);

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
}

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

export const DEFAULT_PRESET = "myco-dark";

export const presetById = (id: string): ThemePreset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

/** Overrides that are real colours, as lower-case `#rrggbb`. */
export function cleanOverrides(overrides: Partial<Record<string, unknown>> | null | undefined): Partial<ThemeBase> {
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
export function resolveTheme(preset: ThemePreset, overrides?: Partial<Record<string, unknown>> | null): ThemeTokens {
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
  { label: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
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
export const cleanFamily = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.replace(/[;{}<>]/g, "").trim() : fallback);

// --- Per-user settings and applying them -------------------------------------------------------

/** The chosen theme preset's id. */
export const themePreset = persisted<string>("myco.editor.theme", DEFAULT_PRESET);
/** Overrides of the key colours, per preset id. */
export const themeOverrides = persisted<Record<string, Partial<ThemeBase>>>("myco.editor.themeOverrides", {});
export const uiFontFamily = persisted<string>("myco.editor.uiFontFamily", UI_FONTS[0].value);
export const uiFontSize = persisted<number>("myco.editor.uiFontSize", DEFAULT_UI_FONT_SIZE);
export const codeFontFamily = persisted<string>("myco.editor.codeFontFamily", CODE_FONTS[0].value);
export const codeFontSize = persisted<number>("myco.editor.codeFontSize", DEFAULT_CODE_FONT_SIZE);

/** The preset in use. */
export const activePreset = computed(() => presetById(themePreset.value));
/** The user's overrides of the preset in use. */
export const activeOverrides = computed(() => cleanOverrides(themeOverrides.value?.[activePreset.value.id]));
/** Every token of the theme in use. */
export const theme = computed(() => resolveTheme(activePreset.value, activeOverrides.value));

/** Override one key colour of the preset in use (null: back to the preset's). */
export function setOverride(key: keyof ThemeBase, value: string | null): void {
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
export function applyTheme(el: HTMLElement, tokens: ThemeTokens, kind: ThemeKind, font: { ui: string; uiSize: number; code: string; codeSize: number }): void {
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
  const hex = (c: string) => (parseHex(c) ? toHex(rgb(c)) : c);
  const withAlpha = (c: string, a: number) => `${hex(c)}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
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
