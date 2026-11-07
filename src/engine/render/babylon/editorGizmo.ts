/**
 * The editor's transform gizmo on the Babylon backend (ADR 0022, ADR 0075 stage 8): Babylon's
 * position, rotation and scale gizmos on the overlay utility layer, attached to a proxy
 * TransformNode that is placed from the selected nodes' world matrices every frame.
 *
 * The engine's node graph stays authoritative (ADR 0010). Babylon moves only the proxy; a drag turns
 * the proxy's change since the drag began into each target's new local pose (`localPoseFromWorld`)
 * and reports it through the handlers. The editor writes the components, and the next `sync` moves
 * the proxy to match.
 *
 * Pointer input comes from Babylon's utility layer: the overlay scene picks with the overlay's render
 * camera on the main scene's pre-pointer events. The coordinator must therefore have attached the main
 * scene's input to the canvas (`scene.attachControl()`) and keep `scene.cameraToUseForPointers` on the
 * view camera. `sync` itself sets `overlay.setRenderCamera(view camera)` while the gizmo shows.
 */
import "@babylonjs/core/Culling/ray.js"; // Scene.pick, for gizmoActiveAt
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { GizmoCoordinatesMode } from "@babylonjs/core/Gizmos/gizmo.js";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo.js";
import { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo.js";
import { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mat4, Quat, Quaternion as EngineQuaternion, Vector3 as EngineVector3 } from "../../core/math";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { composeMatrix, localPoseFromMatrix, matrixFrom, type LocalPose } from "../gizmoMath";
import type { GizmoHandlers, GizmoOptions } from "../RenderSurface";
import type { BabylonEditorContext } from "./editorContext";

type AnyGizmo = PositionGizmo | RotationGizmo | ScaleGizmo;
type Mode = GizmoOptions["mode"];

const DEFAULT_STEPS = { move: 0.25, rotate: 15, scale: 0.1 };
const MODES: readonly Mode[] = ["translate", "rotate", "scale"];

/** A positive finite step, or 0 (no snapping). */
const step = (n: number): number => (n > 0 && Number.isFinite(n) ? n : 0);

type Part = PositionGizmo["xGizmo"] | PositionGizmo["xPlaneGizmo"] | RotationGizmo["xGizmo"] | ScaleGizmo["xGizmo"];

/** Every sub-gizmo (axis, plane and uniform handles) with the axes it drags: three's `axis` string ("X", "YZ", "XYZ"). */
function gizmoParts(g: AnyGizmo): { part: Part; axes: string }[] {
  if (g instanceof PositionGizmo) {
    // A plane gizmo is named by its normal: the X plane drags Y and Z (three's "YZ" square).
    return [
      { part: g.xGizmo, axes: "X" }, { part: g.yGizmo, axes: "Y" }, { part: g.zGizmo, axes: "Z" },
      { part: g.xPlaneGizmo, axes: "YZ" }, { part: g.yPlaneGizmo, axes: "XZ" }, { part: g.zPlaneGizmo, axes: "XY" },
    ];
  }
  if (g instanceof RotationGizmo) return [{ part: g.xGizmo, axes: "X" }, { part: g.yGizmo, axes: "Y" }, { part: g.zGizmo, axes: "Z" }];
  return [{ part: g.xGizmo, axes: "X" }, { part: g.yGizmo, axes: "Y" }, { part: g.zGizmo, axes: "Z" }, { part: g.uniformScaleGizmo, axes: "XYZ" }];
}

/** Every root mesh of a gizmo: its own and each axis/plane handle's (the handles are not its children). */
function gizmoRoots(g: AnyGizmo): Mesh[] {
  return [g._rootMesh, ...gizmoParts(g).map((p) => p.part._rootMesh)];
}

// --- On-screen size: matching three's TransformControls ---------------------------------------------
//
// three (TransformControls.updateMatrixWorld) scales every handle by `factor * size / 4`, where
//   perspective:  factor = distance(gizmo, camera) * min(1.9 * tan(fov / 2) / zoom, 7)
//                 (1.9 * tan(fov / 2) * distance is 0.95 x the visible world height at the gizmo)
//   orthographic: factor = (top - bottom) / zoom   (the visible world height)
// and its geometry is authored in unit-ish handle units: the move arrow's tip is 0.6 out, the
// rotation ring's radius 0.5, the scale handle's far edge 0.58.
//
// Babylon (Gizmo._update, updateScale on) sets the gizmo root's scale to `scaleRatio x depth along the
// camera's forward axis` (perspective: depth, not distance, so it shrinks toward the screen edge and
// ignores fov) or `scaleRatio x (orthoTop - orthoBottom)`. Its geometry is authored smaller and under a
// 1/3 child scale: the move arrow's tip is 0.3375 / 3 = 0.1125 out, the ring's radius 0.3 / 3 = 0.1,
// the scale box's far edge 0.32 / 3 = 0.1067.
//
// So the root scale that puts Babylon's handles where three's are is
//   R = (factor * size / 4) * (three reach / Babylon reach)
// per mode (the ratios are 5.333, 5 and 5.4375). We turn `updateScale` off and set `scaleRatio = R`
// (with updateScale off Babylon sets the root scale to exactly `scaleRatio`) every frame, using three's
// own distance and fov terms, so even off-centre gizmos match. `zoom` is 1 here: Babylon's orthographic
// zoom is already in orthoTop/orthoBottom. `size` is three's default of 1.

/** TransformControls.size. */
const GIZMO_SIZE = 1;
const THREE_REACH: Record<Mode, number> = { translate: 0.6, rotate: 0.5, scale: 0.58 };
const BABYLON_REACH: Record<Mode, number> = { translate: 0.3375 / 3, rotate: 0.3 / 3, scale: 0.32 / 3 };

/** The root scale (Babylon `scaleRatio` with `updateScale` off) giving a `mode` gizmo at `at` the on-screen size three's TransformControls draws. */
export function gizmoRootScale(mode: Mode, camera: Camera, at: Vector3): number {
  let factor: number;
  if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
    factor = (camera.orthoTop ?? 1) - (camera.orthoBottom ?? -1);
  } else {
    let fov = camera.fov; // vertical, as three's
    if (camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED) fov = 2 * Math.atan(Math.tan(fov / 2) / camera.getScene().getEngine().getAspectRatio(camera));
    factor = Vector3.Distance(at, camera.getWorldMatrix().getTranslation()) * Math.min(1.9 * Math.tan(fov / 2), 7);
  }
  return ((factor * GIZMO_SIZE) / 4) * (THREE_REACH[mode] / BABYLON_REACH[mode]);
}

/** three's per-axis rounding: each axis in `mask` to a multiple of `st` (`keepNonZero`: scale, never to 0). */
function roundAxes(v: EngineVector3, mask: string, st: number, keepNonZero = false): void {
  const r = (x: number) => (Math.round(x / st) * st || (keepNonZero ? st : 0)) + 0; // + 0: no negative zero
  if (mask.includes("X")) v.x = r(v.x);
  if (mask.includes("Y")) v.y = r(v.y);
  if (mask.includes("Z")) v.z = r(v.z);
}

export class BabylonEditorGizmo {
  private readonly proxy: TransformNode;
  private readonly gizmos: Partial<Record<Mode, AnyGizmo>> = {};
  private targets: readonly GameObject[] = [];
  private options: GizmoOptions = { mode: "translate", planar: false, snap: false };
  private handlers: GizmoHandlers | null = null;
  /** The last World `sync` saw; drags read the nodes' matrices from it. */
  private world: World | null = null;
  /** Whether the targets are all drawable and a view camera exists (set by `sync`). */
  private ok = false;
  private dragging = false;
  /** World matrices when the drag started: the proxy's and each target's. */
  private start: { proxy: Float64Array; targets: Float64Array[] } | null = null;
  /** The axes the dragged handle moves ("X", "YZ", "XYZ"...), or null (snapping then treats every axis as dragged). */
  private axes: string | null = null;
  /** The view camera (set by `sync`), for the gizmo's screen-constant size. */
  private camera: Camera | null = null;

  constructor(private readonly ctx: BabylonEditorContext) {
    this.proxy = new TransformNode("myco.gizmoProxy", ctx.scene);
    this.proxy.rotationQuaternion = Quaternion.Identity(); // gizmos write rotation here, not into Euler angles
  }

  /**
   * Show a move/rotate/scale gizmo on `nodes` (none, or no handlers, hides it). One node: the gizmo
   * sits on it. Several: at their centre or on the active node's origin (`options.pivot`), moving,
   * turning or scaling them all around that point. Don't pass a node together with a descendant of it.
   */
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.targets = nodes;
    this.options = options;
    this.handlers = handlers;
    const wanted = nodes.length > 0 && handlers ? options.mode : null;
    if (wanted && !this.gizmos[wanted]) this.gizmos[wanted] = this.create(wanted);
    const world = this.world ?? this.ctx.world();
    if (world && !this.dragging) this.place(world);
    this.refresh();
  }

  /** True while dragging the gizmo, or if a canvas point (CSS pixels) is over one of its handles. */
  gizmoActiveAt(x: number, y: number): boolean {
    if (this.dragging) return true;
    const gizmo = this.shown();
    if (!gizmo) return false;
    const layer = this.ctx.overlay;
    const camera = layer.getRenderCamera();
    if (!camera) return false;
    const roots = gizmoRoots(gizmo);
    const hit = layer.utilityLayerScene.pick(x, y, (m) => m.isPickable && m.isEnabled() && roots.some((r) => m.isDescendantOf(r)), false, camera);
    return !!hit?.hit;
  }

  /** Each frame after the renderer's sync: place the proxy on the targets and show or hide the gizmo. */
  sync(world: World): void {
    this.world = world;
    const view = this.ctx.viewCameras()[0];
    const camera = view ? this.ctx.babylonCamera(view) : null;
    const nodes = this.targets.filter((n) => n.isValid && n.transform && n.activeInHierarchy);
    this.camera = camera;
    this.ok = !!camera && nodes.length > 0 && nodes.length === this.targets.length;
    if (camera && this.ok && this.ctx.overlay.getRenderCamera() !== camera) this.ctx.overlay.setRenderCamera(camera);
    if (this.ok && !this.dragging) this.place(world);
    this.refresh();
  }

  dispose(): void {
    for (const g of Object.values(this.gizmos)) g?.dispose();
    this.proxy.dispose();
    this.world = null;
    this.handlers = null;
  }

  // --- Proxy placement ----------------------------------------------------------------------------

  /** Move the proxy onto the targets (a single node's pose, or the centre/pivot of several). */
  private place(world: World): void {
    const nodes = this.targets.filter((n) => n.isValid && n.transform);
    if (nodes.length === 0) return;
    const proxy = this.proxy;
    const rotation = proxy.rotationQuaternion!;
    const worldOf = (n: GameObject) => Matrix.FromArray(world.worldMatrix(n.entity), n.entity * 16);
    if (nodes.length === 1) {
      worldOf(nodes[0]).decompose(proxy.scaling, rotation, proxy.position);
    } else {
      // Several: at their centre or on the active node's origin; turned like the active node in local space, else with the world.
      const { pivot, space, activeIndex } = this.options;
      const active = nodes[Math.min(Math.max(activeIndex ?? nodes.length - 1, 0), nodes.length - 1)];
      worldOf(active).decompose(undefined, rotation, proxy.position);
      if (pivot !== "pivot") {
        const sum = new Vector3();
        for (const n of nodes) sum.addInPlace(worldOf(n).getTranslation());
        proxy.position.copyFrom(sum.scaleInPlace(1 / nodes.length));
      }
      if (space !== "local") rotation.copyFromFloats(0, 0, 0, 1);
      proxy.scaling.setAll(1);
    }
    proxy.computeWorldMatrix(true);
  }

  // --- Gizmos --------------------------------------------------------------------------------------

  private create(mode: Mode): AnyGizmo {
    const layer = this.ctx.overlay;
    const gizmo: AnyGizmo = mode === "translate" ? new PositionGizmo(layer) : mode === "rotate" ? new RotationGizmo(layer) : new ScaleGizmo(layer);
    // Babylon's own screen-constant scaling is replaced by three's (`gizmoRootScale`), and its snapping is off:
    // it is incremental from the drag start, three's is to the absolute grid (`snapped`).
    for (const { part, axes } of gizmoParts(gizmo)) {
      part.updateScale = false;
      part.dragBehavior.onDragStartObservable.add(() => {
        this.axes = axes;
      });
    }
    gizmo.onDragStartObservable.add(() => {
      if (this.current() !== gizmo || !this.handlers) return;
      this.dragging = true;
      this.start = this.world ? this.matrices(this.world) : null;
      this.handlers.onStart();
    });
    gizmo.onDragObservable.add(() => {
      if (!this.dragging || this.current() !== gizmo) return;
      const poses = this.poses();
      if (poses) this.handlers?.onChange(poses);
    });
    gizmo.onDragEndObservable.add(() => {
      if (!this.dragging || this.current() !== gizmo) return;
      this.endDrag();
    });
    return gizmo;
  }

  /** The gizmo for the current mode when something is selected, or null. */
  private current(): AnyGizmo | null {
    if (!this.handlers || this.targets.length === 0) return null;
    return this.gizmos[this.options.mode] ?? null;
  }

  /** The current gizmo if it is attached (visible). */
  private shown(): AnyGizmo | null {
    const g = this.current();
    return g && this.ok && g.attachedNode ? g : null;
  }

  private endDrag(): void {
    this.dragging = false;
    this.start = null;
    this.axes = null;
    this.handlers?.onEnd();
  }

  /** Apply the options to the current gizmo and attach it to the proxy; detach and hide every other one. */
  private refresh(): void {
    const current = this.current();
    const visible = this.ok ? current : null;
    if (this.dragging && !visible) {
      // Hidden mid-drag (selection cleared, mode switched): let go and report the end.
      for (const g of Object.values(this.gizmos)) g?.releaseDrag();
      this.endDrag();
    }
    for (const mode of MODES) {
      const g = this.gizmos[mode];
      if (g && g !== current) this.detach(g);
    }
    if (!current) return;
    if (!visible) {
      this.detach(current);
      return;
    }
    this.resize(current);
    if (this.dragging) return;
    this.configure(current);
    // Re-attaching hands the node to whichever sub-gizmos are enabled now.
    current.attachedNode = null;
    current.attachedNode = this.proxy;
    current._rootMesh.setEnabled(true);
  }

  private detach(g: AnyGizmo): void {
    if (g.attachedNode) g.attachedNode = null;
    g._rootMesh.setEnabled(false);
  }

  /** Give every handle three's on-screen size (each frame: the camera and the proxy move). */
  private resize(g: AnyGizmo): void {
    if (!this.camera) return;
    const scale = gizmoRootScale(this.options.mode, this.camera, this.proxy.position);
    for (const { part } of gizmoParts(g)) part.scaleRatio = scale;
    g.scaleRatio = scale;
  }

  /** Axes and space (the three.js gizmo's `applyGizmoOptions`); snapping is done in `snapped`, not by Babylon. */
  private configure(g: AnyGizmo): void {
    const { planar, space } = this.options;
    const coordinates = space === "local" ? GizmoCoordinatesMode.Local : GizmoCoordinatesMode.World;
    if (g instanceof PositionGizmo) {
      // Planar (2D view): X and Y arrows and the XY square; no Z, no XZ/YZ squares.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = true;
      g.zGizmo.isEnabled = !planar;
      g.xPlaneGizmo.isEnabled = g.yPlaneGizmo.isEnabled = !planar;
      g.zPlaneGizmo.isEnabled = true;
      g.snapDistance = 0;
      g.coordinatesMode = coordinates;
    } else if (g instanceof RotationGizmo) {
      // Planar: around Z only.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = !planar;
      g.zGizmo.isEnabled = true;
      g.snapDistance = 0;
      g.coordinatesMode = coordinates;
    } else {
      // Scaling is always along the node's own axes. Planar: X and Y only, no uniform handle.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = true;
      g.zGizmo.isEnabled = !planar;
      g.uniformScaleGizmo.isEnabled = !planar;
      g.snapDistance = 0;
      g.incrementalSnap = false;
    }
  }

  // --- Drags ---------------------------------------------------------------------------------------

  /** The proxy's world matrix (Babylon stores a transform's 16 floats in the engine's order). */
  private proxyMatrix(): Float64Array {
    return matrixFrom(this.proxy.computeWorldMatrix(true).asArray());
  }

  private matrices(world: World): { proxy: Float64Array; targets: Float64Array[] } {
    return {
      proxy: this.proxyMatrix(),
      targets: this.targets.map((n) => matrixFrom(world.worldMatrix(n.entity), n.entity * 16)),
    };
  }

  /**
   * The proxy's pose `now` with three's TransformControls snapping applied. The proxy itself stays where the
   * pointer put it, so the next drag step doesn't fight the rounding. `start` is the proxy's matrix when the
   * drag began. As in three, only the dragged handle's axes snap:
   *  - translate: the proxy's world position rounds to multiples of the step (an absolute grid), per axis; in
   *    local space the position is rounded in the proxy's start orientation instead;
   *  - rotate: the turn since the drag began, about the dragged axis (the world axis, or the proxy's own in
   *    local space), rounds to a multiple of the step angle;
   *  - scale: the proxy's scale rounds to a multiple of the step per axis (never to 0).
   */
  private snapped(now: Float64Array, start: Float64Array): Float64Array {
    const { snap, mode, space } = this.options;
    if (!snap) return now;
    const steps = this.options.snapSteps ?? DEFAULT_STEPS;
    const mask = this.axes ?? "XYZ";
    const p = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1], sq = [0, 0, 0, 1];
    Mat4.decompose(now, 0, p, 0, q, 0, s, 0);
    Mat4.decompose(start, 0, [0, 0, 0], 0, sq, 0, [1, 1, 1], 0);
    const position = new EngineVector3(p[0], p[1], p[2]), scale = new EngineVector3(s[0], s[1], s[2]);
    let quaternion = new EngineQuaternion(q[0], q[1], q[2], q[3]);
    const startQuaternion = new EngineQuaternion(sq[0], sq[1], sq[2], sq[3]);
    if (mode === "translate") {
      const st = step(steps.move);
      if (!st) return now;
      if (space === "local") Quat.rotate(Quat.conjugate(startQuaternion), position);
      roundAxes(position, mask, st);
      if (space === "local") Quat.rotate(startQuaternion, position);
    } else if (mode === "rotate") {
      const st = (step(steps.rotate) * Math.PI) / 180;
      if (!st || mask.length !== 1) return now;
      const axis = new EngineVector3(mask === "X" ? 1 : 0, mask === "Y" ? 1 : 0, mask === "Z" ? 1 : 0);
      if (space === "local") Quat.rotate(startQuaternion, axis);
      const turn = quaternion.clone().multiply(Quat.conjugate(startQuaternion));
      const angle = 2 * Math.atan2(turn.x * axis.x + turn.y * axis.y + turn.z * axis.z, turn.w);
      quaternion = Quat.fromAxisAngle(axis.x, axis.y, axis.z, Math.round(angle / st) * st).multiply(startQuaternion);
    } else {
      const st = step(steps.scale);
      if (!st) return now;
      roundAxes(scale, mask, st, true);
    }
    return composeMatrix(position, quaternion, scale);
  }

  /**
   * The targets' local poses implied by how the gizmo has moved the proxy since the drag began: the
   * same change (new proxy x inverse of the start proxy) applied to each target's start pose.
   */
  private poses(): LocalPose[] | null {
    const start = this.start, world = this.world;
    if (!start || !world || !this.targets.every((n) => n.isValid)) return null;
    const now = this.snapped(this.proxyMatrix(), start.proxy);
    const startInverse = new Float64Array(16);
    Mat4.invert(startInverse, 0, start.proxy, 0);
    const delta = new Float64Array(16);
    Mat4.multiply(delta, 0, now, 0, startInverse, 0);
    const moved = new Float64Array(16);
    return this.targets.map((node, i) => {
      // A single node is exactly the proxy, so it never picks up rounding error.
      if (this.targets.length === 1) moved.set(now);
      else Mat4.multiply(moved, 0, delta, 0, start.targets[i], 0);
      const parent = node.parent;
      const parentWorld = parent ? matrixFrom(world.worldMatrix(parent.entity), parent.entity * 16) : null;
      return localPoseFromMatrix(parentWorld, moved);
    });
  }
}
