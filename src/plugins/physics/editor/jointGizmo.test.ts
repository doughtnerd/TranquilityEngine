import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, HingeJoint } from "../../../myco";
import { AddComponent } from "../../../editor/document";
import { jointOverlay } from "./jointGizmo";
import { ARC_RADIUS, arcPoints, crossLines, jointWire, perpendicular, rotateAround, zigzag } from "./jointMath";
import { createNode } from "../../../editor/nodeCreate";
import { openSceneFile } from "../../../editor/project";
import { openScene } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { select } from "../../../editor/inspectorTarget";

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

describe("joint overlay", () => {
  let engine: Engine;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
  });

  afterEach(() => {
    select([]);
    engine.dispose();
  });

  it("draws a hinge between two nodes, brighter when selected", () => {
    const scene = openScene.value!;
    const a = createNode(scene, "empty", { position: [0, 0, 0] });
    const b = createNode(scene, "empty", { position: [3, 0, 0] });
    expect(jointOverlay(engine).lines).toEqual([]);
    scene.stack.execute(new AddComponent(a, { type: "engine.HingeJoint", data: { anchor: [1, 0, 0], axis: [0, 1, 0], autoConfigureConnectedAnchor: false, connectedAnchor: [0, 0, 0], useLimits: true, limits: { min: -45, max: 45 } } }));
    scene.sync.nodeFor(a)!.getBehavior(HingeJoint)!.connectedBody = scene.sync.nodeFor(b)!; // object references aren't document fields here
    const overlay = jointOverlay(engine);
    const lines = overlay.lines;
    // cross (3), link, axis, arc, two radii
    expect(lines).toHaveLength(8);
    const link = lines.find((l) => l.points.length === 2 && Math.abs(l.points[1][0] - 3) < 1e-6 && Math.abs(l.points[0][0] - 1) < 1e-6);
    expect(link).toBeDefined();
    const normal = lines[0].color;
    select([a]);
    expect(jointOverlay(engine).lines[0].color).not.toBe(normal);
  });
});
