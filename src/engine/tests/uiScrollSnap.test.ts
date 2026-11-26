import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIPanel } from "../ui/components";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";
import { buildUI, loadUITestSupport, uiAs, type TestUI } from "./uiMarkup";

// ADR 0428, scrolling: CSS Scroll Snap (wheel, touch momentum, keys, scrollTo/scrollBy, scrollIntoView and navigation,
// snapping again after layout changes), `scrollbar-gutter`, and scrolling from the end for `*-reverse` directions and
// `direction: rtl` (CSSOM's negative offsets). Driven through `Input`'s DOM adapter (`UIPointer`), the elements' DOM
// scrolling members and the components' fields.

const DT = 1 / 60;
let engine: Engine;
let pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  vi.unstubAllGlobals();
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

function frame(p: UIPointer, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    engine.step(DT);
    p.sync(DT);
  }
}

/** A 200 × 100 vertical list of ten 40-pixel rows snapping at their starts (`css` styles `.row` and `#list`). */
function list(listAttrs = `scroll-snap-type="y mandatory"`, css = `.row { scroll-snap-align: start; }`): TestUI {
  const rows = Array.from({ length: 10 }, (_, i) => `<button id="r${i}" class="row" height="40" width="180" padding="0">Row ${i}</button>`).join("\n");
  return buildUI(`<Canvas><div id="list" width="200" height="100" flex-direction="column" align-items="flex-start" overflow="auto" ${listAttrs}>${rows}</div></Canvas>`, { css });
}

const panel = (doc: TestUI, id = "list") => uiAs(doc.query(`#${id}`)!, UIPanel);
const laid = (p: UIPointer, doc: TestUI, id = "list") => p.core.elements().find((e) => e.comp === panel(doc, id))!.scroll!;

describe("the snap properties (ADR 0428)", () => {
  it("reads scroll-snap-type, scroll-snap-align, scroll-snap-stop, scroll-padding, scroll-margin and scrollbar-gutter", () => {
    const doc = buildUI(`<Canvas><div id="a" class="a"><div id="b" class="b"/></div><div id="c" class="c"/></Canvas>`, {
      css: `.a { scroll-snap-type: x mandatory; scroll-padding: 4px 8px; scrollbar-gutter: both-edges stable; }
            .b { scroll-snap-align: center end; scroll-snap-stop: always; scroll-margin: 1px 2px 3px 4px; scroll-margin-block: 7px; }
            .c { scroll-snap-type: block; scroll-snap-align: end; scroll-padding-inline: 5px 6px; scrollbar-gutter: stable; }`,
    });
    const a = panel(doc, "a"), b = panel(doc, "b"), c = panel(doc, "c");
    expect([a.scrollSnapAxis, a.scrollSnapStrictness, a.scrollbarGutter]).toEqual(["x", "mandatory", "stable both-edges"]);
    expect([a.scrollPaddingTop, a.scrollPaddingRight, a.scrollPaddingBottom, a.scrollPaddingLeft]).toEqual([4, 8, 4, 8]);
    expect([b.scrollSnapAlignBlock, b.scrollSnapAlignInline, b.scrollSnapStop]).toEqual(["center", "end", "always"]);
    expect([b.scrollMarginTop, b.scrollMarginRight, b.scrollMarginBottom, b.scrollMarginLeft]).toEqual([7, 2, 7, 4]);
    expect([c.scrollSnapAxis, c.scrollSnapStrictness, c.scrollSnapAlignBlock, c.scrollSnapAlignInline, c.scrollbarGutter]).toEqual(["block", "proximity", "end", "end", "stable"]);
    expect([c.scrollPaddingLeft, c.scrollPaddingRight]).toEqual([5, 6]);
  });
});

describe("scroll snapping (ADR 0428)", () => {
  it("snaps scrollTo to the nearest position and scrollBy (directional) on to the next one, smoothly where asked", async () => {
    const doc = list();
    const p = await pointer();
    const el = doc.query("#list")!;
    el.scrollTo(0, 55);
    expect(el.scrollTop).toBe(40);
    el.scrollTo(0, 65);
    expect(el.scrollTop).toBe(80);
    el.scrollBy(0, 5); // a short step still moves on
    expect(el.scrollTop).toBe(120);
    el.scrollBy(0, -1);
    expect(el.scrollTop).toBe(80);
    el.scrollTo(0, 1000);
    expect(el.scrollTop).toBe(300); // the last rows' positions clamp to the end
    el.scrollTo({ top: 10, behavior: "smooth" });
    expect(el.scrollTop).toBe(300);
    p.sync(1);
    expect(el.scrollTop).toBe(0);
  });

  it("proximity snaps only near a position; mandatory snaps a script's raw offset at the next layout", async () => {
    const doc = list(`scroll-snap-type="y"`, `.row { scroll-snap-align: start; } #r5 { margin-top: 200px; }`);
    const p = await pointer();
    const el = doc.query("#list")!;
    el.scrollTo(0, 55);
    expect(el.scrollTop).toBe(40); // within 30% of the 100-pixel snapport
    el.scrollTo(0, 280);
    expect(el.scrollTop).toBe(280); // 120 from both row 4 (160) and row 5 (400): stays
    panel(doc).scrollSnapStrictness = "mandatory";
    panel(doc).scrollY = 130;
    p.sync();
    expect(el.scrollTop).toBe(120);
    expect(p.core.rectOf(doc.query("#r3")!.component)).toMatchObject({ y: 0 }); // drawn where it snapped, that frame
  });

  it("takes scroll-padding, scroll-margin and center/end alignment into the positions", async () => {
    const doc = list(`scroll-snap-type="y mandatory" scroll-padding-top="10"`, `.row { scroll-snap-align: start; } #r3 { scroll-margin-top: 5px; } #r5 { scroll-snap-align: center; } #r7 { scroll-snap-align: end; }`);
    const p = await pointer();
    p.sync();
    const ys = new Map(laid(p, doc).snap!.areas.map((a) => [a.comp, a.y]));
    expect(ys.get(panel(doc, "r2"))).toBe(80 - 10);
    expect(ys.get(panel(doc, "r3"))).toBe(120 - 5 - 10);
    // Centre: the row's middle (220) at the snapport's (10 + 90 / 2 = 55).
    expect(ys.get(panel(doc, "r5"))).toBe(220 - 55);
    // End: the row's end (320) at the snapport's (100).
    expect(ys.get(panel(doc, "r7"))).toBe(320 - 100);
  });

  it("snaps once the wheel has settled, moving on from where the gesture started", async () => {
    const doc = list();
    const p = await pointer();
    p.wheel(panel(doc), 0, 15);
    frame(p);
    expect(panel(doc).scrollY).toBe(15); // at once, unsnapped while the wheel turns
    frame(p, 30);
    expect(panel(doc).scrollY).toBe(40); // settled: on to the next row, eased there
    p.wheel(panel(doc), 0, 90);
    frame(p, 30);
    expect(panel(doc).scrollY).toBe(120); // 130: nearest past the start is 120
  });

  it("eases a touch drag's fling to the position nearest its momentum's end, stopping at scroll-snap-stop: always", async () => {
    const doc = list(undefined, `.row { scroll-snap-align: start; } #r6 { scroll-snap-stop: always; }`);
    const p = await pointer();
    const at = p.pointIn(uiAs(doc.query("#r1")!, UIButton));
    p.dom.touchStart(5, at.x, at.y);
    frame(p);
    p.dom.touchMove(5, at.x, at.y - 30);
    frame(p);
    p.dom.touchMove(5, at.x, at.y - 50);
    frame(p);
    p.dom.touchEnd(5);
    frame(p, 90);
    const y = panel(doc).scrollY;
    expect(y % 40).toBe(0);
    expect(y).toBeGreaterThan(50); // it went on in the fling's direction
    expect(y).toBeLessThanOrEqual(240); // and not past row 6, which stops it
    // A hard fling from the top stops at row 6.
    panel(doc).scrollY = 0;
    p.sync();
    p.dom.touchStart(6, at.x, at.y + 20);
    frame(p);
    for (let i = 1; i <= 3; i++) {
      p.dom.touchMove(6, at.x, at.y + 20 - i * 25);
      frame(p);
    }
    p.dom.touchEnd(6);
    frame(p, 120);
    expect(panel(doc).scrollY).toBe(240);
  });

  it("snaps a slow drag let go, and a scrollbar thumb let go", async () => {
    const doc = list();
    const p = await pointer();
    const at = p.pointIn(uiAs(doc.query("#r1")!, UIButton));
    p.dom.touchStart(5, at.x, at.y);
    frame(p);
    p.dom.touchMove(5, at.x, at.y - 25);
    frame(p, 10); // held still: no momentum
    p.dom.touchEnd(5);
    frame(p, 60);
    expect(panel(doc).scrollY).toBe(40);
    // The thumb: 30 pixels of 75 room is 120 + 40 (from 40) = 160 → snaps to 160.
    p.dom.moveTo(195, 20);
    p.dom.pointerDown(0);
    frame(p);
    p.dom.moveTo(195, 50);
    frame(p);
    expect(panel(doc).scrollY).toBeCloseTo(160);
    p.dom.moveTo(195, 53);
    frame(p);
    p.dom.pointerUp(0);
    frame(p, 60);
    expect(panel(doc).scrollY).toBe(160);
  });

  it("steps keys from snap position to snap position", async () => {
    stubDocument();
    const doc = list(`scroll-snap-type="y mandatory" gap="10"`);
    const p = await pointer();
    p.dom.moveTo(185, 45);
    p.dom.click();
    frame(p);
    // Rows every 50 pixels: positions 0, 50, 100…, the end 490 - 100 = 390.
    p.dom.tap("ArrowDown"); // 40 would land between: on to 50
    frame(p);
    expect(panel(doc).scrollY).toBe(50);
    p.dom.tap("PageDown"); // 50 + 87.5 = 137.5: nearest past 50 is 150
    frame(p);
    expect(panel(doc).scrollY).toBe(150);
    p.dom.tap("End");
    frame(p);
    expect(panel(doc).scrollY).toBe(390);
    p.dom.tap("ArrowUp");
    frame(p);
    expect(panel(doc).scrollY).toBe(350);
  });

  it("scrollIntoView and navigation snap where the element stays in view", async () => {
    const doc = list();
    const p = await pointer();
    uiAs(doc.query("#r0")!, UIButton).focused = true;
    for (let i = 0; i < 4; i++) {
      Input.inject.keyDown("arrowdown");
      frame(p);
      Input.inject.keyUp("arrowdown");
      frame(p);
    }
    expect(uiAs(doc.query("#r4")!, UIButton).focused).toBe(true);
    // `nearest` would be 100 (row 4's end at the list's); the snap positions showing all of row 4 are 120 and 160.
    expect(panel(doc).scrollY).toBe(120);
    Input.inject.releaseAll();
    doc.query("#r9")!.scrollIntoView({ block: "end" });
    expect(panel(doc).scrollY).toBe(300);
  });

  it("snaps again after a layout change: to the row it rests on when rows above it grow", async () => {
    const doc = list(`scroll-snap-type="y"`);
    const p = await pointer();
    const el = doc.query("#list")!;
    el.scrollTo(0, 120); // rests on row 3
    p.sync();
    uiAs(doc.query("#r0")!, UIButton).height = 70;
    p.sync();
    expect(el.scrollTop).toBe(150);
    // Mandatory, removing the row it rests on: the nearest position.
    panel(doc).scrollSnapStrictness = "mandatory";
    uiAs(doc.query("#r3")!, UIButton).display = "none";
    p.sync();
    expect(el.scrollTop).toBe(150); // row 4, moved up into row 3's place
  });
});

describe("scrollbar-gutter (ADR 0428)", () => {
  it("stable keeps the bar's room whether or not it shows: clientWidth shrinks and the content doesn't move when it overflows", async () => {
    const doc = buildUI(`<Canvas><div id="g" width="200" height="100" flex-direction="column" overflow="auto" scrollbar-gutter="stable"><div id="row" height="40"/></div><div id="b" width="200" height="100" overflow-y="scroll" overflow-x="hidden" class="b"/></Canvas>`, { css: `.b { scrollbar-gutter: stable both-edges; scrollbar-width: thin; }` });
    const p = await pointer();
    p.sync();
    const g = doc.query("#g")!;
    expect(g.clientWidth).toBe(190);
    expect(p.core.rectOf(doc.query("#row")!.component)!.width).toBe(190);
    expect(laid(p, doc, "g").barY).toBeNull(); // nothing overflows yet
    uiAs(doc.query("#row")!, UIPanel).height = 400;
    p.sync();
    expect(p.core.rectOf(doc.query("#row")!.component)!.width).toBe(190); // the same width with the bar
    expect(laid(p, doc, "g").barY!.track).toEqual({ x: 190, y: 0, width: 10, height: 100 });
    // both-edges: thin (6) on each side; the bar in the right one.
    expect(doc.query("#b")!.clientWidth).toBe(188);
    expect(laid(p, doc, "b").barY!.track).toEqual({ x: 394, y: 0, width: 6, height: 100 });
  });
});

describe("scrolling from the end (ADR 0428)", () => {
  it("column-reverse starts at the bottom with scrollTop 0, scrolls up through negative offsets, and hit-tests and draws its bar there", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `<button id="r${i}" height="40" width="180" padding="0">Row ${i}</button>`).join("");
    const doc = buildUI(`<Canvas><div id="list" width="200" height="100" flex-direction="column-reverse" align-items="flex-start" overflow="auto">${rows}</div></Canvas>`);
    const p = await pointer();
    p.sync();
    const el = doc.query("#list")!;
    expect([el.scrollTop, el.scrollHeight, el.clientHeight]).toEqual([0, 400, 100]);
    const s = laid(p, doc);
    expect([s.minY, s.maxY]).toEqual([-300, 0]);
    // Row 0 is at the bottom (60–100), row 1 above it.
    expect(p.core.rectOf(doc.query("#r0")!.component)).toMatchObject({ y: 60 });
    expect(p.core.hitTest(90, 80)).toBe(doc.query("#r0")!.component);
    expect(s.barY!.thumb.y).toBe(75); // at the end of the track: 25 long in 100
    p.wheel(panel(doc), 0, -50);
    frame(p);
    expect(el.scrollTop).toBe(-50);
    expect(p.core.hitTest(90, 80)).toBe(doc.query("#r1")!.component); // row 1 (at 20–60) moved down 50
    p.wheel(panel(doc), 0, 50);
    frame(p);
    expect(el.scrollTop).toBe(0); // can't go past the end
    el.scrollTo(0, -1000);
    expect(el.scrollTop).toBe(-300);
    p.sync();
    expect(p.core.rectOf(doc.query("#r9")!.component)).toMatchObject({ y: 0 });
    doc.query("#r0")!.scrollIntoView({ block: "end" });
    expect(el.scrollTop).toBe(0);
  });

  it("direction: rtl lays a row out from the right and scrolls it from there with negative scrollLeft; the bar sits on the left", async () => {
    const items = Array.from({ length: 5 }, (_, i) => `<button id="c${i}" width="80" height="40" padding="0">C${i}</button>`).join("");
    const doc = buildUI(`<Canvas><div id="row" dir="rtl" width="200" height="100" flex-direction="row" overflow="auto">${items}</div></Canvas>`);
    const p = await pointer();
    p.sync();
    const el = doc.query("#row")!;
    expect(panel(doc, "row").direction).toBe("rtl");
    expect([el.scrollLeft, el.scrollWidth]).toEqual([0, 400]);
    expect(laid(p, doc, "row")).toMatchObject({ minX: -200, maxX: 0 });
    expect(p.core.rectOf(doc.query("#c0")!.component)).toMatchObject({ x: 120 }); // the first item at the right
    p.wheel(panel(doc, "row"), -60, 0);
    frame(p);
    expect(el.scrollLeft).toBe(-60);
    expect(p.core.rectOf(doc.query("#c0")!.component)).toMatchObject({ x: 180 });
    // Inline start is the right edge in rtl: c2 (-40…40 at scroll 0) with its right edge at the list's.
    doc.query("#c2")!.scrollIntoView({ inline: "start" });
    expect(el.scrollLeft).toBe(-160);
    // Navigation from c0 leftward finds c2 (off screen at first) and scrolls it into view.
    el.scrollLeft = 0;
    p.sync();
    uiAs(doc.query("#c0")!, UIButton).focused = true;
    for (let i = 0; i < 2; i++) {
      Input.inject.keyDown("arrowleft");
      frame(p);
      Input.inject.keyUp("arrowleft");
      frame(p);
    }
    expect(uiAs(doc.query("#c2")!, UIButton).focused).toBe(true);
    expect(el.scrollLeft).toBe(-40); // c2 spans -40…40 at scroll 0: its left edge to the list's
    Input.inject.releaseAll();
    // A vertical bar in rtl is on the left.
    const col = buildUI(`<Canvas><div id="v" dir="rtl" width="100" height="100" overflow-y="scroll" overflow-x="hidden"/></Canvas>`);
    p.sync();
    expect(laid(p, col, "v").barY!.track.x).toBe(0);
  });

  it("row-reverse scrolls from the right in ltr, and from the left in rtl", async () => {
    const items = Array.from({ length: 5 }, (_, i) => `<button width="80" height="40" padding="0">C${i}</button>`).join("");
    const doc = buildUI(`<Canvas><div id="a" width="200" height="60" flex-direction="row-reverse" overflow="auto">${items}</div><div id="b" dir="rtl" width="200" height="60" flex-direction="row-reverse" overflow="auto">${items}</div></Canvas>`);
    const p = await pointer();
    p.sync();
    expect(laid(p, doc, "a")).toMatchObject({ minX: -200, maxX: 0, x: 0 });
    expect(laid(p, doc, "b")).toMatchObject({ minX: 0, maxX: 200, x: 0 });
  });
});
