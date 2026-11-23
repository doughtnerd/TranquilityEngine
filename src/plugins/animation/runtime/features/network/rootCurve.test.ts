// T33: root deltas from an extracted root curve (`rootCurve.ts`; D25, D35), on synthetic curves.
import { describe, expect, it } from "vitest";
import { rootDelta, type RootDelta } from "./rootCurve";

/** A curve of `frames` frames at 10 per second from `at(f)` → [x, y, z, yaw]. */
function curve(frames: number, at: (f: number) => number[]) {
  const rootCurve = new Float32Array(frames * 4);
  for (let f = 0; f < frames; f++) rootCurve.set(at(f), f * 4);
  return { rootCurve, sampleRate: 10 };
}

const d = (): RootDelta => ({ x: 0, y: 0, z: 0, yaw: 0 });
const TOL = 1e-6; // f32 curve values, f64 maths

describe("rootDelta", () => {
  it("is the curve's movement between two times, linear between frames", () => {
    const c = curve(11, (f) => [0, 0, f * 0.1, 0]); // 1 m/s along +Z
    const r = rootDelta(c, 0.25, 0.55, d());
    expect(r.z).toBeCloseTo(0.3, 6);
    expect(Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.yaw)).toBeLessThan(TOL);
  });

  it("holds past either end of the curve", () => {
    const c = curve(11, (f) => [0, 0, f * 0.1, 0]);
    expect(rootDelta(c, 0.9, 5, d()).z).toBeCloseTo(0.1, 6);
    expect(rootDelta(c, 2, 3, d()).z).toBe(0);
    expect(rootDelta(c, -1, 0, d()).z).toBe(0);
  });

  it("turns the movement into the character's frame at the first time (the curve's heading there)", () => {
    // Facing +X after a quarter turn (yaw π/2), moving along +X in clip space: straight ahead in the character's frame.
    const c = curve(11, (f) => [f * 0.1, 0, 0, Math.PI / 2]);
    const r = rootDelta(c, 0.2, 0.4, d());
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.z).toBeCloseTo(0.2, 6);
    expect(r.yaw).toBeCloseTo(0, 6);
  });

  it("reports the turn between the two times (unwrapped yaw)", () => {
    const c = curve(11, (f) => [0, 0, 0, f * 0.7]); // past ±π by the end
    expect(rootDelta(c, 0.1, 0.9, d()).yaw).toBeCloseTo(0.8 * 7, 5);
  });

  it("a curve with no frames gives no motion", () => {
    expect(rootDelta({ rootCurve: new Float32Array(0), sampleRate: 30 }, 0, 1, d())).toEqual({ x: 0, y: 0, z: 0, yaw: 0 });
  });
});
