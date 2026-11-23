import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, HingeJoint } from "../../../myco";
import { AddComponent } from "../../../editor/document";
import { jointTool } from "./jointGizmo";
import type { EditorOverlay } from "../../../engine/editor";
import { viewportTools } from "../../../editor/sdk/contributions";
import { ARC_RADIUS, arcPoints, crossLines, jointWire, perpendicular, rotateAround, swingRimDirection, zigzag, type JointShape } from "./jointMath";
import { openSceneFile } from "../../../editor/project";
import { openScene, playState } from "../../../editor/state";
import { select } from "../../../editor/inspectorTarget";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools } from "../../../editor/testing";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("joint geometry", () => {
  it("draws a three-line cross", () => {
    const c = crossLines([1, 2, 3], 0.5);
    expect(c).toHaveLength(3);
    close(c[1][0], [1, 1.5, 3]);
    close(c[1][1], [1, 2.5, 3]);
  });

  it("finds a perpendicular and turns vectors around an axis", () => {
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]) expect(perpendicular(axis).reduce((s, v, i) => s + v * axis[i], 0)).toBeCloseTo(0);
    close(rotateAround([1, 0, 0], [0, 0, 1], 90), [0, 1, 0]);
  });

  it("sweeps an arc from min to max at the arc radius", () => {
    const pts = arcPoints([0, 0, 0], [0, 0, 1], [1, 0, 0], 0, 90, ARC_RADIUS, 9);
    expect(pts).toHaveLength(10);
    close(pts[0], [ARC_RADIUS, 0, 0]);
    close(pts[9], [0, ARC_RADIUS, 0]);
  });

  it("zig-zags between two points with straight ends", () => {
    const z = zigzag([0, 0, 0], [4, 0, 0], 4, 0.1);
    close(z[0], [0, 0, 0]);
    close(z[z.length - 1], [4, 0, 0]);
    expect(z).toHaveLength(4 * 2 + 2);
    expect(Math.abs(z[1][1]) + Math.abs(z[1][2])).toBeCloseTo(0.1);
  });

  it("draws hinge axis and limits, slider range, and a link to a distinct connected anchor", () => {
    const base = { anchor: [0, 0, 0] as [number, number, number], connected: null };
    expect(jointWire({ ...base, kind: "ball" })).toHaveLength(3);
    expect(jointWire({ ...base, kind: "hinge", axis: [0, 1, 0] })).toHaveLength(4);
    expect(jointWire({ ...base, kind: "hinge", axis: [0, 1, 0], limits: { min: -30, max: 60 } })).toHaveLength(7); // + arc and two radii
    const slider = jointWire({ ...base, kind: "slider", axis: [1, 0, 0], limits: { min: -1, max: 3 } });
    close(slider[3][0], [-1, 0, 0]);
    close(slider[3][1], [3, 0, 0]);
    expect(jointWire({ ...base, kind: "rope", connected: [0, 2, 0] })).toHaveLength(4);
    expect(jointWire({ ...base, kind: "spring", connected: [0, 2, 0] })[3].length).toBeGreaterThan(4);
  });
});

describe("ball joint limits geometry (ADR 0375)", () => {
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
  const deg = (v: readonly number[], w: readonly number[]) => (Math.acos(v[0] * w[0] + v[1] * w[1] + v[2] * w[2]) * 180) / Math.PI;
  const ball = (swing: { y: number; z: number }, twist = { min: -20, max: 40 }): JointShape => ({ kind: "ball", anchor: [0, 0, 0], connected: null, axis: [1, 0, 0], ball: { twist, swing, frameY: [0, 1, 0], frameZ: [0, 0, 1] } });

  it("puts the rim exactly at swing.z towards the frame's y and swing.y towards z", () => {
    const swing = { y: 20, z: 50 };
    expect(deg(swingRimDirection(X, Y, Z, swing, 0), X)).toBeCloseTo(50, 6); // towards +y: swing.z
    expect(deg(swingRimDirection(X, Y, Z, swing, Math.PI), X)).toBeCloseTo(50, 6);
    expect(deg(swingRimDirection(X, Y, Z, swing, Math.PI / 2), X)).toBeCloseTo(20, 6); // towards +z: swing.y
    expect(deg(swingRimDirection(X, Y, Z, swing, (3 * Math.PI) / 2), X)).toBeCloseTo(20, 6);
  });

  it("is a circular cone when the two half-angles are equal", () => {
    for (let t = 0; t < 6.3; t += 0.7) expect(deg(swingRimDirection(X, Y, Z, { y: 35, z: 35 }, t), X)).toBeCloseTo(35, 6);
  });

  it("is elliptical when they differ: between the axes the rim lies between the two half-angles", () => {
    const a = deg(swingRimDirection(X, Y, Z, { y: 20, z: 50 }, Math.PI / 4), X);
    expect(a).toBeGreaterThan(20);
    expect(a).toBeLessThan(50);
  });

  it("draws the anchor cross, the closed rim, four spokes, the twist arc and its two radii", () => {
    const wire = jointWire(ball({ y: 20, z: 50 }));
    expect(wire).toHaveLength(3 + 1 + 4 + 1 + 2);
    const rim = wire[3];
    close(rim[0], rim[rim.length - 1]); // closed loop
    for (const p of rim) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(ARC_RADIUS, 6);
    close(wire[4][1], rim[0]); // the spokes run to the rim's ends on the two axes
    close(wire[5][1], rim[8]);
  });

  it("draws the twist arc about the axis from min to max, starting from the frame's y direction", () => {
    const wire = jointWire(ball({ y: 20, z: 50 }, { min: 0, max: 90 }));
    const arc = wire[8];
    close(arc[0], [0, 0.3, 0]);
    close(arc[arc.length - 1], [0, 0, 0.3]);
  });

  it("omits the twist arc for an empty range, and the limits entirely while they are off", () => {
    expect(jointWire(ball({ y: 20, z: 50 }, { min: 10, max: 10 }))).toHaveLength(3 + 1 + 4);
    expect(jointWire({ kind: "ball", anchor: [0, 0, 0], connected: null, axis: [1, 0, 0] })).toHaveLength(3);
  });
});

describe("joint overlay", () => {
  let engine: Engine;
  let view: ReturnType<typeof jointView>;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    view = jointView(engine);
  });

  afterEach(() => {
    view.stop();
    select([]);
    engine.dispose();
  });

  it("draws a hinge between two nodes, brighter when selected", () => {
    const scene = openScene.value!;
    const a = insertNew(scene, "empty", { position: [0, 0, 0] });
    const b = insertNew(scene, "empty", { position: [3, 0, 0] });
    expect(view.overlay().lines).toEqual([]);
    scene.stack.execute(new AddComponent(a, { type: "engine.HingeJoint", data: { anchor: [1, 0, 0], axis: [0, 1, 0], autoConfigureConnectedAnchor: false, connectedAnchor: [0, 0, 0], useLimits: true, limits: { min: -45, max: 45 } } }));
    scene.sync.nodeFor(a)!.getBehavior(HingeJoint)!.connectedBody = scene.sync.nodeFor(b)!; // object references aren't document fields here
    const overlay = view.overlay();
    const lines = overlay.lines;
    // cross (3), link, axis, arc, two radii
    expect(lines).toHaveLength(8);
    const link = lines.find((l) => l.points.length === 2 && Math.abs(l.points[1][0] - 3) < 1e-6 && Math.abs(l.points[0][0] - 1) < 1e-6);
    expect(link).toBeDefined();
    const normal = lines[0].color;
    select([a]);
    expect(view.overlay().lines[0].color).not.toBe(normal);
  });

  it("draws a ball joint's swing cone and twist arc in the joint's frame, turned with its axis", () => {
    const scene = openScene.value!;
    const a = insertNew(scene, "empty", { position: [1, 2, 3] });
    scene.stack.execute(new AddComponent(a, { type: "engine.BallJoint", data: { useLimits: true, axis: [0, 1, 0], swing: { y: 30, z: 60 }, twistLimits: { min: -45, max: 45 } } }));
    const lines = view.overlay().lines;
    expect(lines).toHaveLength(11); // cross (3), rim, four spokes, arc, two radii
    // The twist axis is world +y: every rim point leans off it between 30 and 60 degrees.
    for (const p of lines[3].points) {
      const d = [p[0] - 1, p[1] - 2, p[2] - 3];
      const off = (Math.acos(d[1] / Math.hypot(d[0], d[1], d[2])) * 180) / Math.PI;
      expect(off).toBeGreaterThan(29.9);
      expect(off).toBeLessThan(60.1);
    }
    close(lines[0].points[0], [1 - 0.15, 2, 3]);
  });

  it("draws a ball joint without limits as just its cross", () => {
    const scene = openScene.value!;
    const a = insertNew(scene, "empty", { position: [0, 0, 0] });
    scene.stack.execute(new AddComponent(a, { type: "engine.BallJoint", data: {} }));
    expect(view.overlay().lines).toHaveLength(3);
  });

  it("draws a 2D joint's anchor and slider axis where the mirrored node's world matrix puts them (ADR 0301, 0305)", () => {
    const scene = openScene.value!;
    const a = insertNew(scene, "empty", { position: [2, 1, 0] });
    scene.stack.execute(new AddComponent(a, { type: "engine.SliderJoint2D", data: { anchor: [1, 0.5], axis: [1, 0], useLimits: true, limits: { min: 0, max: 2 } } }));
    const node = scene.sync.nodeFor(a)!;
    node.transform!.scale.set(-1, 1, 1); // mirrored left to right
    const lines = view.overlay().lines;
    // The cross's x line is centred on the anchor: (2 - 1, 1 + 0.5).
    close(lines[0].points[0], [1 - 0.15, 1.5, 0]);
    // The slider's range runs along the node's mirrored x axis, -x in the world, from the anchor.
    const range = lines[3].points;
    close(range[0], [1, 1.5, 0]);
    close(range[1], [-1, 1.5, 0]);
  });
});

/** The joint tool on `engine`'s scene view, over a fake viewport (ADR 0128): what it draws now, and a function that removes it. */
function jointView(engine: Engine): { overlay: () => EditorOverlay; stop: () => void } {
  const off = viewportTools.register(jointTool);
  playState.value = "edit";
  const view = sceneViewTools(engine);
  return { overlay: view.overlay, stop: () => (view.stop(), off()) };
}
