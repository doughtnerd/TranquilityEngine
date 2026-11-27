// ADR 0430: CSS filters on UI elements: the `filter` property's values and the cascade that expands them into the filter
// fields, the chain the UI core composes for a subtree, transitions on the fields, and the pixel fallback the drawing
// layer runs where Canvas2D has no `filter`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, Input } from "../index";
import { World } from "../core/World";
import { UIPanel } from "../ui/components";
import { UICore } from "../ui/UICore";
import { uiAnimationReady } from "../ui/animation/UIAnimator";
import { parseFilter } from "../ui/document/filterValues";
import { filterReach, filterStepsOf, filterText } from "../ui/filters";
import { filterPixels } from "../render/filterPixels";
import { buildUI, byId, classList, loadUITestSupport } from "./uiMarkup";

const DT = 1 / 64;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  engine.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

const value = <T,>(r: { ok: true; value: T } | { ok: false; problem: string }) => (r.ok ? r.value : r.problem);

describe("filter values (ADR 0430)", () => {
  it("reads each function into its field, others at their initial values", () => {
    const v = value(parseFilter("blur(3px) brightness(150%) contrast(0.5) grayscale(1) hue-rotate(0.25turn) invert(0.2) opacity(50%) saturate(2) sepia(0.3)"));
    expect(v).toMatchObject({ filterBlur: 3, filterBrightness: 1.5, filterContrast: 0.5, filterGrayscale: 1, filterHueRotate: 90, filterInvert: 0.2, filterOpacity: 0.5, filterSaturate: 2, filterSepia: 0.3, filterDropShadowColor: null });
    const s = value(parseFilter("drop-shadow(2px 4px 6px #ff0000)"));
    expect(s).toMatchObject({ filterBlur: 0, filterBrightness: 1, filterDropShadowOffsetX: 2, filterDropShadowOffsetY: 4, filterDropShadowBlur: 6 });
    expect((s as { filterDropShadowColor: Color }).filterDropShadowColor.toCss()).toBe("rgba(255, 0, 0, 1)");
    expect(value(parseFilter("none"))).toMatchObject({ filterBlur: 0, filterSaturate: 1 });
    expect(value(parseFilter("brightness()"))).toMatchObject({ filterBrightness: 1 });
  });

  it("folds a function listed twice where the two compose, and refuses the rest", () => {
    expect(value(parseFilter("blur(3px) blur(4px)"))).toMatchObject({ filterBlur: 5 }); // Gaussians: √(9 + 16)
    expect(value(parseFilter("brightness(2) brightness(0.25)"))).toMatchObject({ filterBrightness: 0.5 });
    expect(value(parseFilter("hue-rotate(30deg) hue-rotate(60deg)"))).toMatchObject({ filterHueRotate: 90 });
    expect(value(parseFilter("sepia(1) sepia(1)"))).toMatch(/twice/);
    expect(value(parseFilter("drop-shadow(1px 1px red) drop-shadow(2px 2px blue)"))).toMatch(/several/);
    expect(value(parseFilter("url(#f)"))).toMatch(/SVG filter/);
    expect(value(parseFilter("blur(-1px)"))).toMatch(/blur/);
    expect(value(parseFilter("glow(2)"))).toMatch(/isn't a filter function/);
  });

  it("writes steps in the fixed order as CSS text, and says how far they reach", () => {
    const steps = filterStepsOf({ filterSepia: 1, filterBlur: 2, filterDropShadowColor: new Color(0, 0, 0, 0.5), filterDropShadowOffsetX: 3, filterDropShadowBlur: 1 });
    expect(filterText(steps)).toBe("blur(2px) sepia(1) drop-shadow(3px 0px 1px rgba(0, 0, 0, 0.5))");
    expect(filterReach(steps)).toBe(12); // 3 × 2 for the blur, then 3 + 3 × 1 for the shadow
    expect(filterText([])).toBe("none");
  });
});

describe("filters in the cascade and the UI core (ADR 0430)", () => {
  it("expands filter from a stylesheet, a later filter replacing every field", () => {
    const doc = buildUI(`<Canvas><div id="p" class="a b"/></Canvas>`, { css: `.a { filter: blur(2px) sepia(1) } .b { filter: saturate(3) }` });
    const p = byId(doc, "p", UIPanel);
    expect([p.filterBlur, p.filterSepia, p.filterSaturate]).toEqual([0, 0, 3]);
  });

  it("gives each element its own filter, then its ancestors', lengths through the filtering element's transform", async () => {
    const doc = buildUI(`<Canvas><div id="p" position="absolute" width="100" height="100" filter="blur(2px)" scale="2">
        <div id="q" width="10" height="10" filter="drop-shadow(4px 0 1px black)"/><div id="r" width="10" height="10"/></div></Canvas>`);
    const core = new UICore({ interactive: false });
    await core.ready;
    try {
      core.sync(World.require(), 1280, 720, DT);
      const of = (id: string) => core.elements().find((e) => e.comp === byId(doc, id, UIPanel))!.filter;
      expect(filterText(of("p")!)).toBe("blur(4px)"); // scaled 2×
      // Its own drop shadow, through the parent's scale too, then the parent's blur.
      expect(filterText(of("q")!)).toBe("drop-shadow(8px 0px 2px rgba(0, 0, 0, 1)) blur(4px)");
      expect(filterText(of("r")!)).toBe("blur(4px)");
    } finally {
      core.dispose();
    }
  });

  it("publishes a change to only an element's filter or backdrop (nothing else about it moved)", async () => {
    const doc = buildUI(`<Canvas><div id="p" position="absolute" width="10" height="10" filter="blur(2px)"/></Canvas>`);
    const p = byId(doc, "p", UIPanel);
    const core = new UICore({ interactive: false });
    await core.ready;
    try {
      core.sync(World.require(), 1280, 720, DT);
      const version = core.layoutVersion;
      core.sync(World.require(), 1280, 720, DT);
      expect(core.layoutVersion).toBe(version); // an unchanged filter publishes nothing
      const of = () => core.elements().find((e) => e.comp === p)!;
      p.filterBlur = 5;
      core.sync(World.require(), 1280, 720, DT);
      expect(filterText(of().filter!)).toBe("blur(5px)");
      expect(core.layoutVersion).toBeGreaterThan(version);
      p.backdropBlur = 3;
      core.sync(World.require(), 1280, 720, DT);
      expect(filterText(of().backdrop!)).toBe("blur(3px)");
    } finally {
      core.dispose();
    }
  });

  it("transitions each filter function as a number", async () => {
    await uiAnimationReady(World.require());
    const doc = buildUI(`<Canvas><div id="p" class="a"/></Canvas>`, { css: `.a { transition: filter 1s linear } .a.on { filter: blur(8px) grayscale(1) }` });
    const p = byId(doc, "p", UIPanel);
    engine.step(DT);
    classList(doc.query("#p")!).add("on");
    for (let i = 0; i < 33; i++) engine.step(DT);
    expect(p.filterBlur).toBeCloseTo(4, 4);
    expect(p.filterGrayscale).toBeCloseTo(0.5, 4);
  });
});

describe("the pixel fallback (ADR 0430, filterPixels)", () => {
  const image = (w: number, h: number, rgba: number[]) => ({ width: w, height: h, data: new Uint8ClampedArray(Array.from({ length: w * h }, () => rgba).flat()) });

  it("applies colour functions as Filter Effects defines them", () => {
    const img = image(1, 1, [200, 100, 50, 255]);
    filterPixels(img, [{ kind: "grayscale", amount: 1 }]);
    const y = Math.round(0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50);
    expect([...img.data]).toEqual([y, y, y, 255]);
    const inv = image(1, 1, [200, 100, 50, 255]);
    filterPixels(inv, [{ kind: "invert", amount: 1 }, { kind: "opacity", amount: 0.5 }]);
    expect([...inv.data]).toEqual([55, 155, 205, 128]);
    const bright = image(1, 1, [100, 100, 100, 255]);
    filterPixels(bright, [{ kind: "brightness", amount: 2 }, { kind: "contrast", amount: 0 }]);
    expect([...bright.data]).toEqual([128, 128, 128, 255]);
  });

  it("blurs with box passes that keep the total and spread it, without darkening edges", () => {
    const w = 21;
    const img = image(w, w, [0, 0, 0, 0]);
    for (let y = 8; y <= 12; y++) for (let x = 8; x <= 12; x++) img.data.set([255, 0, 0, 255], (y * w + x) * 4);
    filterPixels(img, [{ kind: "blur", radius: 2 }]);
    const alpha = Array.from({ length: w * w }, (_, i) => img.data[i * 4 + 3]);
    expect(alpha[10 * w + 10]).toBeLessThan(255);
    expect(alpha[10 * w + 5]).toBeGreaterThan(0);
    const total = alpha.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 25 * 255) / (25 * 255)).toBeLessThan(0.05); // spread out, not lost (rounding aside)
    // Colour stays red where there's any alpha (premultiplied blur): no dark fringe.
    for (let i = 0; i < w * w; i++) if (alpha[i] > 0) expect(img.data[i * 4]).toBe(255);
  });

  it("draws a drop shadow under the image, offset and coloured", () => {
    const img = image(4, 1, [0, 0, 0, 0]);
    img.data.set([0, 0, 255, 255], 0);
    filterPixels(img, [{ kind: "drop-shadow", x: 2, y: 0, blur: 0, color: new Color(1, 0, 0, 1) }]);
    expect([...img.data.slice(0, 4)]).toEqual([0, 0, 255, 255]); // the image itself
    expect([...img.data.slice(8, 12)]).toEqual([255, 0, 0, 255]); // its shadow, 2 pixels right
    expect(img.data[7]).toBe(0);
  });
});

describe("backdrop-filter (ADR 0432)", () => {
  it("expands into the backdrop fields, transitions them, shows as CSS, and reaches the UI core through the element's transform only", async () => {
    await uiAnimationReady(World.require());
    const doc = buildUI(`<Canvas><div id="p" scale="2"><div id="q" class="g" style="backdrop-filter: blur(2px) saturate(1.5)"/></div><div id="r" class="t"/></Canvas>`, {
      css: `.t { transition: backdrop-filter 1s linear } .t.on { backdrop-filter: blur(8px) brightness(0.5) }`,
    });
    const q = byId(doc, "q", UIPanel);
    expect([q.backdropBlur, q.backdropSaturate, q.backdropBrightness, q.filterBlur]).toEqual([2, 1.5, 1, 0]);
    expect(doc.query("#q")!.computedStyle().backdropFilter).toBe("blur(2px) saturate(1.5)");
    const core = new UICore({ interactive: false });
    await core.ready;
    try {
      core.sync(World.require(), 1280, 720, DT);
      const of = (id: string) => core.elements().find((e) => e.comp === byId(doc, id, UIPanel))!;
      expect(filterText(of("q").backdrop!)).toBe("blur(4px) saturate(1.5)"); // through its parent's scale
      expect(of("q").filter ?? null).toBeNull(); // not a filter of its subtree
      expect(of("p").backdrop ?? null).toBeNull();
    } finally {
      core.dispose();
    }
    const r = byId(doc, "r", UIPanel);
    engine.step(DT);
    classList(doc.query("#r")!).add("on");
    for (let i = 0; i < 33; i++) engine.step(DT);
    expect(r.backdropBlur).toBeCloseTo(4, 4);
    expect(r.backdropBrightness).toBeCloseTo(0.75, 4);
  });
});
