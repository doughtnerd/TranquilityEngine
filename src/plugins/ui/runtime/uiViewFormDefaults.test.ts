import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { UIButton, UIInputField, UIText } from "../../../engine/ui/components";
import { UIView } from "./UIView";
import * as FormDefaultsModule from "./testComponents/FormDefaults.svelte";

// HTML's form defaults on renderer nodes (ADR 0428, as Svelte's conformance fixtures use them): `defaultValue`,
// `defaultChecked`, a text area's content and an option's `selected` attribute are what a reset puts back, with HTML's
// dirty flags; `<input type="reset">` is a reset button; a select's `value` chooses at once; a control inside a text
// element stays a control; `muted` sends `volumechange`; a disabled control's `click()` does nothing; `focus()` sends
// `focus` at once. Driven through the renderer's Element subset and UIView, as components and scripts use them.

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/defaults.svelte": FormDefaultsModule }) });
});

afterEach(() => {
  engine.dispose();
  Input.reset();
});

interface Control {
  value: string;
  checked: boolean;
  selectedIndex: number;
  readonly defaultValue: string;
  readonly options: { selected: boolean; defaultSelected: boolean }[];
  muted: boolean;
  click(): void;
  focus(): void;
  blur(): void;
  dispatchEvent(e: { type: string; bubbles?: boolean }): boolean;
}

interface Nodes {
  name: Control;
  notes: Control;
  check: Control;
  pick: Control;
  plain: Control;
  reset: Control;
  intext: Control;
  off: Control;
  focusme: Control;
  setDefault(v: string): void;
  setMuted(m: boolean): void;
  state(): { name: unknown; agree: unknown; pick: unknown };
}

async function view(): Promise<{ v: UIView; n: Nodes; log: string[] }> {
  const log: string[] = [];
  let n!: Nodes;
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/defaults.svelte", props: { log: (s: string) => log.push(s), onnodes: (x: Nodes) => (n = x) } });
  await v.ready;
  engine.step(DT);
  return { v, n, log };
}

describe("UIView: HTML's form defaults and reset", () => {
  it("draws a text area's content as its value only, and a progress bar's fallback text not at all (no text element beside them)", async () => {
    const { v, n } = await view();
    expect(n.notes.value).toBe("hello");
    const texts = (sel: string) => v.query(sel)!.children.map((c) => (c.component instanceof UIText ? c.component.text : c.component.constructor.name));
    expect(texts("#notes")).toEqual([]);
    expect(texts("#prog")).toEqual([]);
  });

  it("shows defaults, binds them when bound to nothing, and a reset input puts them back", async () => {
    const { v, n } = await view();
    expect(n.name.value).toBe("x");
    expect(n.notes.value).toBe("hello");
    expect(n.check.checked).toBe(true);
    expect(n.state()).toEqual({ name: "x", agree: true, pick: "b" });
    expect(n.pick.options.map((o) => o.defaultSelected)).toEqual([false, false, true]);

    n.name.value = "typed";
    n.name.dispatchEvent({ type: "input", bubbles: true });
    n.notes.value = "edited";
    n.check.checked = false;
    n.check.dispatchEvent({ type: "change", bubbles: true });
    n.setDefault("y");
    engine.step(DT);
    expect(n.name.value).toBe("typed"); // changed by the player: a new default leaves it
    expect(n.name.defaultValue).toBe("y");

    expect(v.query("#reset")!.component).toBeInstanceOf(UIButton);
    expect((v.query("#reset")!.children[0]?.component as UIText).text).toBe("Start over");
    n.reset.click();
    await Promise.resolve();
    engine.step(DT);
    expect([n.name.value, n.notes.value, n.check.checked]).toEqual(["y", "hello", true]);
    expect(n.pick.options.map((o) => o.selected)).toEqual([false, false, true]);
    expect(n.state()).toEqual({ name: "y", agree: true, pick: "c" });
  });

  it("chooses a select's option by value at once, and none for a value no option has", async () => {
    const { n } = await view();
    n.plain.value = "b";
    expect(n.plain.selectedIndex).toBe(1);
    n.plain.value = "zzz";
    expect([n.plain.selectedIndex, n.plain.value]).toEqual([-1, ""]);
  });

  it("keeps a control inside a text element a control", async () => {
    const { v, n } = await view();
    expect(v.query("#intext")!.component).toBeInstanceOf(UIInputField);
    expect(n.intext.value).toBe("7");
  });

  it("sends volumechange when muted changes, ignores click() on a disabled button, and sends focus at once", async () => {
    const { n, log } = await view();
    n.setMuted(true);
    engine.step(DT);
    expect(log).toEqual(["volumechange true"]);
    log.length = 0;
    n.off.click();
    expect(log).toEqual([]);
    n.focusme.focus();
    expect(log).toEqual(["focus"]); // before any frame, as the DOM's focus()
    n.focusme.blur();
    expect(log).toEqual(["focus", "blur"]);
  });
});
