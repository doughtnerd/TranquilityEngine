import { describe, expect, it } from "vitest";
import { matchSelector, parseStylesheet, resolveStyle } from "../ui/document/stylesheet";
import type { MarkupElement, StyleTarget } from "../ui/document/types";
import { UIPanel, UIText } from "../ui/components";
import { Color } from "../core/math";

// ADR 0419 (0418 wave 5's selector items, pulled forward): `:is()`, `:where()` and case-insensitive tags, which
// Svelte's scoped CSS emits (`button.svelte-x`, `.a:where(.svelte-x)`), and the HTML tags Svelte components write.

const state = { hover: false, pressed: false, focus: false, disabled: false };
const target = (tag: string, classes: string[] = [], parent: StyleTarget | null = null, id: string | null = null): StyleTarget => ({ tag, id, classes, state, parent });
const element = (tag: MarkupElement["tag"]): MarkupElement => ({ tag, attributes: [], file: "t.css" });

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

// ADR 0418 wave 5: `:not()`, structural pseudo-classes, attribute selectors, sibling combinators, `:empty`, `:root`,
// `calc()` and canvas `@media`, through the cascade's interface (rule data from the stylesheet parser, targets as the
// document and the UI host build them).

interface Node {
  tag: string;
  id?: string | null;
  classes?: string[];
  attributes?: Record<string, string>;
  text?: boolean;
  children?: Node[];
}

/** Targets for a tree, each listing its children: by id, and the root. */
function build(root: Node, media: { width: number; height: number } | null = null) {
  const byId = new Map<string, StyleTarget>();
  const make = (n: Node, parent: StyleTarget | null): StyleTarget => {
    const t: StyleTarget & { children: StyleTarget[] } = {
      tag: n.tag,
      id: n.id ?? null,
      classes: n.classes ?? [],
      state,
      parent,
      attributes: new Map(Object.entries(n.attributes ?? {})),
      children: [],
      content: !!n.text,
      ...(parent ? {} : { media }),
    };
    for (const c of n.children ?? []) t.children.push(make(c, t));
    if (n.id) byId.set(n.id, t);
    return t;
  };
  const top = make(root, null);
  return { top, get: (id: string) => byId.get(id)! };
}

const list = () =>
  build({
    tag: "ul",
    id: "list",
    children: [
      { tag: "li", id: "a", classes: ["item"] },
      { tag: "li", id: "b", classes: ["item", "done"] },
      { tag: "p", id: "c" },
      { tag: "li", id: "d", classes: ["item"] },
      { tag: "li", id: "e", classes: ["item", "done"] },
    ],
  });

const matching = (text: string, t: ReturnType<typeof list>) => {
  const sheet = parseStylesheet(`${text} {}`, "t.css");
  expect(sheet.problems).toEqual([]);
  return ["a", "b", "c", "d", "e"].filter((id) => sheet.rules[0].selectors.some((sel) => matchSelector(sel, t.get(id))));
};

describe("wave 5 selectors", () => {
  it("matches structural pseudo-classes by position among the child elements", () => {
    const t = list();
    expect(matching(":first-child", t)).toEqual(["a"]);
    expect(matching(":last-child", t)).toEqual(["e"]);
    expect(matching("li:nth-child(odd)", t)).toEqual(["a", "e"]);
    expect(matching(":nth-child(2n)", t)).toEqual(["b", "d"]);
    expect(matching(":nth-child(-n+2)", t)).toEqual(["a", "b"]);
    expect(matching(":nth-last-child(2)", t)).toEqual(["d"]);
    expect(matching(":nth-child(2 of .item)", t)).toEqual(["b"]);
    expect(matching(":nth-last-child(1 of :not(.done))", t)).toEqual(["d"]);
    expect(matching("li:first-of-type, li:last-of-type", t)).toEqual(["a", "e"]);
    expect(matching("p:only-of-type", t)).toEqual(["c"]);
    expect(matching(":only-child", t)).toEqual([]);
    expect(matching("li:nth-of-type(3)", t)).toEqual(["d"]);
  });

  it("matches :not() with a selector list and complex arguments", () => {
    const t = list();
    expect(matching("li:not(.done)", t)).toEqual(["a", "d"]);
    expect(matching(":not(.done, p)", t)).toEqual(["a", "d"]);
    expect(matching("li:not(ul > :first-child)", t)).toEqual(["b", "d", "e"]);
  });

  it("matches the next-sibling and later-sibling combinators", () => {
    const t = list();
    expect(matching("li + li", t)).toEqual(["b", "e"]);
    expect(matching("p ~ li", t)).toEqual(["d", "e"]);
    expect(matching(".done + p", t)).toEqual(["c"]);
    expect(matching("#a ~ .done", t)).toEqual(["b", "e"]);
    expect(matching("ul > li:first-child + li", t)).toEqual(["b"]);
  });

  it("matches attribute selectors against the attributes as written, names case-insensitively", () => {
    const t = build({ tag: "div", id: "root", children: [{ tag: "input", id: "i", attributes: { type: "checkbox", "data-State": "open now", lang: "en-GB", href: "https://x.org/a.PNG" } }] });
    const i = t.get("i");
    const yes = (s: string) => matchSelector(selector(s), i);
    expect(yes("[type]")).toBe(true);
    expect(yes("[data-state]")).toBe(true);
    expect(yes("input[type=checkbox]")).toBe(true);
    expect(yes("[type=Checkbox]")).toBe(false);
    expect(yes("[type=Checkbox i]")).toBe(true);
    expect(yes("[data-state~=open]")).toBe(true);
    expect(yes("[data-state~=ope]")).toBe(false);
    expect(yes("[lang|=en]")).toBe(true);
    expect(yes("[lang|=e]")).toBe(false);
    expect(yes("[href^='https:']")).toBe(true);
    expect(yes('[href$=".png"]')).toBe(false);
    expect(yes('[href$=".png" i]')).toBe(true);
    expect(yes("[href*=x]")).toBe(true);
    expect(yes("[href*='']")).toBe(false);
    expect(yes("[missing]")).toBe(false);
  });

  it("matches :empty (no child elements, no text) and :root (the element without a parent)", () => {
    const t = build({ tag: "div", id: "root", children: [{ tag: "div", id: "blank" }, { tag: "span", id: "label", text: true }, { tag: "div", id: "box", children: [{ tag: "span", id: "x" }] }] });
    expect(["blank", "label", "box", "x"].filter((id) => matchSelector(selector(":empty"), t.get(id)))).toEqual(["blank", "x"]);
    expect(matchSelector(selector(":root"), t.top)).toBe(true);
    expect(matchSelector(selector(":root"), t.get("box"))).toBe(false);
    expect(matchSelector(selector(":root > div:empty"), t.get("blank"))).toBe(true);
  });

  it("doesn't match structural or attribute tests on targets that can't say", () => {
    const bare = target("span", [], target("div"));
    expect(matchSelector(selector(":first-child"), bare)).toBe(false);
    expect(matchSelector(selector(":empty"), bare)).toBe(false);
    expect(matchSelector(selector("[x]"), bare)).toBe(false);
  });

  it("reads the target's current position, so a restyle after siblings change matches again", () => {
    const sheet = parseStylesheet(`li:last-child { font-size: 30px; } li + li { color: #ff0000; }`, "t.css");
    const t = list();
    const resolve = (id: string) => resolveStyle(t.get(id), element("Text"), UIText, [sheet], null, () => {});
    expect(resolve("e").get("fontSize")?.value).toBe(30);
    expect(resolve("d").has("fontSize")).toBe(false);
    (t.top.children as StyleTarget[]).pop(); // the last item removed
    expect(resolve("d").get("fontSize")?.value).toBe(30);
    expect(resolve("a").has("color")).toBe(false);
    expect(resolve("b").get("color")?.value).toEqual(Color.from("#ff0000"));
  });
});

describe("wave 5 values: calc(), min(), max(), clamp()", () => {
  const panel = (decls: string, vars = "") => {
    const warnings: string[] = [];
    const sheet = parseStylesheet(`${vars} div { ${decls} }`, "t.css");
    expect(sheet.problems).toEqual([]);
    const t = build({ tag: "section", id: "root", children: [{ tag: "div", id: "p" }] });
    const parent = resolveStyle(t.top, element("Panel"), UIPanel, [sheet], null, () => {});
    return { values: resolveStyle(t.get("p"), element("Panel"), UIPanel, [sheet], parent, (w) => warnings.push(w)), warnings };
  };

  it("resolves px-only and number expressions in the cascade, with nesting and var()", () => {
    const { values } = panel("width: calc(2 * (10px + 5px)); height: calc(var(--h) / 2 - 4px); gap: calc(3 * 2); padding: calc(1px + 1px) max(4px, 6px); opacity: clamp(0, calc(0.25 * 3), 1);", ":root { --h: 100px; }");
    expect(values.get("width")!.value).toBe("30");
    expect(values.get("height")!.value).toBe("46");
    expect(values.get("gap")!.value).toBe(6);
    expect([values.get("paddingTop")!.value, values.get("paddingRight")!.value]).toEqual([2, 6]);
    expect(values.get("opacity")!.value).toBe(0.75);
  });

  it("keeps a length mixing % and px for layout, in one normal form", () => {
    const { values } = panel("width: calc(100% - 24px); max-width: calc((50% + 10px) * 2); left: calc(30% - 10%);");
    expect(values.get("width")!.value).toBe("calc(100% + -24px)");
    expect(values.get("maxWidth")!.value).toBe("calc(100% + 20px)");
    expect(values.get("left")!.value).toBe("20%");
  });

  it("refuses what doesn't work out, with a warning", () => {
    const { values, warnings } = panel("width: calc(10px * 2px); height: calc(10px + 2); gap: calc(4px / 0); padding: calc(10% + 2px); min-width: min(10px, 50%);");
    expect(["width", "height", "gap", "minWidth", "padding"].filter((f) => values.has(f))).toEqual([]); // padding takes pixels only
    const all = warnings.join("\n");
    expect(all).toMatch(/\* needs a number/);
    expect(all).toMatch(/can't add/);
    expect(all).toMatch(/division by zero/);
    expect(all).toMatch(/compare/);
  });
});

describe("wave 5 @media on the canvas", () => {
  const css = `
    div { gap: 1; }
    @media (min-width: 600px) { div { gap: 2; } }
    @media (orientation: portrait) { div { opacity: 0.5; } }
    @media screen and (max-aspect-ratio: 4/3), print { div { flex-grow: 3; } }
    @media (400px <= height < 500px) { @media not (width > 1000px) { div { flex-shrink: 4; } } }
    @media print { div { gap: 9; } }
  `;

  it("parses @media into rule data and matches it against the canvas in UI pixels", () => {
    const sheet = parseStylesheet(css, "t.css");
    expect(sheet.problems).toEqual([]);
    expect(sheet.rules[1].media).toEqual([[{ condition: { feature: "width", op: ">=", value: 600 } }]]);
    const at = (width: number, height: number) => {
      const t = build({ tag: "div", id: "root", children: [{ tag: "div", id: "p" }] }, { width, height });
      return resolveStyle(t.get("p"), element("Panel"), UIPanel, [sheet], null, () => {});
    };
    const wide = at(1280, 720);
    expect([wide.get("gap")?.value, wide.has("opacity"), wide.has("flexGrow"), wide.has("flexShrink")]).toEqual([2, false, false, false]);
    const tall = at(450, 800);
    expect([tall.get("gap")?.value, tall.get("opacity")?.value, tall.get("flexGrow")?.value]).toEqual([1, 0.5, 3]);
    expect(at(800, 450).get("flexShrink")?.value).toBe(4);
    expect(at(1200, 450).has("flexShrink")).toBe(false);
  });

  it("matches only size-free queries before the canvas has a size", () => {
    const sheet = parseStylesheet(`@media screen { div { gap: 5; } } @media (min-width: 0px) { div { opacity: 0.1; } }`, "t.css");
    const t = build({ tag: "div", id: "root", children: [{ tag: "div", id: "p" }] }, null);
    const r = resolveStyle(t.get("p"), element("Panel"), UIPanel, [sheet], null, () => {});
    expect(r.get("gap")?.value).toBe(5);
    expect(r.has("opacity")).toBe(false);
  });

  it("reports a query it can't read, and keyframes inside @media", () => {
    const sheet = parseStylesheet(`@media (min-width: wide) { div {} } @media screen { @keyframes k { to { opacity: 0; } } }`, "t.css");
    const all = sheet.problems.map((p) => p.message).join("\n");
    expect(all).toMatch(/isn't a length/);
    expect(all).toMatch(/@keyframes isn't supported inside @media/);
  });
});
