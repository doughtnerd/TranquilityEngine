import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, Input, PenState, TouchState, Vector2 } from "../index";
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

  it("reads a click that waited in the queue where it happened, not where the pointer has moved since", () => {
    const dom = DomInput.attach();
    // Two clicks in one long frame: the second waits (one press per button per frame, then a frame up, ADR 0336).
    dom.click(0, 30, 40);
    dom.click(0, 200, 90);
    engine.step(DT);
    expect(Input.getMouseButtonUp(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(30, 40));
    engine.step(DT); // the button reads up
    expect(Input.mousePosition).toEqual(new Vector2(200, 90));
    engine.step(DT);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(200, 90));
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
    dom.retarget(second); // attaching again replaces, never adds
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

// ADR 0335: fingers and the pen are devices of their own, mirrored as the World's Touchscreen and
// Pen nodes; the primary finger and the pen are also the pointer.
describe("touch and pen through the DOM adapter", () => {
  const touchscreen = () => engine.world.root.find("Input/Touchscreen")?.getData(TouchState);
  const pen = () => engine.world.root.find("Input/Pen")?.getData(PenState);
  const PRIMARY = 1 << 10;

  it("reports fingers by pointer id in slots; the first finger is primary and is the pointer", () => {
    const dom = DomInput.attach(new FakeCanvas(10, 20));
    engine.step(DT);
    expect(touchscreen()).toBeUndefined(); // no touchscreen until a finger touches
    dom.touchStart(5, 30, 40);
    dom.touchStart(8, 300, 200);
    engine.step(DT);
    let t = touchscreen()!;
    expect([t.held, t.down, t.count]).toEqual([0b11 | PRIMARY, 0b11 | PRIMARY, 2]);
    expect([t.x0, t.y0, t.x1, t.y1, t.primaryX, t.primaryY]).toEqual([30, 40, 300, 200, 30, 40]);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(30, 40)); // the second finger isn't the pointer

    dom.touchMove(8, 320, 200);
    dom.touchMove(5, 34, 37);
    engine.step(DT);
    t = touchscreen()!;
    expect([t.down, t.primaryDeltaX, t.primaryDeltaY, t.x1]).toEqual([0, 4, -3, 320]);
    expect(Input.mouseDelta).toEqual(new Vector2(4, -3));

    dom.touchEnd(5); // the primary lifts: no primary until every finger has
    engine.step(DT);
    t = touchscreen()!;
    expect([t.held, t.up, t.count]).toEqual([0b10, 0b1 | PRIMARY, 1]);
    expect(Input.getMouseButtonUp(0)).toBe(true);
    dom.touchStart(6, 50, 50); // slot 0 is free again, but this finger isn't primary
    engine.step(DT);
    t = touchscreen()!;
    expect([t.held, t.down, t.x0]).toEqual([0b11, 0b1, 50]);
    expect(Input.getMouseButton(0)).toBe(false);

    dom.touchEnd(8, true); // cancelled by the browser
    dom.touchEnd(6);
    engine.step(DT);
    expect([touchscreen()!.held, touchscreen()!.up]).toEqual([0, 0b11]);
  });

  it("taps in one frame: down and up, pressed that frame", () => {
    const dom = DomInput.attach();
    dom.touchStart(1, 10, 10);
    dom.touchEnd(1);
    engine.step(DT);
    const t = touchscreen()!;
    expect([t.held, t.down, t.up]).toEqual([0, 1 | PRIMARY, 1 | PRIMARY]);
    engine.step(DT);
    expect([touchscreen()!.down, touchscreen()!.up]).toEqual([0, 0]);
  });

  it("measures a pinch between the two lowest-slot fingers", () => {
    const dom = DomInput.attach();
    dom.touchStart(1, 100, 100);
    dom.touchStart(2, 200, 100);
    engine.step(DT);
    expect(touchscreen()!.pinch).toBe(0); // a new pair
    dom.touchMove(2, 250, 100);
    engine.step(DT);
    expect(touchscreen()!.pinch).toBe(50);
    engine.step(DT);
    expect(touchscreen()!.pinch).toBe(0);
    dom.touchMove(1, 130, 100);
    engine.step(DT);
    expect(touchscreen()!.pinch).toBe(-30);
  });

  it("lifts every finger when the window loses focus", () => {
    const dom = DomInput.attach();
    dom.touchStart(1, 10, 10);
    dom.touchStart(2, 20, 10);
    engine.step(DT);
    dom.blur();
    engine.step(DT);
    expect([touchscreen()!.held, touchscreen()!.up]).toEqual([0, 0b11 | PRIMARY]);
    expect(Input.getMouseButtonUp(0)).toBe(true);
  });

  it("reports the pen's position, pressure, tilt, twist and buttons; it is the pointer too", () => {
    const dom = DomInput.attach();
    dom.pen("pointermove", 40, 50); // hovering
    engine.step(DT);
    let p = pen()!;
    expect([p.inRange, p.held, p.pressure, p.x, p.y]).toEqual([1, 0, 0, 40, 50]);

    dom.pen("pointerdown", 42, 50, { pressure: 0.75, tiltX: 45, tiltY: -45, twist: 90 });
    engine.step(DT);
    p = pen()!;
    expect([p.held, p.down, p.pressure, p.tiltX, p.tiltY, p.twist, p.deltaX]).toEqual([1, 1, 0.75, 0.5, -0.5, 0.25, 2]);
    expect(Input.getMouseButtonDown(0)).toBe(true);

    dom.pen("pointermove", 42, 55, { buttons: 3, pressure: 0.5 }); // the barrel button, chorded
    engine.step(DT);
    p = pen()!;
    expect([p.held, p.down, p.deltaY]).toEqual([3, 2, 5]);

    dom.pen("pointerup", 42, 55);
    engine.step(DT);
    p = pen()!;
    expect([p.held, p.up, p.pressure]).toEqual([0, 3, 0]);
    expect(Input.getMouseButtonUp(0)).toBe(true);

    dom.penLeave();
    engine.step(DT);
    expect(pen()!.inRange).toBe(0);
  });

  it("removes the cancel and leave listeners with the rest", () => {
    const dom = DomInput.attach();
    expect(dom.window.listening.get("pointercancel")).toBe(1);
    expect(dom.canvas.listening.get("pointerleave")).toBe(1);
    dom.detach();
    expect(dom.canvas.listeners).toBe(0);
    expect(dom.window.listeners).toBe(0);
  });
});
