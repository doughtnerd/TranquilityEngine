// ADR 0075 stage 8: the editor's transform gizmo on the Babylon backend, run headless on Babylon's
// NullEngine with a real utility layer.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
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
import { BabylonEditorGizmo, gizmoRootScale } from "../render/babylon/editorGizmo";
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

  it("leaves Babylon's own snapping off and takes over sizing (snapping is done on the pose; see below)", () => {
    const a = node("a", [0, 0, 0]);
    for (const mode of ["translate", "rotate", "scale"] as const) {
      gizmo.setGizmo([a], { ...base, mode, snap: true }, handlers);
      sync();
      const g = internals().gizmos[mode]!;
      expect(g.snapDistance).toBe(0);
      expect(g.updateScale).toBe(false);
      expect(g.scaleRatio).toBeCloseTo(gizmoRootScale(mode, camera, BVector3.Zero()), 8);
    }
  });

  // three's TransformControls: handle scale = factor * size / 4 with factor = distance * 1.9 * tan(fov / 2)
  // (perspective) or the visible height (orthographic); reaches 0.6 / 0.5 / 0.58 against Babylon's 0.1125 / 0.1 / 0.10667.
  it("sizes the gizmo like three's TransformControls for a perspective camera", () => {
    camera.fov = Math.PI / 2; // tan(fov / 2) = 1
    const at = new BVector3(0, 0, 0); // 10 from the camera at z = 10
    expect(gizmoRootScale("translate", camera, at)).toBeCloseTo(((10 * 1.9) / 4) * (0.6 / (0.3375 / 3)), 8);
    expect(gizmoRootScale("rotate", camera, at)).toBeCloseTo(((10 * 1.9) / 4) * 5, 8);
    expect(gizmoRootScale("scale", camera, at)).toBeCloseTo(((10 * 1.9) / 4) * (0.58 / (0.32 / 3)), 8);
    // Distance, not depth: the same point 5 units off to the side is further away, so bigger.
    expect(gizmoRootScale("translate", camera, new BVector3(5, 0, 0))).toBeCloseTo((gizmoRootScale("translate", camera, at) * Math.sqrt(125)) / 10, 8);
    camera.fov = 0.5;
    expect(gizmoRootScale("rotate", camera, at)).toBeCloseTo(((10 * 1.9 * Math.tan(0.25)) / 4) * 5, 8);
  });

  it("sizes the gizmo like three's TransformControls for an orthographic camera", () => {
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoTop = 3;
    camera.orthoBottom = -3; // visible height 6, whatever the distance
    expect(gizmoRootScale("translate", camera, BVector3.Zero())).toBeCloseTo((6 / 4) * (0.6 / (0.3375 / 3)), 8);
    expect(gizmoRootScale("rotate", camera, new BVector3(0, 0, -50))).toBeCloseTo((6 / 4) * 5, 8);
    camera.orthoTop = 1;
    camera.orthoBottom = -1; // zoomed in 3x
    expect(gizmoRootScale("scale", camera, BVector3.Zero())).toBeCloseTo((2 / 4) * (0.58 / (0.32 / 3)), 8);
  });

  it("applies that size to the root of every handle each frame", () => {
    const a = node("a", [0, 0, 0]);
    gizmo.setGizmo([a], base, handlers);
    sync();
    const g = internals().gizmos.translate!;
    overlay.utilityLayerScene.render();
    const near = g.xGizmo._rootMesh.scaling.x;
    expect(near).toBeCloseTo(gizmoRootScale("translate", camera, BVector3.Zero()), 6);
    expect(g.xPlaneGizmo.scaleRatio).toBeCloseTo(near, 6);
    const far = node("far", [0, 0, -10]); // twice as far from the camera: twice the size
    gizmo.setGizmo([far], base, handlers);
    sync();
    expect(g.zGizmo.scaleRatio).toBeCloseTo(near * 2, 6);
  });

  /** Start a drag on a handle, as Babylon's pointer behaviour does, then move the proxy by hand and report. */
  const drag = (g: PositionGizmo | RotationGizmo | ScaleGizmo, handle: { dragBehavior: { onDragStartObservable: { notifyObservers(e: never): void } } }, move: () => void) => {
    handle.dragBehavior.onDragStartObservable.notifyObservers({ dragPlanePoint: BVector3.Zero(), dragPlaneNormal: BVector3.Up(), pointerId: 1 } as never);
    move();
    g.onDragObservable.notifyObservers({} as never);
  };
  const snapOn = { ...base, snap: true, snapSteps: { move: 0.5, rotate: 30, scale: 0.25 } };

  it("snaps a translate drag to the absolute world grid from an off-grid start, on the dragged axes only", () => {
    const a = node("a", [0.13, 0.13, 0.13]);
    gizmo.setGizmo([a], { ...snapOn, mode: "translate" }, handlers);
    sync();
    const t = internals().gizmos.translate!;
    drag(t, t.xGizmo, () => (proxy().position.x += 0.3)); // 0.43 -> nearest multiple of 0.5 is 0.5 (not 0.13 + 0.5)
    expect(changes.at(-1)![0].position).toEqual([0.5, 0.13, 0.13]);
    proxy().position.x += 0.1; // 0.53 -> 0.5
    t.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].position[0]).toBe(0.5);
    proxy().position.x += 0.2; // 0.73 -> 0.5
    t.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].position[0]).toBe(0.5);
    proxy().position.x += 0.1; // 0.83 -> 1
    t.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].position[0]).toBe(1);
    t.xGizmo.dragBehavior.onDragEndObservable.notifyObservers({} as never);

    // A plane handle snaps its two axes (the Z plane: X and Y); the third is untouched.
    sync();
    drag(t, t.zPlaneGizmo, () => proxy().position.set(1.3, -0.2, 0.9));
    expect(changes.at(-1)![0].position).toEqual([1.5, 0, 0.9]);
  });

  it("snaps translation in the node's own axes in local space, and the centre of a selection in world space", () => {
    const a = node("a", [0.13, 0, 0], [0, 0, 90]); // local X is world Y
    gizmo.setGizmo([a], { ...snapOn, space: "local" }, handlers);
    sync();
    const t = internals().gizmos.translate!;
    drag(t, t.xGizmo, () => proxy().position.set(0.13, 0.7, 0)); // along local X: 0.7 -> 0.5; world X stays
    const p = changes.at(-1)![0].position;
    expect(p[0]).toBeCloseTo(0.13, 4);
    expect(p[1]).toBeCloseTo(0.5, 4);
    t.xGizmo.dragBehavior.onDragEndObservable.notifyObservers({} as never);

    GameObject.destroy(a);
    const b = node("b", [1.1, 0, 0]);
    const c = node("c", [3.1, 0, 0]);
    gizmo.setGizmo([b, c], { ...snapOn, space: "world" }, handlers); // centre (2.1, 0, 0)
    sync();
    drag(t, t.xGizmo, () => (proxy().position.x += 0.2)); // centre 2.3 -> 2.5: the pair moves by +0.4
    const [pb, pc] = changes.at(-1)!;
    expect(pb.position[0]).toBeCloseTo(1.5, 4);
    expect(pc.position[0]).toBeCloseTo(3.5, 4);
  });

  it("snaps rotation to the step angle counted from the drag start, to the nearest step", () => {
    const a = node("a", [0, 0, 0], [0, 0, 20]); // off-grid start: 20 degrees
    gizmo.setGizmo([a], { ...snapOn, mode: "rotate" }, handlers);
    sync();
    const r = internals().gizmos.rotate!;
    const turn = (deg: number) => proxy().rotationQuaternion!.copyFrom(BQuaternion.FromEulerAngles(0, 0, ((20 + deg) * Math.PI) / 180));
    drag(r, r.zGizmo, () => turn(10)); // 10 degrees -> nearest 30 is 0
    expect(changes.at(-1)![0].rotation[2]).toBeCloseTo(20, 3);
    turn(20); // 20 degrees -> 30, from the start: 20 + 30 = 50 (not 60, the absolute grid)
    r.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].rotation[2]).toBeCloseTo(50, 3);
    turn(-50); // -50 -> -60
    r.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].rotation[2]).toBeCloseTo(-40, 3);
  });

  it("snaps scale to an absolute multiple of the step per axis and never to zero", () => {
    const a = node("a", [0, 0, 0]);
    a.transform!.scale.set(1.13, 0.9, 1.0);
    gizmo.setGizmo([a], { ...snapOn, mode: "scale" }, handlers);
    sync();
    const s = internals().gizmos.scale!;
    drag(s, s.xGizmo, () => proxy().scaling.set(1.4, 0.9, 1)); // 1.4 -> 1.5 (step 0.25); Y stays off-grid, not dragged
    expect(changes.at(-1)![0].scale[0]).toBeCloseTo(1.5, 5);
    expect(changes.at(-1)![0].scale[1]).toBeCloseTo(0.9, 5);
    proxy().scaling.set(0.05, 0.9, 1); // would round to 0: stays at one step
    s.onDragObservable.notifyObservers({} as never);
    expect(changes.at(-1)![0].scale[0]).toBeCloseTo(0.25, 5);
    s.xGizmo.dragBehavior.onDragEndObservable.notifyObservers({} as never);

    sync();
    drag(s, s.uniformScaleGizmo, () => proxy().scaling.set(1.3, 0.9, 1.1)); // the uniform handle snaps all three
    expect(changes.at(-1)![0].scale.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1.25, 1, 1]);
  });

  it("does not snap when snapping is off or a step is invalid", () => {
    const a = node("a", [0.13, 0, 0]);
    gizmo.setGizmo([a], { ...base, snapSteps: { move: 0.5, rotate: 30, scale: 0.25 } }, handlers);
    sync();
    const t = internals().gizmos.translate!;
    drag(t, t.xGizmo, () => (proxy().position.x += 0.3));
    expect(changes.at(-1)![0].position[0]).toBeCloseTo(0.43, 5);
    t.xGizmo.dragBehavior.onDragEndObservable.notifyObservers({} as never);
    gizmo.setGizmo([a], { ...base, snap: true, snapSteps: { move: 0, rotate: 30, scale: 0.25 } }, handlers);
    sync();
    drag(t, t.xGizmo, () => (proxy().position.x += 0.3));
    expect(changes.at(-1)![0].position[0]).toBeCloseTo(0.43, 5);
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
