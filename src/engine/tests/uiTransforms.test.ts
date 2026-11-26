// ADR 0418 wave 3: transforms. The affine module everything reads (composition, inversion, origin), the CSS values
// (`transform`, `translate`, `scale`, `rotate`, `transform-origin`) and the cascade that expands them, and the UI core's
// hit-testing, picking, clipping, corners and keyboard navigation on transformed elements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIPanel } from "../ui/components";
import type { UIComponentType } from "../ui/components";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
import { Assets } from "../scene/Assets";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { applyAffine, compose, decompose, invert, localTransform, multiply, type UIAffine, type UITransformFields } from "../ui/transform2d";
import { parseTransform, parseTransformOrigin, parseTranslate, parseScale, parseRotate } from "../ui/document/transformValues";
import { buildUI, byId } from "./uiMarkup";
import { UIPointer } from "./uiPointer";

const DT = 1 / 60;
let engine: Engine;
const cores: UICore[] = [];
const pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
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

async function laidOut(): Promise<UICore> {
  const c = new UICore({ interactive: false });
  cores.push(c);
  await c.ready;
  c.sync(World.require(), 1280, 720, DT);
  return c;
}

const fields = (over: Partial<UITransformFields> = {}): UITransformFields => ({ translateX: "0", translateY: "0", scaleX: 1, scaleY: 1, rotate: 0, transformOriginX: "50%", transformOriginY: "50%", ...over });
const near = (p: readonly number[], q: readonly number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
const at = (m: UIAffine | null, x: number, y: number) => (m ? applyAffine(m, x, y) : [x, y]);

describe("the transform module (ADR 0418 wave 3)", () => {
  const box = { x: 100, y: 50, width: 200, height: 100 };

  it("is null (the identity) for untransformed fields", () => {
    expect(localTransform(fields(), box)).toBeNull();
    expect(localTransform(fields({ rotate: 360 }), box)).toBeNull();
  });

  it("turns and scales about the origin, by default the box's middle", () => {
    const r = localTransform(fields({ rotate: 90 }), box)!;
    near(at(r, 200, 100), [200, 100]); // the middle stays
    near(at(r, 100, 50), [250, 0]); // the top-left corner turns clockwise about it (y down)
    const s = localTransform(fields({ scaleX: 2, scaleY: 3, transformOriginX: "0%", transformOriginY: "0" }), box)!;
    near(at(s, 100, 50), [100, 50]); // the top-left origin stays
    near(at(s, 300, 150), [500, 350]);
  });

  it("translates in px or % of the element's own box, after rotating and scaling (CSS's translate, rotate, scale order)", () => {
    const t = localTransform(fields({ translateX: "50%", translateY: "-10" }), box)!;
    near(at(t, 100, 50), [200, 40]);
    // Translate isn't turned by the rotation: T(translate) · R · S about the origin.
    const tr = localTransform(fields({ translateX: "10", rotate: 180 }), box)!;
    near(at(tr, 200, 100), [210, 100]);
    near(at(tr, 100, 50), [310, 150]);
  });

  it("composes a parent's transform with its child's, and inverts it", () => {
    const parent = localTransform(fields({ rotate: 90 }), box)!;
    const child = localTransform(fields({ scaleX: 2, scaleY: 2 }), { x: 150, y: 75, width: 20, height: 10 })!;
    const whole = compose(parent, child)!;
    // The child's middle stays under its own scale, then turns with the parent.
    near(at(whole, 160, 80), at(parent, 160, 80));
    expect(compose(null, child)).toBe(child);
    expect(compose(parent, null)).toBe(parent);
    const inv = invert(whole)!;
    near(at(inv, ...(at(whole, 13, 17) as [number, number])), [13, 17]);
    near(multiply(whole, inv), [1, 0, 0, 1, 0, 0]);
    expect(invert(localTransform(fields({ scaleX: 0 }), box)!)).toBeNull();
  });

  it("decomposes into a rotation and scales, and reports the skew of a rotation inside an unequal scale", () => {
    const d = decompose(localTransform(fields({ rotate: 30, scaleX: 2, scaleY: -1 }), box)!);
    expect(d.rotation).toBeCloseTo(Math.PI / 6);
    expect([d.scaleX, d.scaleY]).toEqual([expect.closeTo(2), expect.closeTo(-1)]);
    expect(d.skew).toBeCloseTo(0);
    const squash = localTransform(fields({ scaleX: 2 }), box)!;
    const turned = localTransform(fields({ rotate: 45 }), box)!;
    expect(Math.abs(decompose(multiply(squash, turned)).skew)).toBeGreaterThan(0.1);
  });
});

describe("transform values (ADR 0418 wave 3)", () => {
  const value = <T,>(r: { ok: true; value: T } | { ok: false; problem: string }) => (r.ok ? r.value : r.problem);

  it("folds a transform list, composed left to right, into translate, rotate and scale", () => {
    expect(value(parseTransform("translate(10px, 20%) scale(2) rotate(45deg)"))).toEqual({ translateX: "10", translateY: "20%", scaleX: 2, scaleY: 2, rotate: 45 });
    expect(value(parseTransform("translateX(5px) translateY(-50%) scaleX(1.5) scaleY(0.5)"))).toEqual({ translateX: "5", translateY: "-50%", scaleX: 1.5, scaleY: 0.5, rotate: 0 });
    expect(value(parseTransform("none"))).toEqual({ translateX: "0", translateY: "0", scaleX: 1, scaleY: 1, rotate: 0 });
    // A translate after a rotation and scale moves along the turned, scaled axes.
    expect(value(parseTransform("rotate(90deg) translate(10px)"))).toEqual({ translateX: "0", translateY: "10", scaleX: 1, scaleY: 1, rotate: 90 });
    expect(value(parseTransform("scale(2) translate(10px, 25%)"))).toEqual({ translateX: "20", translateY: "50%", scaleX: 2, scaleY: 2, rotate: 0 });
    expect(value(parseTransform("rotate(0.25turn) rotate(-1.5707963267948966rad)"))).toMatchObject({ rotate: 0 });
  });

  it("says why a list can't fold or be read", () => {
    expect(value(parseTransform("scale(2, 1) rotate(45deg)"))).toMatch(/skews/);
    expect(value(parseTransform("rotate(45deg) translate(10%)"))).toMatch(/% translate after a rotation/);
    expect(value(parseTransform("translate(10px) rotate(180deg) translate(50%)"))).toMatch(/mixes px and %/);
    expect(value(parseTransform("skew(10deg)"))).toMatch(/skew\(\), which isn't supported/);
    expect(value(parseTransform("rotate(1px)"))).toMatch(/angle/);
    expect(value(parseTransform("translate3d(1px, 2px, 3px)"))).toMatch(/isn't supported/);
    expect(value(parseTransform("rotate(45deg"))).toMatch(/transform functions/);
  });

  it("reads the individual properties and transform-origin", () => {
    expect(value(parseTranslate("10px 50%"))).toEqual({ translateX: "10", translateY: "50%" });
    expect(value(parseTranslate("-4"))).toEqual({ translateX: "-4", translateY: "0" });
    expect(value(parseScale("2"))).toEqual({ scaleX: 2, scaleY: 2 });
    expect(value(parseScale("150% 0.5"))).toEqual({ scaleX: 1.5, scaleY: 0.5 });
    expect(value(parseRotate("0.5turn"))).toBe(180);
    expect(value(parseRotate("none"))).toBe(0);
    expect(value(parseTransformOrigin("left top"))).toEqual({ transformOriginX: "0%", transformOriginY: "0%" });
    expect(value(parseTransformOrigin("top left"))).toEqual({ transformOriginX: "0%", transformOriginY: "0%" });
    expect(value(parseTransformOrigin("bottom"))).toEqual({ transformOriginX: "50%", transformOriginY: "100%" });
    expect(value(parseTransformOrigin("10px 25%"))).toEqual({ transformOriginX: "10", transformOriginY: "25%" });
    expect(value(parseTransformOrigin("top 10px"))).toMatch(/position/);
    expect(value(parseTranslate("1px 2px 3px"))).toMatch(/3D/);
  });
});

describe("transforms in the cascade (ADR 0418 wave 3)", () => {
  it("expands transform, translate, scale and transform-origin, and takes rotate as an angle", () => {
    const doc = buildUI(`<Canvas><Panel id="a" class="a"/><Panel id="b" class="b"/><Panel id="c" transform="rotate(-0.25turn) scale(3)" transform-origin="right bottom" translate-x="25%"/></Canvas>`, {
      css: `.a { transform: translate(10px, 20%) rotate(45deg) scale(2, 1); transform-origin: left top }
            .b { translate: 4px; scale: 0.5; rotate: 1rad }`,
    });
    const t = (id: string) => {
      const p = byId(doc, id, UIPanel);
      return [p.translateX, p.translateY, p.scaleX, p.scaleY, p.rotate, p.transformOriginX, p.transformOriginY];
    };
    expect(t("a")).toEqual(["10", "20%", 2, 1, 45, "0%", "0%"]);
    const b = t("b");
    expect(b.slice(0, 4)).toEqual(["4", "0", 0.5, 0.5]);
    expect(b[4]).toBeCloseTo(180 / Math.PI);
    // Attributes take the shorthand too (after rules); `translate` stays the localisation attribute, so `translate-x`.
    expect(t("c")).toEqual(["25%", "0", 3, 3, -90, "100%", "100%"]);
  });

  it("orders transform with the individual properties by the cascade: the later declaration wins for each field", () => {
    const doc = buildUI(`<Canvas><Panel id="a" class="x"/><Panel id="b" class="y"/></Canvas>`, {
      css: `.x { rotate: 10deg; transform: scale(2) }
            .y { transform: rotate(30deg) scale(2); scale: 3 }`,
    });
    const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel);
    expect([a.rotate, a.scaleX]).toEqual([0, 2]); // transform sets every transform field
    expect([b.rotate, b.scaleX, b.scaleY]).toEqual([30, 3, 3]);
  });

  it("warns once about a value it can't read, leaving the fields alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = buildUI(`<Canvas><Panel id="a" class="bad"/><Panel id="b" class="bad"/></Canvas>`, {
      css: `.bad { transform: scale(2, 1) rotate(10deg); rotate: 5px; translate: 1px 2px 3px; transform-origin: middle }`,
    });
    const a = byId(doc, "a", UIPanel);
    expect([a.scaleX, a.rotate, a.translateX, a.transformOriginX]).toEqual([1, 0, "0", "50%"]);
    const text = warn.mock.calls.flat().join("\n");
    expect(text).toMatch(/"scale\(2, 1\) rotate\(10deg\)" rotates after an unequal scale/);
    expect(text).toMatch(/"5px" isn't a valid rotate/);
    expect(text).toMatch(/3D transforms aren't supported/);
    expect(text).toMatch(/"middle" isn't a position/);
    expect(warn.mock.calls.filter((c) => String(c.join(" ")).includes("rotates after an unequal scale"))).toHaveLength(1); // two elements, one warning
  });
});

describe("hit-testing and picking transformed elements (ADR 0418 wave 3)", () => {
  /** A 200 × 50 button at (100, 100), written as `attrs`. */
  function button(attrs: string) {
    const doc = buildUI(`<Canvas><Button id="b" position="absolute" left="100" top="100" width="200" height="50" padding="0" ${attrs}/></Canvas>`);
    return byId(doc, "b", UIButton);
  }

  it("clicks a rotated button where it's drawn, not where it was laid out", async () => {
    const b = button(`rotate="90"`);
    const core = await laidOut();
    expect(core.rectOf(b)).toEqual({ x: 100, y: 100, width: 200, height: 50 }); // layout ignores the transform
    // Turned a quarter about its middle (200, 125): now 50 wide and 200 tall, from (175, 25) to (225, 225).
    expect(core.hitTest(200, 40)).toBe(b);
    expect(core.hitTest(200, 210)).toBe(b);
    expect(core.hitTest(120, 125)).toBeNull(); // in the laid-out box, but not where it's drawn
    expect(core.hitTest(280, 125)).toBeNull();
  });

  it("follows a scale about its origin and a translate in % of its own box", async () => {
    const b = button(`transform="translate(50%, 0) scale(0.5)" transform-origin="left top"`);
    const core = await laidOut();
    // Moved right by 100 (50% of 200), then half size from its top-left: (200, 100) to (300, 125).
    expect(core.hitTest(210, 110)).toBe(b);
    expect(core.hitTest(295, 120)).toBe(b);
    expect(core.hitTest(150, 110)).toBeNull();
    expect(core.hitTest(250, 140)).toBeNull();
    expect(core.pickAll(250, 110)).toEqual([b]);
  });

  it("composes a parent's transform with its children's: a button in a rotated, scaled panel", async () => {
    const doc = buildUI(`<Canvas><Panel id="p" position="absolute" left="0" top="0" width="200" height="200" rotate="180" background-color="#222">
        <Button id="b" position="absolute" left="0" top="0" width="50" height="50" padding="0" scale="2"/></Panel></Canvas>`);
    const b = byId(doc, "b", UIButton), p = byId(doc, "p", UIPanel);
    const core = await laidOut();
    // The button doubles about its middle (25, 25): (-25, -25) to (75, 75), clipped by nothing; then the panel's half
    // turn about (100, 100) puts it at (125, 125) to (225, 225).
    expect(core.hitTest(210, 210)).toBe(b);
    expect(core.hitTest(20, 20)).toBe(p); // where the button was laid out: only the panel there now
    expect(core.pickAll(130, 130)).toEqual([b, p]);
  });

  it("reports corners as drawn, the laid-out ones in the parent's frame, and the transform", async () => {
    const doc = buildUI(`<Canvas><Panel id="p" position="absolute" left="0" top="0" width="100" height="100" translate-x="10">
        <Button id="b" width="40" height="20" padding="0" rotate="90"/></Panel></Canvas>`);
    const b = byId(doc, "b", UIButton);
    const core = await laidOut();
    const c = core.cornersOf(b)!;
    // Laid out at (0, 0, 40, 20); turned about (20, 10); then the panel's translate of 10.
    c.points.forEach((pt, i) => near(pt, [[40, -10], [40, 30], [20, 30], [20, -10]][i]));
    expect(c.layoutPoints).toEqual([[10, 0], [50, 0], [50, 20], [10, 20]]);
    expect(c.size).toEqual([40, 20]);
    const el = core.elements().find((e) => e.comp === b)!;
    near(el.transform!, [0, 1, -1, 0, 40, -10]);
    near([el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height], [20, -10, 20, 40]);
  });

  it("clips with the clipper's transform: an overflow: hidden panel turned a quarter clips its child where it's drawn", async () => {
    const doc = buildUI(`<Canvas><Panel id="clip" position="absolute" left="100" top="100" width="200" height="100" overflow="hidden" rotate="90">
        <Button id="b" position="absolute" left="0" top="0" width="400" height="100" padding="0"/></Panel></Canvas>`);
    const b = byId(doc, "b", UIButton);
    const core = await laidOut();
    // The clip (100, 100)-(300, 200) turns about (200, 150) to (150, 50)-(250, 250); the button reaches past it to the
    // right as laid out, which is downward once turned, and is cut at the clip's edge there.
    expect(core.hitTest(200, 60)).toBe(b);
    expect(core.hitTest(200, 240)).toBe(b);
    expect(core.hitTest(200, 300)).toBeNull(); // the button is drawn here but clipped
    expect(core.hitTest(310, 150)).toBeNull(); // where it was laid out (and would be unclipped) without the turn
    // The clip outline: the clip in the button's frame is a rectangle (both turned together).
    const clip = core.cornersOf(b)!.clip!;
    clip.forEach((pt, i) => near(pt, [[250, 50], [250, 250], [150, 250], [150, 50]][i]));
  });

  it("clips a transformed child by an untransformed clipper", async () => {
    const doc = buildUI(`<Canvas><Panel position="absolute" left="0" top="0" width="100" height="100" overflow="hidden">
        <Button id="b" position="absolute" left="0" top="0" width="100" height="100" padding="0" translate-x="80"/></Panel></Canvas>`);
    const b = byId(doc, "b", UIButton);
    const core = await laidOut();
    expect(core.hitTest(90, 50)).toBe(b);
    expect(core.hitTest(150, 50)).toBeNull(); // drawn there, outside the clip
    expect(core.hitTest(50, 50)).toBeNull(); // laid out there, moved away
    const el = core.elements().find((e) => e.comp === b)!;
    expect(el.bounds).toEqual({ x: 80, y: 0, width: 20, height: 100 });
  });

  it("can't hit an element scaled to nothing", async () => {
    const b = button(`scale-x="0"`);
    const core = await laidOut();
    expect(core.hitTest(200, 125)).toBeNull();
    expect(b.scaleX).toBe(0);
  });
});

describe("navigation between transformed elements (ADR 0418 wave 3)", () => {
  it("searches the transformed boxes' centres", async () => {
    // a and b side by side as laid out; b is translated below a, c is to the right of a.
    const doc = buildUI(`<Canvas>
        <Button id="a" position="absolute" left="0" top="0" width="100" height="50" padding="0"/>
        <Button id="b" position="absolute" left="300" top="0" width="100" height="50" padding="0" transform="translate(-300px, 200px)"/>
        <Button id="c" position="absolute" left="150" top="0" width="100" height="50" padding="0"/>
      </Canvas>`);
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
    expect(b.focused).toBe(true); // drawn below a
    press("arrowup");
    expect(a.focused).toBe(true);
    press("arrowright");
    expect(c.focused).toBe(true); // b's laid-out place, to the right, no longer counts
  });
});

describe("the editor's view of transforms (ADR 0418 wave 3)", () => {
  it("picks from the drawn box in z order", async () => {
    const doc = buildUI(`<Canvas><Button id="under" position="absolute" left="0" top="0" width="100" height="100" padding="0"/>
        <Button id="over" position="absolute" left="200" top="0" width="100" height="100" padding="0" translate-x="-150"/></Canvas>`);
    const [under, over] = ["under", "over"].map((id) => byId(doc, id, UIButton));
    const core = await laidOut();
    expect(core.pickAll(75, 50)).toEqual([over, under] as UIComponentType[]);
    expect(core.pickAll(250, 50)).toEqual([]);
  });
});
