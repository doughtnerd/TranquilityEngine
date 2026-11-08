import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasCssSize } from "../render/canvasCssSize";
import { Assets, Camera, Engine, GameObject, Physics, Plane, Ray, SceneManager, SphereCollider, Vector2, Vector3 } from "../../myco";

describe("Ray and Plane (ADR 0073)", () => {
  it("normalizes the ray's direction and walks along it", () => {
    const r = new Ray([1, 2, 3], [0, 0, -4]);
    expect(r.direction.toArray()).toEqual([0, 0, -1]);
    expect(r.at(5).toArray()).toEqual([1, 2, -2]);
  });

  it("builds a plane from a normal and a point, and measures points against it", () => {
    const p = Plane.fromNormalAndPoint([0, 2, 0], [5, 3, 5]);
    expect(p.normal.toArray()).toEqual([0, 1, 0]);
    expect(p.distance).toBeCloseTo(-3);
    expect(p.distanceToPoint(new Vector3(0, 5, 0))).toBeCloseTo(2);
    expect(p.distanceToPoint(new Vector3(9, 1, 9))).toBeCloseTo(-2);
  });

  it("raycasts to the distance along the ray, or null when parallel or behind", () => {
    const ground = Plane.fromNormalAndPoint([0, 1, 0], [0, 0, 0]);
    expect(ground.raycast(new Ray([0, 10, 0], [0, -1, 0]))).toBeCloseTo(10);
    expect(ground.raycast(new Ray([0, 10, 0], [1, -1, 0]))).toBeCloseTo(10 * Math.SQRT2);
    expect(ground.raycast(new Ray([0, 10, 0], [1, 0, 0]))).toBeNull();
    expect(ground.raycast(new Ray([0, 10, 0], [0, 1, 0]))).toBeNull();
    expect(ground.raycast(new Ray([0, -2, 0], [0, 1, 0]))).toBeCloseTo(2); // from below
  });
});

describe("Camera screen points (ADR 0073)", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 400 } } });
    await SceneManager.load("s.json");
  });

  const camera = (props: Record<string, unknown>, pos: [number, number, number] = [0, 0, 10], euler?: [number, number, number]) => {
    const node = GameObject.create("cam");
    node.transform!.position.set(...pos);
    if (euler) node.transform!.eulerAngles = euler;
    return node.addBehavior(Camera, props);
  };

  it("uses the reference resolution without a render backend", () => {
    expect(camera({}).aspect).toBeCloseTo(2);
    expect(camera({ viewportSize: new Vector2(0.5, 1) }).aspect).toBeCloseTo(1);
  });

  it("gives parallel rays from an orthographic camera", () => {
    const cam = camera({ projection: "orthographic", orthographicSize: 5 });
    const centre = cam.screenPointToRay(new Vector2(400, 200));
    expect(centre.origin.toArray()).toEqual([0, 0, 10]);
    expect(centre.direction.z).toBeCloseTo(-1);
    const corner = cam.screenPointToRay(new Vector2(0, 0)); // top-left: x -10 (aspect 2 * 5), y +5
    expect(corner.origin.x).toBeCloseTo(-10);
    expect(corner.origin.y).toBeCloseTo(5);
    expect(corner.direction.z).toBeCloseTo(-1);
    const bottomRight = cam.viewportPointToRay(new Vector2(1, 0));
    expect(bottomRight.origin.x).toBeCloseTo(10);
    expect(bottomRight.origin.y).toBeCloseTo(-5);
  });

  it("fans perspective rays out from the camera position", () => {
    const cam = camera({ projection: "perspective", fieldOfView: 90 });
    const top = cam.screenPointToRay(new Vector2(400, 0));
    expect(top.origin.toArray()).toEqual([0, 0, 10]);
    expect(top.direction.y).toBeCloseTo(Math.SQRT1_2); // 45 degrees up at fov 90
    expect(top.direction.z).toBeCloseTo(-Math.SQRT1_2);
    const right = cam.screenPointToRay(new Vector2(800, 200));
    expect(right.direction.x / -right.direction.z).toBeCloseTo(2); // tan(45) * aspect
  });

  it("round-trips screen points and world points, orthographic and perspective, on a turned camera", () => {
    for (const props of [{ projection: "orthographic", orthographicSize: 4 }, { projection: "perspective", fieldOfView: 50 }]) {
      const cam = camera(props, [3, 2, 12], [10, 25, 5]);
      for (const px of [new Vector2(100, 50), new Vector2(400, 200), new Vector2(777, 333)]) {
        const back = cam.worldToScreenPoint(cam.screenPointToRay(px).at(7));
        expect(back.x).toBeCloseTo(px.x, 3);
        expect(back.y).toBeCloseTo(px.y, 3);
        expect(back.z).toBeGreaterThan(0);
      }
    }
  });

  it("reports distance in front of the camera, negative behind", () => {
    const cam = camera({ projection: "perspective" });
    const at = cam.worldToScreenPoint(new Vector3(0, 0, 0));
    expect(at.z).toBeCloseTo(10);
    expect(at.x).toBeCloseTo(400);
    expect(at.y).toBeCloseTo(200);
    expect(cam.worldToScreenPoint(new Vector3(0, 0, 20)).z).toBeCloseTo(-10);
  });

  it("maps through a camera's viewport rectangle", () => {
    const cam = camera({ projection: "orthographic", orthographicSize: 5, viewportPosition: new Vector2(0.5, 0), viewportSize: new Vector2(0.5, 1) });
    // The right half of the canvas: x 400..800 maps across the camera's view.
    expect(cam.screenPointToRay(new Vector2(600, 200)).origin.x).toBeCloseTo(0);
    expect(cam.worldToScreenPoint(new Vector3(0, 0, 0)).x).toBeCloseTo(600);
    const corner = cam.worldToScreenPoint(new Vector3(5, 5, 0));
    expect(corner.x).toBeCloseTo(800);
    expect(corner.y).toBeCloseTo(0);
  });

  it("feeds Physics.raycast, which takes a Ray", () => {
    const ball = GameObject.create("ball");
    ball.addBehavior(SphereCollider, { radius: 1 });
    engine.step(1 / 60);
    const cam = camera({ projection: "perspective" });
    const hit = Physics.raycast(cam.screenPointToRay(new Vector2(400, 200)));
    expect(hit?.collider.node.name).toBe("ball");
    expect(hit?.distance).toBeCloseTo(9);
    expect(Physics.raycast(cam.screenPointToRay(new Vector2(0, 0)))).toBeNull();
    expect(Physics.raycast(new Ray([0, 0, 10], [0, 0, -1]), 5)).toBeNull(); // maxDistance as the second argument
    expect(Physics.raycast({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, 100)?.distance).toBeCloseTo(9); // the old form still works
  });

  describe("with a render surface's canvas", () => {
    // A surface reporting its canvas's CSS size the way BabylonSurface does (through CanvasCssSize),
    // with a canvas whose layout reads are counted.
    let reads = 0;
    let size = { w: 800, h: 400 };
    const canvas = {
      get clientWidth() { reads++; return size.w; },
      get clientHeight() { reads++; return size.h; },
    };
    let observed: (() => void) | null = null;
    class FakeObserver {
      constructor(cb: () => void) { observed = cb; }
      observe(): void {}
      disconnect(): void {}
    }
    let tracker: CanvasCssSize;
    beforeEach(() => {
      reads = 0;
      size = { w: 800, h: 400 };
      tracker = new CanvasCssSize(canvas, FakeObserver as unknown as typeof ResizeObserver);
      engine.world.render = { canvas, canvasCssSize: () => tracker.get() } as never;
    });
    afterEach(() => {
      engine.world.render = null;
    });
    /** The canvas resizes: the observer reports after layout, as ResizeObserver does. */
    const resize = (w: number, h: number) => {
      size = { w, h };
      observed!();
    };

    it("follows the canvas's size as it changes", () => {
      const cam = camera({ projection: "orthographic", orthographicSize: 5 });
      expect(cam.aspect).toBeCloseTo(2);
      expect(cam.worldToScreenPoint(new Vector3(0, 0, 0)).x).toBeCloseTo(400);
      resize(300, 600);
      expect(cam.aspect).toBeCloseTo(0.5);
      expect(cam.worldToScreenPoint(new Vector3(0, 0, 0)).toArray().slice(0, 2)).toEqual([150, 300]);
      const corner = cam.screenPointToRay(new Vector2(0, 0)); // top-left: x -2.5 (aspect 0.5 * 5), y +5
      expect(corner.origin.x).toBeCloseTo(-2.5);
      expect(corner.origin.y).toBeCloseTo(5);
      const perspective = camera({ projection: "perspective", fieldOfView: 50 }, [3, 2, 12], [10, 25, 5]);
      const back = perspective.worldToScreenPoint(perspective.screenPointToRay(new Vector2(250, 120)).at(7));
      expect(back.x).toBeCloseTo(250, 3);
      expect(back.y).toBeCloseTo(120, 3);
    });

    it("reads the canvas's layout once per resize, not once per call", () => {
      const cam = camera({ projection: "perspective" });
      for (let i = 0; i < 50; i++) cam.worldToScreenPoint(new Vector3(i, 0, 0));
      expect(reads).toBe(2); // clientWidth and clientHeight, once
      resize(640, 480);
      for (let i = 0; i < 50; i++) cam.screenPointToRay(new Vector2(i, i));
      expect(reads).toBe(4);
      expect(cam.aspect).toBeCloseTo(640 / 480);
      tracker.invalidate(); // the surface set the canvas's style itself
      size = { w: 200, h: 100 };
      expect(cam.aspect).toBeCloseTo(2);
      expect(reads).toBe(6);
    });

    it("falls back to the project's display size while the canvas has no size", () => {
      resize(0, 0);
      expect(camera({}).aspect).toBeCloseTo(2); // 800 x 400 from the project
      resize(100, 100);
      expect(camera({}).aspect).toBeCloseTo(1);
    });

    it("reads the canvas every call without ResizeObserver", () => {
      const plain = new CanvasCssSize(canvas, undefined);
      engine.world.render = { canvas, canvasCssSize: () => plain.get() } as never;
      const cam = camera({});
      size = { w: 100, h: 200 };
      expect(cam.aspect).toBeCloseTo(0.5);
      size = { w: 300, h: 100 };
      expect(cam.aspect).toBeCloseTo(3);
    });
  });
});
