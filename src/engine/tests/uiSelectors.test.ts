import { describe, expect, it } from "vitest";
import { matchSelector, parseStylesheet, resolveStyle } from "../ui/document/stylesheet";
import type { MarkupElement, StyleTarget } from "../ui/document/types";
import { UIPanel, UIText } from "../ui/components";
import { Color } from "../core/math";

// ADR 0419 (0418 wave 5's selector items, pulled forward): `:is()`, `:where()` and case-insensitive tags, which
// Svelte's scoped CSS emits (`button.svelte-x`, `.a:where(.svelte-x)`), and the HTML tags Svelte components write.

const state = { hover: false, pressed: false, focus: false, disabled: false };
const target = (tag: string, classes: string[] = [], parent: StyleTarget | null = null, id: string | null = null): StyleTarget => ({ tag, id, classes, state, parent });
const element = (tag: MarkupElement["tag"]): MarkupElement => ({ kind: "element", tag, attributes: [], children: [], text: null, template: null, span: { start: 0, end: 0 }, openTagSpan: { start: 0, end: 0 }, file: "t.css" });

function selector(text: string) {
  const sheet = parseStylesheet(`${text} {}`, "t.css");
  expect(sheet.problems).toEqual([]);
  return sheet.rules[0].selectors[0];
}

describe("selectors for Svelte's CSS", () => {
  it("matches tags case-insensitively, and the HTML tags components are written with as written", () => {
    expect(matchSelector(selector("button"), target("Button"))).toBe(true);
    expect(matchSelector(selector("BUTTON"), target("button"))).toBe(true);
    expect(matchSelector(selector("div"), target("div"))).toBe(true);
    expect(matchSelector(selector("div"), target("Panel"))).toBe(false); // the tag as written, not the element kind
    expect(matchSelector(selector("section > h1"), target("h1", [], target("section")))).toBe(true);
    expect(parseStylesheet("blink {}", "t.css").problems[0].message).toMatch(/Unknown element "blink"/);
  });

  it("matches :where() and :is() against the element itself, with Svelte's scoping", () => {
    const card = target("div", ["card", "svelte-1"]);
    const label = target("span", ["label", "svelte-1"], card);
    expect(matchSelector(selector(".card.svelte-1 span:where(.svelte-1)"), label)).toBe(true);
    expect(matchSelector(selector(".card.svelte-1 span:where(.svelte-2)"), label)).toBe(false);
    expect(matchSelector(selector(":is(p, span).label"), label)).toBe(true);
    expect(matchSelector(selector(":is(.card .label)"), label)).toBe(true); // an argument with a combinator
    expect(matchSelector(selector(":is(p, h1)"), label)).toBe(false);
  });

  it("gives :where() no specificity and :is() its most specific argument's", () => {
    expect(selector(".a:where(.b #c)").specificity).toEqual([0, 1, 0]);
    expect(selector(".a:is(.b, #c)").specificity).toEqual([1, 1, 0]);
    expect(selector("span:where(.svelte-1)").specificity).toEqual([0, 0, 1]);
  });

  it("lets a later plain class rule beat a scoped :where() rule of the same class count", () => {
    const sheet = parseStylesheet(`.title:where(.svelte-1) { color: #ff0000; } .title { color: #00ff00; } span:where(.svelte-1) { font-size: 20px; }`, "t.css");
    expect(sheet.problems).toEqual([]);
    const resolved = resolveStyle(target("span", ["title", "svelte-1"]), element("Text"), UIText, [sheet], null, () => {});
    expect(resolved.get("color")!.value).toEqual(Color.from("#00ff00"));
    expect((resolved.get("color")!.source as { kind: string; rule?: { selectorText: string } }).rule!.selectorText).toBe(".title");
    expect(resolved.get("fontSize")!.value).toBe(20);
    expect(resolveStyle(target("div", ["svelte-1"]), element("Panel"), UIPanel, [sheet], null, () => {}).has("fontSize")).toBe(false);
  });
});
