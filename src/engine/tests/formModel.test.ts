import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../index";
import { World } from "../core/World";
import { UIForm, UIInputField, UIOption, UIRadio, UISelect, UISlider, UIToggle } from "../ui/components";
import { textRunOf } from "../ui/elementKinds";
import { FormControlState, adoptControlState, chosenOptions, controlState, htmlStepRule, pageSlider, playerTyped, resetForm, selectLabel, selectedness, settleSelect, sliderToEnd, stepSlider, stepValue, writeControl, writeControlValue } from "../ui/formModel";
import { buildUI, byId, loadUITestSupport } from "./uiMarkup";

// ADR 0436: the form-control model, driven through its interface: pure reads (a select's label and choice), HTML's
// selectedness, defaults and dirty flags, a form's reset, scripts' writes and the player's semantic inputs.

let engine: Engine;
beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});
afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

const SELECT = `<Canvas><select id="s"><option id="a" value="a" label="Apple"/><option id="b" value="b" label="Banana"/><option id="c" value="c" label="Cherry"/></select></Canvas>`;

function select(): { s: UISelect; a: UIOption; b: UIOption; c: UIOption } {
  const doc = buildUI(SELECT);
  return { s: byId(doc, "s", UISelect), a: byId(doc, "a", UIOption), b: byId(doc, "b", UIOption), c: byId(doc, "c", UIOption) };
}

describe("selects: reads are pure, settling is a write", () => {
  it("measures a select (its text run) without changing its value or its options", () => {
    const { s, a, b, c } = select();
    // A script chose two options straight on their fields (nothing has settled them yet).
    a.selected = true;
    b.selected = true;
    s.value = "";
    const fields = () => [s.value, a.selected, b.selected, c.selected];
    const before = fields();
    expect(textRunOf(s)!.text).toBe("Banana"); // the last chosen wins, as settling will leave it
    expect(textRunOf(s)!.text).toBe("Banana");
    expect(selectLabel(s)).toBe("Banana");
    expect(chosenOptions(s)).toEqual([b]);
    expect(fields()).toEqual(before);
    // Settling is the write that puts them in step.
    settleSelect(s);
    expect(fields()).toEqual(["b", false, true, false]);
  });

  it("reads a select with nothing chosen as its first enabled option, without choosing it", () => {
    const { s, a, b, c } = select();
    for (const o of [a, b, c]) o.selected = false;
    a.interactable = false;
    settleSelect(s); // the first enabled is chosen
    expect([a.selected, b.selected]).toEqual([false, true]);
    b.selected = false;
    expect(textRunOf(s)!.text).toBe("Banana");
    expect(b.selected).toBe(false);
  });

  it("chooses by a written value at once, and an option chosen by a script unchooses the others", () => {
    const { s, a, b, c } = select();
    writeControl(s, "value", "c");
    expect([a.selected, b.selected, c.selected, s.value]).toEqual([false, false, true, "c"]);
    writeControl(a, "selected", true);
    expect([a.selected, b.selected, c.selected, s.value]).toEqual([true, false, false, "a"]);
    writeControlValue(s, "b");
    expect([a.selected, b.selected, s.value]).toEqual([false, true, "b"]);
  });

  it("keeps HTML's selectedness rule in one place: one of several stays, none chooses the first enabled", () => {
    const on = (x: string) => x !== "off";
    expect(selectedness(["a", "b", "c"], ["a", "c"], on)).toEqual(["c"]); // markup's last wins
    expect(selectedness(["a", "b", "c"], ["a", "c"], on, ["a"])).toEqual(["a"]); // a script's new choice wins
    expect(selectedness(["off", "b"], [], on)).toEqual(["b"]);
    expect(selectedness(["off"], [], on)).toEqual([]);
    expect(selectedness(["a", "b"], ["b"], on)).toEqual(["b"]);
  });
});

describe("defaults, dirty flags and reset", () => {
  it("moves the current value with a new default only while nothing has changed it", () => {
    const st = new FormControlState();
    expect(st.defaultWritten("value", "x", "")).toBe(true);
    expect(st.defaultWritten("value", "y", "x")).toBe(true);
    expect(st.defaultWritten("value", "z", "typed")).toBe(false); // the value isn't its last default any more
    expect(st.defaultWritten("checked", true, false, true)).toBe(false); // held (Svelte's template default)
    st.wrote("checked");
    expect(st.defaultWritten("checked", false, true)).toBe(false);
    expect(st.defaults).toMatchObject({ value: "z", checked: false });
  });

  it("resets a form's controls to their defaults and clears their dirty flags, so a new default reaches them again", () => {
    const doc = buildUI(`<Canvas><form id="f"><input id="name"/><input type="checkbox" id="t"/><input type="range" id="r" min="0" max="10" value="4"/></form></Canvas>`);
    const name = byId(doc, "name", UIInputField);
    const t = byId(doc, "t", UIToggle);
    const r = byId(doc, "r", UISlider);
    // A front end's state for the field (its default given before the control was made); the others as built.
    const st = new FormControlState();
    st.defaultWritten("value", "Ada", "");
    adoptControlState(name, st);
    controlState(t);
    controlState(r);
    playerTyped(name, "Bob");
    t.checked = true;
    r.value = 9;
    expect(st.dirty.value).toBe(true);
    expect(st.defaultWritten("value", "Cy", name.value)).toBe(false);
    resetForm(byId(doc, "f", UIForm));
    expect([name.value, t.checked, r.value]).toEqual(["Cy", false, 4]);
    expect(st.dirty.value).toBe(false);
    expect(st.defaultWritten("value", "Di", name.value)).toBe(true);
  });

  it("checks one radio of a group when a script checks it", () => {
    const doc = buildUI(`<Canvas><input type="radio" id="x" name="g" checked="true"/><input type="radio" id="y" name="g"/></Canvas>`);
    const x = byId(doc, "x", UIRadio);
    const y = byId(doc, "y", UIRadio);
    writeControl(y, "checked", true);
    expect([x.checked, y.checked]).toEqual([false, true]);
  });
});

describe("the player's semantic inputs", () => {
  it("steps a slider by its step, pages by a tenth of its range but at least a step, and goes to its ends", () => {
    const doc = buildUI(`<Canvas><input type="range" id="s" min="0" max="10" step="3" value="3"/></Canvas>`);
    const s = byId(doc, "s", UISlider);
    const world = World.require();
    stepSlider(world, s, 1);
    expect(s.value).toBe(6);
    expect(controlState(s)!.dirty.value).toBe(true);
    pageSlider(world, s, -1); // a tenth (1) would snap back to 6: a page is at least one step
    expect(s.value).toBe(3);
    sliderToEnd(world, s, "max");
    expect(s.value).toBe(9); // the top step that fits
    s.interactable = false;
    sliderToEnd(world, s, "min");
    expect(s.value).toBe(9);
  });
});

describe("HTML's stepping (stepUp, stepDown and a number field's arrows)", () => {
  const rule = (attrs: Parameters<typeof htmlStepRule>[1], type: "number" | "range" = "number") => htmlStepRule(type, attrs)!;

  it("moves an on-step value n steps, and an off-step value only to the nearest step that way", () => {
    const r = rule({ min: "1", step: "3" }); // steps 1, 4, 7…
    expect(stepValue(4, 2, r)).toBe(10);
    expect(stepValue(5, 5, r)).toBe(7); // off the steps: n is ignored
    expect(stepValue(5, -1, r)).toBe(4);
    expect(stepValue(4, -1, r)).toBe(1); // stepUp(-1) is stepDown(1), as browsers do
  });

  it("puts the result at the largest (smallest) step-aligned value in range, and changes nothing the wrong way", () => {
    const r = rule({ min: "0", max: "3", step: "2" });
    expect(stepValue(2, 1, r)).toBe(2); // 4 is past max: the top step in range is 2
    expect(stepValue(3, 1, r)).toBeNull(); // 3 is above every step in range: up would move it down
    expect(stepValue(-5, -1, rule({ min: "0", step: "1" }))).toBeNull(); // below min, down can't go up to min
    expect(stepValue(0, 1, rule({ min: "5", max: "4" }))).toBeNull(); // min above max
  });

  it("steps an unreadable value from 0, from the default value without a min, and as a range with its defaults", () => {
    expect(stepValue(NaN, 1, rule({}))).toBe(1);
    expect(stepValue(NaN, 1, rule({ min: "5" }))).toBe(5); // 0 + 1 is below min: the smallest step in range
    expect(stepValue(2, 1, rule({ value: "0.5" }))).toBe(2.5); // base 0.5: 2 is off the steps
    expect(stepValue(0.1, 2, rule({ step: "0.1" }))).toBe(0.3);
    expect(stepValue(99, 5, rule({}, "range"))).toBe(100); // a range is 0..100 by default
    expect(htmlStepRule("number", { step: "any" })).toBeNull(); // no allowed step: the DOM's stepUp throws
  });
});

describe("default content attributes (the UI host's, ADR 0436)", () => {
  it("applies a select's `multiple` before its options, so each option's `selected` attribute stays chosen", () => {
    const doc = buildUI(`<Canvas><select id="s" multiple=""><option id="a" value="a" selected=""/><option id="b" value="b"/><option id="c" value="c" selected=""/></select></Canvas>`);
    expect(["a", "b", "c"].map((id) => byId(doc, id, UIOption).selected)).toEqual([true, false, true]);
  });

  it("keeps the last `selected` option of a single select, and the last checked radio of a group, as HTML's parser does", () => {
    const doc = buildUI(`<Canvas><select id="s"><option id="a" value="a" selected=""/><option id="b" value="b" selected=""/></select><input type="radio" id="x" name="g" checked=""/><input type="radio" id="y" name="g" checked=""/></Canvas>`);
    expect([byId(doc, "a", UIOption).selected, byId(doc, "b", UIOption).selected, settleSelect(byId(doc, "s", UISelect))]).toEqual([false, true, [byId(doc, "b", UIOption)]]);
    expect([byId(doc, "x", UIRadio).checked, byId(doc, "y", UIRadio).checked]).toEqual([false, true]);
  });
});
