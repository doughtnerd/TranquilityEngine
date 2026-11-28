import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input } from "../index";
import { World } from "../core/World";
import { UIButton, UIForm, UIInputField, UIMeter, UIOption, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UIText, UITextArea, UIToggle } from "../ui/components";
import { UIPointer, stubDocument } from "./uiPointer";
import { buildUI, byId, loadUITestSupport, type TestUI } from "./uiMarkup";
import type { UIHostEvent } from "../ui/host/UIHost";

// ADR 0428: HTML's form elements as UI core kinds, rendered by a view: checkboxes, radios, sliders, number and password
// fields, text areas, selects with their popup list, progress bars and meters, labels and forms; their `input`/`change`
// events and default actions, keyboard and gamepad navigation, the `:checked`, `:indeterminate`, `:disabled` and
// `:placeholder-shown` pseudo-classes and the parts each draws. Driven through a UI core routing `Input`'s DOM adapter
// (`UIPointer`) and the built-in UI actions, as a player drives them.

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
  Input.inject.releaseAll();
  engine.step(DT);
  engine.dispose();
  Input.reset();
  Assets.clearSources();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

/** A frame: the device snapshot and routing, the World's step, then the renderer's layout. */
function frame(p: UIPointer, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    engine.step(DT);
    p.sync(DT);
  }
}

/** Click `el` and run two frames (a second press waits a frame: one press per frame). */
function click(p: UIPointer, el: Parameters<UIPointer["click"]>[0]): void {
  p.click(el);
  frame(p, 2);
}

/** Press and release a key through the built-in UI actions, a frame each. */
function press(p: UIPointer, key: string): void {
  Input.inject.keyDown(key);
  frame(p);
  Input.inject.keyUp(key);
  frame(p);
}

/** Every event of `types` on the document's root, as "type id", in order. */
function record(doc: TestUI, types: readonly string[]): string[] {
  const log: string[] = [];
  for (const t of types) doc.root!.on(t as never, (e: UIHostEvent) => log.push(`${e.type} ${e.element.id ?? "-"}`));
  return log;
}

const COLUMN = `flex-direction="column" align-items="flex-start" gap="8"`;

describe("checkboxes and radios (ADR 0428)", () => {
  it("toggles a checkbox on click with input then change, clears indeterminate, and polls changed", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="checkbox" id="a" indeterminate="true"/></div></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["input", "change", "click"]);
    const a = byId(doc, "a", UIToggle);
    let changed = false;
    p.click(a);
    engine.step(DT);
    changed = a.changed;
    expect(log).toEqual(["click a", "input a", "change a"]);
    expect([a.checked, a.indeterminate, changed]).toEqual([true, false, true]);
    frame(p);
    click(p, a);
    expect(a.checked).toBe(false);
  });

  it("doesn't toggle when the click is prevented, or when it isn't interactable", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="checkbox" id="a"/><input type="checkbox" id="b" interactable="false"/></div></Canvas>`);
    const p = await pointer();
    doc.query("#a")!.on("click", (e) => e.preventDefault());
    click(p, byId(doc, "a", UIToggle));
    click(p, byId(doc, "b", UIToggle));
    expect([byId(doc, "a", UIToggle).checked, byId(doc, "b", UIToggle).checked]).toEqual([false, false]);
  });

  it("toggles before the click's handlers run, as HTML does, and back when one prevents it", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="checkbox" id="a"/><input type="radio" id="r1" name="g" checked="true"/><input type="radio" id="r2" name="g"/></div></Canvas>`);
    const p = await pointer();
    const seen: string[] = [];
    const a = byId(doc, "a", UIToggle);
    const [r1, r2] = [byId(doc, "r1", UIRadio), byId(doc, "r2", UIRadio)];
    let prevent = false;
    doc.query("#a")!.on("click", (e) => {
      seen.push(`a ${a.checked}`);
      if (prevent) e.preventDefault();
    });
    doc.query("#r2")!.on("click", (e) => {
      seen.push(`r ${r1.checked} ${r2.checked}`);
      e.preventDefault();
    });
    const log = record(doc, ["change"]);
    click(p, a);
    expect([a.checked, ...log]).toEqual([true, "change a"]);
    prevent = true;
    click(p, a);
    expect(a.checked).toBe(true);
    click(p, r2);
    expect(seen).toEqual(["a true", "a false", "r false true"]);
    expect([r1.checked, r2.checked, log.length]).toEqual([true, false, 1]);
  });

  it("checks one radio per name within a form, and arrows move the check through the group", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}>
      <form id="f1" flex-direction="row"><input type="radio" id="a" name="size" checked="true"/><input type="radio" id="b" name="size"/><input type="radio" id="c" name="size"/></form>
      <form id="f2" flex-direction="row"><input type="radio" id="d" name="size" checked="true"/></form>
    </div></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["change"]);
    click(p, byId(doc, "b", UIRadio));
    const checked = () => ["a", "b", "c", "d"].filter((id) => byId(doc, id, UIRadio).checked);
    expect(checked()).toEqual(["b", "d"]);
    expect(log).toEqual(["change b"]);
    // A checked radio clicked again changes nothing.
    click(p, byId(doc, "b", UIRadio));
    expect(log).toEqual(["change b"]);
    // Focus on b (the click gave it): the right arrow checks and focuses c, and wraps round to a.
    press(p, "arrowright");
    expect(checked()).toEqual(["c", "d"]);
    expect(byId(doc, "c", UIRadio).focused).toBe(true);
    press(p, "arrowright");
    expect(checked()).toEqual(["a", "d"]);
  });

  it("toggles a focused checkbox with Space (submit)", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="checkbox" id="a"/></div></Canvas>`);
    const p = await pointer();
    byId(doc, "a", UIToggle).focused = true;
    press(p, "space");
    expect(byId(doc, "a", UIToggle).checked).toBe(true);
  });

  it("matches :checked, :indeterminate and :disabled, and draws the fill and mark in accent-color", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="checkbox" id="a"/><input type="checkbox" id="b" interactable="false"/><input type="checkbox" id="c" indeterminate="true"/></div></Canvas>`, {
      css: `input:checked { width: 20px; } input:disabled { opacity: 0.5; } input:indeterminate { height: 30px; } #a { accent-color: #ff0000; }`,
    });
    const p = await pointer();
    frame(p); // the late sync matches pseudo-classes
    const a = byId(doc, "a", UIToggle);
    expect(byId(doc, "b", UIToggle).opacity).toBe(0.5);
    expect(byId(doc, "c", UIToggle).height).toBe("30");
    p.click(a);
    frame(p, 2);
    expect(a.width).toBe("20");
    const laid = p.core.elements().find((e) => e.comp === a)!;
    expect(laid.parts?.[0]).toMatchObject({ x: 0, y: 0, width: 20, color: [1, 0, 0, 1] });
    expect(laid.parts!.length).toBe(3); // the fill and the mark's two strokes
  });
});

describe("labels (ADR 0428)", () => {
  it("toggles the checkbox it wraps, clicks it once, and focuses a field by `for`", async () => {
    stubDocument();
    const doc = buildUI(`<Canvas><div ${COLUMN}>
      <label id="l1"><input type="checkbox" id="t"/>Accept the terms</label>
      <label id="l2" for="name">Name</label>
      <input id="name"/>
    </div></Canvas>`);
    const p = await pointer();
    const clicks: string[] = [];
    doc.query("#t")!.on("click", () => clicks.push("t"));
    click(p, doc.query("#l1")!.children.find((c) => c.component instanceof UIText)!.component);
    expect(byId(doc, "t", UIToggle).checked).toBe(true);
    expect(clicks).toEqual(["t"]);
    // A click on the checkbox itself toggles once (the label doesn't send a second click).
    click(p, byId(doc, "t", UIToggle));
    expect(byId(doc, "t", UIToggle).checked).toBe(false);
    expect(clicks).toEqual(["t", "t"]);
    click(p, doc.query("#l2")!.children[0].component);
    expect(byId(doc, "name", UIInputField).typing).toBe(true);
  });
});

describe("sliders (ADR 0428)", () => {
  it("jumps to a press, follows a drag with input, sends change on release, and snaps to its step", async () => {
    // 216 wide and 16 tall: the thumb's centre runs from 8 to 208, 2 pixels a unit.
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="range" id="s" width="216" step="5"/></div></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["input", "change"]);
    const s = byId(doc, "s", UISlider);
    const r = p.core.rectOf(s)!;
    p.dom.moveTo(r.x + 8 + 2 * 21, r.y + 8); // 21: snapped to 20
    p.dom.pointerDown(0);
    frame(p);
    expect(s.value).toBe(20);
    p.dom.moveTo(r.x + 8 + 2 * 74, r.y + 8);
    frame(p);
    expect(s.value).toBe(75);
    p.dom.moveTo(r.x + 400, r.y + 8); // past the end: the top
    frame(p);
    p.dom.pointerUp(0);
    frame(p);
    expect(s.value).toBe(100);
    expect(log).toEqual(["input s", "input s", "input s", "change s"]);
    expect(s.focused).toBe(true);
  });

  it("steps with the arrow keys, a tenth with Page Up/Down, to its ends with Home/End; up and down leave it", async () => {
    stubDocument();
    const doc = buildUI(`<Canvas><div ${COLUMN}><input type="range" id="s" min="0" max="10" step="1" value="5"/><button id="next" width="80" height="30">Next</button></div></Canvas>`);
    const p = await pointer();
    const s = byId(doc, "s", UISlider);
    s.focused = true;
    frame(p);
    press(p, "arrowright");
    expect(s.value).toBe(6);
    press(p, "arrowleft");
    press(p, "arrowleft");
    expect(s.value).toBe(4);
    p.dom.tap("end");
    frame(p);
    expect(s.value).toBe(10);
    p.dom.tap("pageup"); // a tenth up, at the top already
    p.dom.tap("home");
    frame(p);
    expect(s.value).toBe(0);
    press(p, "arrowdown");
    expect(byId(doc, "next", UIButton).focused).toBe(true);
  });
});

describe("fields: number, password and text areas (ADR 0428)", () => {
  it("draws a password as dots, one per character", async () => {
    const doc = buildUI(`<Canvas><input id="pw" type="password" value="hunter2"/></Canvas>`);
    const p = await pointer();
    expect(p.core.elements().find((e) => e.comp === byId(doc, "pw", UIInputField))!.text!.text).toBe("•••••••");
  });

  it("steps a typing number field with the arrow keys by HTML's stepping, within min and max", async () => {
    stubDocument();
    const doc = buildUI(`<Canvas><input id="n" type="number" min="0" max="3" step="2" value="0"/></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["change", "input"]);
    const n = byId(doc, "n", UIInputField);
    n.focused = true;
    frame(p);
    p.dom.tap("arrowup");
    frame(p, 2);
    expect(n.value).toBe("2");
    // ADR 0448: HTML's stepUp: past `max` it stops at the largest step-aligned value in range (2, not 3), so nothing changes.
    p.dom.tap("arrowup");
    frame(p, 2);
    expect(n.value).toBe("2");
    p.dom.tap("arrowdown");
    frame(p, 2);
    expect(n.value).toBe("0");
    n.value = "1"; // off the steps: a step moves to the nearest step that way, not a whole step
    p.dom.tap("arrowup");
    frame(p, 2);
    expect(n.value).toBe("2");
    expect(log).toEqual(["input n", "input n", "input n"]); // each step is an `input`; a text-like field commits its `change` on Enter or blur
  });

  it("lays a text area out `rows` lines tall, wraps its lines and scrolls them with the wheel", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}><textarea id="t" rows="3" padding="0" border-width="0" width="200" font-size="10"/></div></Canvas>`);
    const t = byId(doc, "t", UITextArea);
    t.value = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const p = await pointer();
    p.sync();
    expect(p.core.rectOf(t)!.height).toBeCloseTo(36); // 3 lines of 12
    const el = doc.query("#t")!;
    expect(el.scrollHeight).toBeCloseTo(120);
    p.wheel(t, 0, 30);
    frame(p);
    expect(t.scrollY).toBe(30);
  });

  it("starts a new line on Enter in a text area instead of submitting its form", async () => {
    const fake = stubDocument();
    const doc = buildUI(`<Canvas><form id="f"><textarea id="t"/></form></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["submit"]);
    byId(doc, "t", UITextArea).focused = true;
    frame(p);
    fake.emit("keydown", { key: "Enter" });
    fake.typeText("a\nb");
    p.dom.tap("enter");
    frame(p, 2);
    expect(byId(doc, "t", UITextArea).value).toBe("a\nb");
    expect(log).toEqual([]);
  });
});

describe("selects (ADR 0428)", () => {
  const SELECT = `<Canvas><div flex-direction="row" align-items="flex-start" gap="8" width="400" height="300" overflow="hidden">
    <select id="s"><option id="o1" value="r">Red</option><option id="o2" value="g" selected="true">Green</option><option id="o3" interactable="false">Blue</option></select>
    <button id="other" width="100" height="30">Other</button>
  </div></Canvas>`;

  it("shows its chosen option, opens a list above everything on click, chooses with input then change, and closes", async () => {
    const doc = buildUI(SELECT);
    const p = await pointer();
    const log = record(doc, ["input", "change"]);
    const s = byId(doc, "s", UISelect);
    expect(s.value).toBe("g");
    expect(p.core.elements().find((e) => e.comp === s)!.text!.text).toBe("Green");
    const o1 = byId(doc, "o1", UIOption);
    expect(p.core.elements().find((e) => e.comp === o1)!.visible).toBe(false);
    click(p, s);
    expect(s.open).toBe(true);
    // The list is below the select, drawn after every other element, and hit before them.
    const box = p.core.rectOf(s)!;
    const list = p.core.elements().find((e) => e.comp === o1)!;
    expect(list.visible).toBe(true);
    expect(list.y).toBeCloseTo(box.y + box.height);
    expect(list.order).toBeGreaterThan(p.core.elements().find((e) => e.comp === byId(doc, "other", UIButton))!.order);
    click(p, o1);
    expect([s.open, s.value, o1.selected, byId(doc, "o2", UIOption).selected]).toEqual([false, "r", true, false]);
    expect(log).toEqual(["input s", "change s"]);
    expect(p.core.elements().find((e) => e.comp === s)!.text!.text).toBe("Red");
  });

  it("closes on a press outside, and a written value chooses its option", async () => {
    const doc = buildUI(SELECT);
    const p = await pointer();
    const s = byId(doc, "s", UISelect);
    click(p, s);
    click(p, byId(doc, "other", UIButton));
    expect(s.open).toBe(false);
    s.value = "r";
    p.sync();
    expect(byId(doc, "o1", UIOption).selected).toBe(true);
    expect(byId(doc, "o2", UIOption).selected).toBe(false);
  });

  it("opens from the keyboard, moves through enabled options with the arrows, chooses with Enter and cancels with Escape", async () => {
    const doc = buildUI(SELECT);
    const p = await pointer();
    const s = byId(doc, "s", UISelect);
    s.focused = true;
    frame(p);
    press(p, "enter");
    expect(s.open).toBe(true);
    expect(byId(doc, "o2", UIOption).focused).toBe(true);
    press(p, "arrowup");
    expect(byId(doc, "o1", UIOption).focused).toBe(true);
    press(p, "arrowdown");
    press(p, "arrowdown"); // Blue isn't interactable: stays on Green
    expect(byId(doc, "o2", UIOption).focused).toBe(true);
    press(p, "arrowup");
    press(p, "enter");
    expect([s.open, s.value, s.focused]).toEqual([false, "r", true]);
    press(p, "enter");
    press(p, "escape");
    expect([s.open, s.value, s.focused]).toEqual([false, "r", true]);
  });
});

describe("progress bars and meters (ADR 0428)", () => {
  it("fills a progress bar to value / max, sweeps an indeterminate one, and colours a meter by its regions", async () => {
    const doc = buildUI(`<Canvas><div ${COLUMN}>
      <progress id="p" value="0.25" width="100"/><progress id="q" width="100"/>
      <meter id="good" value="0.9" low="0.3" high="0.7" optimum="1" width="100"/><meter id="fair" value="0.5" low="0.3" high="0.7" optimum="1" width="100"/><meter id="poor" value="0.1" low="0.3" high="0.7" optimum="1" width="100"/>
    </div></Canvas>`, { css: `progress:indeterminate { opacity: 0.75; }` });
    const p = await pointer();
    frame(p);
    const parts = (id: string, type: new () => UIProgress | UIMeter) => p.core.elements().find((e) => e.comp === byId(doc, id, type))!.parts;
    expect(parts("p", UIProgress)![0]).toMatchObject({ x: 0, width: 25 });
    expect(byId(doc, "q", UIProgress).opacity).toBe(0.75);
    expect(byId(doc, "p", UIProgress).opacity).toBe(1);
    expect(parts("good", UIMeter)![0].color[0]).toBeLessThan(0.5); // green
    expect(parts("fair", UIMeter)![0].color[1]).toBeGreaterThan(0.6); // yellow
    expect(parts("poor", UIMeter)![0].color[0]).toBeGreaterThan(0.8); // red
    expect(parts("poor", UIMeter)![0].color[1]).toBeLessThan(0.4);
  });
});

describe("forms (ADR 0428)", () => {
  it("submits on a submit button and on Enter in a field, and resets its controls as built unless prevented", async () => {
    const fake = stubDocument();
    const doc = buildUI(`<Canvas><form id="f" ${COLUMN}>
      <input id="name" value="Ada"/><input type="checkbox" id="t" checked="true"/>
      <select id="s"><option id="o1">One</option><option id="o2">Two</option></select>
      <button id="go" width="80" height="30">Go</button><button id="clear" type="reset" width="80" height="30">Clear</button><button id="plain" type="button" width="80" height="30">Plain</button>
    </form></Canvas>`);
    const p = await pointer();
    const log = record(doc, ["submit", "reset"]);
    click(p, byId(doc, "go", UIButton));
    expect(log).toEqual(["submit f"]);
    expect(byId(doc, "f", UIForm).owner).toBeTruthy();
    click(p, byId(doc, "plain", UIButton));
    expect(log).toEqual(["submit f"]);
    // Enter in a field: its own submit, then the form's.
    click(p, byId(doc, "name", UIInputField));
    fake.emit("keydown", { key: "Enter" });
    p.dom.tap("enter");
    frame(p);
    expect(log.join("; ")).toEqual(["submit f", "submit name", "submit f"].join("; "));
    // Change things, then reset.
    byId(doc, "name", UIInputField).value = "Bob";
    byId(doc, "t", UIToggle).checked = false;
    byId(doc, "s", UISelect).value = "Two";
    p.sync();
    click(p, byId(doc, "clear", UIButton));
    expect(log.at(-1)).toBe("reset f");
    expect([byId(doc, "name", UIInputField).value, byId(doc, "t", UIToggle).checked, byId(doc, "s", UISelect).value]).toEqual(["Ada", true, "One"]);
    // A prevented reset leaves them.
    doc.query("#f")!.on("reset", (e) => e.preventDefault());
    byId(doc, "t", UIToggle).checked = false;
    click(p, byId(doc, "clear", UIButton));
    expect(byId(doc, "t", UIToggle).checked).toBe(false);
  });

  it("matches :placeholder-shown while a field with a placeholder is empty", async () => {
    const doc = buildUI(`<Canvas><input id="n" placeholder="Name"/></Canvas>`, { css: `input:placeholder-shown { opacity: 0.5; }` });
    const p = await pointer();
    frame(p);
    const n = byId(doc, "n", UIInputField);
    expect(n.opacity).toBe(0.5);
    n.value = "x";
    frame(p);
    expect(n.opacity).toBe(1);
    void UIPanel;
  });
});
