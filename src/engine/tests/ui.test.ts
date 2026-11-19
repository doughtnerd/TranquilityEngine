import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine, GameObject, Input, Vector2, getComponentClass, getFields } from "../index";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UILength } from "../ui/components";
import { World } from "../core/World";

// ADR 0069: UI components in a headless World, and Input without UI. Layout, pointer routing and
// editor picking are tested on the renderer-neutral core (uiCore.test.ts, ADR 0076) and on Babylon
// (babylonUI.test.ts); the three.js runtime was removed with its backend (ADR 0081).

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

function world(): World {
  return World.require();
}

function node<T extends UIPanel | UIText | UIImage | UICanvas>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  const n = GameObject.create(name, { parent });
  return n.addBehavior(type as never, init as never) as T;
}

/** A 1280×720 screen canvas with a column of fixed-size buttons. */
function menu() {
  const canvas = node("Canvas", null, UICanvas);
  const column = node("Menu", canvas.node, UIPanel, { flexDirection: "column", padding: 20, gap: 10, width: "100%", height: "100%" } as Partial<UIPanel>);
  const play = node("Play", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  const quit = node("Quit", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  return { canvas, column, play, quit };
}

describe("UI components (ADR 0069)", () => {
  it("register with stable ids and declare their fields", () => {
    expect(getComponentClass("engine.UICanvas")).toBe(UICanvas);
    expect(getComponentClass("engine.UIPanel")).toBe(UIPanel);
    expect(getComponentClass("engine.UIText")).toBe(UIText);
    expect(getComponentClass("engine.UIImage")).toBe(UIImage);
    expect(getComponentClass("engine.UIButton")).toBe(UIButton);
    expect(getComponentClass("engine.UIInputField")).toBe(UIInputField);
    const button = getFields(UIButton).map((f) => f.name);
    for (const name of ["flexDirection", "justifyContent", "alignItems", "gap", "padding", "margin", "width", "height", "positionType", "top", "right", "bottom", "left", "flexGrow", "backgroundColor", "borderRadius", "borderWidth", "borderColor", "opacity", "visible", "display", "hoverColor", "pressedColor", "interactable"]) {
      expect(button).toContain(name);
    }
    expect(getFields(UICanvas).map((f) => f.name)).toEqual(["mode", "referenceResolution", "matchHeight", "sortOrder", "pixelSize"]);
    expect(getFields(UIInputField).map((f) => f.name)).toEqual(expect.arrayContaining(["value", "placeholder", "maxLength"]));
  });

  it("hold data in a headless World without building anything: with no UI core, nothing clicks or submits", () => {
    const { play } = menu();
    const field = node("Name", null, UIInputField, { placeholder: "Your name" } as Partial<UIInputField>);
    expect(world().render).toBeNull();
    engine.step(DT);
    // A press and release where Play would be laid out (uiCore.test.ts clicks it with a core).
    Input.simulatePointer(100, 40);
    Input.simulate("down", "mouse0");
    Input.simulate("up", "mouse0");
    engine.step(DT);
    expect(play.hovered).toBe(false);
    expect(play.clicked).toBe(false);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true); // the game gets the press: no UI claimed it
    engine.step(DT);
    expect(play.clicked).toBe(false);

    field.focused = true;
    expect(field.focused).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);
    expect(Input.keyboardOverUI).toBe(false); // no core routes, so no field claims the keyboard
  });
});

describe("Input without UI (ADR 0069 keeps the old behaviour)", () => {
  it("reports presses, holds and releases as before when nothing claims them", () => {
    Input.simulatePointer(10, 10);
    Input.simulate("down", "mouse0");
    Input.beginFrame();
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(10, 10));
    Input.simulate("up", "mouse0");
    Input.beginFrame();
    expect(Input.getMouseButtonUp(0)).toBe(true);
  });
});

describe("UI colours", () => {
  it("panel colours are plain Color fields", () => {
    const { play } = menu();
    play.backgroundColor = new Color(1, 0, 0, 0.5);
    expect(play.backgroundColor.a).toBe(0.5);
  });
});
