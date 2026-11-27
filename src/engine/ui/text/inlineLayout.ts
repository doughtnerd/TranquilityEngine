/**
 * Inline text layout (ADR 0429): a text element's styled runs laid out together as one paragraph flow, the way a browser
 * lays out phrasing content. The UI core measures with it (Yoga's measure of a text element with runs), publishes its
 * lines for the drawing layer to draw as they are, hit-tests runs with it and places the caret of editable text, so what's
 * measured, drawn, hit and edited is one layout.
 *
 * - **Line breaking across runs.** The runs' text is joined and broken where `lineBreak.ts` allows (spaces, CJK with the
 *   kinsoku rules, Thai words; anywhere for `wrap: "anywhere"`), so a word split between runs (`<b>bo</b>ld`) stays
 *   whole and a break can fall inside a run. An inline object (an image, or an atomic inline box) is a place to break on
 *   both sides; a line break (`\n`: a `<br>` run, or one kept by `white-space`) ends the line. Lines fill greedily;
 *   trailing spaces hang past the width; a piece wider than the width overflows. ADR 0432: a run with `nowrap` has no
 *   break after its characters, and a run with `keepSpaces` keeps its trailing spaces on the line, taking room (and a
 *   break after each of them).
 * - **Inline boxes (ADR 0432).** An inline element with margins, borders or padding (`UITextRun.boxes`) takes room for its
 *   start side before its first character and for its end side after its last; a box broken across lines is sliced, and
 *   each line reports its parts (`UIInlineLine.boxes`), border boxes around the element's glyph box, for drawing and
 *   hit-testing. Vertical padding and borders are drawn, not laid out, as in CSS.
 * - **Line boxes.** Each line is as tall as its tallest run (font size × line height; images and atomic boxes by their
 *   height), with the paragraph's own font as a strut, so plain text keeps its line height. Runs sit on a common
 *   baseline, `shift` raising or lowering theirs (`sub`, `super`); `middle`, `top`, `bottom`, `text-top` and
 *   `text-bottom` align as in CSS. An atomic box's baseline is its own (its last line's), an image's its bottom edge.
 * - **Direction.** Lines are aligned per `align` (an edge, `start`/`end` already resolved); in a right-to-left paragraph a
 *   line's fragments are placed from the right in logical order, and the browser orders mixed text within each fragment
 *   (a known simplification of the bidi algorithm across runs, as 0356 records for input fields).
 *
 * Pure: the caller passes the width of a string in a run's font (`RunMeasure`).
 */
import { lineSegments, type LineBreakMode } from "./lineBreak";
import type { UIInlineBox, UIInlineRun, UITextWrap } from "../uiCoreTypes";

/** The character an inline object (an image, an atomic inline box) stands for in the joined text (one UTF-16 unit). */
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
  /** The box its glyphs (or its image, or its atomic box's margin box) fill: what its background paints and its decorations span. */
  readonly top: number;
  readonly height: number;
}

/** ADR 0432: one line's part of an inline box (`UITextRun.boxes[box]`): its border box, from the content box's corner. */
export interface UIInlineBoxPart {
  readonly box: number;
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  /** Whether this part has the box's left side and its right side (a box broken across lines has its start side on its first line only, its end side on its last). */
  readonly left: boolean;
  readonly right: boolean;
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
  /** ADR 0432: its parts of inline boxes, outer boxes before the boxes inside them. Absent: none. */
  readonly boxes?: readonly UIInlineBoxPart[];
}

/** A paragraph of runs laid out: its lines, the widest line's width and the total height. */
export interface UIInlineLayout {
  readonly lines: readonly UIInlineLine[];
  readonly width: number;
  readonly height: number;
  /** The runs' text joined (inline objects as U+FFFC, line breaks as `\n`). */
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
  /** ADR 0432: the text's inline boxes (`UITextRun.boxes`). */
  readonly boxes?: readonly UIInlineBox[];
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

/** An inline object's width, height and baseline (down from its top): an atomic box's own, an image's bottom edge. */
function objectOf(run: UIInlineRun): { width: number; height: number; baseline: number } | null {
  if (run.atom) return run.atom;
  if (run.image) return { width: run.image.width, height: run.image.height, baseline: run.image.height };
  return null;
}

interface Metrics {
  /** How far its inline box reaches above and below the line's baseline (`top`/`bottom` boxes: placed once the line is known). */
  above: number;
  below: number;
  /** Its inline box's height: font size × line height, or an object's height. */
  height: number;
  /** Text: the half-leading, from the inline box's top to the glyph box's. */
  half: number;
}

/** A fragment of `run`'s inline box against its line's baseline (`base`: the paragraph's font size, which `middle` and `text-*` align to). */
function metricsOf(run: UIInlineRun, lineHeight: number, base: number): Metrics {
  const object = objectOf(run);
  const h = object ? object.height : run.fontSize * lineHeight;
  const half = object ? 0 : (h - (INLINE_ASCENT + INLINE_DESCENT) * run.fontSize) / 2;
  let above = (object ? object.baseline : half + INLINE_ASCENT * run.fontSize) + run.shift;
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

/** ADR 0432: the room inline boxes take at each run's start and end, and each box's effective run range (runs with text). */
interface Edges {
  /** By run: the boxes starting at it (outer first) and ending at it (inner first). */
  readonly opens: (readonly number[])[];
  readonly closes: (readonly number[])[];
  /** By run: the boxes it's inside (outer first). */
  readonly inside: (readonly number[])[];
  /** By run: room before its first character and after its last. */
  readonly before: Float64Array;
  readonly after: Float64Array;
}

/** A box's room on its start side and its end side (each a margin, then a border plus padding), for the direction. */
function sidesOf(b: UIInlineBox, rtl: boolean): { startMargin: number; startInner: number; endInner: number; endMargin: number } {
  return rtl
    ? { startMargin: b.margin[1], startInner: b.border[1] + b.padding[1], endInner: b.padding[3] + b.border[3], endMargin: b.margin[0] }
    : { startMargin: b.margin[0], startInner: b.border[3] + b.padding[3], endInner: b.padding[1] + b.border[1], endMargin: b.margin[1] };
}

function edgesOf(runs: readonly UIInlineRun[], boxes: readonly UIInlineBox[] | undefined, rtl: boolean): Edges | null {
  if (!boxes?.length) return null;
  const n = runs.length;
  const opens: number[][] = runs.map(() => []), closes: number[][] = runs.map(() => []), inside: number[][] = runs.map(() => []);
  const before = new Float64Array(n), after = new Float64Array(n);
  boxes.forEach((b, i) => {
    let first = Math.max(0, b.first), last = Math.min(n - 1, b.last);
    while (first <= last && runs[first].text.length === 0) first++;
    while (last >= first && runs[last].text.length === 0) last--;
    if (first > last) return;
    opens[first].push(i);
    closes[last].unshift(i);
    for (let k = first; k <= last; k++) inside[k].push(i);
    const s = sidesOf(b, rtl);
    before[first] += s.startMargin + s.startInner;
    after[last] += s.endInner + s.endMargin;
  });
  return { opens, closes, inside, before, after };
}

/**
 * Lay `runs` out. Offsets in the result index the joined text (`inlineText`). Empty runs take no room; a paragraph with
 * no text is one empty line, its strut's height.
 */
export function layoutInline(runs: readonly UIInlineRun[], o: InlineLayoutOptions, measure: RunMeasure): UIInlineLayout {
  const text = inlineText(runs);
  const starts = runStarts(runs);
  const rtl = o.direction === "rtl";
  const edges = edgesOf(runs, o.boxes, rtl);
  const mode: LineBreakMode = o.wrap === "anywhere" ? "anywhere" : "normal";
  const wraps = o.wrap !== "none" && Number.isFinite(o.maxWidth);
  // A width Yoga reports (float32) can come back a hair under the one measured: lines laid out at it wrap as measured.
  const maxWidth = o.maxWidth + Math.max(1e-3, o.maxWidth * 1e-6);
  // ADR 0432: each character's run, for the white space rules that differ by run (no break, spaces that take room).
  const special = runs.some((r) => r.nowrap || r.keepSpaces);
  const runOf = special ? new Int32Array(text.length) : null;
  if (runOf) runs.forEach((r, k) => runOf.fill(k, starts[k], starts[k] + r.text.length));
  /** True when the space at `i` hangs past a line's end (and so is dropped from the line's content). */
  const hangs = (i: number) => text.charCodeAt(i) === 32 && !(runOf && runs[runOf[i]].keepSpaces);
  const trim = (start: number, end: number) => {
    while (end > start && hangs(end - 1)) end--;
    return end;
  };
  /** The width of `[a, b)`, measured run by run, with the room inline boxes take where they start and end in it. */
  const span = (a: number, b: number): number => {
    let w = 0;
    for (let k = runIndexAt(starts, runs, a); k < runs.length && starts[k] < b; k++) {
      const r = runs[k];
      const from = Math.max(a, starts[k]), to = Math.min(b, starts[k] + r.text.length);
      if (to <= from) continue;
      const object = objectOf(r);
      w += object ? object.width * (to - from) : measure(text.slice(from, to), r);
      if (edges) {
        if (from === starts[k]) w += edges.before[k];
        if (to === starts[k] + r.text.length) w += edges.after[k];
      }
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
    if (!wraps || pe === p) ranges.push({ start: p, end: trim(p, pe), next: Math.min(next, text.length) });
    else wrapParagraph(text, p, pe, mode, maxWidth, span, trim, runOf ? (i) => !!runs[runOf[i]].nowrap : null, runOf ? (i) => !!runs[runOf[i]].keepSpaces && text.charCodeAt(i) === 32 : null, ranges);
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
  type Sized = { run: number; start: number; end: number; width: number; before: number; after: number; m: Metrics };
  const sized: { range: (typeof ranges)[number]; frags: Sized[]; width: number; above: number; below: number }[] = [];
  for (const range of ranges) {
    const frags: Sized[] = [];
    let width = 0;
    let above = strut.above, below = strut.below;
    if (range.end > range.start) {
      for (let k = runIndexAt(starts, runs, range.start); k < runs.length && starts[k] < range.end; k++) {
        const r = runs[k];
        const a = Math.max(range.start, starts[k]), b = Math.min(range.end, starts[k] + r.text.length);
        if (b <= a) continue;
        const object = objectOf(r);
        const w = object ? object.width * (b - a) : measure(text.slice(a, b), r);
        const m = metricsOf(r, o.lineHeight, o.fontSize);
        if (r.verticalAlign !== "top" && r.verticalAlign !== "bottom") {
          above = Math.max(above, m.above);
          below = Math.max(below, m.below);
        }
        const before = edges && a === starts[k] ? edges.before[k] : 0;
        const after = edges && b === starts[k] + r.text.length ? edges.after[k] : 0;
        frags.push({ run: k, start: a, end: b, width: w, before, after, m });
        width += before + w + after;
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
    /** A logical span `[at, at + w)` on this line, placed (from the right in right-to-left text). */
    const place = (at: number, w: number) => (rtl ? lx + s.width - at - w : lx + at);
    const fragments: UIInlineFragment[] = [];
    const parts: UIInlineBoxPart[] = [];
    const open = new Map<number, { left: number; start: boolean }>();
    const close = (box: number, right: number, end: boolean) => {
      const at = open.get(box)!;
      open.delete(box);
      const b = o.boxes![box];
      const glyphTop = baseline - b.shift - INLINE_ASCENT * b.fontSize;
      const top = glyphTop - b.padding[0] - b.border[0];
      const h = (INLINE_ASCENT + INLINE_DESCENT) * b.fontSize + b.padding[0] + b.padding[2] + b.border[0] + b.border[2];
      parts.push({ box, x: place(at.left, right - at.left), width: right - at.left, top, height: h, left: rtl ? end : at.start, right: rtl ? at.start : end });
    };
    let cursor = 0;
    for (const f of s.frags) {
      const r = runs[f.run];
      if (edges) {
        // Boxes it's inside that this line hasn't opened yet continue from the line before (sliced: no start side).
        const opening = f.start === starts[f.run] ? edges.opens[f.run] : [];
        for (const box of edges.inside[f.run]) if (!open.has(box) && !opening.includes(box)) open.set(box, { left: cursor, start: false });
        for (const box of opening) {
          const sides = sidesOf(o.boxes![box], rtl);
          open.set(box, { left: cursor + sides.startMargin, start: true });
          cursor += sides.startMargin + sides.startInner;
        }
      }
      const x = place(cursor, f.width);
      cursor += f.width;
      // Its inline box's top: on the baseline as its metrics say, or at the line box's top or bottom.
      const boxTop = r.verticalAlign === "top" ? y : r.verticalAlign === "bottom" ? y + height - f.m.height : baseline - f.m.above;
      const top = boxTop + f.m.half;
      const object = objectOf(r);
      const h = object ? object.height : (INLINE_ASCENT + INLINE_DESCENT) * r.fontSize;
      const fb = object ? top + object.baseline : top + INLINE_ASCENT * r.fontSize;
      fragments.push({ run: f.run, start: f.start, end: f.end, text: text.slice(f.start, f.end), x, width: f.width, baseline: fb, top, height: h });
      if (edges && f.end === starts[f.run] + r.text.length) {
        for (const box of edges.closes[f.run]) {
          const sides = sidesOf(o.boxes![box], rtl);
          cursor += sides.endInner;
          if (open.has(box)) close(box, cursor, true);
          cursor += sides.endMargin;
        }
      }
    }
    // Boxes still open go on to the next line (sliced: no end side here). Outer boxes first, as they're drawn.
    for (const box of [...open.keys()]) close(box, cursor, false);
    parts.sort((a, b) => a.box - b.box);
    lines.push({ start: s.range.start, end: s.range.end, next: s.range.next, top: y, height, baseline, x: lx, width: s.width, fragments, ...(parts.length ? { boxes: parts } : {}) });
    y += height;
  }
  return { lines, width: widest, height: y, text };
}

/** The strut's run: only its size matters. */
const BASE_STRUT: UIInlineRun = { text: "", fontSize: 16, fontWeight: "400", fontStyle: "normal", fontFamily: "", color: "", decoration: "", background: null, verticalAlign: "baseline", shift: 0, image: null, owner: null, source: null };

/**
 * Greedy wrapping of the paragraph `[ps, pe)` into `out`. `trim` moves an end back over hanging spaces; ADR 0432:
 * `noBreakAfter(i)` is true where the character at `i` has no break after it (`nowrap`), `breakAfter(i)` where it has one
 * (a space that takes room: `break-spaces`).
 */
function wrapParagraph(text: string, ps: number, pe: number, mode: LineBreakMode, maxWidth: number, span: (a: number, b: number) => number, trim: (start: number, end: number) => number, noBreakAfter: ((i: number) => boolean) | null, breakAfter: ((i: number) => boolean) | null, out: { start: number; end: number; next: number }[]): void {
  // Break opportunities: the line breaker's pieces, split again around inline objects (and after spaces that take room).
  const raw: { start: number; end: number }[] = [];
  let at = ps;
  for (const seg of lineSegments(text.slice(ps, pe), mode)) {
    let s = at;
    const e = at + seg.length;
    for (let i = at; i < e; i++) {
      if (breakAfter?.(i)) {
        raw.push({ start: s, end: i + 1 });
        s = i + 1;
        continue;
      }
      if (text[i] !== INLINE_OBJECT) continue;
      if (i > s) raw.push({ start: s, end: i });
      // The object and the spaces after it.
      let j = i + 1;
      while (j < e && text.charCodeAt(j) === 32 && !breakAfter?.(j)) j++;
      raw.push({ start: i, end: j });
      s = j;
      i = j - 1;
    }
    if (s < e) raw.push({ start: s, end: e });
    at = e;
  }
  // A piece ending inside a `nowrap` run joins the next one: no break there.
  const pieces: { start: number; end: number }[] = [];
  for (const piece of raw) {
    const last = pieces[pieces.length - 1];
    if (last && noBreakAfter?.(last.end - 1)) last.end = piece.end;
    else pieces.push({ ...piece });
  }
  let lineStart = ps;
  let lineEnd = ps; // where the line's content ends so far (its hanging spaces excluded)
  let full = 0; // the line's width so far, its trailing spaces included
  for (const piece of pieces) {
    const content = trim(piece.start, piece.end);
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
    const before = r.image || r.atom ? (index > f.start ? f.width : 0) : measure(f.text.slice(0, index - f.start), r);
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
  if (r.image || r.atom) return into < best.width / 2 ? best.start : best.end;
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
