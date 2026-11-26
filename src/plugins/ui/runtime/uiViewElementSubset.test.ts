import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { UISlider, UIText, UIToggle } from "../../../engine/ui/components";
import { UIView } from "./UIView";
import * as SubsetModule from "./testComponents/ElementSubset.svelte";

// ADR 0419's Element subset on renderer nodes, as Svelte's conformance fixtures use it (the conformance triage):
// `click()` runs HTML's activation (a checkbox toggles before the click's listeners, back if one prevents it, then
// `input` and `change`; a submit button submits its form), namespaces, reflected attributes, `stepUp`/`stepDown`,
// `getElementsByTagName`/`getElementsByClassName`, and an <input> keeping its value when its type changes.

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/subset.svelte": SubsetModule }) });
});

afterEach(() => {
  engine.dispose();
  Input.reset();
});

/** The DOM-like members the tests use on renderer nodes. */
interface Node {
  querySelector(s: string): Node;
  getElementsByTagName(t: string): Node[];
  getElementsByClassName(c: string): Node[];
  getAttribute(n: string): string | null;
  click(): void;
  stepUp(n?: number): void;
  stepDown(n?: number): void;
  readonly namespaceURI: string;
  readonly id: string;
  checked: boolean;
  value: string;
  hidden: boolean;
  translate: boolean;
  draggable: boolean;
  tabIndex: number;
  readonly type: string;
}

async function view(props: Record<string, unknown> = {}): Promise<{ v: UIView; root: Node; log: string[] }> {
  const log: string[] = [];
  let root!: Node;
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/subset.svelte", props: { log: (s: string) => log.push(s), onnode: (n: Node) => (root = n), ...props } });
  await v.ready;
  engine.step(DT);
  return { v, root, log };
}

describe("UIView: the Element subset as Svelte's fixtures use it", () => {
  it("click() on a checkbox toggles it before its click listeners, then sends input and change (the binding following change)", async () => {
    const { v, root, log } = await view();
    root.querySelector("#agree").click();
    expect(log).toEqual(["click true", "input false", "change true"]); // bind:checked follows `change`, as in the DOM
    expect(v.query("#agree")!.as(UIToggle).checked).toBe(true);
    engine.step(DT);
    expect(v.query("#state")!.as(UIText).text).toBe("true");
  });

  it("click() on a checkbox whose click listener prevents it puts it back, and sends nothing more", async () => {
    const { v, root, log } = await view({ prevent: true });
    root.querySelector("#agree").click();
    expect(log).toEqual(["click true"]);
    expect(root.querySelector("#agree").checked).toBe(false);
    expect(v.query("#agree")!.as(UIToggle).checked).toBe(false);
  });

  it("click() on a submit button submits its form; a type=button button doesn't", async () => {
    const { root, log } = await view();
    root.querySelector("#plain").click();
    expect(log).toEqual([]);
    root.querySelector("#send").click();
    expect(log).toEqual(["submit"]);
  });

  it("gives elements their namespace: SVG inside <svg>, HTML again inside <foreignObject>, MathML inside <math>", async () => {
    const { root } = await view();
    expect(root.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(root.querySelector("#icon").namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.querySelector("circle").namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.querySelector("foreignObject").namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.querySelector("foreignObject span").namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(root.querySelector("#row").namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
  });

  it("reflects hidden, translate (written as yes/no from a boolean), draggable, tabIndex and type", async () => {
    const { root } = await view();
    const flags = root.querySelector("#flags");
    expect([flags.hidden, flags.translate, flags.draggable, flags.tabIndex]).toEqual([true, false, true, 3]);
    expect(flags.getAttribute("translate")).toBe("no");
    flags.hidden = false;
    flags.translate = true;
    expect([flags.getAttribute("hidden"), flags.getAttribute("translate")]).toEqual([null, "yes"]);
    expect([root.querySelector("#plainspan").tabIndex, root.querySelector("#send").tabIndex]).toEqual([-1, 0]);
    expect([root.querySelector("#send").type, root.querySelector("#plain").type, root.querySelector("#agree").type]).toEqual(["submit", "button", "checkbox"]);
  });

  it("steps a range or number field by its step within min and max, and refuses to step a text field", async () => {
    const { v, root } = await view();
    const amount = root.querySelector("#amount");
    expect(() => amount.stepUp()).toThrow(/InvalidStateError/);
    root.querySelector("#kind").click(); // text -> range: the value is kept
    engine.step(DT);
    expect(v.query("#amount")!.as(UISlider).value).toBe(7);
    amount.stepUp(); // 7 is off the step: up to the next step from min
    expect(amount.value).toBe("8");
    amount.stepUp(5);
    expect(amount.value).toBe("10");
    amount.stepDown(2);
    expect(amount.value).toBe("6");
  });

  it("finds elements by tag and by class", async () => {
    const { root } = await view();
    expect(root.getElementsByTagName("button").map((b) => b.id)).toEqual(["send", "plain", "kind"]);
    expect(root.getElementsByClassName("shape").length).toBe(2);
  });
});
