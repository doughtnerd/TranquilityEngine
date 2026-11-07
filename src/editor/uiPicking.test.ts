import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Color, Engine, GameObject, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../engine";
import { isPaintedUI, orderClickHits, partitionUIHits } from "./uiPicking";

let engine: Engine;
beforeEach(async () => {
  engine = await Engine.create({ headless: true });
});
afterEach(() => engine.dispose());

const make = <T extends UIPanel | UIText | UIImage | UICanvas | UIInputField | UIButton>(type: new () => T, init: Partial<T> = {}): T => GameObject.create("n").addBehavior(type as never, init as never) as T;

describe("isPaintedUI", () => {
  it("is false for a canvas and a transparent panel, true for a fill or a border", () => {
    expect(isPaintedUI(make(UICanvas))).toBe(false);
    expect(isPaintedUI(make(UIPanel))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: new Color(1, 0, 0, 0) }))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: new Color(1, 0, 0, 0.5) }))).toBe(true);
    expect(isPaintedUI(make(UIPanel, { borderWidth: 2, borderColor: Color.white }))).toBe(true);
    expect(isPaintedUI(make(UIPanel, { borderWidth: 0, borderColor: Color.white }))).toBe(false);
    expect(isPaintedUI(make(UIPanel, { backgroundColor: Color.white, opacity: 0 }))).toBe(false);
  });
  it("counts text, images, buttons and filled input fields", () => {
    expect(isPaintedUI(make(UIText))).toBe(false);
    expect(isPaintedUI(make(UIText, { text: "  " }))).toBe(false);
    expect(isPaintedUI(make(UIText, { text: "Play" }))).toBe(true);
    expect(isPaintedUI(make(UIImage))).toBe(false);
    expect(isPaintedUI(make(UIImage, { image: "a.png" }))).toBe(true);
    expect(isPaintedUI(make(UIButton))).toBe(true); // buttons have a default fill
    expect(isPaintedUI(make(UIInputField))).toBe(true);
    expect(isPaintedUI(make(UIInputField, { backgroundColor: null, placeholder: "Name" }))).toBe(true);
    expect(isPaintedUI(make(UIInputField, { backgroundColor: null, borderWidth: 0 }))).toBe(false);
  });
});

describe("click ordering", () => {
  it("splits hits keeping order and puts painted UI before the scene and bare UI after", () => {
    const bare = make(UIPanel), a = make(UIText, { text: "a" }), b = make(UIPanel, { backgroundColor: Color.white });
    expect(partitionUIHits([a, bare, b])).toEqual({ painted: [a, b], bare: [bare] });
    expect(orderClickHits(["ui:a", "ui:b"], ["mesh", "ui:a"], ["ui:bare", "mesh"])).toEqual(["ui:a", "ui:b", "mesh", "ui:bare"]);
  });
});
