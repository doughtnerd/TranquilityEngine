// "Press to bind" (ADR 0336): presses named as the engine names controls.
import { describe, expect, it } from "vitest";
import { canonicalControlPath } from "../engine/editor";
import { keyControl, padControl, pointerControl } from "./controlCapture";

describe("press to bind", () => {
  it("names keys as control paths, with Escape cancelling", () => {
    expect(keyControl(" ")).toBe("<Keyboard>/space");
    expect(keyControl("A")).toBe("<Keyboard>/a");
    expect(keyControl("ArrowLeft")).toBe("<Keyboard>/arrowleft");
    expect(keyControl("Escape")).toBeNull();
    expect(pointerControl(2)).toBe("<Pointer>/button2");
    for (const path of [keyControl("Enter")!, pointerControl(0)]) expect(canonicalControlPath(path)).toBe(path);
  });

  it("takes the first gamepad button or stick axis pressed since capture began, not one already held", () => {
    const rest = { buttons: Array(17).fill(0), axes: [0, 0, 0, 0] };
    const south = { ...rest, buttons: rest.buttons.map((_, i) => (i === 0 ? 1 : 0)) };
    expect(padControl(rest, south)).toBe("<Gamepad>/buttonSouth");
    expect(padControl(south, south)).toBeNull();
    expect(padControl(south, { ...south, axes: [0, -0.9, 0, 0] })).toBe("<Gamepad>/leftStickY");
    expect(padControl(undefined, { ...rest, buttons: rest.buttons.map((_, i) => (i === 7 ? 0.6 : 0)) })).toBe("<Gamepad>/rightTrigger");
  });
});
