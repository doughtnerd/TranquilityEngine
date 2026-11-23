/**
 * Line breaking for UI text (ADR 0356 §5): where a line may end, and greedy wrapping to a width. The UI's text
 * measuring (`render/babylon/ui.ts` `textSize`) and its drawing (the text block's line wrapper) both wrap through
 * `wrapLine`, so the lines measured are the lines drawn.
 *
 * - `normal` (`UIText.wordBreak` `break-word`): a line may end after a run of spaces (today's Latin behaviour), between
 *   ideographs, kana and Hangul syllables and next to them, with the Japanese and Chinese line-start and line-end rules
 *   (kinsoku: no line starts with closing punctuation, small kana or the prolonged sound mark, none ends with an opening
 *   bracket), and between the words of Thai, Lao, Khmer and Myanmar text, which `Intl.Segmenter` finds (word
 *   granularity; without it, those runs break only at spaces).
 * - `anywhere` (`break-all`): between any two graphemes.
 *
 * A line that is wider than the width with no place to break overflows, as on the web. Pure; no DOM.
 */

export type LineBreakMode = "normal" | "anywhere";

/** One wrapped line and its measured width. */
export interface WrappedLine {
  readonly text: string;
  readonly width: number;
}

/** Characters no line starts with (JIS X 4051 classes: closing brackets, punctuation, small kana, iteration marks). */
const NO_START = new Set(
  [
    ...")]}）］｝〕〉》」』】〙〗〟’”｠»",
    ...",.!?:;%、。，．！？：；・‥…‼⁇⁈⁉％‰℃°′″",
    ...("ヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻ゝゞ" + "‐゠–〜～"),
  ],
);
/** Characters no line ends with (opening brackets and quotes). */
const NO_END = new Set([..."([{（［｛〔〈《「『【〘〖〝‘“｟«"]);

/** Ideographs, kana, Hangul, Bopomofo and CJK punctuation and full-width forms: a line may break on either side. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿゠・ー＀-￯]/u;
/** Scripts written without spaces between words, segmented by dictionary. */
const SEGMENTED: readonly (readonly [RegExp, string])[] = [
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Lao}/u, "lo"],
  [/\p{Script=Khmer}/u, "km"],
  [/\p{Script=Myanmar}/u, "my"],
];

type Segmenter = { segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
type SegmenterCtor = new (locale?: string, options?: { granularity: "grapheme" | "word" }) => Segmenter;
const SegmenterClass = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
const segmenters = new Map<string, Segmenter | null>();

function segmenter(locale: string | undefined, granularity: "grapheme" | "word"): Segmenter | null {
  const key = `${locale ?? ""}|${granularity}`;
  let s = segmenters.get(key);
  if (s === undefined) {
    try {
      s = SegmenterClass ? new SegmenterClass(locale, { granularity }) : null;
    } catch {
      s = null;
    }
    segmenters.set(key, s);
  }
  return s;
}

/** A text's graphemes (user-perceived characters), or its code points without `Intl.Segmenter`. */
export function graphemes(text: string): string[] {
  const s = segmenter(undefined, "grapheme");
  return s ? Array.from(s.segment(text), (g) => g.segment) : [...text];
}

const segmentedLocale = (g: string): string | null => {
  for (const [re, locale] of SEGMENTED) if (re.test(g)) return locale;
  return null;
};

/**
 * The text cut at every place a line may break, in order: joined, the pieces are the text. Each piece ends where a line
 * may end (a run of spaces stays at the end of the piece before the break). Splits no grapheme.
 */
export function lineSegments(text: string, mode: LineBreakMode = "normal"): string[] {
  if (text === "") return [];
  const gs = graphemes(text);
  if (mode === "anywhere") return gs;
  /** breakBefore[i]: a line may start at grapheme i. */
  const breakBefore = new Array<boolean>(gs.length).fill(false);
  // Words of Thai, Lao, Khmer and Myanmar runs.
  for (let i = 0; i < gs.length; ) {
    const locale = segmentedLocale(gs[i]);
    if (!locale) {
      i++;
      continue;
    }
    let j = i;
    while (j < gs.length && segmentedLocale(gs[j]) === locale) j++;
    const s = segmenter(locale, "word");
    if (s) {
      // Grapheme index of each UTF-16 offset in the run.
      const offsets = new Map<number, number>();
      let at = 0;
      for (let k = i; k < j; k++) {
        offsets.set(at, k);
        at += gs[k].length;
      }
      for (const w of s.segment(gs.slice(i, j).join(""))) {
        const k = offsets.get(w.index);
        if (k !== undefined && k > i) breakBefore[k] = true;
      }
    }
    i = j;
  }
  for (let i = 1; i < gs.length; i++) {
    const prev = gs[i - 1];
    const cur = gs[i];
    if (cur === " ") {
      breakBefore[i] = false; // spaces stay with the piece before them
      continue;
    }
    if (prev === " ") breakBefore[i] = true;
    else if (CJK.test(prev) || CJK.test(cur)) breakBefore[i] = true;
    if (breakBefore[i] && prev !== " " && (NO_START.has(firstChar(cur)) || NO_END.has(lastChar(prev)))) breakBefore[i] = false;
  }
  const out: string[] = [];
  let piece = gs[0];
  for (let i = 1; i < gs.length; i++) {
    if (breakBefore[i]) {
      out.push(piece);
      piece = gs[i];
    } else piece += gs[i];
  }
  out.push(piece);
  return out;
}

const firstChar = (g: string): string => String.fromCodePoint(g.codePointAt(0)!);
const lastChar = (g: string): string => [...g].pop()!;

/**
 * One paragraph (no line breaks) wrapped greedily to `maxWidth`: each line takes pieces while it fits, measured without
 * the spaces it ends with (which are dropped from the line). A first piece wider than `maxWidth` overflows on its own
 * line. `measure` gives a string's width in the same units as `maxWidth`.
 */
export function wrapLine(line: string, maxWidth: number, measure: (text: string) => number, mode: LineBreakMode = "normal"): WrappedLine[] {
  if (!Number.isFinite(maxWidth)) return [{ text: line, width: measure(line) }];
  const pieces = lineSegments(line, mode);
  if (pieces.length === 0) return [{ text: "", width: measure("") }];
  const out: WrappedLine[] = [];
  let current = "";
  let currentWidth = 0;
  for (const piece of pieces) {
    const test = current + piece;
    const shown = test.replace(/ +$/, "");
    const w = measure(shown);
    if (current !== "" && w > maxWidth) {
      out.push({ text: current.replace(/ +$/, ""), width: currentWidth });
      current = piece;
      currentWidth = measure(piece.replace(/ +$/, ""));
    } else {
      current = test;
      currentWidth = w;
    }
  }
  out.push({ text: current.replace(/ +$/, ""), width: currentWidth });
  return out;
}

/** Text wrapped to `maxWidth`: each paragraph (split at `\n`) wrapped by `wrapLine`. */
export function wrapText(text: string, maxWidth: number, measure: (text: string) => number, mode: LineBreakMode = "normal"): WrappedLine[] {
  return text.split("\n").flatMap((p) => wrapLine(p, maxWidth, measure, mode));
}
