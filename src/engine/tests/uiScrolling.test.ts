import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIPanel, UIText } from "../ui/components";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";
import { buildUI, loadUITestSupport, uiAs, type TestUI } from "./uiMarkup";

// ADR 0427: elements scroll with `overflow: auto | scroll`: layout, clipping and drawing offsets, hit-testing, the
// wheel (with chaining and `overscroll-behavior`), touch drags with momentum, keys, scrollbars, the DOM's scrolling
// members on document elements, smooth scrolling, `scroll`/`scrollend` events and navigation. Driven through a UI core
// routing `Input`'s DOM adapter (`UIPointer`) and documents built from markup.

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

/** A frame: the device snapshot and routing, the World's step, then the renderer's layout (`dt` on). */
function frame(p: UIPointer, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    engine.step(DT);
    p.sync(DT);
  }
}

/** A 200 × 100 vertical list of ten 40-pixel rows (400 pixels of content) at (0, 0). */
function list(attrs = "", css?: string): TestUI {
  const rows = Array.from({ length: 10 }, (_, i) => `<button id="r${i}" height="40" width="180" padding="0">Row ${i}</button>`).join("\n");
  return buildUI(`<Canvas><div id="list" width="200" height="100" flex-direction="column" align-items="flex-start" overflow="auto" ${attrs}>${rows}</div></Canvas>`, css === undefined ? {} : { css });
}

const panel = (doc: TestUI, id = "list") => uiAs(doc.query(`#${id}`)!, UIPanel);

describe("layout and drawing (ADR 0427)", () => {
  it("measures the content past the padding box, offsets the children by the scroll, clamps it, and hit-tests what's shown", async () => {
    const doc = list();
    const p = await pointer();
    const el = doc.query("#list")!;
    expect([el.scrollHeight, el.clientHeight, el.scrollWidth, el.clientWidth]).toEqual([400, 100, 200, 200]);
    el.scrollTop = 60;
    p.sync();
    expect(p.core.rectOf(doc.query("#r0")!.component)).toMatchObject({ y: -60 });
    expect(p.core.rectOf(doc.query("#r2")!.component)).toMatchObject({ y: 20 });
    // The pointer at (90, 50) is over row 2 now (it starts at 20 on screen); rows scrolled out of the clip aren't hit.
    expect(p.core.hitTest(90, 50)).toBe(doc.query("#r2")!.component);
    expect(p.core.hitTest(90, 110)).toBeNull();
    // The editor's outline follows the offset too.
    expect(p.core.cornersOf(doc.query("#r2")!.component)!.points[0]).toEqual([0, 20]);
    // A script asking for more than the content has is clamped at the next layout.
    panel(doc).scrollY = 1000;
    p.sync();
    expect(el.scrollTop).toBe(300);
  });

  it("lays out the content unconstrained along a scrolling axis: text keeps its height instead of shrinking, as under overflow: hidden", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `<p id="t${i}" font-size="20">Line ${i}</p>`).join("");
    const doc = buildUI(`<Canvas><div id="list" width="200" height="60" flex-direction="column" overflow="auto">${lines}</div><div id="clip" width="200" height="60" flex-direction="column" overflow="hidden">${lines.replace(/id="t/g, 'id="h')}</div></Canvas>`);
    const p = await pointer();
    p.sync();
    const scrolled = p.core.rectOf(doc.query("#t5")!.component)!;
    const squeezed = p.core.rectOf(doc.query("#h5")!.component)!;
    expect(scrolled.height).toBeCloseTo(24, 0); // 20 px at line height 1.2
    // ADR 0433: under overflow: hidden too, as in CSS: a flex item doesn't shrink below its content (its automatic
    // minimum size); the rows overflow and are clipped. (Yoga squeezed them.)
    expect(squeezed.height).toBeCloseTo(24, 0);
    expect(doc.query("#list")!.scrollHeight).toBeCloseTo(144, 0);
  });

  it("reads overflow-x and overflow-y, the overflow shorthand's two values, and CSS's visible-beside-scroll rule", async () => {
    const doc = buildUI(`<Canvas><div id="a" class="a"/><div id="b" class="b"/><div id="c" overflow-y="scroll"/></Canvas>`, { css: `.a { overflow: hidden auto; } .b { overflow: scroll; overflow-x: hidden; }` });
    const a = panel(doc, "a"), b = panel(doc, "b");
    expect([a.overflow, a.overflowX, a.overflowY]).toEqual(["visible", "hidden", "auto"]);
    expect([b.overflow, b.overflowX, b.overflowY]).toEqual(["scroll", "hidden", null]);
    const p = await pointer();
    p.sync();
    // c: visible beside scroll computes to auto, so it clips and the player scrolls it both ways.
    const c = p.core.elements().find((e) => e.comp === panel(doc, "c"))!;
    expect(c.scroll).toMatchObject({ userX: true, userY: true });
    const laidA = p.core.elements().find((e) => e.comp === a)!;
    expect(laidA.scroll).toMatchObject({ userX: false, userY: true });
  });
});

describe("the wheel (ADR 0427)", () => {
  it("scrolls the list under the pointer as the wheel event's default action, which a handler can prevent; the game doesn't see it", async () => {
    const doc = list();
    const p = await pointer();
    let prevent = false;
    let gameSaw = -1;
    doc.query("#list")!.on("wheel", (e) => {
      if (prevent) e.preventDefault();
      gameSaw = Input.mouseScrollDelta.y;
    });
    p.wheel(panel(doc), 0, 50);
    frame(p);
    expect(panel(doc).scrollY).toBe(50);
    expect(gameSaw).toBe(0); // a UI scroller took it
    prevent = true;
    p.wheel(panel(doc), 0, 50);
    frame(p);
    expect(panel(doc).scrollY).toBe(50);
  });

  it("chains to the next scroller out once the inner one can't move, unless overscroll-behavior contains it", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => `<button id="i${i}" height="40" width="100" padding="0">I${i}</button>`).join("");
    const doc = buildUI(`<Canvas><div id="outer" width="300" height="100" flex-direction="column" overflow="auto"><div id="inner" width="200" height="60" flex-direction="column" overflow="auto">${rows}</div><div height="300" width="10"/></div></Canvas>`);
    const p = await pointer();
    const inner = panel(doc, "inner"), outer = panel(doc, "outer");
    p.wheel(inner, 0, 500);
    frame(p);
    expect([inner.scrollY, outer.scrollY]).toEqual([100, 0]); // the inner one first, to its end
    p.wheel(inner, 0, 30);
    frame(p);
    expect([inner.scrollY, outer.scrollY]).toEqual([100, 30]); // then the outer one
    inner.overscrollBehavior = "contain";
    p.wheel(inner, 0, 30);
    frame(p);
    expect(outer.scrollY).toBe(30);
  });
});

describe("touch and pen drags (ADR 0427)", () => {
  it("scrolls by a touch drag past the threshold, cancelling the row's press (no click), then keeps going with momentum", async () => {
    const doc = list();
    const p = await pointer();
    const seen: string[] = [];
    doc.query("#r1")!.on("click", () => seen.push("click"));
    doc.query("#r1")!.on("pointercancel", () => seen.push("cancel"));
    const at = p.pointIn(uiAs(doc.query("#r1")!, UIButton));
    p.dom.touchStart(5, at.x, at.y);
    frame(p);
    p.dom.touchMove(5, at.x, at.y - 6);
    frame(p);
    expect(panel(doc).scrollY).toBe(0); // under the threshold: still a press
    p.dom.touchMove(5, at.x, at.y - 30);
    frame(p);
    expect(panel(doc).scrollY).toBe(30);
    p.dom.touchMove(5, at.x, at.y - 60);
    frame(p);
    expect(panel(doc).scrollY).toBe(60);
    p.dom.touchEnd(5);
    frame(p);
    const released = panel(doc).scrollY;
    frame(p, 5);
    expect(panel(doc).scrollY).toBeGreaterThan(released); // momentum
    expect(seen).toEqual(["cancel"]);
  });

  it("doesn't scroll by a mouse drag (the press stays a press)", async () => {
    const doc = list();
    const p = await pointer();
    const at = p.pointIn(uiAs(doc.query("#r1")!, UIButton));
    p.dom.moveTo(at.x, at.y);
    p.dom.pointerDown(0);
    frame(p);
    p.dom.moveTo(at.x, at.y - 40);
    frame(p);
    p.dom.pointerUp(0);
    frame(p);
    expect(panel(doc).scrollY).toBe(0);
  });
});

describe("keys (ADR 0427)", () => {
  it("scrolls the list a press landed in with the arrows, Page Down and End while nothing is focused; Page Up from a focused row", async () => {
    stubDocument();
    // A gap between the rows: a press there lands on the list itself, which focuses nothing.
    const doc = list(`gap="10"`);
    const p = await pointer();
    p.dom.moveTo(185, 45); // right of the 180-pixel rows, left of the scrollbar, inside the list
    p.dom.click();
    frame(p);
    p.dom.tap("ArrowDown");
    frame(p);
    expect(panel(doc).scrollY).toBe(40);
    p.dom.tap("PageDown");
    frame(p);
    expect(panel(doc).scrollY).toBeCloseTo(40 + 87.5);
    p.dom.tap("End");
    frame(p);
    expect(panel(doc).scrollY).toBe(490 - 100);
    // A focused row: the arrows are navigation's, but Page Up scrolls the list it's in.
    uiAs(doc.query("#r9")!, UIButton).focused = true;
    p.dom.tap("PageUp");
    frame(p);
    expect(panel(doc).scrollY).toBeCloseTo(390 - 87.5);
  });
});

describe("navigation (ADR 0427, 0340)", () => {
  it("finds rows scrolled out of view and scrolls the one it focuses into view", async () => {
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
    // Row 4 is at 160–200 in the content: the nearest scroll that shows it puts its bottom at the list's.
    expect(panel(doc).scrollY).toBe(100);
    Input.inject.releaseAll();
  });
});

describe("scrollbars (ADR 0427)", () => {
  it("shows a bar for scroll always and for auto when the content overflows, styled by scrollbar-width and scrollbar-color", async () => {
    const doc = buildUI(`<Canvas><div id="auto" width="100" height="100" overflow="auto"/><div id="scroll" class="s" width="100" height="100" overflow-y="scroll" overflow-x="hidden"/><div id="none" width="100" height="100" overflow="scroll" scrollbar-width="none"/></Canvas>`, { css: `.s { scrollbar-color: #ff0000 #00ff00; scrollbar-width: thin; }` });
    const p = await pointer();
    p.sync();
    const laid = (id: string) => p.core.elements().find((e) => e.comp === panel(doc, id))!.scroll!;
    expect([laid("auto").barX, laid("auto").barY]).toEqual([null, null]);
    expect(laid("scroll").barX).toBeNull();
    expect(laid("scroll").barY!.track).toEqual({ x: 194, y: 0, width: 6, height: 100 });
    expect([laid("none").barX, laid("none").barY]).toEqual([null, null]);
    expect(panel(doc, "scroll").scrollbarThumbColor?.r).toBe(1);
    expect(panel(doc, "scroll").scrollbarTrackColor?.g).toBe(1);
  });

  it("scrolls by dragging the thumb, and pages by a press on the track", async () => {
    const doc = list();
    const p = await pointer();
    p.sync();
    const bar = p.core.elements().find((e) => e.comp === panel(doc))!.scroll!.barY!;
    // The thumb: a quarter of the track (100 of 400 shown), 25 pixels long, 75 pixels of room for 300 of scroll.
    expect(bar.thumb).toEqual({ x: 190, y: 0, width: 10, height: 25 });
    p.dom.moveTo(195, 10);
    p.dom.pointerDown(0);
    frame(p);
    p.dom.moveTo(195, 40);
    frame(p);
    expect(panel(doc).scrollY).toBeCloseTo(120); // 30 pixels of 75 room is 120 of 300
    p.dom.pointerUp(0);
    frame(p);
    p.dom.moveTo(195, 95); // the track below the thumb
    p.dom.click();
    frame(p);
    expect(panel(doc).scrollY).toBeCloseTo(120 + 87.5);
  });
});

describe("the script API and events (ADR 0427)", () => {
  it("scrollTo, scrollBy and scrollIntoView on document elements; smooth scrolling eases over frames", async () => {
    const doc = list();
    const p = await pointer();
    const el = doc.query("#list")!;
    el.scrollTo(0, 100);
    expect(el.scrollTop).toBe(100);
    el.scrollBy({ top: 20 });
    expect(el.scrollTop).toBe(120);
    p.sync();
    doc.query("#r9")!.scrollIntoView({ block: "end" });
    expect(el.scrollTop).toBe(300);
    p.sync();
    doc.query("#r2")!.scrollIntoView(); // block: start
    expect(el.scrollTop).toBe(80);
    p.sync();
    doc.query("#r3")!.scrollIntoView({ block: "nearest" }); // already shown: stays
    expect(el.scrollTop).toBe(80);
    el.scrollTo({ top: 0, behavior: "smooth" });
    expect(el.scrollTop).toBe(80);
    p.sync(0.1);
    const mid = el.scrollTop;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(80);
    p.sync(1);
    expect(el.scrollTop).toBe(0);
    // scroll-behavior: smooth makes auto smooth.
    panel(doc).scrollBehavior = "smooth";
    el.scrollTo(0, 200);
    expect(el.scrollTop).toBe(0);
    p.sync(1);
    expect(el.scrollTop).toBe(200);
  });

  it("sends scroll (not bubbling) the frame after the offsets change, and scrollend once they stop", async () => {
    const doc = list();
    const p = await pointer();
    const seen: string[] = [];
    doc.query("#list")!.on("scroll", (e) => seen.push(`scroll ${e.bubbles}`));
    doc.query("#list")!.on("scrollend", () => seen.push("scrollend"));
    doc.root!.on("scroll", () => seen.push("canvas heard it"));
    frame(p);
    panel(doc).scrollY = 40;
    p.sync();
    frame(p);
    expect(seen).toEqual(["scroll false"]);
    frame(p, 2);
    expect(seen).toEqual(["scroll false", "scrollend"]);
  });
});
