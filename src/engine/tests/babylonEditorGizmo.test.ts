// ADR 0075 stage 8: the editor's transform gizmo on the Babylon backend, run headless on Babylon's
// NullEngine with a real utility layer.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import type { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo.js";
import type { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo.js";
import type { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo.js";
import { Matrix, Quaternion as BQuaternion, Vector3 as BVector3 } from "@babylonjs/core/Maths/math.vector.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import type { LocalPose } from "../render/gizmoMath";
import { BabylonEditorGizmo } from "../render/babylon/editorGizmo";
import type { BabylonEditorContext } from "../render/babylon/editorContext";
import type { GizmoHandlers, GizmoOptions } from "../render/RenderSurface";

const base: GizmoOptions = { mode: "translate", planar: false, snap: false };

describe("the transform gizmo on the Babylon backend (ADR 0075 stage 8)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let overlay: UtilityLayerRenderer;
  let camera: FreeCamera;
  let gizmo: BabylonEditorGizmo;
  let calls: string[];
  let changes: LocalPose[][];
  let handlers: GizmoHandlers;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    camera = new FreeCamera("view", new BVector3(0, 0, 10), scene);
    camera.setTarget(BVector3.Zero());
    scene.activeCamera = camera;
    overlay = new UtilityLayerRenderer(scene);
    const view = {};
    const ctx = {
      scene,
      overlay,
      canvas: {} as HTMLCanvasElement,
      editor: true,
      world: () => World.require(),
      viewCameras: () => [view],
      babylonCamera: () => camera,
      sprites: () => [],
      meshes: () => [],
      texts: () => [],
    } as unknown as BabylonEditorContext;
    gizmo = new BabylonEditorGizmo(ctx);
    calls = [];
    changes = [];
    handlers = {
      onStart: () => calls.push("start"),
      onChange: (poses) => {
        calls.push("change");
        changes.push(poses);
      },
      onEnd: () => calls.push("end"),
    };
  });

  afterEach(() => {
    gizmo.dispose();
    overlay.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const node = (name: string, pos: [number, number, number], euler?: [number, number, number]) => {
    const n = GameObject.create(name);
    n.transform!.position.set(...pos);
    if (euler) n.transform!.eulerAngles = euler;
    return n;
  };
  const sync = () => {
    engine.step(1 / 60);
    gizmo.sync(World.require());
  };
  const proxy = () => scene.getTransformNodeByName("myco.gizmoProxy")!;
  const internals = () => gizmo as unknown as { gizmos: { translate?: PositionGizmo; rotate?: RotationGizmo; scale?: ScaleGizmo } };
  const shownModes = () =>
    Object.entries(internals().gizmos)
      .filter(([, g]) => g.attachedNode === proxy() && g._rootMesh.isEnabled())
      .map(([mode]) => mode);
  const pos = () => proxy().position.asArray().map((v) => Math.round(v * 1e4) / 1e4);

  it("sits on a single node, aligned with it, and on the centre of several, aligned with the world", () => {
    const a = node("a", [2, 0, 0], [0, 90, 0]);
    const b = node("b", [0, 4, 0], [0, 0, 90]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    expect(pos()).toEqual([2, 0, 0]);
    const q = proxy().rotationQuaternion!;
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 4);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 4);

    gizmo.setGizmo([a, b], base, handlers);
    sync();
    expect(pos()).toEqual([1, 2, 0]);
    expect(proxy().rotationQuaternion!.equalsWithEpsilon(BQuaternion.Identity())).toBe(true);
    expect(proxy().scaling.asArray()).toEqual([1, 1, 1]);
  });

  it("sits on the active node's origin with pivot 'pivot' and turns like it in local space", () => {
    const a = node("a", [2, 0, 0], [0, 90, 0]);
    const b = node("b", [0, 4, 0], [0, 0, 90]);
    gizmo.setGizmo([a, b], { ...base, pivot: "pivot", space: "local", activeIndex: 0 }, handlers);
    sync();
    expect(pos()).toEqual([2, 0, 0]);
    expect(proxy().rotationQuaternion!.y).toBeCloseTo(Math.SQRT1_2, 4);

    gizmo.setGizmo([a, b], { ...base, pivot: "pivot" }, handlers); // default active: the last
    sync();
    expect(pos()).toEqual([0, 4, 0]);
    expect(proxy().rotationQuaternion!.equalsWithEpsilon(BQuaternion.Identity())).toBe(true);
  });

  it("creates and shows the gizmo of the current mode only, and hides it on an empty selection or no handlers", () => {
    const a = node("a", [0, 0, 0]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    expect(shownModes()).toEqual(["translate"]);
    gizmo.setGizmo([a], { ...base, mode: "rotate" }, handlers);
    sync();
    expect(Object.keys(internals().gizmos).sort()).toEqual(["rotate", "translate"]);
    expect(shownModes()).toEqual(["rotate"]);
    expect(internals().gizmos.translate!.attachedNode).toBeNull();
    gizmo.setGizmo([a], { ...base, mode: "scale" }, handlers);
    sync();
    expect(shownModes()).toEqual(["scale"]);
    gizmo.setGizmo([], base, handlers);
    sync();
    expect(shownModes()).toEqual([]);
    gizmo.setGizmo([a], base, null);
    sync();
    expect(shownModes()).toEqual([]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    expect(shownModes()).toEqual(["translate"]);
    GameObject.destroy(a);
    sync();
    expect(shownModes()).toEqual([]);
  });

  it("aligns the gizmo with the node in local space and with the world otherwise", () => {
    const a = node("a", [0, 0, 0], [0, 90, 0]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    expect(internals().gizmos.translate!.xGizmo.updateGizmoRotationToMatchAttachedMesh).toBe(false);
    gizmo.setGizmo([a], { ...base, space: "local" }, handlers);
    sync();
    expect(internals().gizmos.translate!.xGizmo.updateGizmoRotationToMatchAttachedMesh).toBe(true);
    gizmo.setGizmo([a], { ...base, mode: "scale", space: "world" }, handlers);
    sync();
    expect(internals().gizmos.scale!.updateGizmoRotationToMatchAttachedMesh).toBe(true); // scaling is always along the node's axes
  });

  it("drops the Z handles in a planar (2D) view", () => {
    const a = node("a", [0, 0, 0]);
    gizmo.setGizmo([a], { ...base, planar: true }, handlers);
    sync();
    const t = internals().gizmos.translate!;
    expect([t.xGizmo.isEnabled, t.yGizmo.isEnabled, t.zGizmo.isEnabled]).toEqual([true, true, false]);
    expect([t.xPlaneGizmo.isEnabled, t.yPlaneGizmo.isEnabled, t.zPlaneGizmo.isEnabled]).toEqual([false, false, true]);

    gizmo.setGizmo([a], { ...base, mode: "rotate", planar: true }, handlers);
    sync();
    const r = internals().gizmos.rotate!;
    expect([r.xGizmo.isEnabled, r.yGizmo.isEnabled, r.zGizmo.isEnabled]).toEqual([false, false, true]);

    gizmo.setGizmo([a], { ...base, mode: "scale", planar: true }, handlers);
    sync();
    const s = internals().gizmos.scale!;
    expect([s.xGizmo.isEnabled, s.yGizmo.isEnabled, s.zGizmo.isEnabled, s.uniformScaleGizmo.isEnabled]).toEqual([true, true, false, false]);

    gizmo.setGizmo([a], base, handlers); // back to 3D: everything returns
    sync();
    expect([t.zGizmo.isEnabled, t.xPlaneGizmo.isEnabled]).toEqual([true, true]);
    expect(t.zGizmo.attachedNode).toBe(proxy());
  });

  it("snaps to the steps (defaults 0.25 m, 15 degrees, 0.1) and not at all when snapping is off", () => {
    const a = node("a", [0, 0, 0]);
    gizmo.setGizmo([a], { ...base, snap: true }, handlers);
    sync();
    expect(internals().gizmos.translate!.snapDistance).toBe(0.25);
    gizmo.setGizmo([a], { ...base, mode: "rotate", snap: true }, handlers);
    sync();
    expect(internals().gizmos.rotate!.snapDistance).toBeCloseTo((15 * Math.PI) / 180, 8);
    gizmo.setGizmo([a], { ...base, mode: "scale", snap: true }, handlers);
    sync();
    expect(internals().gizmos.scale!.snapDistance).toBe(0.1);

    const steps = { move: 1, rotate: 45, scale: 0.5 };
    gizmo.setGizmo([a], { ...base, snap: true, snapSteps: steps }, handlers);
    gizmo.setGizmo([a], { ...base, mode: "rotate", snap: true, snapSteps: steps }, handlers);
    gizmo.setGizmo([a], { ...base, mode: "scale", snap: true, snapSteps: steps }, handlers);
    sync();
    expect(internals().gizmos.translate!.snapDistance).toBe(1);
    expect(internals().gizmos.rotate!.snapDistance).toBeCloseTo(Math.PI / 4, 8);
    expect(internals().gizmos.scale!.snapDistance).toBe(0.5);

    gizmo.setGizmo([a], { ...base, mode: "scale", snap: false }, handlers);
    sync();
    expect(internals().gizmos.scale!.snapDistance).toBe(0);
  });

  it("reports a single node's drag through Babylon's own axis handler as onStart, onChange and onEnd", () => {
    const a = node("a", [1, 2, 3]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    const g = internals().gizmos.translate!;
    const axis = g.xGizmo.dragBehavior;
    const event = (dx: number) => ({ delta: new BVector3(dx, 0, 0), dragDistance: dx, dragPlanePoint: BVector3.Zero(), dragPlaneNormal: BVector3.Up(), pointerId: 1 }) as never;
    axis.onDragStartObservable.notifyObservers({} as never);
    sync(); // a frame mid-drag must not move the proxy back
    axis.onDragObservable.notifyObservers(event(0.5));
    axis.onDragObservable.notifyObservers(event(0.5));
    axis.onDragEndObservable.notifyObservers({} as never);
    expect(calls).toEqual(["start", "change", "change", "end"]);
    expect(changes.at(-1)![0].position).toEqual([2, 2, 3]);
    expect(changes.at(-1)![0].scale).toEqual([1, 1, 1]);
    expect(gizmo.gizmoActiveAt(0, 0)).toBe(false);
  });

  it("maps a drag of two nodes, one parented, to each node's local pose", () => {
    const parent = node("parent", [10, 0, 0], [0, 0, 90]);
    const child = node("child", [0, 0, 0]);
    child.setParent(parent, { keepWorldTransform: false });
    child.transform!.position.set(2, 0, 0); // world: parent rotated 90 degrees about Z, so (10, 2, 0)
    const other = node("other", [0, 0, 6]);
    gizmo.setGizmo([child, other], { ...base, pivot: "pivot", activeIndex: 1 }, handlers);
    sync();
    const world = World.require();
    expect(Array.from(world.worldMatrix(child.entity).slice(child.entity * 16 + 12, child.entity * 16 + 15)).map((v) => Math.round(v))).toEqual([10, 2, 0]);

    // Translate: both move by +1 along world X; the child's local offset turns with its parent (world X is the parent's local -Y).
    const t = internals().gizmos.translate!;
    t.onDragStartObservable.notifyObservers({} as never);
    proxy().position.x += 1;
    t.onDragObservable.notifyObservers({} as never);
    expect(changes).toHaveLength(1);
    const [c, o] = changes[0];
    expect(c.position[0]).toBeCloseTo(2, 4);
    expect(c.position[1]).toBeCloseTo(-1, 4);
    expect(c.rotation[2]).toBeCloseTo(0, 3);
    expect(o.position).toEqual([1, 0, 6]);
    t.onDragEndObservable.notifyObservers({} as never);
    expect(calls).toEqual(["start", "change", "end"]);
  });

  it("rotates several nodes around the shared pivot and scales them about it", () => {
    const a = node("a", [1, 0, 0]);
    const b = node("b", [3, 0, 0]);
    gizmo.setGizmo([a, b], { ...base, mode: "rotate" }, handlers); // centre (2, 0, 0)
    sync();
    const r = internals().gizmos.rotate!;
    r.onDragStartObservable.notifyObservers({} as never);
    // A quarter turn about world Z, as the gizmo applies it to the proxy's rotation.
    proxy().rotationQuaternion!.copyFromFloats(0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4));
    r.onDragObservable.notifyObservers({} as never);
    const [pa, pb] = changes[0];
    expect(pa.position[0]).toBeCloseTo(2, 4);
    expect(pa.position[1]).toBeCloseTo(-1, 4);
    expect(pb.position[0]).toBeCloseTo(2, 4);
    expect(pb.position[1]).toBeCloseTo(1, 4);
    expect(pa.rotation[2]).toBeCloseTo(90, 3);
    r.onDragEndObservable.notifyObservers({} as never);

    calls.length = 0;
    changes.length = 0;
    gizmo.setGizmo([a, b], { ...base, mode: "scale" }, handlers);
    sync();
    const s = internals().gizmos.scale!;
    s.onDragStartObservable.notifyObservers({} as never);
    proxy().scaling.set(2, 1, 1);
    s.onDragObservable.notifyObservers({} as never);
    const [sa, sb] = changes[0];
    expect(sa.position[0]).toBeCloseTo(0, 4); // 1 -> 2 + 2 * (1 - 2)
    expect(sb.position[0]).toBeCloseTo(4, 4);
    expect(sa.scale[0]).toBeCloseTo(2, 4);
    expect(sb.scale[1]).toBeCloseTo(1, 4);
    s.onDragEndObservable.notifyObservers({} as never);
    expect(calls).toEqual(["start", "change", "end"]);
  });

  it("ends a drag when the gizmo is hidden mid-drag, and ignores events from gizmos that aren't current", () => {
    const a = node("a", [0, 0, 0]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    const t = internals().gizmos.translate!;
    t.onDragStartObservable.notifyObservers({} as never);
    expect(gizmo.gizmoActiveAt(5, 5)).toBe(true); // true while dragging
    gizmo.setGizmo([], base, handlers);
    expect(calls).toEqual(["start", "end"]);
    expect(gizmo.gizmoActiveAt(5, 5)).toBe(false);

    calls.length = 0;
    gizmo.setGizmo([a], { ...base, mode: "rotate" }, handlers);
    sync();
    t.onDragStartObservable.notifyObservers({} as never); // the move gizmo is no longer current
    expect(calls).toEqual([]);
  });

  it("finds a canvas point over a handle, and none elsewhere", () => {
    const a = node("a", [0, 0, 0]);
    expect(gizmo.gizmoActiveAt(256, 128)).toBe(false); // nothing selected
    gizmo.setGizmo([a], base, handlers);
    sync();
    overlay.utilityLayerScene.render(); // lays out the gizmo (the real frame does this)
    const g = internals().gizmos.translate!;
    const rootScale = g._rootMesh.scaling.x;
    expect(rootScale).toBeGreaterThan(0);
    const w = babylon.getRenderWidth(), h = babylon.getRenderHeight();
    // Aim at the base of the X arrow, through the camera the pick uses.
    const transform = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
    const p = BVector3.Project(new BVector3(rootScale * 0.1, 0, 0), Matrix.IdentityReadOnly, transform, camera.viewport.toGlobal(w, h));
    expect(gizmo.gizmoActiveAt(p.x, p.y)).toBe(true);
    expect(gizmo.gizmoActiveAt(2, 2)).toBe(false);
  });
});
