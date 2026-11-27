import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIInputField, UIPanel } from "../ui/components";
import type { UIHostElement, UIHostEvent } from "../ui/host/UIHost";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";
import { buildUI, loadUITestSupport, uiAs, type TestUI } from "./uiMarkup";

// ADR 0426: UI events travel through capture, target and bubble phases over the target's ancestors in a view, with
// the DOM's event members, pointer and key data, and default actions handlers can prevent. Driven as a player drives
// them: a UI core routes `Input`'s DOM adapter (`UIPointer`), views built from markup (ADR 0423), handlers through `on`.

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

const step = (frames = 1) => {
  for (let i = 0; i < frames; i++) engine.step(DT);
};

/** A column list of two 200 × 40 rows at the canvas's corner, inside a panel with a background. */
function list(): TestUI {
  return buildUI(`<Canvas>
  <div id="list" flex-direction="column" align-items="flex-start" background-color="#222222" padding="10">
    <button id="one" width="200" height="40" padding="0">One</button>
    <button id="two" width="200" height="40" padding="0">Two</button>
    <input id="name" width="200" height="30"/>
  </div>
</Canvas>`);
}

describe("inert (HTML's)", () => {
  it("takes an inert element's subtree out of hit-testing and focus: the pointer reaches what's behind", async () => {
    const doc = buildUI(`<Canvas>
  <div id="back" background-color="#222222" padding="10">
    <div id="wrap" inert="true">
      <button id="b" width="200" height="40" padding="0">B</button>
    </div>
  </div>
</Canvas>`);
    const clicks: string[] = [];
    doc.query("#back")!.on("click", (e) => clicks.push(e.element.id ?? ""));
    const b = uiAs(doc.query("#b")!, UIButton);
    const p = await pointer();
    step();
    expect(() => p.click(b)).toThrow(/would hit/);
    b.focused = true;
    expect(b.focused).toBe(false);

    uiAs(doc.query("#wrap")!, UIPanel).inert = false;
    step();
    p.click(b);
    step();
    expect(clicks).toEqual(["b"]);
    b.focused = true;
    expect(b.focused).toBe(true);
  });
});

describe("propagation (ADR 0426)", () => {
  it("runs capture handlers from the root down, the target's, then bubble handlers back up", async () => {
    const doc = list();
    const seen: string[] = [];
    const log = (who: string) => (e: UIHostEvent) => seen.push(`${who} ${e.eventPhase} ${e.element.id}`);
    doc.root!.on("click", log("canvas-capture"), { capture: true });
    doc.root!.on("click", log("canvas"));
    doc.query("#list")!.on("click", log("list-capture"), { capture: true });
    doc.query("#list")!.on("click", log("list"));
    doc.query("#one")!.on("click", log("one"));
    doc.query("#one")!.on("click", log("one-capture"), { capture: true });
    const p = await pointer();
    p.click(uiAs(doc.query("#one")!, UIButton));
    step();
    // At the target, capture handlers run first (as browsers do now); the label made from "One" is the button's.
    expect(seen).toEqual(["canvas-capture 1 one", "list-capture 1 one", "one-capture 2 one", "one 2 one", "list 3 one", "canvas 3 one"]);
  });

  it("stops at stopPropagation (after the element's other handlers) and at stopImmediatePropagation (at once)", async () => {
    const doc = list();
    const seen: string[] = [];
    doc.query("#list")!.on("click", () => seen.push("list"));
    doc.query("#one")!.on("click", (e) => (seen.push("one a"), e.stopPropagation()));
    doc.query("#one")!.on("click", () => seen.push("one b"));
    doc.query("#two")!.on("click", (e) => (seen.push("two a"), e.stopImmediatePropagation()));
    doc.query("#two")!.on("click", () => seen.push("two b"));
    const p = await pointer();
    p.click(uiAs(doc.query("#one")!, UIButton));
    step();
    p.click(uiAs(doc.query("#two")!, UIButton));
    step(2); // a second press waits a frame (one press per frame)
    expect(seen).toEqual(["one a", "one b", "two a"]);
  });

  it("delivers a click on a row to a handler on its list, with the row as the target, the button's polled click set", async () => {
    const doc = list();
    const targets: string[] = [];
    let clicked = false;
    doc.query("#list")!.on("click", (e) => {
      targets.push(e.element.id!);
      clicked = uiAs(doc.query("#two")!, UIButton).clicked; // as a script would that frame
    });
    const p = await pointer();
    p.click(uiAs(doc.query("#two")!, UIButton));
    step();
    expect(targets).toEqual(["two"]);
    expect(clicked).toBe(true);
  });

  it("removes once handlers after they run, and off removes a handler for its own phase", async () => {
    const doc = list();
    const seen: string[] = [];
    const listEl = doc.query("#list")!;
    const capture = () => seen.push("capture");
    listEl.on("click", () => seen.push("once"), { once: true });
    listEl.on("click", capture, { capture: true });
    listEl.off("click", capture); // a bubble handler: the capture one stays
    const p = await pointer();
    const one = uiAs(doc.query("#one")!, UIButton);
    p.click(one);
    step();
    p.click(one);
    step(2); // a second press waits a frame (one press per frame)
    expect(seen).toEqual(["capture", "once", "capture"]);
  });
});

describe("pointer events (ADR 0426)", () => {
  it("sends over, enter, move, down, up, click and dblclick with positions in canvas and element pixels", async () => {
    const doc = list();
    const seen: string[] = [];
    const one = doc.query("#one")!;
    for (const type of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup", "click", "dblclick", "pointerout", "pointerleave"] as const) {
      one.on(type, (e) => {
        if (e.element === one) seen.push(`${type} ${e.clientX},${e.clientY} ${e.offsetX},${e.offsetY} b${e.button} ${e.detail}`);
      });
    }
    const p = await pointer();
    // The row is at (10, 10) (the list's padding), 200 × 40: its middle is (110, 30).
    p.click(uiAs(one, UIButton));
    step();
    expect(seen).toEqual(["pointerover 110,30 100,20 b-1 0", "pointerenter 110,30 100,20 b-1 0", "pointermove 110,30 100,20 b-1 0", "pointerdown 110,30 100,20 b0 0", "pointerup 110,30 100,20 b0 0", "click 110,30 100,20 b0 1"]);
    seen.length = 0;
    p.dom.click();
    step(2); // a second press waits a frame (one press per frame)
    expect(seen).toEqual(["pointerdown 110,30 100,20 b0 0", "pointerup 110,30 100,20 b0 0", "click 110,30 100,20 b0 2", "dblclick 110,30 100,20 b0 2"]);
    seen.length = 0;
    p.leave();
    step();
    expect(seen.map((s) => s.split(" ")[0])).toEqual(["pointerout", "pointerleave"]);
  });

  it("enters and leaves each element the pointer crosses into and out of, not the ones it stays in; over and out bubble", async () => {
    const doc = list();
    const seen: string[] = [];
    for (const id of ["list", "one", "two"]) {
      const el = doc.query(`#${id}`)!;
      el.on("pointerenter", () => seen.push(`enter ${id}`));
      el.on("pointerleave", () => seen.push(`leave ${id}`));
    }
    doc.query("#list")!.on("pointerover", (e) => seen.push(`over@list ${e.element.id} from ${(e.relatedTarget as UIHostElement | null)?.id ?? "-"}`));
    const p = await pointer();
    p.hover(uiAs(doc.query("#one")!, UIButton));
    step();
    expect(seen).toEqual(["over@list one from -", "enter list", "enter one"]);
    seen.length = 0;
    p.hover(uiAs(doc.query("#two")!, UIButton));
    step();
    expect(seen).toEqual(["leave one", "over@list two from one", "enter two"]);
  });

  it("sends contextmenu with a right press, and doesn't click a button that isn't interactable", async () => {
    const doc = list();
    const seen: string[] = [];
    doc.query("#list")!.on("contextmenu", (e) => seen.push(`menu ${e.element.id} ${e.button}`));
    doc.query("#list")!.on("click", (e) => seen.push(`click ${e.element.id}`));
    uiAs(doc.query("#two")!, UIButton).interactable = false;
    const p = await pointer();
    p.hover(uiAs(doc.query("#one")!, UIButton));
    p.dom.click(2);
    step();
    p.click(uiAs(doc.query("#two")!, UIButton));
    step();
    expect(seen).toEqual(["menu one 2"]);
  });
});

describe("default actions (ADR 0426)", () => {
  it("focuses on press after the pointerdown's dispatch, unless a handler prevents it; focusin and focusout bubble", async () => {
    stubDocument();
    const doc = list();
    const seen: string[] = [];
    const name = doc.query("#name")!;
    const listEl = doc.query("#list")!;
    listEl.on("focusin", (e) => seen.push(`focusin ${e.element.id}`));
    listEl.on("focusout", (e) => seen.push(`focusout ${e.element.id} to ${(e.relatedTarget as UIHostElement | null)?.id ?? "-"}`));
    name.on("focus", (e) => seen.push(`focus ${e.element.id}`));
    let prevent = true;
    name.on("pointerdown", (e) => {
      seen.push(`down, focused: ${uiAs(name, UIInputField).focused}`);
      if (prevent) e.preventDefault();
    });
    const p = await pointer();
    p.click(uiAs(name, UIInputField));
    step();
    expect(uiAs(name, UIInputField).focused).toBe(false);
    prevent = false;
    p.dom.click();
    step(2); // a second press waits a frame (one press per frame)
    expect(uiAs(name, UIInputField).focused).toBe(true);
    expect(uiAs(name, UIInputField).typing).toBe(true);
    p.click(uiAs(doc.query("#one")!, UIButton));
    step(2);
    expect(seen).toEqual(["down, focused: false", "down, focused: false", "focus name", "focusin name", "focusout name to one", "focusin one"]);
  });

  it("sends keydown and keyup to the focused element, bubbling; preventing Enter's keydown cancels the field's submit", async () => {
    const dom = stubDocument();
    const doc = list();
    const seen: string[] = [];
    const name = doc.query("#name")!;
    doc.query("#list")!.on("keydown", (e) => seen.push(`keydown ${e.key} ${e.code} on ${e.element.id}`));
    doc.query("#list")!.on("keyup", (e) => seen.push(`keyup ${e.key}`));
    name.on("submit", () => seen.push("submit"));
    uiAs(name, UIInputField).focused = true;
    const p = await pointer();
    p.sync();
    dom.typeText("Ada");
    p.dom.keyDown("a");
    p.dom.keyUp("a");
    step();
    // Enter, with the hidden input's submit: let through, then prevented.
    dom.emit("keydown", { key: "Enter" });
    p.dom.keyDown("Enter");
    step();
    expect(uiAs(name, UIInputField).submitted).toBe(true);
    p.dom.keyUp("Enter");
    step();
    name.on("keydown", (e) => e.preventDefault(), { once: true });
    dom.emit("keydown", { key: "Enter" });
    p.dom.keyDown("Enter");
    step();
    expect(uiAs(name, UIInputField).submitted).toBe(false);
    expect(seen).toEqual(["keydown a KeyA on name", "keyup a", "keydown Enter Enter on name", "submit", "keyup Enter", "keydown Enter Enter on name"]);
  });
});

describe("drags between UI elements (ADR 0426)", () => {
  it("drags a draggable element past the threshold: dragstart, drag, dragenter/dragover, drop where a dragover was prevented, dragend; no click", async () => {
    const doc = buildUI(`<Canvas>
  <div id="src" draggable="true" width="100" height="100" background-color="#ff0000"/>
  <div id="bin" width="100" height="100" margin-left="50" background-color="#0000ff"/>
</Canvas>`);
    const seen: string[] = [];
    const src = doc.query("#src")!;
    const bin = doc.query("#bin")!;
    src.on("dragstart", (e) => (seen.push("dragstart"), e.dataTransfer!.setData("text", "apple")));
    src.on("dragend", () => seen.push("dragend"));
    src.on("click", () => seen.push("click"));
    bin.on("dragenter", (e) => seen.push(`dragenter from ${(e.relatedTarget as UIHostElement | null)?.id ?? "-"}`));
    bin.on("dragover", (e) => e.preventDefault());
    bin.on("drop", (e) => seen.push(`drop ${e.dataTransfer!.getData("text/plain")}`));
    const p = await pointer();
    const from = p.pointIn(uiAs(src, UIPanel));
    const to = p.pointIn(uiAs(bin, UIPanel));
    p.dom.moveTo(from.x, from.y);
    p.dom.pointerDown(0);
    step();
    p.dom.moveTo(from.x + 10, from.y);
    step(); // past the threshold: dragstart
    p.dom.moveTo(to.x, to.y);
    step(); // over the bin: dragenter and a prevented dragover
    p.dom.pointerUp(0);
    step();
    expect(seen).toEqual(["dragstart", "dragenter from -", "drop apple", "dragend"]);
  });
});
