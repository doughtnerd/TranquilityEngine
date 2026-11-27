import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIInputField, UIPanel, UIText } from "../ui/components";
import type { UIComponentType } from "../ui/components";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
import { Assets } from "../scene/Assets";
import { buildUI, byId, loadUITestSupport } from "./uiMarkup";
import { UIPointer } from "./uiPointer";

// ADR 0422 wave 1: layout on Yoga. Per-side padding, margin and border widths with CSS shorthands, min/max sizes,
// wrapping, align-self/-content, flex-shrink/-basis, aspect-ratio, overflow: hidden (clipping drawing order, hits,
// picking and navigation) and z-index, through UI views, the UI core and keyboard navigation.

const DT = 1 / 60;
let engine: Engine;
const cores: UICore[] = [];
const pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  for (const c of cores.splice(0)) c.dispose();
  for (const p of pointers.splice(0)) p.dispose();
  Input.inject.releaseAll();
  engine.step(DT);
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

/** A UI core that has laid out the World's UI at 1280 × 720 (a scale of 1 for the default canvas). */
async function laidOut(): Promise<UICore> {
  const c = new UICore({ interactive: false });
  cores.push(c);
  await c.ready;
  c.sync(World.require(), 1280, 720, DT);
  return c;
}

/** An element's box in canvas pixels. */
function box(core: UICore, c: UIComponentType): [number, number, number, number] {
  const r = core.rectOf(c)!;
  return [r.x, r.y, r.width, r.height];
}

const panel = (doc: ReturnType<typeof buildUI>, id: string) => byId(doc, id, UIPanel);

describe("shorthands and longhands in the cascade (ADR 0422)", () => {
  it("expands padding, margin and border-width: one value is the all-sides field, two to four the sides", () => {
    const doc = buildUI(`<Canvas><div id="a" class="two"/><div id="b" class="one"/><div id="c" class="three"/><div id="d" class="four"/></Canvas>`, {
      css: `.two { padding: 4px 8px; margin: 1px 2px; border-width: 3px 5px }
            .one { padding: 6px; border-width: 2px }
            .three { margin: 1px 2px 3px }
            .four { padding: 1px 2px 3px 4px }`,
    });
    const a = panel(doc, "a");
    expect([a.paddingTop, a.paddingRight, a.paddingBottom, a.paddingLeft]).toEqual([4, 8, 4, 8]);
    expect([a.marginTop, a.marginRight, a.marginBottom, a.marginLeft]).toEqual([1, 2, 1, 2]);
    expect([a.borderTopWidth, a.borderRightWidth, a.borderBottomWidth, a.borderLeftWidth]).toEqual([3, 5, 3, 5]);
    expect(a.padding).toBe(0); // the all-sides value is untouched by a multi-value shorthand
    const b = panel(doc, "b");
    expect(b.padding).toBe(6);
    expect([b.paddingTop, b.paddingRight, b.paddingBottom, b.paddingLeft]).toEqual([null, null, null, null]);
    expect(b.borderWidth).toBe(2);
    const c = panel(doc, "c");
    expect([c.marginTop, c.marginRight, c.marginBottom, c.marginLeft]).toEqual([1, 2, 3, 2]);
    const d = panel(doc, "d");
    expect([d.paddingTop, d.paddingRight, d.paddingBottom, d.paddingLeft]).toEqual([1, 2, 3, 4]);
  });

  it("orders shorthands and longhands as CSS does: the later declaration wins for each longhand", () => {
    const doc = buildUI(`<Canvas><div id="a" class="x"/><div id="b" class="y"/><div id="c" class="z"/></Canvas>`, {
      css: `.x { padding: 10px; padding-left: 2px }
            .y { padding-left: 2px; padding: 10px }
            #c { padding-left: 7px }
            .z { padding: 1px 2px }`,
    });
    const a = panel(doc, "a");
    expect([a.padding, a.paddingLeft, a.paddingTop]).toEqual([10, 2, null]);
    const b = panel(doc, "b");
    expect([b.padding, b.paddingLeft]).toEqual([10, null]); // the shorthand reset the side: it takes padding again
    const c = panel(doc, "c");
    expect([c.paddingTop, c.paddingLeft]).toEqual([1, 7]); // the id rule is more specific than the class's shorthand
  });

  it("takes shorthands in attributes too, and attributes beat rules", () => {
    const doc = buildUI(`<Canvas><div id="a" padding="1 2 3 4" border="2px solid #fff"/><div id="b" padding-left="5"/></Canvas>`, {
      css: `#a { padding-left: 9px; border-width: 7px } div { padding: 3px 3px }`,
    });
    const a = panel(doc, "a");
    expect([a.paddingTop, a.paddingRight, a.paddingBottom, a.paddingLeft]).toEqual([1, 2, 3, 4]);
    expect(a.borderWidth).toBe(2);
    expect([a.borderColor.r, a.borderColor.g, a.borderColor.b]).toEqual([1, 1, 1]);
    const b = panel(doc, "b");
    expect([b.paddingTop, b.paddingLeft]).toEqual([3, 5]);
  });

  it("reads border as a width, solid or none, and a colour, in any order", () => {
    const doc = buildUI(`<Canvas><div id="a" class="a"/><div id="b" class="b"/><div id="c" class="c"/></Canvas>`, {
      css: `.a { border-width: 1px 2px; border: rgb(255, 0, 0) solid 4px }
            .b { border-width: 3px; border: none }
            .c { border: solid }`,
    });
    const a = panel(doc, "a");
    expect(a.borderWidth).toBe(4);
    expect(a.borderLeftWidth).toBeNull();
    expect([a.borderColor.r, a.borderColor.g, a.borderColor.b]).toEqual([1, 0, 0]);
    expect(panel(doc, "b").borderWidth).toBe(0);
    expect(panel(doc, "c").borderWidth).toBe(3); // medium
  });

  it("reads flex as grow, shrink and basis, with CSS's one- and two-value forms", () => {
    const doc = buildUI(`<Canvas><div id="a" flex="1"/><div id="b" flex="none"/><div id="c" flex="2 0 50%"/><div id="d" flex="100px"/><div id="e" flex="3 40px"/><div id="f" flex="auto"/></Canvas>`);
    const fields = (id: string) => {
      const p = panel(doc, id);
      return [p.flexGrow, p.flexShrink, p.flexBasis];
    };
    expect(fields("a")).toEqual([1, 1, "0"]);
    expect(fields("b")).toEqual([0, 0, "auto"]);
    expect(fields("c")).toEqual([2, 0, "50%"]);
    expect(fields("d")).toEqual([1, 1, "100"]);
    expect(fields("e")).toEqual([3, 1, "40"]);
    expect(fields("f")).toEqual([1, 1, "auto"]);
  });

  it("converts the other layout properties, and warns about a value that isn't valid, leaving the field alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = buildUI(`<Canvas><div id="a" class="a"/><p id="t" class="t"/></Canvas>`, {
      css: `.a { min-width: 10px; max-width: 50%; min-height: auto; max-height: none; flex-wrap: wrap-reverse; align-self: center;
                 align-content: space-between; flex-shrink: 2; flex-basis: 30px; aspect-ratio: 16 / 9; overflow: hidden; z-index: -2;
                 padding: 1px 2px 3px 4px 5px }
            .t { border: 2px solid red; flex-shrink: auto }`,
    });
    const a = panel(doc, "a");
    expect([a.minWidth, a.maxWidth, a.minHeight, a.maxHeight]).toEqual(["10", "50%", "auto", "none"]);
    expect([a.flexWrap, a.alignSelf, a.alignContent, a.flexShrink, a.flexBasis]).toEqual(["wrap-reverse", "center", "space-between", 2, "30"]);
    expect(a.aspectRatio).toBeCloseTo(16 / 9);
    expect([a.overflow, a.zIndex]).toEqual(["hidden", -2]);
    expect([a.paddingTop, a.padding]).toEqual([null, 0]); // five values: not a padding
    expect(warn.mock.calls.flat().join("\n")).toMatch(/"1px 2px 3px 4px 5px" isn't a valid padding/);
    // A Text has no border: the shorthand sets nothing on it, and isn't unknown.
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/unknown property "border"/);
    expect(byId(doc, "t", UIText).flexShrink).toBeNull();
  });
});

describe("Yoga layout of the new fields (ADR 0422)", () => {
  it("lays out per-side padding, margin and border widths", async () => {
    const doc = buildUI(`<Canvas><div id="p" width="200" height="100" padding="1 2 3 4" border-width="10 0 0 20"><div id="c" flex-grow="1" margin="5 6 7 8"/></div></Canvas>`);
    const core = await laidOut();
    // Inside the border (top 10, left 20) and padding (top 1, left 4), then the margin (top 5, left 8).
    expect(box(core, panel(doc, "c"))).toEqual([20 + 4 + 8, 10 + 1 + 5, 200 - 20 - 0 - 4 - 2 - 8 - 6, 100 - 10 - 0 - 1 - 3 - 5 - 7]);
  });

  it("clamps sizes to min and max", async () => {
    const doc = buildUI(`<Canvas><div id="a" width="10" min-width="40" height="500" max-height="50%"/><div id="b" flex-grow="1" max-width="100"/></Canvas>`);
    const core = await laidOut();
    expect(box(core, panel(doc, "a"))).toEqual([0, 0, 40, 360]);
    expect(box(core, panel(doc, "b"))[2]).toBe(100);
  });

  it("wraps children onto new lines, aligning the lines with align-content and an item with align-self", async () => {
    const doc = buildUI(`<Canvas><div id="row" width="250" height="300" flex-wrap="wrap" align-content="center" align-items="flex-start">
        <div id="a" width="100" height="40"/><div id="b" width="100" height="40"/><div id="c" width="100" height="40" align-self="flex-end"/>
      </div></Canvas>`);
    const core = await laidOut();
    // Two lines of 40 centred in 300: the first at 110, the second at 150.
    expect(box(core, panel(doc, "a"))).toEqual([0, 110, 100, 40]);
    expect(box(core, panel(doc, "b"))).toEqual([100, 110, 100, 40]);
    expect(box(core, panel(doc, "c"))).toEqual([0, 150, 100, 40]);
  });

  it("shrinks panels only when flex-shrink says so (null keeps the kind's), from flex-basis", async () => {
    const doc = buildUI(`<Canvas><div width="300" height="50"><div id="keep" width="200"/><div id="shrink" width="200" flex-shrink="1"/></div>
        <div width="300" height="50"><div id="basis" flex-basis="120" width="10"/></div></Canvas>`);
    const core = await laidOut();
    expect(box(core, panel(doc, "keep"))[2]).toBe(200);
    expect(box(core, panel(doc, "shrink"))[2]).toBe(100);
    expect(box(core, panel(doc, "basis"))[2]).toBe(120);
  });

  it("keeps an aspect ratio when only one side is set", async () => {
    const doc = buildUI(`<Canvas><div align-items="flex-start" width="400" height="400"><div id="a" width="200" aspect-ratio="2"/></div></Canvas>`);
    const core = await laidOut();
    expect(box(core, panel(doc, "a"))).toEqual([0, 0, 200, 100]);
  });
});

describe("overflow: hidden (ADR 0422)", () => {
  /** A 100 × 100 panel with a 10 px border clipping a button that hangs out of it to the right and below. */
  function clipped() {
    const doc = buildUI(`<Canvas><div id="clip" width="100" height="100" border-width="10" background-color="#333" overflow="hidden">
        <button id="inside" position="absolute" left="0" top="0" width="150" height="150" padding="0"/>
      </div></Canvas>`);
    return { doc, clip: panel(doc, "clip"), inside: byId(doc, "inside", UIButton) };
  }

  it("hits a clipped child only inside the clipper's padding box", async () => {
    const { clip, inside } = clipped();
    const core = await laidOut();
    expect(box(core, inside)).toEqual([10, 10, 150, 150]); // laid out as before: clipping doesn't change layout
    expect(core.hitTest(50, 50)).toBe(inside);
    expect(core.hitTest(95, 50)).toBe(clip); // on the border: outside the padding box
    expect(core.hitTest(130, 130)).toBeNull(); // in the button's box, but clipped away
    expect(core.pickAll(130, 130)).toEqual([]);
    expect(core.pickAll(50, 50)).toEqual([inside, clip]);
  });

  it("reports each element's clip, its clipper and the clipper's padding box, and the clipped corners", async () => {
    const { clip, inside } = clipped();
    const core = await laidOut();
    const el = core.elements().find((e) => e.comp === inside)!;
    expect(el.clip).toEqual({ x: 10, y: 10, width: 80, height: 80 });
    expect(el.clipper).toBe(clip);
    const c = core.elements().find((e) => e.comp === clip)!;
    expect([c.clip, c.clipper, c.childClip]).toEqual([null, null, { x: 10, y: 10, width: 80, height: 80 }]);
    expect(core.cornersOf(inside)!.clip).toEqual([[10, 10], [90, 10], [90, 90], [10, 90]]);
    expect(core.cornersOf(clip)!.clip).toBeNull();
  });

  it("intersects nested clips", async () => {
    const doc = buildUI(`<Canvas><div width="100" height="100" overflow="hidden"><div id="inner" position="absolute" left="50" top="50" width="100" height="100" overflow="hidden">
        <button id="b" position="absolute" left="0" top="0" width="100" height="100" padding="0"/></div></div></Canvas>`);
    const core = await laidOut();
    const b = byId(doc, "b", UIButton);
    expect(core.elements().find((e) => e.comp === b)!.clip).toEqual({ x: 50, y: 50, width: 50, height: 50 });
    expect(core.hitTest(120, 120)).toBeNull();
    expect(core.hitTest(75, 75)).toBe(b);
  });

  it("takes an element clipped away out of keyboard navigation, and searches the drawn part of the rest", async () => {
    const doc = buildUI(`<Canvas><div flex-direction="column" width="200" height="80" overflow="hidden">
        <button id="a" width="100" height="50" padding="0"/><button id="b" width="100" height="50" padding="0"/><button id="c" width="100" height="50" padding="0"/>
      </div></Canvas>`);
    const p = await UIPointer.create(World.require());
    pointers.push(p);
    const [a, b, c] = ["a", "b", "c"].map((id) => byId(doc, id, UIButton));
    a.focused = true;
    engine.step(DT);
    const press = (key: string) => {
      Input.inject.keyDown(key);
      engine.step(DT);
      Input.inject.keyUp(key);
      engine.step(DT);
    };
    press("arrowdown");
    expect(b.focused).toBe(true); // half shown: still reachable
    press("arrowdown");
    expect(b.focused).toBe(true); // c is below the clip
    press("tab");
    expect(a.focused).toBe(true); // next skips c too, wrapping to a
    expect(c.focused).toBe(false);
  });
});

describe("z-index (ADR 0422)", () => {
  it("orders drawing and hits among siblings by zIndex, then document order", async () => {
    const doc = buildUI(`<Canvas><button id="a" position="absolute" width="100" height="100" padding="0"/><button id="b" position="absolute" width="100" height="100" padding="0"/></Canvas>`);
    const [a, b] = ["a", "b"].map((id) => byId(doc, id, UIButton));
    const core = await laidOut();
    expect(core.hitTest(50, 50)).toBe(b); // the later sibling is on top
    a.zIndex = 1;
    core.sync(World.require(), 1280, 720, DT);
    expect(core.hitTest(50, 50)).toBe(a);
    const order = (c: UIComponentType) => core.elements().find((e) => e.comp === c)!.order;
    expect(order(a)).toBeGreaterThan(order(b));
    expect(core.elements().map((e) => e.comp)).toEqual([a, b]); // elements() stays in tree order
    a.zIndex = 0;
    b.zIndex = -1;
    core.sync(World.require(), 1280, 720, DT);
    expect(core.hitTest(50, 50)).toBe(a);
    expect(core.pickAll(50, 50)).toEqual([a, b]);
  });

  it("keeps a child's zIndex inside its parent's stacking context, as CSS does", async () => {
    const doc = buildUI(`<Canvas>
        <div id="p" position="absolute" width="100" height="100" z-index="1" background-color="#111"><button id="child" width="100" height="100" padding="0" z-index="100"/></div>
        <button id="s" position="absolute" width="100" height="100" padding="0" z-index="2"/>
        <button id="under" position="absolute" width="100" height="100" padding="0"/>
      </Canvas>`);
    const [p, child, s, under] = [panel(doc, "p"), ...["child", "s", "under"].map((id) => byId(doc, id, UIButton))];
    const core = await laidOut();
    expect(core.pickAll(50, 50)).toEqual([s, child, p, under]);
    const orders = new Map(core.elements().map((e) => [e.comp, e.order]));
    expect([orders.get(under), orders.get(p), orders.get(child), orders.get(s)]).toEqual([0, 1, 2, 3]);
  });

  it("draws an overflow: hidden element's descendants right after it, as one group", async () => {
    const doc = buildUI(`<Canvas>
        <div id="clip" position="absolute" width="100" height="100" overflow="hidden"><button id="inner" width="100" height="100" padding="0" z-index="5"/></div>
        <button id="after" position="absolute" width="100" height="100" padding="0"/>
      </Canvas>`);
    const [clip, inner, after] = [panel(doc, "clip"), byId(doc, "inner", UIButton), byId(doc, "after", UIButton)];
    const core = await laidOut();
    const orders = new Map(core.elements().map((e) => [e.comp, e.order]));
    expect([orders.get(clip), orders.get(inner), orders.get(after)]).toEqual([0, 1, 2]);
    expect(core.hitTest(50, 50)).toBe(after);
  });
});

describe("content sizes where Yoga's shortcuts differ from CSS", () => {
  // A HUD: a clock row, a shrink-to-fit middle of empty lines, and bars along the bottom of a space-between column.
  const HUD = (lines: string) =>
    buildUI(`<Canvas><div id="screen"><div id="top"/><div id="row"><div id="middle"><div id="lines">${lines}</div></div></div><div id="bottom"/></div></Canvas>`, {
      css: `#screen { width: 100%; height: 100%; flex-direction: column; justify-content: space-between; padding: 12px }
            #top { height: 40px }
            #row { justify-content: center }
            #middle, #lines { flex-direction: column; align-items: center }
            #middle { padding: 18px }
            #bottom { height: 80px }
            .line { font-size: 20px }`,
    });

  it("lays a column of empty lines in a shrink-to-fit box out at its content's height, keeping the bottom row on screen", async () => {
    const doc = HUD(`<span class="line"></span>`.repeat(8));
    const core = await laidOut();
    expect(box(core, panel(doc, "lines"))[3]).toBeLessThan(0.1);
    expect(box(core, panel(doc, "middle"))[3]).toBeCloseTo(36, 1);
    expect(box(core, panel(doc, "bottom"))).toEqual([12, 628, 1256, 80]);
  });

  it("does the same for a zero-width box with a height", async () => {
    const doc = HUD(`<div class="line" width="0" height="24"/>`);
    const core = await laidOut();
    expect(box(core, panel(doc, "lines"))[3]).toBeCloseTo(24, 1);
    expect(box(core, panel(doc, "bottom"))).toEqual([12, 628, 1256, 80]);
  });

  it("measures an empty text, or one of collapsed white space, as 0 × 0; a line of text and an empty input as a line", async () => {
    const doc = buildUI(`<Canvas><div id="col"><span id="empty"></span><span id="spaces">   </span><span id="word">Hi</span><input id="field"/></div></Canvas>`, {
      css: `#col { flex-direction: column; align-items: flex-start } span, input { font-size: 20px }`,
    });
    const core = await laidOut();
    expect(box(core, byId(doc, "empty", UIText)).slice(2)).toEqual([0, 0]);
    expect(box(core, byId(doc, "spaces", UIText)).slice(2)).toEqual([0, 0]);
    expect(box(core, byId(doc, "word", UIText))[3]).toBeGreaterThan(20);
    expect(core.rectOf(byId(doc, "field", UIInputField))!.height).toBeGreaterThan(20);
  });
});

describe("baseline alignment (ADR 0433)", () => {
  it("lines texts of different sizes up on their first lines' baselines, padding included, as CSS does", async () => {
    const doc = buildUI(`<Canvas><div id="row"><span id="small">Ahoy</span><span id="big">Ahoy</span><span id="padded">Ahoy</span><div id="box" width="30" height="10"/></div></Canvas>`, {
      css: `#row { align-items: baseline } span { line-height: 1.2 } #small { font-size: 20px } #big { font-size: 40px } #padded { font-size: 20px; padding-top: 10px }`,
    });
    const core = await laidOut();
    // A line's baseline sits at half its leading plus the font's ascent (0.95 em): 19 px for 20 px text, 38 px for 40 px.
    const top = (id: string) => box(core, byId(doc, id, UIText))[1];
    expect(top("big")).toBeCloseTo(0, 3);
    expect(top("small")).toBeCloseTo(19, 3);
    expect(top("padded")).toBeCloseTo(9, 3);
    // A box without text synthesises its baseline at its bottom edge.
    expect(box(core, panel(doc, "box"))[1]).toBeCloseTo(28, 3);
  });

  it("aligns a container on its first item's baseline", async () => {
    const doc = buildUI(`<Canvas><div id="row"><div id="col"><span id="first">One</span><span>Two</span></div><span id="big">Big</span></div></Canvas>`, {
      css: `#row { align-items: baseline } #col { flex-direction: column; padding: 6px } span { line-height: 1.2; font-size: 20px } #big { font-size: 40px }`,
    });
    const core = await laidOut();
    // The column's baseline: 6 px of padding and 19 px into its first line; the big text's is 38 px down.
    expect(box(core, panel(doc, "col"))[1]).toBeCloseTo(13, 3);
    expect(box(core, byId(doc, "big", UIText))[1]).toBeCloseTo(0, 3);
  });
});

describe("calc() mixing % and px (ADR 0422 wave 5, resolved in the layout engine by 0433)", () => {
  it("resolves nested calc() lengths against this layout's sizes, in one layout", async () => {
    const doc = buildUI(`<Canvas><div id="outer"><div id="mid"><div id="inner"/></div><div id="abs"/></div></Canvas>`, {
      css: `#outer { width: 400px; height: 300px; align-items: flex-start }
            #mid { width: calc(50% + 10px); height: calc(100% - 20px); align-items: flex-start }
            #inner { width: calc(50% + 10px); height: calc(50% - 5px) }
            #abs { position: absolute; left: calc(25% + 4px); top: calc(50% - 10px); width: 10px; height: 10px }`,
    });
    const core = await laidOut();
    expect(box(core, panel(doc, "mid"))).toEqual([0, 0, 210, 280]);
    expect(box(core, panel(doc, "inner"))).toEqual([0, 0, 115, 135]);
    expect(box(core, panel(doc, "abs")).slice(0, 2)).toEqual([104, 140]);
    // The outer box grows: every calc() follows in the next layout.
    panel(doc, "outer").width = 600 as never;
    engine.step(DT);
    core.sync(engine.world, 1280, 720);
    expect(box(core, panel(doc, "inner"))[2]).toBe(165);
  });
});
