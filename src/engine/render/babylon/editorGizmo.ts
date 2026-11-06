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
import { GizmoCoordinatesMode } from "@babylonjs/core/Gizmos/gizmo.js";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo.js";
import { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo.js";
import { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Matrix4, Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from "three";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { localPoseFromWorld, type LocalPose } from "../gizmoMath";
import type { GizmoHandlers, GizmoOptions } from "../RenderSurface";
import type { BabylonEditorContext } from "./editorContext";

type AnyGizmo = PositionGizmo | RotationGizmo | ScaleGizmo;
type Mode = GizmoOptions["mode"];

const DEFAULT_STEPS = { move: 0.25, rotate: 15, scale: 0.1 };
const MODES: readonly Mode[] = ["translate", "rotate", "scale"];

/** A positive finite step, or 0 (Babylon's "no snapping"). */
const step = (n: number): number => (n > 0 && Number.isFinite(n) ? n : 0);

/** Every root mesh of a gizmo: its own and each axis/plane handle's (the handles are not its children). */
function gizmoRoots(g: AnyGizmo): Mesh[] {
  const parts = g instanceof PositionGizmo ? [g.xGizmo, g.yGizmo, g.zGizmo, g.xPlaneGizmo, g.yPlaneGizmo, g.zPlaneGizmo] : g instanceof RotationGizmo ? [g.xGizmo, g.yGizmo, g.zGizmo] : [g.xGizmo, g.yGizmo, g.zGizmo, g.uniformScaleGizmo];
  return [g._rootMesh, ...parts.map((p) => p._rootMesh)];
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
  private start: { proxy: Matrix4; targets: Matrix4[] } | null = null;

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

  /** Axes, space and snapping (the three.js gizmo's `applyGizmoOptions`). */
  private configure(g: AnyGizmo): void {
    const { planar, snap, space } = this.options;
    const steps = this.options.snapSteps ?? DEFAULT_STEPS;
    const coordinates = space === "local" ? GizmoCoordinatesMode.Local : GizmoCoordinatesMode.World;
    if (g instanceof PositionGizmo) {
      // Planar (2D view): X and Y arrows and the XY square; no Z, no XZ/YZ squares.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = true;
      g.zGizmo.isEnabled = !planar;
      g.xPlaneGizmo.isEnabled = g.yPlaneGizmo.isEnabled = !planar;
      g.zPlaneGizmo.isEnabled = true;
      g.snapDistance = snap ? step(steps.move) : 0;
      g.coordinatesMode = coordinates;
    } else if (g instanceof RotationGizmo) {
      // Planar: around Z only.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = !planar;
      g.zGizmo.isEnabled = true;
      g.snapDistance = snap ? (step(steps.rotate) * Math.PI) / 180 : 0;
      g.coordinatesMode = coordinates;
    } else {
      // Scaling is always along the node's own axes. Planar: X and Y only, no uniform handle.
      g.xGizmo.isEnabled = g.yGizmo.isEnabled = true;
      g.zGizmo.isEnabled = !planar;
      g.uniformScaleGizmo.isEnabled = !planar;
      g.snapDistance = snap ? step(steps.scale) : 0;
      g.incrementalSnap = true;
    }
  }

  // --- Drags ---------------------------------------------------------------------------------------

  /** The proxy's world matrix as three's (both libraries store a transform's 16 floats in the same order). */
  private proxyMatrix(): Matrix4 {
    return new Matrix4().fromArray(this.proxy.computeWorldMatrix(true).asArray());
  }

  private matrices(world: World): { proxy: Matrix4; targets: Matrix4[] } {
    return {
      proxy: this.proxyMatrix(),
      targets: this.targets.map((n) => new Matrix4().fromArray(world.worldMatrix(n.entity), n.entity * 16)),
    };
  }

  /**
   * The targets' local poses implied by how the gizmo has moved the proxy since the drag began: the
   * same change (new proxy x inverse of the start proxy) applied to each target's start pose.
   */
  private poses(): LocalPose[] | null {
    const start = this.start, world = this.world;
    if (!start || !world || !this.targets.every((n) => n.isValid)) return null;
    const now = this.proxyMatrix();
    const delta = now.clone().multiply(start.proxy.clone().invert());
    const position = new ThreeVector3(), quaternion = new ThreeQuaternion(), scale = new ThreeVector3();
    return this.targets.map((node, i) => {
      // A single node is exactly the proxy, so it never picks up rounding error.
      (this.targets.length === 1 ? now : delta.clone().multiply(start.targets[i])).decompose(position, quaternion, scale);
      const parent = node.parent;
      const parentWorld = parent ? new Matrix4().fromArray(world.worldMatrix(parent.entity), parent.entity * 16) : null;
      return localPoseFromWorld(parentWorld, position, quaternion, scale);
    });
  }
}
