// The Line inspector's subtitle strip and the Lines table's reading-speed flag (ADR 0343 §3, §6): a subtitle's pages
// over the heard audio, each with the characters per second it asks of a reader while the audio plays, and warnings
// (reading speed over the language's limit, more than two lines, a line over 42 characters at the built-in medium
// size). The Studio has no renderer, so pages are measured by characters (`fitsLines`), the timing and length preview
// 0343 calls for; the editor's Play is the exact one. Pure, over `subtitles.ts`.
import type { LanguageSettings } from "../../../engine/localisation/languages";
import {
  characterCount, fitsLines, pageTimes, readingRule, splitPages, subMarkerTimes, type PageTime, type ReadingRule, type SubtitleMarker,
} from "../../../engine/localisation/subtitles";
import type { SubtitleProjectSettings } from "../../../engine/localisation/subtitleSettings";

/** Characters on one subtitle line at the built-in medium size at 1920×1080 (0343 §6). */
export const LINE_CHARS = 42;
/** Lines on one page (the built-in display's `maxLines`). */
export const PAGE_LINES = 2;

export interface StripPage extends PageTime {
  /** Characters per second while the audio plays this page (its share of the audio, before the reading minimum). */
  readonly cps: number;
  /** `cps` is over the language's reading speed. */
  readonly fast: boolean;
  /** The page's longest line, characters, wrapped at `LINE_CHARS`. */
  readonly longestLine: number;
}

export interface SubtitleStrip {
  readonly language: string;
  readonly rule: ReadingRule;
  readonly pages: readonly StripPage[];
  /** Seconds the subtitle shows (the last page lingers past the audio when the text is long). */
  readonly shown: number;
  /** Seconds of audio it was timed against. */
  readonly duration: number;
  readonly warnings: readonly string[];
}

/** The lines a page wraps into at `max` characters (greedy word wrap, as `fitsLines` counts). */
function wrapped(page: string, max: number): number[] {
  const out: number[] = [];
  for (const paragraph of page.split("\n")) {
    let width = 0;
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const n = characterCount(word);
      if (width > 0 && width + 1 + n > max) { out.push(width); width = 0; }
      width = width === 0 ? n : width + 1 + n;
    }
    out.push(width);
  }
  return out;
}

const round = (n: number) => Math.round(n);

/**
 * The strip of `text` in `language` over `duration` seconds of audio (null: no audio, so the subtitle shows for its
 * reading time), with `markers` from the heard file's sidecar (Cue markers named `sub` time page changes).
 */
export function subtitleStrip(
  text: string, language: string, duration: number | null, languages: LanguageSettings, subtitles: SubtitleProjectSettings | null, markers: readonly SubtitleMarker[] = [],
): SubtitleStrip {
  const rule = readingRule(language, languages, subtitles);
  const pages = splitPages(text, fitsLines(LINE_CHARS, PAGE_LINES));
  const d = duration ?? 0;
  const marks = subMarkerTimes(markers, d);
  // The audio's share of each page: proportional (or by marker) with no reading minimum.
  const share = pageTimes(pages, d, { speed: Infinity, minDisplay: 0 }, marks);
  const shown = pageTimes(pages, d, rule, marks);
  const out: StripPage[] = shown.map((p, i) => {
    const span = share[i] ? share[i].end - share[i].start : 0;
    const cps = duration !== null && span > 0 ? characterCount(p.text) / span : 0;
    return { ...p, cps, fast: cps > rule.speed, longestLine: Math.max(0, ...wrapped(p.text, LINE_CHARS)) };
  });
  const warnings: string[] = [];
  const fastest = out.reduce((m, p) => Math.max(m, p.cps), 0);
  if (fastest > rule.speed) warnings.push(`${round(fastest)} cps, max ${round(rule.speed)}: the subtitle stays ${(Math.max(...out.map((p) => p.end)) - d).toFixed(1)} s after the audio.`);
  const tall = out.filter((p) => wrapped(p.text, LINE_CHARS).length > PAGE_LINES).length;
  if (tall > 0) warnings.push(`${tall} page${tall === 1 ? "" : "s"} over ${PAGE_LINES} lines.`);
  const long = out.filter((p) => p.longestLine > LINE_CHARS).length;
  if (long > 0) warnings.push(`${long} page${long === 1 ? " has" : "s have"} a line over ${LINE_CHARS} characters.`);
  return { language, rule, pages: out, shown: out.length ? out[out.length - 1].end : 0, duration: d, warnings };
}

/** The Lines table's reading-speed flag for a cell: the fastest page's cps over the limit, or null. */
export function readingFlag(strip: SubtitleStrip): { cps: number; max: number } | null {
  const fastest = strip.pages.reduce((m, p) => Math.max(m, p.cps), 0);
  return fastest > strip.rule.speed ? { cps: round(fastest), max: round(strip.rule.speed) } : null;
}
