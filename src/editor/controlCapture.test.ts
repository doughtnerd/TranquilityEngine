// "Press to bind" (ADR 0336): presses named as the engine names controls.
import { describe, expect, it } from "vitest";
import { canonicalControlPath } from "../engine/editor";
import { keyControl, pointerControl, pointerPressControl, pressControl } from "./controlCapture";

describe("press to bind", () => {
  it("names keys as control paths, with Escape cancelling", () => {
    expect(keyControl(" ")).toBe("<Keyboard>/space");
    expect(keyControl("A")).toBe("<Keyboard>/a");
    expect(keyControl("ArrowLeft")).toBe("<Keyboard>/arrowleft");
    expect(keyControl("Escape")).toBeNull();
    expect(pointerControl(2)).toBe("<Pointer>/button2");
    for (const path of [keyControl("Enter")!, pointerControl(0)]) expect(canonicalControlPath(path)).toBe(path);
  });

  it("names touch and pen presses in the window by their device", () => {
    expect(pointerPressControl({ pointerType: "mouse", button: 1 })).toBe("<Pointer>/button1");
    expect(pointerPressControl({ pointerType: "touch", button: 0 })).toBe("<Touch>/primary");
    expect(pointerPressControl({ pointerType: "pen", button: 0, buttons: 1 })).toBe("<Pen>/tip");
    expect(pointerPressControl({ pointerType: "pen", button: 2, buttons: 3 })).toBe("<Pen>/barrel");
    expect(pointerPressControl({ pointerType: "pen", button: 5, buttons: 32 })).toBe("<Pen>/eraser");
    for (const path of ["<Touch>/primary", "<Pen>/tip", "<Pen>/barrel", "<Pen>/eraser"]) expect(canonicalControlPath(path)).toBe(path);
  });

  it("binds the device snapshot's presses as they are named, a finger as the primary touch, with Escape cancelling", () => {
    expect(pressControl({ device: "gamepad", control: "<Gamepad>/buttonSouth", value: 1 })).toBe("<Gamepad>/buttonSouth");
    expect(pressControl({ device: "gamepad", control: "<Gamepad>/leftStickY", value: -0.9 })).toBe("<Gamepad>/leftStickY");
    expect(pressControl({ device: "touch", control: "<Touch>/touch2", value: 1 })).toBe("<Touch>/primary");
    expect(pressControl({ device: "keyboard", control: "<Keyboard>/escape", value: 1 })).toBeNull();
  });
});
