// ADR 0333: how a moving emitter travels its route over time: by arc length at its speed, stopping at the end of a route
// that doesn't loop, travelling a looping route's short closing gap (velocity carries) and jumping a long one.
import { describe, expect, it } from "vitest";
import { advanceRoute, closeDistance, ROUTE_CLOSE_METRES, routeGap, travelAt, travelPose, travelSpeed } from "./routeTravel";

const v = (x: number, z: number) => ({ x, y: 0, z });
const out = () => ({ position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 } });
/** A 10 m square ending 2 m short of its start: 38 m of route, a 2 m gap. */
const circuit = [v(0, 0), v(10, 0), v(10, 10), v(0, 10), v(0, 2)];
const line = [v(0, 0), v(20, 0)];

describe("route travel", () => {
  it("advances by arc length at the speed, and places the emitter at its height", () => {
    const t = travelAt(0);
    advanceRoute(line, 10, false, t, 0.5, 5);
    expect(t).toEqual({ u: 0.25, gap: null });
    const o = out();
    travelPose(line, 3, false, t, o);
    expect(o).toEqual({ position: { x: 5, y: 3, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
  });

  it("stops at the end of a route that doesn't loop, and its speed goes to 0", () => {
    const t = travelAt(0.9);
    expect(travelSpeed(line, 10, false, t)).toBe(10);
    advanceRoute(line, 10, false, t, 1, 5);
    expect(t.u).toBe(1);
    expect(travelSpeed(line, 10, false, t)).toBe(0);
  });

  it("jumps a looping route's long gap back to its start, keeping the distance left over", () => {
    const t = travelAt(0.9); // 2 m before the end; the gap is 20 m
    advanceRoute(line, 10, true, t, 0.3, closeDistance(150, 1 / 60));
    expect(t.gap).toBeNull();
    expect(t.u).toBeCloseTo(0.05, 9); // 1 m past the start
  });

  it("travels a looping route's short gap at its speed, so the motion stays continuous", () => {
    expect(routeGap(circuit)).toBe(2);
    const t = travelAt(37 / 38); // 1 m before the end
    const o = out();
    advanceRoute(circuit, 10, true, t, 0.15, closeDistance(150, 1 / 60)); // 1.5 m: 0.5 m into the gap
    expect(t.gap).toBeCloseTo(0.5, 9);
    travelPose(circuit, 1, true, t, o);
    expect(o.position.x).toBeCloseTo(0, 9);
    expect(o.position.y).toBe(1);
    expect(o.position.z).toBeCloseTo(1.5, 9);
    expect(o.direction).toEqual({ x: 0, y: 0, z: -1 });
    advanceRoute(circuit, 10, true, t, 0.25, closeDistance(150, 1 / 60)); // 2.5 m: the rest of the gap, then 1 m on
    expect(t.gap).toBeNull();
    expect(t.u).toBeCloseTo(1 / 38, 9);
    expect(travelSpeed(circuit, 10, true, t)).toBe(10);
  });

  it("every frame's step is the speed times dt, across the wrap of a near-closed route", () => {
    const t = travelAt(0.9);
    const o = out();
    travelPose(circuit, 0, true, t, o);
    let prev = { ...o.position };
    for (let f = 0; f < 120; f++) {
      advanceRoute(circuit, 12, true, t, 1 / 60, closeDistance(150, 1 / 60));
      travelPose(circuit, 0, true, t, o);
      const step = Math.hypot(o.position.x - prev.x, o.position.z - prev.z);
      expect(step).toBeLessThanOrEqual(12 / 60 + 1e-9); // corners cut a little; never a jump
      expect(step).toBeGreaterThan(0.1);
      prev = { ...o.position };
    }
  });

  it("travels gaps up to ROUTE_CLOSE_METRES, and longer ones the Doppler guard would miss at a long frame", () => {
    expect(closeDistance(150, 1 / 60)).toBe(ROUTE_CLOSE_METRES);
    expect(closeDistance(150, 0.05)).toBeCloseTo(15, 9);
    expect(closeDistance(Number.NaN, 0.05)).toBe(ROUTE_CLOSE_METRES);
  });

  it("skips whole laps of a huge step, and stays put with no length, speed or time", () => {
    const t = travelAt(0);
    advanceRoute(line, 1000, true, t, 1.01, 5); // 1010 m on a 20 m lap: 10 m in
    expect(t.u).toBeCloseTo(0.5, 6);
    const still = travelAt(0.3);
    advanceRoute([v(1, 1), v(1, 1)], 10, true, still, 1, 5);
    advanceRoute(line, 0, true, still, 1, 5);
    advanceRoute(line, 10, true, still, 0, 5);
    expect(still).toEqual({ u: 0.3, gap: null });
    expect(travelSpeed(line, 0, true, still)).toBe(0);
    expect(travelAt(Number.NaN)).toEqual({ u: 0, gap: null });
    expect(travelAt(2).u).toBe(1);
  });
});
