/**
 * The subtitle model (ADR 0343 §3, §5), shared by the audio runtime (subtitle-only lines), the subtitles plugin, the
 * Studio's subtitle strip and the editor:
 *
 * - **Reading speed** of a language in characters per second: its `readingSpeed` in `project.json`, else the built-in
 *   defaults from the Netflix timed-text guides (`ja` 4, `zh*` 9, `ko` 12), else `subtitles.readingSpeed` (15).
 * - **Reading time** of a text: `max(minDisplay, characters / readingSpeed)`, characters being graphemes including
 *   spaces (the speaker name isn't part of the text).
 * - **Pages:** text that doesn't fit (the caller's measure: the UI core's real wrapping, or `fitsLines` for a
 *   character estimate) splits at sentence ends, then clause marks (`, ; : 、 ，`), then words, then anywhere, at the
 *   point that balances the halves; a blank line forces a break.
 * - **Page times:** Cue markers named `sub` time the page changes; without them pages share the line's duration in
 *   proportion to their characters; each page shows at least its reading time, and the last lingers past the audio
 *   when the text is long.
 * - **Rows:** a new line replaces its speaker's row; rows stack oldest first, at most `maxStack`; when full a caption
 *   is dropped before speech, then the oldest row.
 *
 * Pure; no plugin, no DOM.
 */
import { languageOf, type LanguageSettings } from "./languages";
import { DEFAULT_MIN_DISPLAY, DEFAULT_READING_SPEED } from "./subtitleSettings";

/** Built-in reading speeds by primary language subtag (characters per second; Netflix timed-text guides). */
export const BUILTIN_READING_SPEEDS: Readonly<Record<string, number>> = Object.freeze({ ja: 4, zh: 9, ko: 12 });

/** The rule a reading time is measured with. */
export interface ReadingRule {
  /** Characters per second. */
  speed: number;
  /** Seconds. */
  minDisplay: number;
}

/**
 * The reading speed of `code` (0343 §3): its row's `readingSpeed`, else the built-in default for its primary subtag,
 * else `fallback` (the `subtitles.readingSpeed`).
 */
export function readingSpeed(code: string, languages: LanguageSettings | null = null, fallback = DEFAULT_READING_SPEED): number {
  const own = languages ? languageOf(languages, code)?.readingSpeed : null;
  if (own !== null && own !== undefined) return own;
  return BUILTIN_READING_SPEEDS[code.split("-")[0].toLowerCase()] ?? fallback;
}

/** The reading rule of `code` under the project's settings. */
export function readingRule(code: string, languages: LanguageSettings | null, subtitles: { readingSpeed: number; minDisplay: number } | null): ReadingRule {
  return { speed: readingSpeed(code, languages, subtitles?.readingSpeed ?? DEFAULT_READING_SPEED), minDisplay: subtitles?.minDisplay ?? DEFAULT_MIN_DISPLAY };
}

let segmenter: Intl.Segmenter | null | undefined;

/** The graphemes of `text` (`Intl.Segmenter`; code points where it is missing). */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    try { segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch { segmenter = null; }
  }
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/** Characters as subtitle guides count them: graphemes including spaces, line breaks not counted. */
export const characterCount = (text: string): number => graphemes(text.replace(/\r?\n/g, "")).length;

/** Seconds `text` needs on screen: `max(minDisplay, characters / speed)`. */
export function readingTime(text: string, rule: ReadingRule): number {
  const speed = rule.speed > 0 ? rule.speed : DEFAULT_READING_SPEED;
  return Math.max(rule.minDisplay, characterCount(text) / speed);
}

/** Characters per second a page shown for `seconds` asks of the reader (the Studio's "21 cps" flag). */
export const charactersPerSecond = (text: string, seconds: number): number => (seconds > 0 ? characterCount(text) / seconds : Infinity);

// --- pages -----------------------------------------------------------------------------------------------------------

/** Whether a candidate page fits the display. */
export type PageFits = (page: string) => boolean;

/**
 * A character-count measure for previews without a renderer: greedy word wrap at `maxChars` graphemes per line,
 * fitting when it takes at most `maxLines` lines (a word longer than a line breaks anywhere). Subtitle guides use 42
 * characters and 2 lines.
 */
export function fitsLines(maxChars = 42, maxLines = 2): PageFits {
  return (page) => {
    let lines = 0;
    for (const paragraph of page.split("\n")) {
      let width = 0;
      lines++;
      for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
        const n = characterCount(word);
        const needed = width === 0 ? n : width + 1 + n;
        if (width > 0 && needed > maxChars) { lines++; width = 0; }
        if (width === 0 && n > maxChars) {
          lines += Math.ceil(n / maxChars) - 1;
          width = n - (Math.ceil(n / maxChars) - 1) * maxChars;
        } else width = width === 0 ? n : width + 1 + n;
      }
      if (lines > maxLines) return false;
    }
    return lines <= maxLines;
  };
}

const SENTENCE = /[.!?…。！？]["'”’»)」』）]*\s+|[。！？]["'”’»)」』）]*/gu;
const CLAUSE = /[,;:]\s+|[、，；：]/gu;
const WORD = /\s+/gu;

/** The split points (offsets after the mark and the space) of `text` at one level. */
function splitPoints(text: string, re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[0].length;
    if (at > 0 && at < text.length) out.push(at);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function split(text: string, fits: PageFits, out: string[]): void {
  if (fits(text)) return void out.push(text);
  const chars = graphemes(text);
  if (chars.length <= 1) return void out.push(text);
  for (const level of [SENTENCE, CLAUSE, WORD, null]) {
    let points = level ? splitPoints(text, level) : [];
    if (!level) {
      // Anywhere: between graphemes (Chinese and Japanese text has no spaces).
      let at = 0;
      points = chars.slice(0, -1).map((c) => (at += c.length));
    }
    if (points.length === 0) continue;
    // Balance the halves: the point nearest the middle by characters.
    const half = characterCount(text) / 2;
    let best = points[0];
    for (const p of points) if (Math.abs(characterCount(text.slice(0, p)) - half) < Math.abs(characterCount(text.slice(0, best)) - half)) best = p;
    split(text.slice(0, best).trimEnd(), fits, out);
    split(text.slice(best).trimStart(), fits, out);
    return;
  }
  out.push(text);
}

/**
 * The pages of a subtitle: blank lines force breaks, then each part that doesn't `fit` is halved at the best split
 * point of the highest level that has one (sentence, clause, word, anywhere), recursively. Empty text has no pages.
 */
export function splitPages(text: string, fits: PageFits): string[] {
  const out: string[] = [];
  for (const part of text.split(/\r?\n[ \t]*\r?\n/)) {
    const p = part.trim();
    if (p !== "") split(p, fits, out);
  }
  return out;
}

/** A page's display interval in seconds from the line's start. */
export interface PageTime {
  text: string;
  start: number;
  end: number;
}

/** A Cue marker (0328) as the subtitle model needs it. */
export interface SubtitleMarker {
  type: string;
  name: string;
  /** Seconds from the line's start (the heard file's trim applied by the caller). */
  at: number;
}

/** The times of the `sub` Cue markers among `markers`, sorted, inside `(0, duration)`. */
export function subMarkerTimes(markers: readonly SubtitleMarker[], duration = Infinity): number[] {
  return markers.filter((m) => m.type === "cue" && m.name === "sub" && m.at > 0 && m.at < duration).map((m) => m.at).sort((a, b) => a - b);
}

/**
 * When each page shows, for a line of `duration` seconds. Page `i > 0` starts at the `i`th `sub` marker when there is
 * one, else the pages after the last marker share the time left in proportion to their characters. Then each page
 * shows at least its reading time (pushing later pages back), and the last ends at the later of the audio's end and its
 * own start plus its reading time.
 */
export function pageTimes(pages: readonly string[], duration: number, rule: ReadingRule, markers: readonly number[] = []): PageTime[] {
  const n = pages.length;
  if (n === 0) return [];
  const d = Math.max(0, duration);
  const starts: number[] = [0];
  const marks = markers.filter((m) => m > 0 && m < d).sort((a, b) => a - b).slice(0, n - 1);
  for (const m of marks) starts.push(m);
  // Pages without a marker share what is left, by characters.
  const from = starts.length - 1;
  const counts = pages.map(characterCount);
  const left = counts.slice(from).reduce((a, b) => a + b, 0) || 1;
  let t = starts[from];
  const span = d - t;
  for (let i = from; i < n - 1; i++) starts.push((t += (span * counts[i]) / left));
  const out: PageTime[] = [];
  for (let i = 0; i < n; i++) {
    const min = readingTime(pages[i], rule);
    const start = i === 0 ? 0 : Math.max(starts[i], out[i - 1].start + readingTime(pages[i - 1], rule));
    if (i > 0) out[i - 1].end = start;
    out.push({ text: pages[i], start, end: i === n - 1 ? Math.max(d, start + min) : start });
  }
  return out;
}

// --- rows ------------------------------------------------------------------------------------------------------------

/** A row on the display: a speech line (with its speaker, or null) or a caption. */
export interface SubtitleRow {
  id: number;
  kind: "speech" | "caption";
  speaker: string | null;
}

/**
 * The rows after `row` arrives (0343 §5): speech replaces the row of the same speaker; the new row goes last (nearest
 * the edge); over `maxStack`, the oldest caption is dropped first, then the oldest row. Returns a new list.
 */
export function pushRow<R extends SubtitleRow>(rows: readonly R[], row: R, maxStack: number): R[] {
  const out = rows.filter((r) => !(row.kind === "speech" && row.speaker !== null && r.kind === "speech" && r.speaker === row.speaker));
  out.push(row);
  const limit = Math.max(1, Math.floor(maxStack));
  while (out.length > limit) {
    const caption = out.findIndex((r) => r.kind === "caption" && r !== row);
    out.splice(caption >= 0 ? caption : 0, 1);
  }
  return out;
}
