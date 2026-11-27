// ADR 0428 (wave G2), pseudo-elements: `::before`/`::after` with `content`, `::placeholder`, `::selection` and form
// controls' part pseudo-elements, through the way game UI is built (a UIView mounting a Svelte component: `buildUI`), the
// UI core that lays it out and routes the pointer (`UIPointer`), and the selector readers rule data and queries share.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine } from "../index";
import { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { UIButton, UIInputField, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UIText, UIToggle, UIMeter, type UIComponentType } from "../ui/components";
import { textRunOf } from "../ui/elementKinds";
import { parseStylesheet } from "../ui/document/stylesheet";
import { parseSelectorQuery } from "../ui/document/selectorQuery";
import { buildUI, byId, classList, loadUITestSupport } from "./uiMarkup";
import { UIPointer } from "./uiPointer";

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

const RED = Color.from("#ff0000");
const BLUE = Color.from("#0000ff");

/** The UI component on a node (a generated element's, found through the node tree as any node's). */
function compOf<T extends UIComponentType>(node: GameObject, type: abstract new () => T): T {
  const c = node.getComponent(type as never) as T | null;
  if (!c) throw new Error(`"${node.name}" has no ${type.name}.`);
  return c;
}

describe("pseudo-element selectors (ADR 0428)", () => {
  it("reads a trailing pseudo-element in rule data and queries alike, counting it as a type selector", () => {
    for (const text of ["p::before", "button:hover::after", ".a > p:first-child::before", "div:before", "input::placeholder", "input::-webkit-slider-thumb", "select::picker-icon", "input::checkmark"]) {
      const sheet = parseStylesheet(`${text} {}`, "t.css");
      expect(sheet.problems).toEqual([]);
      expect(parseSelectorQuery(text)).toEqual(sheet.rules[0].selectors);
    }
    const [sel] = parseSelectorQuery("p.a::before");
    expect(sel.pseudoElement).toBe("before");
    expect(sel.specificity).toEqual([0, 1, 2]);
    expect(parseSelectorQuery("div:after")[0].pseudoElement).toBe("after");
    expect(parseSelectorQuery("::selection")[0]).toMatchObject({ pseudoElement: "selection", root: false });
  });

  it("refuses unknown pseudo-elements, ones inside arguments, and anything after one", () => {
    expect(() => parseSelectorQuery("p::first-line")).toThrow(/::first-line isn't supported/);
    expect(() => parseSelectorQuery(":is(p::before)")).toThrow(/can't be inside/);
    expect(() => parseSelectorQuery("p::before span")).toThrow(/ends its selector/);
    expect(() => parseSelectorQuery("p::before:hover")).toThrow(/nothing may follow/);
    expect(parseStylesheet(`p::first-letter {}`, "t.css").problems[0].message).toMatch(/::first-letter isn't supported/);
    expect(parseStylesheet(`:is(p::before) {}`, "t.css").problems[0].message).toMatch(/can't be inside/);
    expect(parseStylesheet(`p::before:hover {}`, "t.css").problems[0].message).toMatch(/ends its selector/);
  });
});

describe("::before and ::after (ADR 0428)", () => {
  it("generates boxes first and last in an element, styled by their rules, with their content as a label", async () => {
    const ui = buildUI(`<Canvas><div id="d" data-tip="tip" position="absolute" left="0" top="0" flex-direction="row"><div id="c" width="10" height="10"/></div></Canvas>`, {
      css: `#d::before { content: "A " attr(data-tip) "!"; width: 20px; height: 10px; background-color: #ff0000; color: #0000ff }
            #d::after { content: ""; width: 5px; height: 10px; border-radius: 2px; background-color: #0000ff }`,
    });
    const d = ui.query("#d")!;
    const kids = d.node.children;
    expect(kids.map((n) => n.name)).toEqual(["::before", "c", "::after"]);
    const before = compOf(kids[0], UIPanel);
    expect(before.backgroundColor).toEqual(RED);
    expect(before.width).toBe("20");
    const label = compOf(kids[0].children[0], UIText);
    expect(label.text).toBe("A tip!");
    expect(label.color).toEqual(BLUE); // inherited from its box
    const after = compOf(kids[2], UIPanel);
    expect(after.borderRadius).toBe(2);
    expect(kids[2].children).toEqual([]); // `content: ""` has no label
    // Laid out by the UI core as the element's first and last child.
    const pointer = await UIPointer.create(World.require());
    try {
      expect(pointer.core.rectOf(byId(ui, "c", UIPanel))!.x).toBe(20);
      expect(pointer.core.rectOf(after)!.x).toBe(30);
      expect(pointer.core.rectOf(byId(ui, "d", UIPanel))!.width).toBe(35);
    } finally {
      pointer.dispose();
    }
    // Not elements: queries, children and structural selectors don't see them.
    expect(d.children.map((c) => c.id)).toEqual(["c"]);
    expect(ui.queryAll("#d *").map((e) => e.id)).toEqual(["c"]);
    expect(ui.query("#c:first-child:last-child")?.id).toBe("c");
  });

  it("is an inline run inside a text element, before and after its own text, hitting as the text", () => {
    const ui = buildUI(`<Canvas><p id="p" data-end="!">Hello</p></Canvas>`, {
      css: `p::before { content: "\\BB  "; color: #ff0000 } p::after { content: attr(data-end) }`,
    });
    const p = byId(ui, "p", UIText);
    const runs = textRunOf(p)!.runs!;
    expect(runs.map((r) => r.text)).toEqual(["» ", "Hello", "!"]);
    expect(runs[0].color).toBe("rgba(255, 0, 0, 1)");
    expect(runs[0].owner).toBe(p); // its events go to the text
    expect(textRunOf(p)!.text).toBe("» Hello!");
  });

  it("collapses its white space with the text's, sits inside its element's inline box, and is an atom when inline-block", () => {
    const ui = buildUI(`<Canvas><p id="p"><span id="s">  Hello   world</span> <em id="e">x</em></p></Canvas>`, {
      css: `#s::before { content: "»   " } #s { padding: 0 4px; border: 1px solid #0000ff } #e::after { content: "!"; display: inline-block; padding: 2px }`,
    });
    const p = byId(ui, "p", UIText);
    const run = textRunOf(p)!;
    expect(run.runs!.map((r) => r.text)).toEqual(["» ", "Hello world", " ", "x", "￼"]);
    const s = byId(ui, "s", UIText);
    // The span's box spans its generated run and its own text.
    expect(run.boxes!.map((b) => [b.owner, b.first, b.last])).toEqual([[s, 0, 1]]);
    expect(run.runs![4].atom).toBeTruthy();
  });

  it("restyles when attributes, classes and rules change, and goes with content: none", () => {
    const ui = buildUI(`<Canvas><div id="d" data-n="1"/></Canvas>`, {
      css: `#d::before { content: "n" attr(data-n) } #d.off::before { content: none } #d.big::before { width: 50px }`,
    });
    const d = ui.query("#d")!;
    const label = () => compOf(d.node.children[0].children[0], UIText).text;
    expect(label()).toBe("n1");
    d.tree.setAttributes(d, new Map([...d.attributes, ["data-n", "2"]]));
    step();
    expect(label()).toBe("n2");
    classList(d).add("big");
    step();
    expect(compOf(d.node.children[0], UIPanel).width).toBe("50");
    classList(d).add("off");
    step();
    expect(d.node.children).toEqual([]);
    classList(d).remove("off");
    step();
    expect(label()).toBe("n2");
  });

  it("follows the originating element's pseudo-classes (:hover::before), and its clicks go to that element", async () => {
    const ui = buildUI(`<Canvas><button id="b" position="absolute" left="0" top="0" padding="0" flex-direction="row"/></Canvas>`, {
      css: `#b::before { content: ""; width: 40px; height: 20px; background-color: #0000ff } #b:hover::before { background-color: #ff0000 }`,
    });
    const b = ui.query("#b")!;
    const box = compOf(b.node.children[0], UIPanel);
    const clicks: string[] = [];
    b.on("click", (e) => clicks.push(`${e.element.id}`));
    const pointer = await UIPointer.create(World.require());
    try {
      expect(box.backgroundColor).toEqual(BLUE);
      const at = pointer.pointIn(box);
      pointer.dom.moveTo(at.x, at.y);
      step();
      pointer.sync();
      step();
      expect(byId(ui, "b", UIButton).hovered).toBe(true);
      expect(box.backgroundColor).toEqual(RED);
      pointer.dom.click();
      step(2);
      expect(clicks).toEqual(["b"]);
    } finally {
      pointer.dispose();
    }
  });

  it("transitions a generated element's fields, and is removed with its element", () => {
    const ui = buildUI(`<Canvas><div id="d"/></Canvas>`, {
      css: `#d::before { content: "x"; opacity: 1; transition: opacity 1s linear } #d.dim::before { opacity: 0 }`,
    });
    const d = ui.query("#d")!;
    const gen = d.node.children[0];
    const box = compOf(gen, UIPanel);
    classList(d).add("dim");
    step(32);
    expect(box.opacity).toBeGreaterThan(0.2);
    expect(box.opacity).toBeLessThan(0.8);
    d.tree.remove(d);
    expect(gen.isValid).toBe(false);
  });
});

describe("::placeholder and ::selection (ADR 0428)", () => {
  it("style an input's placeholder (colour faded by opacity, slant) and selection, keeping the defaults otherwise", () => {
    const ui = buildUI(`<Canvas><input id="a" placeholder="Name"/><input id="b"/><textarea id="t"></textarea><p id="p" contenteditable="true">x</p></Canvas>`, {
      css: `#a::placeholder { color: #ff0000; opacity: 0.5; font-style: italic }
            textarea::placeholder { opacity: 0.5 }
            #a::selection, p::selection { color: #ffffff; background-color: #0000ff }`,
    });
    const a = byId(ui, "a", UIInputField), b = byId(ui, "b", UIInputField), t = byId(ui, "t", UIInputField);
    expect(a.placeholderColor).toEqual(new Color(1, 0, 0, 0.5));
    expect(a.placeholderFontStyle).toBe("italic");
    expect(b.placeholderColor).toEqual(new UIInputField().placeholderColor);
    const grey = new UIInputField().placeholderColor;
    expect(t.placeholderColor).toEqual(new Color(grey.r, grey.g, grey.b, 0.5)); // the default colour, faded
    expect([a.selectionColor, a.selectionBackgroundColor]).toEqual([Color.from("#ffffff"), BLUE]);
    expect(b.selectionBackgroundColor).toBeNull();
    expect(byId(ui, "p", UIText).selectionBackgroundColor).toEqual(BLUE);
  });

  it("goes back to the defaults when its rule stops matching", () => {
    const ui = buildUI(`<Canvas><input id="a" class="x"/></Canvas>`, { css: `.x::placeholder { color: #ff0000 }` });
    const a = byId(ui, "a", UIInputField);
    expect(a.placeholderColor).toEqual(RED);
    classList(ui.query("#a")!).remove("x");
    step();
    expect(a.placeholderColor).toEqual(new UIInputField().placeholderColor);
  });
});

describe("form part pseudo-elements (ADR 0428)", () => {
  async function partsOf(c: UIComponentType) {
    const pointer = await UIPointer.create(World.require());
    try {
      return pointer.core.elements().find((e) => e.comp === c)!.parts;
    } finally {
      pointer.dispose();
    }
  }

  it("size and paint a slider's thumb and track", async () => {
    const ui = buildUI(`<Canvas><input id="s" type="range" min="0" max="10" value="5" position="absolute" width="110" height="20"/></Canvas>`, {
      css: `#s::-webkit-slider-thumb { width: 10px; height: 30px; background-color: #ff0000; border: 2px solid #0000ff; border-radius: 1px; box-shadow: 0 1px 4px #000000 }
            #s::-webkit-slider-runnable-track { height: 6px; background-color: #0000ff }`,
    });
    const [track, fill, thumb] = (await partsOf(byId(ui, "s", UISlider)))!;
    expect(thumb).toMatchObject({ x: 50, y: -5, width: 10, height: 30, color: [1, 0, 0, 1], radius: 1, border: { width: 2, color: [0, 0, 1, 1] }, shadow: { x: 0, y: 1, blur: 4, color: [0, 0, 0, 1] } });
    expect(track).toMatchObject({ x: 5, y: 7, width: 100, height: 6, color: [0, 0, 1, 1] });
    expect(fill).toMatchObject({ x: 5, width: 50, height: 6 }); // the fill keeps the accent colour
  });

  it("paint a progress bar's track and value, a meter's value by region, a check mark and a select's arrow", async () => {
    const ui = buildUI(
      `<Canvas><progress id="p" value="5" max="10" width="100" height="10"/>
        <meter id="m" value="0.9" low="0.3" high="0.7" optimum="0.1" width="100" height="10"/>
        <input id="c" type="checkbox" checked="" width="20" height="20"/><input id="r" type="radio" checked="" width="20" height="20"/>
        <select id="sel"><option>One</option></select></Canvas>`,
      {
        css: `#p::-webkit-progress-bar { background-color: #0000ff; border-radius: 3px } #p::-webkit-progress-value { background-color: #ff0000 }
              #m::-webkit-meter-optimum-value { background-color: #00ff00 } #m::-webkit-meter-even-less-good-value { background-color: #ff00ff }
              input::checkmark { color: #ff0000 } select::picker-icon { color: #0000ff }`,
      },
    );
    const [bar, value] = (await partsOf(byId(ui, "p", UIProgress)))!;
    expect(bar).toMatchObject({ x: 0, width: 100, color: [0, 0, 1, 1], radius: 3 });
    expect(value).toMatchObject({ width: 50, color: [1, 0, 0, 1] });
    expect((await partsOf(byId(ui, "m", UIMeter)))![0].color).toEqual([1, 0, 1, 1]); // 0.9 is even less good
    const check = (await partsOf(byId(ui, "c", UIToggle)))!;
    expect(check.slice(1).map((p) => p.color)).toEqual([[1, 0, 0, 1], [1, 0, 0, 1]]);
    expect((await partsOf(byId(ui, "r", UIRadio)))![1].color).toEqual([1, 0, 0, 1]);
    expect((await partsOf(byId(ui, "sel", UISelect)))!.map((p) => p.color)).toEqual([[0, 0, 1, 1], [0, 0, 1, 1]]);
  });
});
