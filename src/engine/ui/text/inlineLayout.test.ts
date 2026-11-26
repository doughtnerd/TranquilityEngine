// ADR 0425: a text's inline runs laid out together (wrapping across runs, line boxes, alignment, direction), and the
// caret, hit-testing and selection on that layout.
import { describe, expect, it } from "vitest";
import { caretAt, indexAt, inlineFont, layoutInline, selectionRects, type InlineLayoutOptions } from "./inlineLayout";
import type { UIInlineBox, UIInlineRun } from "../uiCoreTypes";

const run = (text: string, extra: Partial<UIInlineRun> = {}): UIInlineRun => ({
  text, fontSize: 10, fontWeight: "400", fontStyle: "normal", fontFamily: "Inter", color: "white", decoration: "", background: null, verticalAlign: "baseline", shift: 0, image: null, owner: null, source: null, ...extra,
});
/** One unit per character at size 10, two for bold: so a run's style changes its width. */
const measure = (s: string, r: UIInlineRun) => [...s].length * (r.fontWeight === "700" ? 2 : 1) * (r.fontSize / 10);
const opts = (o: Partial<InlineLayoutOptions> = {}): InlineLayoutOptions => ({ maxWidth: Infinity, wrap: "word", lineHeight: 1.2, align: "left", direction: "ltr", fontSize: 10, ...o });
const texts = (runs: UIInlineRun[], o: Partial<InlineLayoutOptions>) => layoutInline(runs, opts(o), measure).lines.map((l) => l.fragments.map((f) => f.text).join("|"));

describe("inline layout: wrapping across runs", () => {
  it("measures each run in its own style and keeps a word split between runs whole", () => {
    const runs = [run("You have "), run("12", { fontWeight: "700" }), run(" coins")];
    const laid = layoutInline(runs, opts(), measure);
    expect(laid.width).toBe(9 + 4 + 6);
    expect(laid.lines).toHaveLength(1);
    expect(laid.lines[0].fragments.map((f) => [f.text, f.x, f.width])).toEqual([["You have ", 0, 9], ["12", 9, 4], [" coins", 13, 6]]);
    // "bo|ld" is one word: it moves to the next line whole.
    expect(texts([run("a "), run("bo", { fontWeight: "700" }), run("ld")], { maxWidth: 5 })).toEqual(["a", "bo|ld"]);
  });

  it("breaks inside a run, drops the spaces a line ends with, and lets an overlong word overflow", () => {
    expect(texts([run("one two "), run("three four")], { maxWidth: 9 })).toEqual(["one two", "three", "four"]);
    expect(texts([run("Supercalifragilistic is")], { maxWidth: 10 })).toEqual(["Supercalifragilistic", "is"]);
    expect(texts([run("one two three")], { maxWidth: 4, wrap: "none" })).toEqual(["one two three"]);
  });

  it("ends a line at a line break run, and a trailing one makes no line unless the text is editable", () => {
    const runs = [run("a"), run("\n"), run("b"), run("\n")];
    expect(texts(runs, {})).toEqual(["a", "b"]);
    expect(texts(runs, { keepTrailingBreak: true })).toEqual(["a", "b", ""]);
  });

  it("breaks around an inline image, sized by its own box", () => {
    const img = run("￼", { image: { src: "i.png", width: 8, height: 20 } });
    const laid = layoutInline([run("go "), img, run(" now")], opts({ maxWidth: 12 }), measure);
    expect(laid.lines.map((l) => l.fragments.map((f) => f.text).join(""))).toEqual(["go ￼", "now"]);
    // The image (on the baseline, 20 tall) makes its line taller than the strut.
    expect(laid.lines[0].height).toBeGreaterThan(12);
    expect(laid.lines[1].height).toBeCloseTo(12);
  });
});

describe("inline layout: line boxes and vertical alignment", () => {
  it("gives plain text the paragraph's line height and a bigger run a taller line", () => {
    expect(layoutInline([run("abc")], opts(), measure).height).toBeCloseTo(12);
    const tall = layoutInline([run("a "), run("B", { fontSize: 20 })], opts(), measure);
    expect(tall.height).toBeCloseTo(24);
    // Both on one baseline.
    const [a, b] = tall.lines[0].fragments;
    expect(a.baseline).toBeCloseTo(b.baseline);
  });

  it("raises super, lowers sub, and puts top and bottom runs at the line's edges", () => {
    const laid = layoutInline([run("x"), run("2", { shift: 4 }), run("i", { shift: -2 }), run("t", { verticalAlign: "top", fontSize: 6 })], opts(), measure);
    const [x, sup, sub, top] = laid.lines[0].fragments;
    expect(sup.baseline).toBeCloseTo(x.baseline - 4);
    expect(sub.baseline).toBeCloseTo(x.baseline + 2);
    expect(top.top - laid.lines[0].top).toBeCloseTo((6 * 1.2 - 6 * 1.2) / 2);
  });
});

describe("inline layout: alignment and direction", () => {
  it("aligns each line in the align width", () => {
    const laid = layoutInline([run("ab"), run("cd")], opts({ align: "right", alignWidth: 10 }), measure);
    expect(laid.lines[0].x).toBe(6);
    expect(laid.lines[0].fragments.map((f) => f.x)).toEqual([6, 8]);
    expect(layoutInline([run("ab")], opts({ align: "center", alignWidth: 10 }), measure).lines[0].x).toBe(4);
  });

  it("places a right-to-left line's fragments from the right, in logical order", () => {
    const laid = layoutInline([run("ab"), run("cd")], opts({ align: "right", alignWidth: 10, direction: "rtl" }), measure);
    expect(laid.lines[0].fragments.map((f) => [f.text, f.x])).toEqual([["ab", 8], ["cd", 6]]);
  });
});

describe("inline layout: caret, hit-testing and selection", () => {
  const runs = [run("ab "), run("cd", { fontWeight: "700" }), run("\n"), run("ef")];
  const laid = layoutInline(runs, opts(), measure);

  it("puts the caret after the characters before it, in their runs' widths, on the line of its offset", () => {
    expect(caretAt(laid, runs, 0, measure)).toMatchObject({ x: 0, top: 0 });
    expect(caretAt(laid, runs, 4, measure).x).toBe(3 + 2);
    expect(caretAt(laid, runs, 5, measure).x).toBe(3 + 4);
    expect(caretAt(laid, runs, 7, measure)).toMatchObject({ x: 1, top: laid.lines[1].top });
  });

  it("finds the offset nearest a point", () => {
    expect(indexAt(laid, runs, 0.4, 1, measure)).toBe(0);
    expect(indexAt(laid, runs, 3.9, 1, measure)).toBe(3);
    expect(indexAt(laid, runs, 99, 1, measure)).toBe(5);
    expect(indexAt(laid, runs, 1.2, 15, measure)).toBe(7);
  });

  it("selects across a line break as one rectangle per line", () => {
    const rects = selectionRects(laid, runs, 1, 8, measure);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ x: 1, y: 0 });
    expect(rects[1]).toMatchObject({ x: 0, width: 2, y: laid.lines[1].top });
  });

  it("writes a run's font as a canvas takes it", () => {
    expect(inlineFont(run("x", { fontStyle: "italic", fontWeight: "700", fontSize: 12 }))).toBe("italic 700 12px Inter");
  });
});

describe("inline layout: white space by run (ADR 0428)", () => {
  it("doesn't break after a nowrap run's characters, and wraps around it", () => {
    expect(texts([run("aa "), run("bb cc", { nowrap: true }), run(" dd")], { maxWidth: 6 })).toEqual(["aa", "bb cc", "dd"]);
    // A nowrap run wider than the line overflows on its own line, as an overlong word does.
    expect(texts([run("a "), run("b c d e f", { nowrap: true })], { maxWidth: 4 })).toEqual(["a", "b c d e f"]);
  });

  it("keeps spaces that take room on the line (and can break after each), where other spaces hang", () => {
    const hang = layoutInline([run("ab   cd")], opts({ maxWidth: 4 }), measure);
    expect(hang.lines.map((l) => [l.end - l.start, l.width])).toEqual([[2, 2], [2, 2]]);
    const keep = layoutInline([run("ab   cd", { keepSpaces: true })], opts({ maxWidth: 4 }), measure);
    expect(keep.lines[0].fragments[0].text).toBe("ab  ");
    expect(keep.lines[0].width).toBe(4);
  });

  it("breaks lines at line breaks kept in a run's text", () => {
    expect(texts([run("a\nb c")], { maxWidth: Infinity })).toEqual(["a", "b c"]);
  });
});

describe("inline layout: inline boxes (ADR 0428)", () => {
  const box = (first: number, last: number, extra: Partial<UIInlineBox> = {}): UIInlineBox => ({
    owner: null as unknown as UIInlineBox["owner"], first, last, margin: [1, 2], border: [1, 1, 1, 1], padding: [2, 3, 2, 3], fontSize: 10, shift: 0, background: "red", borderColor: "black", radius: 0, ...extra,
  });

  it("takes room for a box's start side before its first character and its end side after its last", () => {
    const runs = [run("ab "), run("cd"), run(" ef")];
    const laid = layoutInline(runs, opts({ boxes: [box(1, 1)] }), measure);
    const [ab, cd, ef] = laid.lines[0].fragments;
    // Start side: margin 1 + border 1 + padding 3; end side: padding 3 + border 1 + margin 2.
    expect(cd.x).toBe(ab.width + 5);
    expect(ef.x).toBe(cd.x + 2 + 6);
    expect(laid.width).toBe(3 + 5 + 2 + 6 + 3);
    // Its part: the border box, around its glyph box with the vertical padding and border (which the line doesn't grow by).
    const part = laid.lines[0].boxes![0];
    expect(part).toMatchObject({ box: 0, x: 3 + 1, width: 1 + 3 + 2 + 3 + 1, left: true, right: true });
    expect(part.height).toBeCloseTo(12 + 2 * 2 + 2);
    expect(laid.height).toBeCloseTo(12);
  });

  it("slices a box broken across lines: its start side on the first line, its end side on the last", () => {
    const runs = [run("aa "), run("bb cc"), run(" dd")];
    const laid = layoutInline(runs, opts({ maxWidth: 9, boxes: [box(1, 1, { margin: [0, 0], border: [0, 0, 0, 0], padding: [0, 1, 0, 1] })] }), measure);
    expect(laid.lines.map((l) => l.fragments.map((f) => f.text).join("|"))).toEqual(["aa |bb", "cc| dd"]);
    expect(laid.lines[0].boxes).toEqual([expect.objectContaining({ x: 3, width: 3, left: true, right: false })]);
    expect(laid.lines[1].boxes).toEqual([expect.objectContaining({ x: 0, width: 3, left: false, right: true })]);
  });

  it("mirrors the sides in right-to-left text", () => {
    const laid = layoutInline([run("ab"), run("cd")], opts({ direction: "rtl", align: "right", alignWidth: 20, boxes: [box(1, 1, { margin: [0, 0], border: [0, 0, 0, 0], padding: [0, 4, 0, 1] })] }), measure);
    const [ab, cd] = laid.lines[0].fragments;
    // Logically "ab", then the box's start side (its right: 4), "cd", its end side (its left: 1); placed from the right.
    expect(ab.x).toBe(18);
    expect(cd.x).toBe(18 - 4 - 2);
    expect(laid.lines[0].boxes![0]).toMatchObject({ x: 11, width: 7, left: true, right: true });
  });
});

describe("inline layout: atomic inline boxes (ADR 0428)", () => {
  it("places an atomic box on the line by its own baseline and size", () => {
    const atom = run("￼", { atom: { width: 6, height: 20, baseline: 15 } });
    const laid = layoutInline([run("ab "), atom, run(" c")], opts(), measure);
    const [ab, a] = laid.lines[0].fragments;
    expect(a.width).toBe(6);
    expect(a.baseline).toBeCloseTo(ab.baseline); // its baseline on the line's
    expect(a.top).toBeCloseTo(ab.baseline - 15);
    expect(laid.lines[0].height).toBeGreaterThan(20 - 1);
  });

  it("breaks around an atomic box unless it's in a nowrap run", () => {
    const atom = (extra: Partial<UIInlineRun> = {}) => run("￼", { atom: { width: 4, height: 10, baseline: 10 }, ...extra });
    expect(texts([run("aaa"), atom(), run("b")], { maxWidth: 5 })).toEqual(["aaa", "￼|b"]);
    expect(texts([run("aaa", { nowrap: true }), atom({ nowrap: true }), run("b")], { maxWidth: 5 })).toEqual(["aaa|￼|b"]);
  });
});
