import { beforeEach, describe, expect, it } from "vitest";
import { Camera, Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { DomInput } from "../engine/tests/domInput";

let engine: Engine;
let orbit: OrbitCamera;
const frame = 1 / 60;
/** The keyboard and mouse, through `Input`'s DOM adapter. */
const dom = () => DomInput.attach();

/** World position of the scene camera. */
const eye = () => orbit.gameObject.find("Arm/Camera")!.transform!.worldPosition;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, kind: "editor" });
  orbit = OrbitCamera.create(GameObject.create("SceneCamera"));
  engine.step(frame);
});

describe("OrbitCamera (ADR 0022)", () => {
  it("places the camera `distance` from the focus point, above it for positive pitch, on the -Z side at yaw 0 (ADR 0164)", () => {
    const p = eye();
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(orbit.distance, 4);
    expect(p.y).toBeGreaterThan(0);
    orbit.yaw = 0;
    orbit.focus();
    const front = eye();
    expect(front.x).toBeCloseTo(0, 4);
    expect(front.z).toBeLessThan(0);
    // A positive yaw turns the view right: the eye swings to -X.
    orbit.yaw = 90;
    orbit.focus();
    expect(eye().x).toBeLessThan(-1);
  });

  it("rotates while the right mouse button drags", () => {
    const before = eye();
    dom().pointerDown(2);
    engine.step(frame); // the press: travel before it is ignored
    dom().move(100, -50);
    engine.step(frame);

    expect(orbit.yaw).toBeCloseTo(-35 + 100 * orbit.sensitivity + 360, 4);
    expect(orbit.pitch).toBeCloseTo(24 - 50 * orbit.sensitivity, 4);
    const after = eye();
    expect(Math.hypot(after.x, after.y, after.z)).toBeCloseTo(orbit.distance, 4); // still on the sphere
    expect(after.x).not.toBeCloseTo(before.x, 2);
  });

  it("ignores movement without a drag button, and plain left drags", () => {
    dom().move(80, 40);
    engine.step(frame);
    dom().pointerDown(0);
    dom().move(80, 40);
    engine.step(frame);
    expect(orbit.yaw).toBeCloseTo(325, 4);
    expect(orbit.pitch).toBeCloseTo(24, 4);
  });

  it("ignores travel from before a drag began", () => {
    dom().move(300, 200); // moved, then pressed, within one frame
    dom().pointerDown(2);
    engine.step(frame);
    expect(orbit.yaw).toBeCloseTo(325, 4);
    expect(orbit.pitch).toBeCloseTo(24, 4);
  });

  it("orbits with Alt + left drag and clamps pitch", () => {
    dom().keyDown("alt");
    dom().pointerDown(0);
    engine.step(frame); // the press: travel before it is ignored
    dom().move(0, 10_000);
    engine.step(frame);
    expect(orbit.pitch).toBe(orbit.maxPitch);
  });

  it("pans with middle drag and Shift + right drag, keeping the view angle", () => {
    dom().pointerDown(1);
    engine.step(frame); // the press: travel before it is ignored
    dom().move(120, 0);
    engine.step(frame);
    dom().pointerUp(1);
    const afterMiddle = orbit.focusPoint;
    expect(Math.hypot(afterMiddle.x, afterMiddle.y, afterMiddle.z)).toBeGreaterThan(0.1);
    expect(afterMiddle.y).toBeCloseTo(0, 4); // horizontal drag moves along the camera's right axis only
    expect(orbit.yaw).toBeCloseTo(325, 4);

    dom().keyDown("shift");
    dom().pointerDown(2);
    engine.step(frame); // the press: travel before it is ignored
    dom().move(0, 60);
    engine.step(frame);
    expect(orbit.focusPoint.y).toBeGreaterThan(afterMiddle.y); // dragging down moves the focus up
    expect(orbit.yaw).toBeCloseTo(325, 4);
    expect(orbit.pitch).toBeCloseTo(24, 4);
  });

  it("zooms with the wheel within limits", () => {
    dom().scroll(0, -200); // scroll up: closer
    engine.step(frame);
    expect(orbit.distance).toBeLessThan(11);
    dom().scroll(0, 1_000_000);
    engine.step(frame);
    expect(orbit.distance).toBe(orbit.maxDistance);
  });

  it("F focuses the origin", () => {
    orbit.focus([3, 1, -2]);
    dom().keyDown("f");
    engine.step(frame);
    expect(orbit.focusPoint.toArray()).toEqual([0, 0, 0]);
  });

  it("2D mode looks along +Z orthographically from z = -distance, pans with right drag, and restores the 3D angles", () => {
    const camera = orbit.gameObject.find("Arm/Camera")!.getBehavior(Camera)!;
    orbit.mode = "2d";
    engine.step(frame);
    expect(camera.projection).toBe("orthographic");
    const p = eye();
    expect(p.x).toBeCloseTo(0, 4);
    expect(p.y).toBeCloseTo(0, 4);
    expect(p.z).toBeCloseTo(-orbit.distance, 4);

    dom().pointerDown(2);
    engine.step(frame); // the press: travel before it is ignored
    dom().move(100, 0);
    engine.step(frame);
    expect(orbit.yaw).toBe(0);
    expect(orbit.focusPoint.x).toBeLessThan(0); // the scene follows the pointer to the right

    dom().pointerUp(2);
    orbit.mode = "3d";
    engine.step(frame);
    expect(camera.projection).toBe("perspective");
    expect(orbit.yaw).toBeCloseTo(325, 4);
    expect(orbit.pitch).toBeCloseTo(24, 4);
  });
});
