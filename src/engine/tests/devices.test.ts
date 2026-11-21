import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, Input, Vector2 } from "../index";
import { DomInput, FakeCanvas } from "./domInput";

// ADR 0310: keyboard, mouse and wheel reach `Input` through the DOM adapter and the device snapshot,
// once per Engine frame (ADR 0011 step 2).

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  engine.dispose();
  Input.reset();
});

describe("device input through the DOM adapter", () => {
  it("snapshots keys once per frame: down, held, up", () => {
    const dom = DomInput.attach();
    dom.keyDown("W");
    expect(Input.getKey("w")).toBe(false); // not until the next snapshot
    engine.step(DT);
    expect(Input.getKeyDown("w")).toBe(true);
    expect(Input.getKey("w")).toBe(true);
    expect(Input.anyKeyDown).toBe(true);
    engine.step(DT);
    expect(Input.getKeyDown("w")).toBe(false);
    expect(Input.getKey("w")).toBe(true);
    dom.keyUp("w");
    engine.step(DT);
    expect(Input.getKeyUp("w")).toBe(true);
    expect(Input.getKey("w")).toBe(false);
  });

  it("names Space, Escape and Enter by friendly names, and keeps Space from scrolling the page", () => {
    const dom = DomInput.attach();
    const space = dom.keyDown(" ");
    dom.keyDown("Esc");
    dom.keyDown("Return");
    engine.step(DT);
    expect(space.defaultPrevented).toBe(true);
    expect(Input.getKeyDown("space")).toBe(true);
    expect(Input.getKeyDown(" ")).toBe(true);
    expect(Input.getKeyDown("escape")).toBe(true);
    expect(Input.getKeyDown("enter")).toBe(true);
  });

  it("reports a press and release in one frame as down and up, never held after", () => {
    const dom = DomInput.attach();
    dom.tap("a");
    engine.step(DT);
    expect(Input.getKeyDown("a")).toBe(true);
    expect(Input.getKeyUp("a")).toBe(true);
    engine.step(DT);
    expect(Input.getKey("a")).toBe(false);
  });

  it("gives the pointer in canvas pixels, its movement and the wheel per frame", () => {
    const dom = DomInput.attach(new FakeCanvas(10, 20));
    dom.moveTo(100, 40);
    dom.move(5, -2);
    const wheel = dom.scroll(0, 3, 1); // three lines
    engine.step(DT);
    expect(Input.mousePosition).toEqual(new Vector2(105, 38));
    expect(Input.mouseDelta).toEqual(new Vector2(105, 38));
    expect(Input.mouseScrollDelta).toEqual(new Vector2(0, 48));
    expect(wheel.defaultPrevented).toBe(true);
    engine.step(DT);
    expect(Input.mouseDelta).toEqual(new Vector2(0, 0));
    expect(Input.mouseScrollDelta).toEqual(new Vector2(0, 0));
  });

  it("reads mouse buttons as keys", () => {
    const dom = DomInput.attach();
    dom.pointerDown(2, 30, 40);
    engine.step(DT);
    expect(Input.getMouseButtonDown(2)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(30, 40));
    dom.pointerUp(2);
    engine.step(DT);
    expect(Input.getMouseButtonUp(2)).toBe(true);
    expect(Input.getMouseButton(2)).toBe(false);
  });

  it("releases every held key when the window loses focus", () => {
    const dom = DomInput.attach();
    dom.keyDown("d");
    dom.pointerDown(0);
    engine.step(DT);
    dom.blur();
    engine.step(DT);
    expect(Input.getKeyUp("d")).toBe(true);
    expect(Input.getMouseButtonUp(0)).toBe(true);
    expect(Input.getKey("d")).toBe(false);
  });

  it("removes every listener it added, the context menu's too, on retarget and detach", () => {
    const dom = DomInput.attach();
    const first = dom.canvas;
    expect(dom.contextMenu().defaultPrevented).toBe(true);
    const second = dom.retarget();
    expect(first.listeners).toBe(0);
    expect(dom.contextMenu().defaultPrevented).toBe(true);
    Input.attach(second as unknown as HTMLCanvasElement); // attaching again replaces, never adds
    expect(second.listening.get("contextmenu")).toBe(1);
    dom.detach();
    expect(second.listeners).toBe(0);
    expect(dom.window.listeners).toBe(0);
  });

  it("keeps held keys across a retarget: it's the same keyboard", () => {
    const dom = DomInput.attach();
    dom.keyDown("shift");
    engine.step(DT);
    dom.retarget();
    engine.step(DT);
    expect(Input.getKey("shift")).toBe(true);
  });
});
