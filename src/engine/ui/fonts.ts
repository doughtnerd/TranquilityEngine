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
 * - **Language fonts** (ADR 0356 §5): the current language's `fonts` come after a text's own font and before
 *   Inter, and its `fontReplace` swaps a text's font for another, so the font follows the language (Han
 *   unification: Japanese and Chinese share code points, not glyph shapes). They load as a language
 *   participant: `Locale.setLanguage` (and the start language at boot) waits for them, at most 3 s.
 *
 * Text measured before a font arrives uses the fallback; each arrival bumps `fontEpoch()` and calls
 * the `onFontLoaded` listeners, so the UI core measures its text again and the drawing layer redraws.
 * Without the FontFace API (Node, tests) nothing loads, and the family names are still returned.
 */
import { Locale, localeFonts } from "../localisation/Locale";
import { registerLanguageParticipant } from "../localisation/runtime/participants";
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
  /** Settles once the face loaded (true) or failed (false); resolved at once without the FontFace API. */
  ready: Promise<boolean>;
}

const projectFonts = new Map<string, ProjectFont>();

/** A CSS identifier for a font file's path (unquoted, so it's safe in a canvas font string). */
function familyFor(path: string): string {
  return `myco-font-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The font entry of a file path (loading it on first use), or null when the path isn't a font file (warned once). */
function projectFont(path: string, what: string): ProjectFont | null {
  let entry = projectFonts.get(path);
  if (!entry) {
    if (!FONT_FILE.test(path)) {
      warnOnce(`ext|${path}`, `${what} "${path}" isn't a font file (.ttf, .otf, .woff or .woff2); the text uses Inter.`);
      return null;
    }
    const family = familyFor(path);
    entry = { family, ready: loadProjectFont(path, family) };
    projectFonts.set(path, entry);
  }
  return entry;
}

/** The current language's font families, then Inter and the system font, cached until the language changes. */
let languageStack: { epoch: number; families: string } | null = null;
function languageFamilies(): string {
  const epoch = Locale.epoch;
  if (languageStack?.epoch !== epoch) {
    const own = localeFonts().fonts.map((f) => projectFont(normalizeAssetPath(f.trim()), "Language font")?.family).filter((f): f is string => !!f);
    languageStack = { epoch, families: [...own, UI_FONT_FAMILY].join(", ") };
  }
  return languageStack.families;
}

/**
 * The CSS family list for a `font` field (ADR 0356 §5): the font (or the current language's replacement for it),
 * the language's fonts, then Inter and the system font. Empty is no font of its own; a font file asset is its own
 * family (loaded on first use). Anything else warns once and is left out.
 */
export function fontFamilyOf(font: string | null | undefined): string {
  let path = font ? normalizeAssetPath(font.trim()) : "";
  if (path) {
    const replace = localeFonts().fontReplace;
    const swapped = replace[path] ?? replace[`asset:${path}`];
    if (swapped) path = normalizeAssetPath(swapped.trim());
  }
  const rest = languageFamilies();
  if (!path) return rest;
  const entry = projectFont(path, "UI font");
  return entry ? `${entry.family}, ${rest}` : rest;
}

function loadProjectFont(path: string, family: string): Promise<boolean> {
  const fonts = fontSet();
  if (!fonts) return Promise.resolve(true);
  let url: string;
  try {
    url = Assets.url(path);
  } catch (err) {
    warnOnce(`url|${path}`, `UI font "${path}" couldn't be found: ${(err as Error).message} The text uses Inter.`);
    return Promise.resolve(false);
  }
  const face = new FontFace(family, `url(${JSON.stringify(url)})`, { display: "swap" });
  fonts.add(face);
  return face.load().then(
    () => {
      loaded();
      return true;
    },
    (err: unknown) => {
      fonts.delete(face);
      warnOnce(`load|${path}`, `UI font "${path}" couldn't load (${(err as Error)?.message ?? err}); the text uses Inter.`);
      return false;
    },
  );
}

/** How long a language switch waits for its fonts before switching with the fallback (ADR 0356 §5). */
const LANGUAGE_FONT_TIMEOUT_MS = 3000;

/** Load a language's font files; resolves once all settled, or after `LANGUAGE_FONT_TIMEOUT_MS` with a warning. */
function loadLanguageFonts(code: string): Promise<void> {
  const ready = localeFonts(code).fonts.map((f) => projectFont(normalizeAssetPath(f.trim()), "Language font")?.ready ?? Promise.resolve(false));
  if (ready.length === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warnOnce(`slow|${code}`, `The fonts of "${code}" took longer than ${LANGUAGE_FONT_TIMEOUT_MS / 1000} s to load; switching with the fallback font.`);
      resolve();
    }, LANGUAGE_FONT_TIMEOUT_MS);
  });
  return Promise.race([Promise.all(ready).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

// Language switches wait for the language's fonts (ADR 0356 §5): registered with the UI, which is what draws text.
registerLanguageParticipant({ name: "fonts", prepare: loadLanguageFonts });
