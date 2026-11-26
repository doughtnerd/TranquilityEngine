/**
 * Inline text layout (ADR 0425): a text element's styled runs laid out together as one paragraph flow, the way a browser
 * lays out phrasing content. The UI core measures with it (Yoga's measure of a text element with runs), publishes its
 * lines for the drawing layer to draw as they are, hit-tests runs with it and places the caret of editable text, so what's
 * measured, drawn, hit and edited is one layout.
 *
 * - **Line breaking across runs.** The runs' text is joined and broken where `lineBreak.ts` allows (spaces, CJK with the
 *   kinsoku rules, Thai words; anywhere for `wrap: "anywhere"`), so a word split between runs (`<b>bo</b>ld`) stays
 *   whole and a break can fall inside a run. An inline image is a place to break on both sides; a line break run (`\n`)
 *   ends the line. Lines fill greedily; trailing spaces hang past the width; a piece wider than the width overflows.
 * - **Line boxes.** Each line is as tall as its tallest run (font size × line height, images by their height), with the
 *   paragraph's own font as a strut, so plain text keeps its line height. Runs sit on a common baseline, `shift` raising
 *   or lowering theirs (`sub`, `super`); `middle`, `top`, `bottom`, `text-top` and `text-bottom` align as in CSS.
 * - **Direction.** Lines are aligned per `align` (an edge, `start`/`end` already resolved); in a right-to-left paragraph a
 *   line's fragments are placed from the right in logical order, and the browser orders mixed text within each fragment
 *   (a known simplification of the bidi algorithm across runs, as 0356 records for input fields).
 *
 * Pure: the caller passes the width of a string in a run's font (`RunMeasure`).
 */
import { lineSegments, type LineBreakMode } from "./lineBreak";
import type { UIInlineRun, UITextWrap } from "../uiCoreTypes";

/** The character an inline image stands for in the joined text (one UTF-16 unit). */
export const INLINE_OBJECT = "￼";
/** A run's ascent and descent as shares of its font size: the box glyphs are drawn and backgrounds painted in (1.2 em, as a line). */
export const INLINE_ASCENT = 0.95;
export const INLINE_DESCENT = 0.25;

/** One run's part of a line: drawn at `x` (from the content box's left), its baseline `baseline` down from the content box's top. */
export interface UIInlineFragment {
  /** Index of its run. */
  readonly run: number;
  /** Its part of the joined text, `[start, end)`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly x: number;
  readonly width: number;
  readonly baseline: number;
  /** The box its glyphs (or its image) fill: what its background paints and its decorations span. */
  readonly top: number;
  readonly height: number;
}

/** One line: its fragments in visual order, and the part of the joined text it holds. */
export interface UIInlineLine {
  /** Its first character, the end of its content (trailing spaces excluded), and where the next line starts. */
  readonly start: number;
  readonly end: number;
  readonly next: number;
  readonly top: number;
  readonly height: number;
  /** Its baseline, down from the content box's top. */
  readonly baseline: number;
  /** Where its content starts and how wide it is, after alignment. */
  readonly x: number;
  readonly width: number;
  readonly fragments: readonly UIInlineFragment[];
}

/** A paragraph of runs laid out: its lines, the widest line's width and the total height. */
export interface UIInlineLayout {
  readonly lines: readonly UIInlineLine[];
  readonly width: number;
  readonly height: number;
  /** The runs' text joined (images as U+FFFC, line breaks as `\n`). */
  readonly text: string;
  /** Where the content box starts inside the element's border box (its padding and border), set by the UI core. */
  readonly inset?: { readonly x: number; readonly y: number };
}

/** The width of `text` drawn in `run`'s font, in the same units as the layout. */
export type RunMeasure = (text: string, run: UIInlineRun) => number;

export interface InlineLayoutOptions {
  /** The width lines wrap at (Infinity: never). */
  readonly maxWidth: number;
  /** The width lines are aligned in (the content box's); absent: `maxWidth` when finite, else the widest line. */
  readonly alignWidth?: number;
  readonly wrap: UITextWrap;
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
  readonly align: "left" | "center" | "right" | "justify";
  readonly direction: "ltr" | "rtl";
  /** The paragraph's own font size: each line's strut. */
  readonly fontSize: number;
  /** A line break at the very end starts an empty last line (editable text); otherwise it makes none, as in HTML. */
  readonly keepTrailingBreak?: boolean;
}

/** A run's CSS font (`italic 700 16px Inter, system-ui`), as a 2D canvas takes it. */
export function inlineFont(run: Pick<UIInlineRun, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">): string {
  return `${run.fontStyle === "italic" ? "italic " : ""}${run.fontWeight} ${run.fontSize}px ${run.fontFamily}`;
}

/** The runs' text joined, as the layout's offsets count it. */
export function inlineText(runs: readonly UIInlineRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

/** Each run's first offset in the joined text. */
function runStarts(runs: readonly UIInlineRun[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const r of runs) {
    out.push(at);
    at += r.text.length;
  }
  return out;
}

/** The run holding offset `i` (the last run starting at or before it with text there). */
function runIndexAt(starts: readonly number[], runs: readonly UIInlineRun[], i: number): number {
  let lo = 0, hi = starts.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= i) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  while (found > 0 && runs[found].text.length === 0) found--;
  return found;
}

interface Metrics {
  /** How far its inline box reaches above and below the line's baseline (`top`/`bottom` boxes: placed once the line is known). */
  above: number;
  below: number;
  /** Its inline box's height: font size × line height, or an image's height. */
  height: number;
  /** Text: the half-leading, from the inline box's top to the glyph box's. */
  half: number;
}

/** A fragment of `run`'s inline box against its line's baseline (`base`: the paragraph's font size, which `middle` and `text-*` align to). */
function metricsOf(run: UIInlineRun, lineHeight: number, base: number): Metrics {
  const image = run.image;
  const h = image ? image.height : run.fontSize * lineHeight;
  const half = image ? 0 : (h - (INLINE_ASCENT + INLINE_DESCENT) * run.fontSize) / 2;
  let above = (image ? h : half + INLINE_ASCENT * run.fontSize) + run.shift;
  switch (run.verticalAlign) {
    case "middle":
      above = h / 2 + 0.25 * base;
      break;
    case "text-top":
      above = INLINE_ASCENT * base;
      break;
    case "text-bottom":
      above = h - INLINE_DESCENT * base;
      break;
  }
  return { above, below: h - above, height: h, half };
}

/**
 * Lay `runs` out. Offsets in the result index the joined text (`inlineText`). Empty runs take no room; a paragraph with
 * no text is one empty line, its strut's height.
 */
export function layoutInline(runs: readonly UIInlineRun[], o: InlineLayoutOptions, measure: RunMeasure): UIInlineLayout {
  const text = inlineText(runs);
  const starts = runStarts(runs);
  const mode: LineBreakMode = o.wrap === "anywhere" ? "anywhere" : "normal";
  const wraps = o.wrap !== "none" && Number.isFinite(o.maxWidth);
  // A width Yoga reports (float32) can come back a hair under the one measured: lines laid out at it wrap as measured.
  const maxWidth = o.maxWidth + Math.max(1e-3, o.maxWidth * 1e-6);
  /** The width of `[a, b)`, measured run by run. */
  const span = (a: number, b: number): number => {
    let w = 0;
    for (let k = runIndexAt(starts, runs, a); k < runs.length && starts[k] < b; k++) {
      const r = runs[k];
      const from = Math.max(a, starts[k]), to = Math.min(b, starts[k] + r.text.length);
      if (to <= from) continue;
      if (r.image) w += r.image.width * (to - from);
      else w += measure(text.slice(from, to), r);
    }
    return w;
  };

  // Lines as offset ranges: [start, end) shown, `next` where the following line starts.
  const ranges: { start: number; end: number; next: number }[] = [];
  let p = 0;
  while (p <= text.length) {
    const nl = text.indexOf("\n", p);
    const pe = nl < 0 ? text.length : nl;
    const next = nl < 0 ? text.length + 1 : nl + 1;
    if (!wraps || pe === p) ranges.push({ start: p, end: trimEnd(text, p, pe), next: Math.min(next, text.length) });
    else wrapParagraph(text, p, pe, mode, maxWidth, span, ranges);
    if (nl >= 0 && ranges.length) ranges[ranges.length - 1].next = nl + 1;
    p = next;
    if (nl < 0) break;
  }
  // As in HTML, a line break at the very end makes no line of its own (editable text shows it: the caret goes there).
  if (!o.keepTrailingBreak && ranges.length > 1 && text.endsWith("\n")) {
    ranges.pop();
    ranges[ranges.length - 1].next = text.length;
  }
  if (!ranges.length) ranges.push({ start: 0, end: 0, next: 0 });

  const strut = metricsOf({ ...BASE_STRUT, fontSize: o.fontSize }, o.lineHeight, o.fontSize);
  const lines: UIInlineLine[] = [];
  let y = 0;
  let widest = 0;
  const sized: { range: (typeof ranges)[number]; frags: { run: number; start: number; end: number; width: number; m: Metrics }[]; width: number; above: number; below: number }[] = [];
  for (const range of ranges) {
    const frags: (typeof sized)[number]["frags"] = [];
    let width = 0;
    let above = strut.above, below = strut.below;
    if (range.end > range.start) {
      for (let k = runIndexAt(starts, runs, range.start); k < runs.length && starts[k] < range.end; k++) {
        const r = runs[k];
        const a = Math.max(range.start, starts[k]), b = Math.min(range.end, starts[k] + r.text.length);
        if (b <= a) continue;
        const w = r.image ? r.image.width * (b - a) : measure(text.slice(a, b), r);
        const m = metricsOf(r, o.lineHeight, o.fontSize);
        if (r.verticalAlign !== "top" && r.verticalAlign !== "bottom") {
          above = Math.max(above, m.above);
          below = Math.max(below, m.below);
        }
        frags.push({ run: k, start: a, end: b, width: w, m });
        width += w;
      }
    }
    // `top` and `bottom` boxes taller than the line grow it (downward for `top`, upward for `bottom`).
    for (const f of frags) {
      const va = runs[f.run].verticalAlign;
      if (va === "top" && f.m.height > above + below) below = f.m.height - above;
      if (va === "bottom" && f.m.height > above + below) above = f.m.height - below;
    }
    widest = Math.max(widest, width);
    sized.push({ range, frags, width, above, below });
  }
  const alignWidth = o.alignWidth ?? (Number.isFinite(o.maxWidth) ? o.maxWidth : widest);
  for (const s of sized) {
    const height = s.above + s.below;
    const baseline = y + s.above;
    const free = alignWidth - s.width;
    const lx = o.align === "right" ? free : o.align === "center" ? free / 2 : 0;
    const fragments: UIInlineFragment[] = [];
    let cursor = 0;
    for (const f of s.frags) {
      const r = runs[f.run];
      const x = o.direction === "rtl" ? lx + s.width - cursor - f.width : lx + cursor;
      cursor += f.width;
      // Its inline box's top: on the baseline as its metrics say, or at the line box's top or bottom.
      const boxTop = r.verticalAlign === "top" ? y : r.verticalAlign === "bottom" ? y + height - f.m.height : baseline - f.m.above;
      const top = boxTop + f.m.half;
      const h = r.image ? r.image.height : (INLINE_ASCENT + INLINE_DESCENT) * r.fontSize;
      const fb = r.image ? top + h : top + INLINE_ASCENT * r.fontSize;
      fragments.push({ run: f.run, start: f.start, end: f.end, text: text.slice(f.start, f.end), x, width: f.width, baseline: fb, top, height: h });
    }
    lines.push({ start: s.range.start, end: s.range.end, next: s.range.next, top: y, height, baseline, x: lx, width: s.width, fragments });
    y += height;
  }
  return { lines, width: widest, height: y, text };
}

/** The strut's run: only its size matters. */
const BASE_STRUT: UIInlineRun = { text: "", fontSize: 16, fontWeight: "400", fontStyle: "normal", fontFamily: "", color: "", decoration: "", background: null, verticalAlign: "baseline", shift: 0, image: null, owner: null, source: null };

/** `end` moved back over the spaces before it (not before `start`). */
function trimEnd(text: string, start: number, end: number): number {
  while (end > start && text.charCodeAt(end - 1) === 32) end--;
  return end;
}

/** Greedy wrapping of the paragraph `[ps, pe)` into `out`. */
function wrapParagraph(text: string, ps: number, pe: number, mode: LineBreakMode, maxWidth: number, span: (a: number, b: number) => number, out: { start: number; end: number; next: number }[]): void {
  // Break opportunities: the line breaker's pieces, split again around inline images.
  const pieces: { start: number; end: number }[] = [];
  let at = ps;
  for (const seg of lineSegments(text.slice(ps, pe), mode)) {
    let s = at;
    const e = at + seg.length;
    for (let i = at; i < e; i++) {
      if (text[i] !== INLINE_OBJECT) continue;
      if (i > s) pieces.push({ start: s, end: i });
      // The image and the spaces after it.
      let j = i + 1;
      while (j < e && text.charCodeAt(j) === 32) j++;
      pieces.push({ start: i, end: j });
      s = j;
      i = j - 1;
    }
    if (s < e) pieces.push({ start: s, end: e });
    at = e;
  }
  let lineStart = ps;
  let lineEnd = ps; // where the line's content ends so far (its trailing spaces excluded)
  let full = 0; // the line's width so far, its trailing spaces included
  for (const piece of pieces) {
    const content = trimEnd(text, piece.start, piece.end);
    const w = content > piece.start ? span(piece.start, content) : 0;
    const spaces = content < piece.end ? span(content, piece.end) : 0;
    if (content > piece.start && lineEnd > lineStart && full + w > maxWidth) {
      out.push({ start: lineStart, end: lineEnd, next: piece.start });
      lineStart = piece.start;
      lineEnd = content;
      full = w + spaces;
      continue;
    }
    if (content > piece.start) lineEnd = content;
    full += w + spaces;
  }
  out.push({ start: lineStart, end: lineEnd, next: pe });
}

// --- Positions: the caret, hit-testing, the selection ---------------------------------------------

/** The line an offset belongs to: the one whose `[start, next)` holds it (the last line holds the text's end). */
export function lineOf(layout: UIInlineLayout, index: number): number {
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i++) if (index < lines[i].next || i === lines.length - 1) return i;
  return lines.length - 1;
}

/** Where the caret at `index` is drawn: an x and its line's top and height. */
export function caretAt(layout: UIInlineLayout, runs: readonly UIInlineRun[], index: number, measure: RunMeasure, direction: "ltr" | "rtl" = "ltr"): { x: number; top: number; height: number } {
  const line = layout.lines[lineOf(layout, index)];
  const rtl = direction === "rtl";
  const endX = rtl ? line.x : line.x + line.width;
  for (const f of line.fragments) {
    if (index < f.start || index > f.end) continue;
    const r = runs[f.run];
    const before = r.image ? (index > f.start ? f.width : 0) : measure(f.text.slice(0, index - f.start), r);
    return { x: rtl ? f.x + f.width - before : f.x + before, top: line.top, height: line.height };
  }
  const first = line.fragments[0];
  return { x: index <= line.start && first ? (rtl ? first.x + first.width : first.x) : endX, top: line.top, height: line.height };
}

/** The offset nearest a point (content box coordinates): the caret position a press there puts. */
export function indexAt(layout: UIInlineLayout, runs: readonly UIInlineRun[], x: number, y: number, measure: RunMeasure, direction: "ltr" | "rtl" = "ltr"): number {
  const lines = layout.lines;
  let line = lines[lines.length - 1];
  for (const l of lines) {
    if (y < l.top + l.height) {
      line = l;
      break;
    }
  }
  const rtl = direction === "rtl";
  const frags = line.fragments;
  if (!frags.length) return line.start;
  // The fragment under x, else the nearest one.
  let best = frags[0], bestDistance = Infinity;
  for (const f of frags) {
    const d = x < f.x ? f.x - x : x > f.x + f.width ? x - f.x - f.width : 0;
    if (d < bestDistance) [best, bestDistance] = [f, d];
  }
  const r = runs[best.run];
  const into = rtl ? best.x + best.width - x : x - best.x;
  if (into <= 0) return best.start;
  if (into >= best.width) return best.end === line.end ? line.end : best.end;
  if (r.image) return into < best.width / 2 ? best.start : best.end;
  // Walk the graphemes for the nearest boundary.
  let prev = 0, at = best.start;
  const chars = [...best.text];
  for (const ch of chars) {
    const next = measure(best.text.slice(0, at - best.start + ch.length), r);
    if (into < (prev + next) / 2) return at;
    prev = next;
    at += ch.length;
  }
  return best.end;
}

/** The selection `[from, to)` as rectangles, one per line it spans. */
export function selectionRects(layout: UIInlineLayout, runs: readonly UIInlineRun[], from: number, to: number, measure: RunMeasure, direction: "ltr" | "rtl" = "ltr"): { x: number; y: number; width: number; height: number }[] {
  const out: { x: number; y: number; width: number; height: number }[] = [];
  if (to <= from) return out;
  const lines = layout.lines;
  lines.forEach((line, i) => {
    const owned = i === lines.length - 1 ? layout.text.length : line.next;
    const a = Math.max(from, line.start), b = Math.min(to, owned);
    if (b <= a) return;
    const x1 = caretAt(layout, runs, Math.min(a, line.end), measure, direction).x;
    // Past the line's content (its trailing spaces, its line break): to its end, a little further on an empty line.
    const x2 = b > line.end ? (direction === "rtl" ? line.x - (line.end === line.start ? 4 : 0) : line.x + line.width + (line.end === line.start ? 4 : 0)) : caretAt(layout, runs, b, measure, direction).x;
    const left = Math.min(x1, x2), right = Math.max(x1, x2);
    if (right > left) out.push({ x: left, y: line.top, width: right - left, height: line.height });
  });
  return out;
}
