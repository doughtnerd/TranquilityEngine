import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine } from "../index";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "../ui/components";
import { UI_TAGS, cssFontWeight, isInteractiveKind, isLeafKind, isPaintedUI, textRunOf, uiKindOf, uiPseudoState, uiTypeOfTag } from "../ui/elementKinds";
import { UI_FONT_FAMILY } from "../ui/fonts";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { uiElement } from "./uiMarkup";

// ADR 0271: the UI element kinds and the resolved text run.

let engine: Engine;
beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
});
afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

const make = <T extends UIComponentType>(type: new () => T, init: Partial<T> = {}): T => uiElement("n", null, type, init);

describe("UI element kinds", () => {
  it("names each component's kind, subclasses first", () => {
    expect([UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField].map((t) => uiKindOf(make(t as new () => UIComponentType)))).toEqual(["canvas", "panel", "text", "image", "button", "input"]);
  });

  it("maps every markup tag to its component type", () => {
    expect([...UI_TAGS].sort()).toEqual(["Audio", "Button", "Canvas", "Form", "Image", "InputField", "Label", "Meter", "Option", "Panel", "Progress", "Radio", "Select", "Slider", "Svg", "Text", "TextArea", "Toggle", "Video"]);
    expect(uiTypeOfTag("InputField")).toBe(UIInputField);
    expect(uiTypeOfTag("Button")).toBe(UIButton);
  });

  it("says which kinds are leaves and which take the pointer", () => {
    expect((["canvas", "panel", "text", "image", "button", "input"] as const).filter(isLeafKind)).toEqual(["text", "image", "input"]);
    expect((["canvas", "panel", "text", "image", "button", "input"] as const).filter(isInteractiveKind)).toEqual(["button", "input"]);
  });

  it("gives each kind's pseudo-classes", () => {
    const button = make(UIButton);
    const none = { checked: false, indeterminate: false, "placeholder-shown": false };
    expect(uiPseudoState(button)).toEqual({ hover: false, pressed: false, focus: false, disabled: false, ...none });
    button.focused = true; // ADR 0340 focus: `button:focus` matches
    expect(uiPseudoState(button)).toMatchObject({ focus: true });
    button.focused = false;
    button.interactable = false;
    expect(uiPseudoState(button)).toMatchObject({ disabled: true });
    const field = make(UIInputField);
    field.focused = true;
    expect(uiPseudoState(field)).toEqual({ hover: false, pressed: false, focus: true, disabled: false, ...none });
    const text = make(UIText);
    text.enabled = false;
    expect(uiPseudoState(text)).toEqual({ hover: false, pressed: false, focus: false, disabled: true, ...none });
  });

  it("paints by each kind's rule (the editor's UI picking reads it): nothing for a canvas or a transparent panel, a fill or a border", () => {
    expect(isPaintedUI(make(UICanvas))).toBe(false);
    expect(isPaintedUI(make(UIPanel))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: new Color(1, 0, 0, 0) }))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: new Color(1, 0, 0, 0.5) }))).toBe(true);
    expect(isPaintedUI(make(UIPanel, { borderWidth: 2, borderColor: Color.white }))).toBe(true);
    expect(isPaintedUI(make(UIPanel, { borderWidth: 0, borderColor: Color.white }))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: Color.white, opacity: 0 }))).toBe(false);
  });

  it("paints text, images, buttons and filled input fields", () => {
    expect(isPaintedUI(make(UIText))).toBe(false);
    expect(isPaintedUI(make(UIText, { text: "  " }))).toBe(false);
    expect(isPaintedUI(make(UIText, { text: "Play" }))).toBe(true);
    expect(isPaintedUI(make(UIText, { text: "Play", opacity: 0 }))).toBe(false);
    expect(isPaintedUI(make(UIImage))).toBe(false);
    expect(isPaintedUI(make(UIImage, { image: "a.png" }))).toBe(true);
    expect(isPaintedUI(make(UIButton))).toBe(true); // buttons have a default fill
    expect(isPaintedUI(make(UIInputField))).toBe(true);
    expect(isPaintedUI(make(UIInputField, { backgroundColor: null, placeholder: "Name" }))).toBe(true);
    expect(isPaintedUI(make(UIInputField, { backgroundColor: null, borderWidth: 0 }))).toBe(false);
  });
});

describe("text runs", () => {
  it("resolves a UIText's text, size, CSS weight, family, line height and wrapping", () => {
    const text = make(UIText, { text: "Hello", fontSize: 20, fontWeight: "semi-bold", wordBreak: "break-all" });
    expect(textRunOf(text)).toEqual({ text: "Hello", fontSize: 20, fontWeight: "600", fontFamily: UI_FONT_FAMILY, lineHeight: 1.2, wrap: "anywhere", direction: "ltr", align: "left" });
    text.wordBreak = "keep-all";
    expect(textRunOf(text)!.wrap).toBe("none");
    text.wordBreak = "break-word";
    expect(textRunOf(text)!.wrap).toBe("word");
    text.font = "fonts/a.woff2";
    expect(textRunOf(text)!.fontFamily).toBe(`myco-font-fonts-a-woff2, ${UI_FONT_FAMILY}`);
  });

  it("resolves an input field's value, or its placeholder while empty, on one line at weight 400", () => {
    const field = make(UIInputField, { placeholder: "Name", fontSize: 14 });
    expect(textRunOf(field)).toEqual({ text: "Name", fontSize: 14, fontWeight: "400", fontFamily: UI_FONT_FAMILY, lineHeight: 1.2, wrap: "none", direction: "ltr", align: "left" });
    field.value = "a\nb\r\nc";
    expect(textRunOf(field)!.text).toBe("a b  c"); // one space per line-break character, so caret indices still match
  });

  it("has no run for kinds without text", () => {
    expect(textRunOf(make(UIPanel))).toBeNull();
    expect(textRunOf(make(UIButton))).toBeNull();
    expect(textRunOf(make(UIImage))).toBeNull();
    expect(textRunOf(make(UICanvas))).toBeNull();
  });

  it("takes the named weights or a whole number from 1 to 1000; anything else is 400", () => {
    const names = ["light", "normal", "medium", "semi-bold", "bold"].map(cssFontWeight);
    expect(names).toEqual(["300", "400", "500", "600", "700"]);
    expect(["350", "650", "1", "1000", "0100"].map(cssFontWeight)).toEqual(["350", "650", "1", "1000", "100"]);
    expect(["0", "1001", "odd", "", "350.5", "-100", "Bold"].map(cssFontWeight)).toEqual(["400", "400", "400", "400", "400", "400", "400"]);
  });
});
