import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIImage, UIText, type UIComponentType } from "../../../engine/ui/components";
import type { UILaidOutElement } from "../../../engine/ui/uiCoreTypes";
import { UIPointer, stubDocument } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as RichTextModule from "./testComponents/RichText.svelte";

// ADR 0429 in Svelte views: a text element's inline children are styled runs of it, laid out and drawn together; a link
// run takes clicks; `{@html}` parses inline HTML into runs (block elements into panels, scripts and handlers dropped);
// `contenteditable` edits the runs through the hidden text area, with `bind:textContent` and `bind:innerHTML`. Driven
// through a UI core routing `Input`'s DOM adapter (`UIPointer`), as a player drives them, and read from what the core
// lays out for the drawing layer (`elements()`).

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/rich.svelte": RichTextModule }) });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


async function view(props: Record<string, unknown> = {}): Promise<{ v: UIView; log: string[] }> {
  const log: string[] = [];
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/rich.svelte", props: { log: (s: string) => log.push(s), ...props } });
  await v.ready;
  pointer = await UIPointer.create(World.require());
  pointer.sync();
  return { v, log };
}

const comp = (v: UIView, selector: string): UIComponentType => v.query(selector)!.component;
const laid = (v: UIView, selector: string): UILaidOutElement | undefined => pointer!.core.elements().find((e) => e.comp === comp(v, selector));
const runTexts = (el: UILaidOutElement | undefined) => el?.text?.runs?.map((r) => r.text);

describe("UIView: inline runs (ADR 0429)", () => {
  it("makes a text's inline children styled runs of it, measured and laid out as one paragraph", async () => {
    const { v } = await view();
    const para = laid(v, "#para")!;
    expect(runTexts(para)).toEqual(["Hello ", "world", " and ", "a ", "link", "!"]);
    expect(para.text!.text).toBe("Hello world and a link!");
    const runs = para.text!.runs!;
    // HTML's defaults (b bold, a underlined, em italic) under the component's CSS (b green).
    expect(runs[1]).toMatchObject({ fontWeight: "700", color: "rgba(0, 255, 0, 1)" });
    expect(runs[3].decoration).toBe("underline");
    expect(runs[4]).toMatchObject({ fontStyle: "italic", decoration: "underline" });
    // The runs aren't boxes of their own: only the text is laid out, with the core's lines.
    expect(laid(v, "#bold")).toBeUndefined();
    expect(para.inline!.lines).toHaveLength(1);
    expect(para.inline!.width).toBeCloseTo(para.width, 3);
    // A run has its fragment's box, inside its text's, after "Hello ".
    const bold = pointer!.core.rectOf(comp(v, "#bold"))!;
    const box = pointer!.core.rectOf(comp(v, "#para"))!;
    expect(bold.x).toBeGreaterThan(box.x);
    expect(bold.x + bold.width).toBeLessThan(box.x + box.width);
    expect(bold.height).toBeCloseTo(box.height, 3);
  });

  it("wraps across runs at the text's width", async () => {
    const { v } = await view({ width: "60" });
    const para = laid(v, "#para")!;
    expect(para.inline!.lines.length).toBeGreaterThan(1);
    expect(para.height).toBeCloseTo(para.inline!.height, 3);
    // Every word whole on some line.
    const lines = para.inline!.lines.map((l) => l.fragments.map((f) => f.text).join(""));
    expect(lines.join(" ").replace(/\s+/g, " ")).toBe("Hello world and a link!");
  });

  it("raises <sup>, lowers <sub>, breaks the line at <br>, and runs <code>, <mark> and an <img> inline", async () => {
    const { v } = await view();
    const chem = laid(v, "#chem")!;
    const runs = chem.text!.runs!;
    const sub = runs.find((r) => r.owner === comp(v, "#two"))!;
    const sup = runs.find((r) => r.owner === comp(v, "#sq"))!;
    expect(sub.shift).toBeLessThan(0);
    expect(sup.shift).toBeGreaterThan(0);
    expect(sub.fontSize).toBeCloseTo(16 * 0.83, 1);
    expect(runs.some((r) => r.text === "\n")).toBe(true);
    expect(chem.inline!.lines).toHaveLength(2);
    expect(runs.find((r) => r.owner === comp(v, "#code"))!.fontFamily).toMatch(/monospace/);
    expect(runs.find((r) => r.owner === comp(v, "#mark"))).toMatchObject({ background: "rgba(255, 255, 0, 1)", color: "rgba(0, 0, 0, 1)" });
    const img = runs.find((r) => r.owner === comp(v, "#pic"))!;
    expect(img.image).toMatchObject({ width: 12, height: 12 });
    expect(comp(v, "#pic")).toBeInstanceOf(UIImage);
  });

  it("sends a click on a link's run to the run, bubbling through the link", async () => {
    const { v, log } = await view();
    const em = comp(v, "#em");
    const r = pointer!.core.rectOf(em)!;
    expect(r.width).toBeGreaterThan(0);
    expect(pointer!.core.hitTest(r.x + r.width / 2, r.y + r.height / 2)).toBe(em);
    pointer!.dom.moveTo(r.x + r.width / 2, r.y + r.height / 2);
    pointer!.dom.click();
    engine.step(DT);
    expect(log).toEqual(["click em on link #x"]);
  });
});

describe("UIView: {@html} (ADR 0429)", () => {
  it("parses inline HTML into runs of the text it's in, and follows the value", async () => {
    const { v } = await view();
    expect(runTexts(laid(v, "#html"))).toEqual(["Hi ", "there"]);
    expect(laid(v, "#html")!.text!.runs![1].fontWeight).toBe("700");
    v.props.html = "<i>new</i> text &amp; more";
    engine.step(DT);
    pointer!.sync();
    expect(runTexts(laid(v, "#html"))).toEqual(["new", " text & more"]);
    expect(laid(v, "#html")!.text!.runs![0].fontStyle).toBe("italic");
  });

  it("makes block elements panels, and drops scripts and event attributes", async () => {
    const { v } = await view();
    const box = v.query("#htmlblock .box");
    expect(box).not.toBeNull();
    expect(box!.component.constructor.name).toBe("UIPanel");
    expect(runTexts(laid(v, "#htmlblock .box p"))).toEqual(["block ", "x"]);
    // The script is gone; the span keeps its text but not its handler.
    expect(v.query("#htmlblock")!.children.map((c) => c.tag)).toEqual(["div", "span"]);
    const span = v.query("#htmlblock span")!;
    expect(span.attributes.has("onclick")).toBe(false);
    expect((span.component as UIText).text).toBe("ok");
  });
});

describe("UIView: contenteditable (ADR 0429)", () => {
  it("edits a text from a press and typing, with input events and bind:textContent", async () => {
    const fake = stubDocument();
    const { v } = await view();
    expect((comp(v, "#edit") as UIText).contentEditable).toBe(true);
    expect((comp(v, "#edit") as UIText).text).toBe("Edit me");
    const r = pointer!.core.rectOf(comp(v, "#edit"))!;
    pointer!.dom.moveTo(r.x + r.width - 1, r.y + r.height / 2);
    pointer!.dom.click();
    engine.step(DT);
    pointer!.sync();
    // Being edited: the hidden text area holds its text, and the caret shows.
    expect(fake.value).toBe("Edit me");
    expect(laid(v, "#edit")!.editing?.caret).not.toBeNull();
    fake.typeText("Edit me!");
    engine.step(DT);
    expect((comp(v, "#plain") as UIText).text).toBe("Edit me!");
  });

  it("keeps the runs' styles while editing them, read back by bind:innerHTML", async () => {
    const fake = stubDocument();
    const { v } = await view();
    expect(runTexts(laid(v, "#richedit"))).toEqual(["a ", "b"]);
    const r = pointer!.core.rectOf(comp(v, "#richedit"))!;
    pointer!.dom.moveTo(r.x + r.width - 1, r.y + r.height / 2);
    pointer!.dom.click();
    engine.step(DT);
    pointer!.sync();
    expect(fake.value).toBe("a b");
    fake.typeText("a bc");
    engine.step(DT);
    expect((comp(v, "#rich") as UIText).text).toBe("a <i>bc</i>");
    pointer!.sync();
    expect(runTexts(laid(v, "#richedit"))).toEqual(["a ", "bc"]);
  });
});
