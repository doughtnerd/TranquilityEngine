// ADR 0437: the UI core resolves each box element's paint (fill, border colour and widths, corner radii) from its fields
// and its interaction state, and reports it on `UILaidOutElement.paint`. The Unity-style state colours (`hoverColor`,
// `pressedColor`, `focusColor`) are inputs; where an element's own style rules state a state's look (`:hover`,
// `:pressed`, `:focus`), the style's restyled (and transitioned) value is what's reported. Tested through the reported
// elements of a real UI core that routes the pointer (`UIPointer`), as the drawing layer reads them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Color, Engine, Input } from "../index";
import { UIButton, UICanvas, UIInputField, UIPanel, UIText, type UIComponentType } from "../ui/components";
import type { UIPaint } from "../ui/uiCoreTypes";
import { buildUI, byId, loadUITestSupport, uiElement } from "./uiMarkup";
import { UIPointer } from "./uiPointer";

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  Input.inject.releaseAll();
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Assets.clearSources();
});

const node = uiElement;
const css = (c: Color) => [c.r, c.g, c.b, c.a];

async function core(): Promise<UIPointer> {
  pointer = await UIPointer.create(World.require());
  pointer.leave(); // off every element until a test moves it
  return pointer;
}

/** A frame: the World steps (routing the pointer, restyling), then the core lays out and resolves paint, as the renderer does. */
function frame(p: UIPointer, seconds = DT): void {
  engine.step(seconds);
  p.sync();
}

function paintOf(p: UIPointer, c: UIComponentType): UIPaint {
  const el = p.core.elements().find((e) => e.comp === c);
  if (!el?.paint) throw new Error(`"${c.owner.name}" has no reported paint.`);
  return el.paint;
}

const fillOf = (p: UIPointer, c: UIComponentType) => paintOf(p, c).background;

describe("resolved paint: Unity-style state colours (ADR 0437, 0069, 0340)", () => {
  it("fills a button with its hover and pressed colours, the plain colour once a press leaves it or it isn't interactable", async () => {
    const canvas = node("C", null, UICanvas);
    const grey = new Color(0.2, 0.2, 0.2, 1);
    const button = node("B", canvas.node, UIButton, { backgroundColor: grey, hoverColor: new Color(0, 1, 0, 1), pressedColor: new Color(0, 0, 1, 1), width: "100", height: "40" });
    const p = await core();
    expect(fillOf(p, button)).toEqual(css(grey));
    p.hover(button);
    frame(p);
    expect(fillOf(p, button)).toEqual([0, 1, 0, 1]);
    p.dom.pointerDown(0);
    frame(p);
    expect(fillOf(p, button)).toEqual([0, 0, 1, 1]);
    p.leave(); // pressed, but the pointer left: the plain colour
    frame(p);
    expect(button.pressed).toBe(true);
    expect(fillOf(p, button)).toEqual(css(grey));
    p.hover(button);
    button.interactable = false;
    frame(p);
    expect(fillOf(p, button)).toEqual(css(grey));
  });

  it("shows focus colours only while the last UI input was navigation: a button's fill, a field's border", async () => {
    const canvas = node("C", null, UICanvas);
    const grey = new Color(0.2, 0.2, 0.2, 1);
    const at = (top: string) => ({ width: "100", height: "40", positionType: "absolute" as const, left: "0", top });
    const first = node("First", canvas.node, UIButton, { backgroundColor: grey, hoverColor: new Color(0, 1, 0, 1), focusColor: new Color(1, 0, 0, 1), ...at("0") });
    const second = node("Second", canvas.node, UIButton, { backgroundColor: grey, hoverColor: new Color(0, 1, 0, 1), focusColor: new Color(1, 0, 0, 1), ...at("100") });
    const field = node("Field", canvas.node, UIInputField, { borderColor: new Color(1, 1, 1, 1), focusColor: new Color(0, 0, 1, 1), ...at("200") });
    const p = await core();
    const press = (key: string) => {
      Input.inject.keyDown(key);
      frame(p);
      Input.inject.keyUp(key);
      frame(p);
    };
    p.leave();
    first.focused = true; // a script's focus: no navigation yet, no colour
    frame(p);
    expect(fillOf(p, first)).toEqual(css(grey));
    press("arrowdown");
    expect(second.focused).toBe(true);
    expect(fillOf(p, second)).toEqual([1, 0, 0, 1]);
    expect(fillOf(p, first)).toEqual(css(grey));
    press("arrowdown");
    expect(field.focused).toBe(true);
    expect(paintOf(p, field).borderColor).toEqual([0, 0, 1, 1]);
    expect(fillOf(p, second)).toEqual(css(grey));
    p.dom.moveTo(600, 600); // the pointer moves (over nothing): it's the last UI input now
    frame(p);
    expect(field.focused).toBe(true);
    expect(paintOf(p, field).borderColor).toEqual([1, 1, 1, 1]);
    p.click(second); // focused by a click: hovered, never the focus colour
    frame(p);
    p.leave();
    frame(p);
    expect(second.focused).toBe(true);
    expect(fillOf(p, second)).toEqual(css(grey));
  });
});

describe("resolved paint: the style's own state rules (ADR 0437)", () => {
  it("draws a stylesheet's :hover and :pressed backgrounds, not the Unity-style colours, and the plain one after", async () => {
    const ui = buildUI(`<Canvas><button id="b" width="100" height="40"/></Canvas>`, {
      css: `#b { background-color: #333333 } #b:hover { background-color: #00ff00 } #b:pressed { background-color: #0000ff }`,
    });
    const b = byId(ui, "b", UIButton);
    const p = await core();
    frame(p);
    expect(fillOf(p, b)).toEqual(css(Color.from("#333333")));
    p.hover(b);
    frame(p);
    expect(fillOf(p, b)).toEqual([0, 1, 0, 1]);
    p.dom.pointerDown(0);
    frame(p);
    expect(fillOf(p, b)).toEqual([0, 0, 1, 1]);
    p.dom.pointerUp(0); // released over it: hovered again
    frame(p);
    expect(fillOf(p, b)).toEqual([0, 1, 0, 1]);
    p.leave();
    frame(p);
    expect(fillOf(p, b)).toEqual(css(Color.from("#333333")));
    // The Unity-style colours are untouched: they're the fallback, not where the style's state looks go.
    expect(b.hoverColor).toEqual(new UIButton().hoverColor);
  });

  it("shows a :hover background while pressed when no :pressed rule says otherwise", async () => {
    const ui = buildUI(`<Canvas><button id="b" width="100" height="40"/></Canvas>`, { css: `button:hover { background-color: #00ff00 }` });
    const b = byId(ui, "b", UIButton);
    const p = await core();
    p.hover(b);
    p.dom.pointerDown(0);
    frame(p);
    expect(b.pressed && b.hovered).toBe(true);
    expect(fillOf(p, b)).toEqual([0, 1, 0, 1]);
  });

  it("keeps the Unity-style colours for the states the style doesn't state", async () => {
    const ui = buildUI(`<Canvas><button id="b" width="100" height="40" hover-color="#ff00ff"/></Canvas>`, { css: `#b { background-color: #333333 }` });
    const b = byId(ui, "b", UIButton);
    const p = await core();
    p.hover(b);
    frame(p);
    expect(fillOf(p, b)).toEqual([1, 0, 1, 1]);
  });

  it("draws a :hover background's transition as it runs", async () => {
    const ui = buildUI(`<Canvas><button id="b" width="100" height="40"/></Canvas>`, {
      css: `#b { background-color: #000000; transition: background-color 1s linear } #b:hover { background-color: #ffffff }`,
    });
    const b = byId(ui, "b", UIButton);
    const p = await core();
    frame(p);
    p.hover(b);
    frame(p); // hovered and restyled: the transition starts
    frame(p, 0.5);
    const [r, g, bl] = fillOf(p, b)!;
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.8);
    expect([g, bl]).toEqual([r, r]);
    for (let i = 0; i < 8; i++) frame(p, 0.25);
    expect(fillOf(p, b)).toEqual([1, 1, 1, 1]);
  });

  it("draws a :focus rule's fill and border while navigating, over focusColor", async () => {
    const ui = buildUI(`<Canvas><div flex-direction="column"><button id="a" width="100" height="40"/><input id="f" width="100" height="40" border-width="2"/></div></Canvas>`, {
      css: `#a:focus { background-color: #ff0000 } #f { border-color: #ffffff } #f:focus { border-color: #00ff00 }`,
    });
    const a = byId(ui, "a", UIButton);
    const f = byId(ui, "f", UIInputField);
    const p = await core();
    const press = (key: string) => {
      Input.inject.keyDown(key);
      frame(p);
      Input.inject.keyUp(key);
      frame(p);
    };
    p.leave();
    a.focused = true;
    frame(p);
    press("arrowdown");
    expect(f.focused).toBe(true);
    expect(paintOf(p, f).borderColor).toEqual([0, 1, 0, 1]);
    press("arrowup");
    expect(a.focused).toBe(true);
    expect(fillOf(p, a)).toEqual([1, 0, 0, 1]);
    expect(paintOf(p, f).borderColor).toEqual([1, 1, 1, 1]);
  });
});

describe("resolved paint: borders and corners (ADR 0437, 0422, 0432)", () => {
  it("resolves each corner's radius, -1 taking borderRadius, and each side's border width", async () => {
    const canvas = node("C", null, UICanvas);
    const panel = node("P", canvas.node, UIPanel, { width: "100", height: "40", borderRadius: 5, borderTopLeftRadius: 1, borderTopRightRadius: 2, borderBottomRightRadius: 3, borderWidth: 2, borderLeftWidth: 6, borderColor: new Color(0, 1, 0, 1) });
    const p = await core();
    expect(paintOf(p, panel)).toEqual({ background: null, borderColor: [0, 1, 0, 1], borderWidths: [2, 2, 2, 6], radii: [1, 2, 3, 5] });
    panel.borderTopLeftRadius = panel.borderTopRightRadius = panel.borderBottomRightRadius = -1;
    panel.borderRadius = 8;
    p.sync();
    expect(paintOf(p, panel).radii).toEqual([8, 8, 8, 8]);
  });

  it("paints a text's box with one radius, and leaves a transparent fill out", async () => {
    const canvas = node("C", null, UICanvas);
    const text = node("T", canvas.node, UIText, { text: "Hi", backgroundColor: new Color(1, 0, 0, 0), borderWidth: 1, borderRadius: 4 });
    const p = await core();
    expect(paintOf(p, text)).toMatchObject({ background: null, borderWidths: [1, 1, 1, 1], radii: [4, 4, 4, 4] });
  });

  it("reports the same paint object while nothing changes, and a new one (and layout version) when the state does", async () => {
    const canvas = node("C", null, UICanvas);
    const button = node("B", canvas.node, UIButton, { width: "100", height: "40" });
    const p = await core();
    const before = paintOf(p, button);
    const version = p.core.layoutVersion;
    frame(p);
    expect(paintOf(p, button)).toBe(before);
    expect(p.core.layoutVersion).toBe(version);
    p.hover(button);
    frame(p);
    expect(paintOf(p, button)).not.toBe(before);
    expect(p.core.layoutVersion).toBeGreaterThan(version);
  });
});
