import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";

let engine: Engine;
let orbit: OrbitCamera;
const frame = 1 / 60;

/** World position of the scene camera. */
const eye = () => orbit.gameObject.find("Arm/Camera")!.transform!.worldPosition;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, kind: "editor" });
  orbit = OrbitCamera.create(GameObject.create("SceneCamera"));
  engine.step(frame);
});

describe("OrbitCamera (ADR 0022)", () => {
  it("places the camera `distance` from the focus point, above it for negative pitch", () => {
    const p = eye();
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(orbit.distance, 4);
    expect(p.y).toBeGreaterThan(0);
  });

  it("rotates while the right mouse button drags", () => {
    const before = eye();
    Input.simulate("down", "mouse2");
    Input.simulateMouseMove(100, -50);
    engine.step(frame);

    expect(orbit.yaw).toBeCloseTo(35 - 100 * orbit.sensitivity, 4);
    expect(orbit.pitch).toBeCloseTo(-24 + 50 * orbit.sensitivity, 4);
    const after = eye();
    expect(Math.hypot(after.x, after.y, after.z)).toBeCloseTo(orbit.distance, 4); // still on the sphere
    expect(after.x).not.toBeCloseTo(before.x, 2);
  });

  it("ignores movement without a drag button, and plain left drags", () => {
    Input.simulateMouseMove(80, 40);
    engine.step(frame);
    Input.simulate("down", "mouse0");
    Input.simulateMouseMove(80, 40);
    engine.step(frame);
    expect(orbit.yaw).toBeCloseTo(35, 4);
    expect(orbit.pitch).toBeCloseTo(-24, 4);
  });

  it("orbits with Alt + left drag and clamps pitch", () => {
    Input.simulate("down", "alt");
    Input.simulate("down", "mouse0");
    Input.simulateMouseMove(0, 10_000);
    engine.step(frame);
    expect(orbit.pitch).toBe(orbit.minPitch);
  });
});
