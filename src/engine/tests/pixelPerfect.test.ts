import { beforeEach, describe, expect, it } from "vitest";
import { Assets, Camera, Engine, GameObject, SceneManager, Vector2, Vector3 } from "../index";
import { pixelCenterOffset, pixelPerfectView, snapToGrid } from "../render/pixelPerfect";

describe("pixelPerfectView (ADR 0014)", () => {
  it("picks the largest integer zoom that still shows the wanted area", () => {
    const v = pixelPerfectView(720, 5, 16);
    expect(v.zoom).toBe(4);
    expect(v.orthographicSize).toBeCloseTo(5.625);
    expect(v.unitsPerPixel).toBeCloseTo(1 / 64);
    expect(pixelPerfectView(1080, 5, 16).zoom).toBe(6);
    expect(pixelPerfectView(160, 5, 16)).toMatchObject({ zoom: 1, orthographicSize: 5 });
  });

  it("never drops below zoom 1 and then shows heightPx / ppu units", () => {
    const v = pixelPerfectView(400, 5, 100);
    expect(v.zoom).toBe(1);
    expect(v.orthographicSize).toBeCloseTo(2);
    expect(v.unitsPerPixel).toBeCloseTo(0.01);
  });

  it("guards bad input", () => {
    expect(pixelPerfectView(0, 5, 16)).toEqual({ zoom: 1, orthographicSize: 5, unitsPerPixel: 1 / 16 });
    expect(pixelPerfectView(720, 0, 16)).toEqual({ zoom: 1, orthographicSize: 0, unitsPerPixel: 1 / 16 });
    expect(pixelPerfectView(720, -1, 16).zoom).toBe(1);
    expect(pixelPerfectView(720, 5, 0)).toEqual({ zoom: 1, orthographicSize: 5, unitsPerPixel: 0 });
    expect(pixelPerfectView(NaN, 5, 16).zoom).toBe(1);
  });
});

describe("snapToGrid and pixelCenterOffset", () => {
  it("rounds to the nearest multiple", () => {
    expect(snapToGrid(1.26, 0.25)).toBeCloseTo(1.25);
    expect(snapToGrid(1.4, 0.25)).toBeCloseTo(1.5);
    expect(snapToGrid(-0.9, 0.5)).toBeCloseTo(-1);
  });
  it("returns the value for a non-positive step", () => {
    expect(snapToGrid(1.234, 0)).toBe(1.234);
    expect(snapToGrid(1.234, -1)).toBe(1.234);
  });
  it("offsets half a pixel for odd sizes only", () => {
    expect(pixelCenterOffset(721, 0.02)).toBeCloseTo(0.01);
    expect(pixelCenterOffset(720, 0.02)).toBe(0);
  });
});

describe("Camera pixelPerfect", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 400 }, render: { pixelsPerUnit: 16 } } });
    await SceneManager.load("s.json");
  });

  const camera = (props: Record<string, unknown>) => {
    const node = GameObject.create("cam");
    node.transform!.position.set(0, 0, 10);
    return node.addBehavior(Camera, props);
  };

  it("uses the plain size when pixelPerfect is off or perspective", () => {
    expect(camera({ orthographicSize: 5 })._effectiveOrthographicSize()).toBe(5);
    expect(camera({ pixelPerfect: true, projection: "perspective", orthographicSize: 5 })._effectiveOrthographicSize()).toBe(5);
  });

  it("uses the integer-zoom size when on (400px, size 5, ppu 16 -> zoom 2)", () => {
    const cam = camera({ pixelPerfect: true, orthographicSize: 5 });
    expect(cam.pixelSnapping).toBe(true);
    expect(cam._effectiveOrthographicSize()).toBeCloseTo(400 / (2 * 16 * 2));
  });

  it("worldToScreenPoint and screenPointToRay agree with the effective size", () => {
    const cam = camera({ pixelPerfect: true, orthographicSize: 5 });
    const size = cam._effectiveOrthographicSize(); // 6.25
    const top = cam.worldToScreenPoint(new Vector3(0, size, 0));
    expect(top.y).toBeCloseTo(0);
    const right = cam.worldToScreenPoint(new Vector3(size * 2, 0, 0));
    expect(right.x).toBeCloseTo(800);
    // one world unit is zoom * ppu = 32 device pixels
    expect(cam.worldToScreenPoint(new Vector3(1, 0, 0)).x - 400).toBeCloseTo(32);
    expect(cam.screenPointToRay(new Vector2(0, 0)).origin.y).toBeCloseTo(size);
  });
});
