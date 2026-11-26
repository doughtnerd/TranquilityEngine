import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIButton, UIInputField, UIMeter, UIOption, UIProgress, UIRadio, UISelect, UISlider, UIText, UITextArea, UIToggle } from "../../../engine/ui/components";
import { UIPointer, stubDocument } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as ControlsModule from "./testComponents/Controls.svelte";

// ADR 0424 in Svelte views: HTML's form tags become the UI core's form kinds, and the renderer's `bind` hook gives
// bind:checked, bind:group (radios and checkboxes) and bind:value (with number coercion for range and number inputs,
// on selects with values of any type, and on text areas). Driven through a UI core routing `Input`'s DOM adapter
// (`UIPointer`), as a player drives them.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/controls.svelte": ControlsModule }) });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  Input.inject.releaseAll();
  engine.dispose();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Api = { setKind(kind: string): void; setColour(c: string): void; setLevel(n: number): void };

async function view(): Promise<{ v: UIView; log: string[]; api: Api; echo: () => string }> {
  const log: string[] = [];
  let api!: Api;
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/controls.svelte", props: { log: (s: string) => log.push(s), onapi: (a: Api) => (api = a) } });
  await v.ready;
  pointer = await UIPointer.create(World.require(), 1280, 1000);
  return { v, log, api, echo: () => v.query("#echo")!.as(UIText).text };
}

/** A frame, then the renderer's layout; a click waits a second frame (one press per frame). */
function frame(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    engine.step(DT);
    pointer!.sync(DT);
  }
}

function click(c: Parameters<UIPointer["click"]>[0]): void {
  pointer!.click(c);
  frame(2);
}

describe("UIView: form elements (ADR 0424)", () => {
  it("maps HTML's form tags to their kinds and pushes the bound values in", async () => {
    const { v, echo } = await view();
    expect(v.query("#agree")!.component).toBeInstanceOf(UIToggle);
    expect(v.query("#m")!.as(UIRadio).checked).toBe(true);
    expect(v.query("#s")!.as(UIRadio).checked).toBe(false);
    expect([v.query("#ham")!.as(UIToggle).checked, v.query("#egg")!.as(UIToggle).checked]).toEqual([true, false]);
    expect(v.query("#volume")!.as(UISlider).value).toBe(30);
    expect(v.query("#count")!.as(UIInputField)).toMatchObject({ type: "number", value: "2" });
    expect(v.query("#notes")!.component).toBeInstanceOf(UITextArea);
    expect(v.query("#bar")!.as(UIProgress).value).toBeCloseTo(0.3);
    expect(v.query("#gauge")!.as(UIMeter).value).toBe(0.5);
    expect(v.query("#go")!.component).toBeInstanceOf(UIButton);
    frame();
    expect(v.query("#colour")!.as(UISelect).value).toBe("g");
    expect(v.query("#level")!.as(UISelect).value).toBe("1");
    expect(echo()).toBe("false m ham 30 number:2 g number:1");
  });

  it("binds checked through a label's click, and a radio group and a checkbox group both ways", async () => {
    const { v, log, echo } = await view();
    click(v.query("#agree-label")!.children.find((c) => c.component instanceof UIText)!.component);
    expect(log).toContain("agree true");
    click(v.query("#s")!.as(UIRadio));
    click(v.query("#egg")!.as(UIToggle));
    expect(echo()).toBe("true s ham,egg 30 number:2 g number:1");
    expect(v.query("#m")!.as(UIRadio).checked).toBe(false);
    click(v.query("#ham")!.as(UIToggle));
    expect(echo()).toBe("true s egg 30 number:2 g number:1");
  });

  it("binds a slider's and a number field's value as numbers, and a select's to its option's value of any type", async () => {
    stubDocument();
    const { v, api, echo } = await view();
    const slider = v.query("#volume")!.as(UISlider);
    slider.focused = true;
    frame();
    pointer!.dom.tap("end");
    frame(2);
    expect(echo()).toContain(" 100 ");
    expect(v.query("#bar")!.as(UIProgress).value).toBe(1);
    const count = v.query("#count")!.as(UIInputField);
    count.focused = true;
    frame();
    pointer!.dom.tap("arrowup");
    frame(2);
    expect(echo()).toContain("number:3");
    // Choosing "Two" in the level select binds the number 2 (its value attribute's own value).
    click(v.query("#level")!.as(UISelect));
    click(v.query("#level")!.query("option:last-child")!.as(UIOption));
    expect(echo()).toContain("number:2");
    // The bound state written by the component chooses the option.
    api.setColour("r");
    frame(2);
    expect(v.query("#colour")!.as(UISelect).value).toBe("r");
    expect(v.query("#colour")!.query("option")!.as(UIOption).selected).toBe(true);
  });

  it("binds a text area's value as typed (Enter starts a line), and submits and resets its form", async () => {
    const fake = stubDocument();
    const { v, log, echo } = await view();
    click(v.query("#notes")!.as(UITextArea));
    fake.emit("keydown", { key: "Enter" });
    fake.typeText("one\ntwo");
    frame(2);
    expect(echo()).toContain(" one\ntwo".replace("\n", " ")); // text collapses whitespace when drawn in <p>
    click(v.query("#go")!.as(UIButton));
    expect(log).toEqual(["submit"]);
    // A reset button puts the controls back as they were made, and the bindings take their values again (as Svelte's
    // DOM bindings do on a form's reset).
    click(v.query("#agree")!.as(UIToggle));
    click(v.query("#egg")!.as(UIToggle));
    expect(echo()).toMatch(/^true m ham,egg /);
    click(v.query("#clear")!.as(UIButton));
    await Promise.resolve();
    frame();
    expect(log).toEqual(["submit", "agree true", "reset"]);
    expect(v.query("#agree")!.as(UIToggle).checked).toBe(false);
    expect(echo()).toMatch(/^false m ham /);
  });

  it("makes an <input> again as what its new type says, in place", async () => {
    const { v, api } = await view();
    expect(v.query("#morph")!.component).toBeInstanceOf(UIToggle);
    api.setKind("range");
    frame(2);
    expect(v.query("#morph")!.component).toBeInstanceOf(UISlider);
    api.setKind("password");
    frame(2);
    expect(v.query("#morph")!.as(UIInputField).type).toBe("password");
    // Still in its place: after the meter, before the button.
    const ids = v.query("#form")!.children.map((c) => c.id);
    expect(ids.indexOf("morph")).toBe(ids.indexOf("gauge") + 1);
  });
});
