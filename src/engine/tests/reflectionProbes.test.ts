import { describe, expect, it } from "vitest";
import { Camera, ReflectionProbe } from "../index";
import { pickProbe, type ProbeBox } from "../render/probeBoxes";

const box = (id: number, size: number, x = 0, y = 0, z = 0): ProbeBox => ({ id, center: { x, y, z }, size: { x: size, y: size, z: size } });

describe("pickProbe", () => {
  it("returns the box containing the point", () => {
    expect(pickProbe({ x: 1, y: 1, z: 1 }, [box(1, 10)])?.id).toBe(1);
  });
  it("picks the smaller of nested boxes", () => {
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [box(1, 20), box(2, 4)])?.id).toBe(2);
  });
  it("returns null outside every box", () => {
    expect(pickProbe({ x: 50, y: 0, z: 0 }, [box(1, 10)])).toBeNull();
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [])).toBeNull();
  });
  it("includes the edges", () => {
    expect(pickProbe({ x: 5, y: -5, z: 5 }, [box(1, 10)])?.id).toBe(1);
  });
  it("breaks volume ties by lower id", () => {
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [box(7, 10), box(3, 10)])?.id).toBe(3);
  });
});

describe("ReflectionProbe", () => {
  it("has defaults", () => {
    const p = new ReflectionProbe();
    expect([p.size.x, p.size.y, p.size.z]).toEqual([10, 10, 10]);
    expect(p.intensity).toBe(1);
    expect(p.refresh).toBe("onLoad");
  });
  it("capture() bumps the request counter", () => {
    const p = new ReflectionProbe();
    expect(p._captureRequests).toBe(0);
    p.capture();
    expect(p._captureRequests).toBe(1);
  });
});

describe("Camera viewport", () => {
  it("covers the whole canvas by default", () => {
    const c = new Camera();
    expect([c.viewportPosition.x, c.viewportPosition.y]).toEqual([0, 0]);
    expect([c.viewportSize.x, c.viewportSize.y]).toEqual([1, 1]);
  });
});
