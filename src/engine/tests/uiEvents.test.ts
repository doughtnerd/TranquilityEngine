import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Input } from "../index";
import { UIButton, UIInputField, UIPanel } from "../ui/components";
import { UIEvents, loadUIDocumentSupport, type UIDocument, type UIEvent } from "../ui/UIDocument";
import { World } from "../core/World";
import { UIPointer, stubDocument } from "./uiPointer";
import { buildUI } from "./uiMarkup";

// ADR 0422: UI events travel through capture, target and bubble phases over the target's ancestors in a document, with
// the DOM's event members, pointer and key data, and default actions handlers can prevent. Driven as a player drives
// them: a UI core routes `Input`'s DOM adapter (`UIPointer`), documents built from markup, handlers through `on`.

const DT = 1 / 60;
let engine: Engine;
let pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
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
function list(): UIDocument {
  return buildUI(`<Canvas>
  <Panel id="list" flex-direction="column" align-items="flex-start" background-color="#222222" padding="10">
    <Button id="one" width="200" height="40" padding="0">One</Button>
    <Button id="two" width="200" height="40" padding="0">Two</Button>
    <InputField id="name" width="200" height="30"/>
  </Panel>
</Canvas>`);
}

describe("inert (HTML's)", () => {
  it("takes an inert element's subtree out of hit-testing and focus: the pointer reaches what's behind", async () => {
    const doc = buildUI(`<Canvas>
  <Panel id="back" background-color="#222222" padding="10">
    <Panel id="wrap" inert="true">
      <Button id="b" width="200" height="40" padding="0">B</Button>
    </Panel>
  </Panel>
</Canvas>`);
    const clicks: string[] = [];
    doc.query("#back")!.on("click", (e) => clicks.push(e.target.id ?? ""));
    const b = doc.query("#b")!.as(UIButton);
    const p = await pointer();
    step();
    expect(() => p.click(b)).toThrow(/would hit/);
    b.focused = true;
    expect(b.focused).toBe(false);

    doc.query("#wrap")!.as(UIPanel).inert = false;
    step();
    p.click(b);
    step();
    expect(clicks).toEqual(["b"]);
    b.focused = true;
    expect(b.focused).toBe(true);
  });
});

describe("propagation (ADR 0422)", () => {
  it("runs capture handlers from the root down, the target's, then bubble handlers back up", async () => {
    const doc = list();
    const seen: string[] = [];
    const log = (who: string) => (e: UIEvent) => seen.push(`${who} ${e.eventPhase} ${e.target.id}>${e.currentTarget?.id ?? "canvas"}`);
    doc.root!.on("click", log("canvas-capture"), { capture: true }).on("click", log("canvas"));
    doc.query("#list")!.on("click", log("list-capture"), { capture: true }).on("click", log("list"));
    doc.query("#one")!.on("click", log("one")).on("click", log("one-capture"), { capture: true });
    const p = await pointer();
    p.click(doc.query("#one")!.as(UIButton));
    step();
    // At the target, capture handlers run first (as browsers do now); the label made from "One" is the button's.
    expect(seen).toEqual(["canvas-capture 1 one>canvas", "list-capture 1 one>list", "one-capture 2 one>one", "one 2 one>one", "list 3 one>list", "canvas 3 one>canvas"]);
  });

  it("stops at stopPropagation (after the element's other handlers) and at stopImmediatePropagation (at once)", async () => {
    const doc = list();
    const seen: string[] = [];
    doc.query("#list")!.on("click", () => seen.push("list"));
    doc.query("#one")!.on("click", (e) => (seen.push("one a"), e.stopPropagation())).on("click", () => seen.push("one b"));
    doc.query("#two")!.on("click", (e) => (seen.push("two a"), e.stopImmediatePropagation())).on("click", () => seen.push("two b"));
    const p = await pointer();
    p.click(doc.query("#one")!.as(UIButton));
    step();
    p.click(doc.query("#two")!.as(UIButton));
    step(2); // a second press waits a frame (one press per frame)
    expect(seen).toEqual(["one a", "one b", "two a"]);
  });

  it("delivers a click on a row to a handler on its list, with the row as the target, and keeps the UIEvents buffer as it was", async () => {
    const doc = list();
    const targets: string[] = [];
    let buffered: UIEvent[] = [];
    let clicked = false;
    doc.query("#list")!.on("click", (e) => {
      targets.push(e.target.id!);
      // As a script would that frame: the buffer and the polled state.
      buffered = [...UIEvents.read()];
      clicked = doc.query("#two")!.clicked;
    });
    const p = await pointer();
    p.click(doc.query("#two")!.as(UIButton));
    step();
    expect(targets).toEqual(["two"]);
    // The buffer has what it always had: the button's polled click and hover, once each.
    expect(buffered.map((e) => `${e.type} ${e.element.id}`)).toEqual(["click two", "hover two"]);
    expect(clicked).toBe(true);
  });

  it("removes once handlers after they run, and off removes a handler for its own phase", async () => {
    const doc = list();
    const seen: string[] = [];
    const listEl = doc.query("#list")!;
    const capture = () => seen.push("capture");
    listEl.on("click", () => seen.push("once"), { once: true }).on("click", capture, { capture: true });
    listEl.off("click", capture); // a bubble handler: the capture one stays
    const p = await pointer();
    const one = doc.query("#one")!.as(UIButton);
    p.click(one);
    step();
    p.click(one);
    step(2); // a second press waits a frame (one press per frame)
    expect(seen).toEqual(["capture", "once", "capture"]);
  });
});

describe("pointer events (ADR 0422)", () => {
  it("sends over, enter, move, down, up, click and dblclick with positions in canvas and element pixels", async () => {
    const doc = list();
    const seen: string[] = [];
    const one = doc.query("#one")!;
    for (const type of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup", "click", "dblclick", "pointerout", "pointerleave"] as const) {
      one.on(type, (e) => {
        if (e.target === one) seen.push(`${type} ${e.clientX},${e.clientY} ${e.offsetX},${e.offsetY} b${e.button} ${e.detail}`);
      });
    }
    const p = await pointer();
    // The row is at (10, 10) (the list's padding), 200 × 40: its middle is (110, 30).
    p.click(one.as(UIButton));
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
      el.on("pointerenter", () => seen.push(`enter ${id}`)).on("pointerleave", () => seen.push(`leave ${id}`));
    }
    doc.query("#list")!.on("pointerover", (e) => seen.push(`over@list ${e.target.id} from ${e.relatedTarget?.id ?? "-"}`));
    const p = await pointer();
    p.hover(doc.query("#one")!.as(UIButton));
    step();
    expect(seen).toEqual(["over@list one from -", "enter list", "enter one"]);
    seen.length = 0;
    p.hover(doc.query("#two")!.as(UIButton));
    step();
    expect(seen).toEqual(["leave one", "over@list two from one", "enter two"]);
  });

  it("sends contextmenu with a right press, and doesn't click a button that isn't interactable", async () => {
    const doc = list();
    const seen: string[] = [];
    doc.query("#list")!.on("contextmenu", (e) => seen.push(`menu ${e.target.id} ${e.button}`)).on("click", (e) => seen.push(`click ${e.target.id}`));
    doc.query("#two")!.as(UIButton).interactable = false;
    const p = await pointer();
    p.hover(doc.query("#one")!.as(UIButton));
    p.dom.click(2);
    step();
    p.click(doc.query("#two")!.as(UIButton));
    step();
    expect(seen).toEqual(["menu one 2"]);
  });
});

describe("default actions (ADR 0422)", () => {
  it("focuses on press after the pointerdown's dispatch, unless a handler prevents it; focusin and focusout bubble", async () => {
    stubDocument();
    const doc = list();
    const seen: string[] = [];
    const name = doc.query("#name")!;
    const listEl = doc.query("#list")!;
    listEl.on("focusin", (e) => seen.push(`focusin ${e.target.id}`)).on("focusout", (e) => seen.push(`focusout ${e.target.id} to ${e.relatedTarget?.id ?? "-"}`));
    name.on("focus", (e) => seen.push(`focus ${e.target.id}`));
    let prevent = true;
    name.on("pointerdown", (e) => {
      seen.push(`down, focused: ${name.focused}`);
      if (prevent) e.preventDefault();
    });
    const p = await pointer();
    p.click(name.as(UIInputField));
    step();
    expect(name.focused).toBe(false);
    prevent = false;
    p.dom.click();
    step(2); // a second press waits a frame (one press per frame)
    expect(name.focused).toBe(true);
    expect(name.as(UIInputField).typing).toBe(true);
    p.click(doc.query("#one")!.as(UIButton));
    step(2);
    expect(seen).toEqual(["down, focused: false", "down, focused: false", "focus name", "focusin name", "focusout name to one", "focusin one"]);
  });

  it("sends keydown and keyup to the focused element, bubbling; preventing Enter's keydown cancels the field's submit", async () => {
    const dom = stubDocument();
    const doc = list();
    const seen: string[] = [];
    const name = doc.query("#name")!;
    doc.query("#list")!.on("keydown", (e) => seen.push(`keydown ${e.key} ${e.code} on ${e.target.id}`)).on("keyup", (e) => seen.push(`keyup ${e.key}`));
    name.on("submit", () => seen.push("submit"));
    name.as(UIInputField).focused = true;
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
    expect(name.submitted).toBe(true);
    p.dom.keyUp("Enter");
    step();
    name.on("keydown", (e) => e.preventDefault(), { once: true });
    dom.emit("keydown", { key: "Enter" });
    p.dom.keyDown("Enter");
    step();
    expect(name.submitted).toBe(false);
    expect(seen).toEqual(["keydown a KeyA on name", "keyup a", "keydown Enter Enter on name", "submit", "keyup Enter", "keydown Enter Enter on name"]);
  });
});

describe("drags between UI elements (ADR 0422)", () => {
  it("drags a draggable element past the threshold: dragstart, drag, dragenter/dragover, drop where a dragover was prevented, dragend; no click", async () => {
    const doc = buildUI(`<Canvas>
  <Panel id="src" draggable="true" width="100" height="100" background-color="#ff0000"/>
  <Panel id="bin" width="100" height="100" margin-left="50" background-color="#0000ff"/>
</Canvas>`);
    const seen: string[] = [];
    const src = doc.query("#src")!;
    const bin = doc.query("#bin")!;
    src.on("dragstart", (e) => (seen.push("dragstart"), e.dataTransfer!.setData("text", "apple")));
    src.on("dragend", () => seen.push("dragend"));
    src.on("click", () => seen.push("click"));
    bin.on("dragenter", (e) => seen.push(`dragenter from ${e.relatedTarget?.id ?? "-"}`));
    bin.on("dragover", (e) => e.preventDefault());
    bin.on("drop", (e) => seen.push(`drop ${e.dataTransfer!.getData("text/plain")}`));
    const p = await pointer();
    const from = p.pointIn(src.as(UIPanel));
    const to = p.pointIn(bin.as(UIPanel));
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
