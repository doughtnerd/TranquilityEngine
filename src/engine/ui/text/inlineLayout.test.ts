// ADR 0425: a text's inline runs laid out together (wrapping across runs, line boxes, alignment, direction), and the
// caret, hit-testing and selection on that layout.
import { describe, expect, it } from "vitest";
import { caretAt, indexAt, inlineFont, layoutInline, selectionRects, type InlineLayoutOptions } from "./inlineLayout";
import type { UIInlineRun } from "../uiCoreTypes";

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
