// ADR 0428 (wave G1), selectors and values: `:has()` with relative selectors, and `em`, `rem` and viewport lengths in
// every length and in `calc()`, through the way game UI is built (a UIView mounting a Svelte component: `buildUI`) and
// the selector reader queries and rule data share.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Assets, Color, Engine, Vector2 } from "../index";
import { UIPanel, UIText } from "../ui/components";
import { parseStylesheet } from "../ui/document/stylesheet";
import { parseSelectorQuery } from "../ui/document/selectorQuery";
import { buildUI, byId, classList, loadUITestSupport, type TestUI } from "./uiMarkup";

const DT = 1 / 64;
let engine: Engine;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  engine.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};

type TreeNode = { text: string } | { tag: string; attributes: Record<string, string>; children: TreeNode[] };

/** The element data the view renders under the canvas (the component's props, which Svelte watches). */
function nodes(ui: TestUI): TreeNode[] {
  return ui.view.props.nodes as TreeNode[];
}

/** The children data of the element at `path` (indices from the canvas). */
function childrenAt(ui: TestUI, ...path: number[]): TreeNode[] {
  let list = nodes(ui);
  for (const i of path) list = (list.filter((n) => "tag" in n)[i] as Extract<TreeNode, { tag: string }>).children;
  return list;
}

const RED = Color.from("#ff0000");

describe(":has() (ADR 0428)", () => {
  it("matches an element by what's inside or after it, with each leading combinator, in rules and queries", () => {
    const ui = buildUI(
      `<Canvas>
        <div id="a" class="card"><p class="badge">New</p></div>
        <div id="b" class="card"><div><p class="badge">Deep</p></div></div>
        <div id="c" class="card"><p>Plain</p></div>
        <div id="d" class="row"/><div id="e" class="tip"/>
      </Canvas>`,
      {
        css: `.card:has(.badge) { background-color: #ff0000 }
              .card:has(> .badge) { border-width: 2px }
              .row:has(+ .tip) { opacity: 0.5 }
              .row:has(~ .card) { flex-grow: 3 }`,
      },
    );
    step(); // the sibling forms match once the later siblings exist (each element is styled as it's rendered)
    const [a, b, c] = ["a", "b", "c"].map((id) => byId(ui, id, UIPanel));
    expect([a.backgroundColor, b.backgroundColor, c.backgroundColor]).toEqual([RED, RED, null]);
    expect([a.borderWidth, b.borderWidth]).toEqual([2, 0]); // only a direct child for `>`
    expect(byId(ui, "d", UIPanel).opacity).toBe(0.5);
    expect(byId(ui, "d", UIPanel).flexGrow).toBe(0); // no card after it
    expect(ui.queryAll(".card:has(p.badge)").map((e) => e.id)).toEqual(["a", "b"]);
    expect(ui.queryAll(".card:has(> p)").map((e) => e.id)).toEqual(["a", "c"]);
    expect(ui.queryAll("div:not(:has(*))").map((e) => e.id)).toEqual(["d", "e"]);
  });

  it("takes its most specific argument's specificity, and refuses :has() inside :has()", () => {
    const sheet = parseStylesheet(`.a:has(#x, .y) {} :has(> .b .c) {}`, "t.css");
    expect(sheet.problems).toEqual([]);
    expect(sheet.rules[0].selectors[0].specificity).toEqual([1, 1, 0]);
    expect(sheet.rules[1].selectors[0].specificity).toEqual([0, 2, 0]);
    expect(parseStylesheet(`.a:has(.b:has(.c)) {}`, "t.css").problems[0].message).toMatch(/:has\(\) inside :has\(\) isn't supported/);
    expect(() => parseSelectorQuery(".a:has(:is(.b:has(.c)))")).toThrow(/:has\(\) inside :has\(\)/);
    const rel = parseSelectorQuery(".a:has(+ .b, .c > .d)")[0].parts[0].selector.has![0];
    expect(rel.map((s) => s.parts[0].combinator)).toEqual(["+", " "]);
  });

  it("restyles an anchor when an element inside it changes class, appears or goes", () => {
    const ui = buildUI(`<Canvas><div id="card" class="card"><p id="t" class="title">Hi</p></div></Canvas>`, { css: `.card:has(.on) { background-color: #ff0000 } .card:has(span) { opacity: 0.25 }` });
    const card = byId(ui, "card", UIPanel);
    expect(card.backgroundColor).toBeNull();
    classList(ui.query("#t")!).add("on");
    step();
    expect(card.backgroundColor).toEqual(RED);
    classList(ui.query("#t")!).remove("on");
    step();
    expect(card.backgroundColor).toBeNull();
    // An element appearing inside it, then going.
    childrenAt(ui, 0).push({ tag: "div", attributes: {}, children: [{ tag: "span", attributes: {}, children: [] }] });
    flushSync();
    step();
    expect(card.opacity).toBe(0.25);
    childrenAt(ui, 0).pop();
    flushSync();
    step();
    expect(card.opacity).toBe(1);
  });

  it("restyles an earlier sibling for + and ~, and an anchor's descendants when :has() isn't the subject", () => {
    const ui = buildUI(
      `<Canvas><div id="w"><div id="s" class="label"/><div id="n" class="field"/></div><div id="card" class="card"><p id="title">T</p><div id="x"/></div></Canvas>`,
      { css: `.label:has(+ .field.bad) { border-width: 3px } .card:has(.on) p { color: #ff0000 }` },
    );
    expect(byId(ui, "s", UIPanel).borderWidth).toBe(0);
    classList(ui.query("#n")!).add("bad");
    step();
    expect(byId(ui, "s", UIPanel).borderWidth).toBe(3);
    expect(byId(ui, "title", UIText).color).toEqual(Color.white);
    classList(ui.query("#x")!).add("on");
    step();
    expect(byId(ui, "title", UIText).color).toEqual(RED);
  });

  it("restyles an anchor when an element inside it gains or loses a pseudo-class (:has(:focus))", () => {
    const ui = buildUI(`<Canvas><div id="form" class="form"><input id="f"/></div></Canvas>`, { css: `.form:has(input:focus) { border-width: 2px }` });
    const form = byId(ui, "form", UIPanel);
    step();
    expect(form.borderWidth).toBe(0);
    ui.query("#f")!.focus();
    step();
    expect(form.borderWidth).toBe(2);
    ui.query("#f")!.blur();
    step();
    expect(form.borderWidth).toBe(0);
  });

  it("passes an anchor's changed inherited values down to its subtree", () => {
    const ui = buildUI(`<Canvas><div id="card" class="card"><div><p id="t">Hi</p></div><div id="i" class="flag"/></div></Canvas>`, { css: `.card:has(.flag.on) { color: #ff0000; font-size: 20px }` });
    const t = byId(ui, "t", UIText);
    expect(t.color).toEqual(Color.white);
    classList(ui.query("#i")!).add("on");
    step();
    expect([t.color, t.fontSize]).toEqual([RED, 20]);
  });
});

describe("relative lengths: em, rem and viewport units (ADR 0428)", () => {
  it("resolves em against the element's font size (its parent's inside font-size), in every length and in calc()", () => {
    const ui = buildUI(
      `<Canvas><div id="box" class="box"><p id="p" class="inner">x</p><div id="mixed" class="mixed"/></div></Canvas>`,
      {
        css: `.box { font-size: 20px; padding: 0.5em 1em; width: 10em; border: 0.1em solid #000; transform: translate(1em, 0) }
              .inner { font-size: 1.5em; width: 2em; text-shadow: 0.1em 0.1em 0 #000 }
              .mixed { width: calc(50% + 1em); height: calc(2em - 4px) }`,
      },
    );
    const box = byId(ui, "box", UIPanel);
    expect([box.paddingTop, box.paddingRight, box.width, box.borderWidth, box.translateX]).toEqual([10, 20, "200", 2, "20"]);
    const p = byId(ui, "p", UIText);
    expect([p.fontSize, p.width, p.textShadowOffsetX]).toEqual([30, "60", 3]);
    const mixed = byId(ui, "mixed", UIPanel);
    expect([mixed.width, mixed.height]).toEqual(["calc(50% + 20px)", "36"]); // its font size is inherited: 20px
  });

  it("resolves rem against the root canvas element's font size, which its children inherit", () => {
    const ui = buildUI(`<Canvas><p id="a">a</p><p id="b" class="b">b</p></Canvas>`, { css: `:root { font-size: 10px; color: #ff0000 } .b { font-size: 2rem; width: 3rem; padding: 1em }` });
    const a = byId(ui, "a", UIText), b = byId(ui, "b", UIText);
    expect([a.fontSize, a.color]).toEqual([10, RED]);
    expect([b.fontSize, b.width, b.padding]).toEqual([20, "30", 20]);
  });

  it("resolves vw, vh, vmin and vmax against the canvas in UI pixels, and restyles when it changes size", () => {
    // Headless, nothing lays the canvas out, so its reference resolution is its size.
    const ui = buildUI(`<Canvas reference-resolution="1000 500"><div id="a" class="a"/><div id="b" style="height: 10vmax"/></Canvas>`, {
      css: `.a { width: 10vw; height: 20vh; padding: 1vmin; margin: calc(100vw - 990px) }`,
    });
    const a = byId(ui, "a", UIPanel), b = byId(ui, "b", UIPanel);
    step(); // the view's reference resolution reaches its canvas in the frame
    expect([a.width, a.height, a.padding, a.margin, b.height]).toEqual(["100", "100", 5, 10, "100"]);
    ui.view.referenceResolution = new Vector2(2000, 500);
    step(2);
    expect([a.width, a.height, a.padding, a.margin, b.height]).toEqual(["200", "100", 5, 1010, "200"]);
  });

  it("converts relative lengths in keyframes with the element's own units", () => {
    const ui = buildUI(`<Canvas><div id="a" class="a"/></Canvas>`, { css: `@keyframes grow { from { width: 1em } to { width: 3em } } .a { font-size: 10px; animation: grow 1s linear }` });
    step();
    expect(byId(ui, "a", UIPanel).width).toBe("10");
  });
});
