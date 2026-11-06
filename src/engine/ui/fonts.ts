/**
 * UI fonts (ADR 0076): the bundled Inter and project font files, loaded with the FontFace API so the
 * 2D canvas that measures and draws UI text can use them. Nothing here is public API.
 *
 * - **Inter** ships with the engine (`fonts/Inter-latin-wght.woff2`, SIL OFL, `fonts/Inter-OFL.txt`):
 *   the variable font (weights 100–900) subset to Latin, Latin-1 and common punctuation, 48 KB.
 *   Other characters fall back, glyph by glyph, to `system-ui, sans-serif`.
 * - **Project fonts**: a `font` field names a font file asset (`.ttf`, `.otf`, `.woff`, `.woff2`). It
 *   loads on first use under a generated family name, with Inter after it.
 *
 * Text measured before a font arrives uses the fallback; each arrival bumps `fontEpoch()` and calls
 * the `onFontLoaded` listeners, so the UI core measures its text again and the drawing layer redraws.
 * Without the FontFace API (Node, tests) nothing loads, and the family names are still returned.
 */
import { Assets, normalizeAssetPath } from "../scene/Assets";

/** The bundled font's CSS family name. */
export const BUNDLED_FONT_FAMILY = "Inter";
/** The family list every UI text uses when its `font` is empty. */
export const UI_FONT_FAMILY = `${BUNDLED_FONT_FAMILY}, system-ui, sans-serif`;
/** File extensions a `font` field may name. */
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

let epoch = 0;
const listeners = new Set<() => void>();
const warned = new Set<string>();

/** Increases each time a font finishes loading (text measured before it is stale). */
export function fontEpoch(): number {
  return epoch;
}

/** Call `fn` whenever a font finishes loading. Returns the unsubscribe function. */
export function onFontLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function loaded(): void {
  epoch++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error("[myco] a font listener failed:", err);
    }
  }
}

/** The document's font set, when this environment can load fonts. */
function fontSet(): FontFaceSet | null {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return null;
  return document.fonts;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

let bundled: Promise<void> | null = null;

/**
 * Load the bundled Inter once. Never rejects: on failure the text draws in the fallback fonts.
 * Vite bundles the file as an asset (the player, the editor and exported games ship it under
 * `assets/`); the engine library build puts it beside its bundle (vite.engine.config.ts).
 */
export function loadBundledFont(): Promise<void> {
  bundled ??= (async () => {
    const fonts = fontSet();
    if (!fonts) return;
    const url = new URL("./fonts/Inter-latin-wght.woff2", import.meta.url);
    const face = new FontFace(BUNDLED_FONT_FAMILY, `url(${JSON.stringify(url.href)}) format("woff2")`, { weight: "100 900", style: "normal", display: "swap" });
    fonts.add(face);
    await face.load();
    loaded();
  })().catch((err: unknown) => warnOnce("bundled", `the bundled Inter font couldn't load, so UI text uses the system font: ${(err as Error)?.message ?? err}`));
  return bundled;
}

interface ProjectFont {
  readonly family: string;
}

const projectFonts = new Map<string, ProjectFont>();

/** A CSS identifier for a font file's path (unquoted, so it's safe in a canvas font string). */
function familyFor(path: string): string {
  return `myco-font-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * The CSS family list for a `font` field: empty is the bundled Inter; a font file asset is its own
 * family (loaded on first use) followed by Inter. Anything else warns once and uses Inter.
 */
export function fontFamilyOf(font: string | null | undefined): string {
  const path = font ? normalizeAssetPath(font.trim()) : "";
  if (!path) return UI_FONT_FAMILY;
  let entry = projectFonts.get(path);
  if (!entry) {
    if (!FONT_FILE.test(path)) {
      warnOnce(`ext|${path}`, `UI font "${path}" isn't a font file (.ttf, .otf, .woff or .woff2); the text uses Inter.`);
      return UI_FONT_FAMILY;
    }
    entry = { family: familyFor(path) };
    projectFonts.set(path, entry);
    loadProjectFont(path, entry.family);
  }
  return `${entry.family}, ${UI_FONT_FAMILY}`;
}

function loadProjectFont(path: string, family: string): void {
  const fonts = fontSet();
  if (!fonts) return;
  let url: string;
  try {
    url = Assets.url(path);
  } catch (err) {
    warnOnce(`url|${path}`, `UI font "${path}" couldn't be found: ${(err as Error).message} The text uses Inter.`);
    return;
  }
  const face = new FontFace(family, `url(${JSON.stringify(url)})`, { display: "swap" });
  fonts.add(face);
  face
    .load()
    .then(loaded)
    .catch((err: unknown) => {
      fonts.delete(face);
      warnOnce(`load|${path}`, `UI font "${path}" couldn't load (${(err as Error)?.message ?? err}); the text uses Inter.`);
    });
}

/** @internal Tests: forget loaded fonts and listeners' state. */
export function _resetFonts(): void {
  bundled = null;
  projectFonts.clear();
  warned.clear();
  epoch = 0;
}
