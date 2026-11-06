// Collider gizmos (ADR 0022, 0039, 0045), like Unity's: every 2D and 3D collider in the scene is
// outlined in green (selected nodes' brighter): 3D ones as wireframes, mesh colliders by their
// triangles. With "Edit Collider" on, the collider gets handles: box edges (2D) or faces (3D)
// resize it (Alt: symmetric), circle and sphere handles set the radius, capsule handles its radius
// and height, polygon and edge vertices drag (snapping with Ctrl or "always snap"), a press on an
// edge's middle handle adds a vertex there and drags it, Ctrl+click on a vertex removes it, and
// the centre handle moves the offset. Each drag or click is one undo step (an override on prefab
// instances).
import { effect } from "@preact/signals";
import { BoxCollider, BoxCollider2D, CapsuleCollider, CircleCollider2D, Collider, Collider2D, EdgeCollider2D, GameObject, MeshCollider, PolygonCollider2D, SphereCollider, type Engine } from "../engine";
import { meshTriangleData, overlayHandleAt, pointOnPlane, pointOnSpritePlane, rayAt, addEditorOverlay, removeEditorOverlay, viewportCanvas, type EditorOverlay } from "../engine/editor";
import {
  boxHandles3D,
  boxWire,
  capsuleHandleAxis,
  capsuleHandles3D,
  capsuleWire,
  centerDelta,
  closestOnAxis,
  dragBoxFace3D,
  dragCapsuleHeight,
  dragCapsuleRadius,
  dragSphereRadius,
  meshOutline,
  meshWire,
  sphereHandles3D,
  sphereWire,
  worldCenter,
  type BoxFace3D,
  type MeshOutline,
  type Pose3D,
  type V3,
  type Wire,
} from "./collider3dMath";
import {
  boxCorners,
  boxHandles,
  circleHandles,
  circlePoints,
  dragBoxEdge,
  dragCircleRadius,
  insertPoint,
  movePoint,
  pointsHandle,
  pointsHandles,
  pointsOutline,
  readPoints,
  removePoint,
  tidy,
  toLocal,
  type BoxHandle,
  type Pose2D,
  type V2,
} from "./colliderMath";
import { SetField } from "./document";
import { cleanSnap, snapActive, snapSettings, snapTo } from "./sceneTools";
import { editingCollider, openScene, playState, selectedNodes, selectedWorldNode, selection, status, type EditingCollider } from "./state";
import { theme, viewportColors } from "./theme";

const COLOR = 0x3fae5a;
const COLOR_SELECTED = 0x9dff9d;
const HANDLE_CENTER = 0xffffff;
const HANDLE_INSERT = 0x9a7bd8;

/** A node's 2D world pose for collider math. */
export function poseOf(node: GameObject): Pose2D {
  const t = node.transform!;
  const p = t.worldPosition, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: t.worldRotation2D, scale: [s.x, s.y] };
}

/** A node's 3D world pose for collider math. */
export function pose3DOf(node: GameObject): Pose3D {
  const t = node.transform!;
  const p = t.worldPosition, q = t.worldRotation, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
}

type EditableCollider2D = BoxCollider2D | CircleCollider2D | PolygonCollider2D | EdgeCollider2D;
type EditableCollider3D = BoxCollider | SphereCollider | CapsuleCollider;
type EditableCollider = EditableCollider2D | EditableCollider3D;

const CLASSES: Record<EditingCollider["type"], typeof Collider2D | typeof Collider> = {
  "engine.BoxCollider2D": BoxCollider2D,
  "engine.CircleCollider2D": CircleCollider2D,
  "engine.PolygonCollider2D": PolygonCollider2D,
  "engine.EdgeCollider2D": EdgeCollider2D,
  "engine.BoxCollider": BoxCollider,
  "engine.SphereCollider": SphereCollider,
  "engine.CapsuleCollider": CapsuleCollider,
};

const is3D = (c: EditableCollider): c is EditableCollider3D => c instanceof Collider;

/** The collider types "Edit Collider" works on. */
export const EDITABLE_COLLIDERS: ReadonlySet<string> = new Set(Object.keys(CLASSES));

/** The collider being edited, if it's still there. */
function editedCollider(): { node: GameObject; collider: EditableCollider; editing: EditingCollider } | null {
  const editing = editingCollider.value;
  const node = selectedWorldNode();
  if (!editing || !node?.transform || selection.value !== editing.key) return null;
  const collider = node.getBehaviors(CLASSES[editing.type] as typeof Collider2D)[editing.index] as unknown as EditableCollider | undefined;
  return collider ? { node, collider, editing } : null;
}

const isPoints = (c: Collider2D): c is PolygonCollider2D | EdgeCollider2D => c instanceof PolygonCollider2D || c instanceof EdgeCollider2D;

/** Every 2D collider in the edited scene, with its outline in world space (open for edge colliders). */
export function colliderShapes(engine: Engine): { node: GameObject; points: [number, number, number][]; closed: boolean }[] {
  const out: { node: GameObject; points: [number, number, number][]; closed: boolean }[] = [];
  for (const c of GameObject.findObjectsOfType(Collider2D)) {
    const node = c.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const pose = poseOf(node);
    const center: V2 = [c.center.x, c.center.y];
    if (c instanceof BoxCollider2D) out.push({ node, points: boxCorners(pose, center, [c.size.x, c.size.y]), closed: true });
    else if (c instanceof CircleCollider2D) out.push({ node, points: circlePoints(pose, center, c.radius), closed: true });
    else if (isPoints(c)) out.push({ node, points: pointsOutline(pose, center, readPoints(c.points)), closed: c instanceof PolygonCollider2D });
  }
  return out;
}

/** Each mesh collider's outline, worked out once per mesh. */
const outlines = new WeakMap<object, MeshOutline>();

/** Each 3D collider's last wireframe and what it was made from (pose and shape), so an unchanged one isn't rebuilt every frame. */
const wires = new WeakMap<Collider, { key: string; source: unknown; wire: Wire }>();

/** Every 3D collider in the edited scene, as a wireframe in world space. Mesh colliders whose model is loading are left out. */
export function collider3dShapes(engine: Engine): { node: GameObject; wire: Wire }[] {
  const out: { node: GameObject; wire: Wire }[] = [];
  for (const c of GameObject.findObjectsOfType(Collider)) {
    const node = c.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const pose = pose3DOf(node);
    const center: V3 = [c.center.x, c.center.y, c.center.z];
    const mesh = c instanceof MeshCollider ? meshTriangleData(c.mesh, node) : null; // the same object while the mesh is unchanged
    if (c instanceof MeshCollider && !mesh) continue;
    const shape =
      c instanceof BoxCollider ? `b${c.size.x},${c.size.y},${c.size.z}` : c instanceof SphereCollider ? `s${c.radius}` : c instanceof CapsuleCollider ? `c${c.radius},${c.height},${c.direction}` : mesh ? "m" : null;
    if (shape === null) continue;
    const key = `${shape}|${pose.position}|${pose.rotation}|${pose.scale}|${center}`;
    const cached = wires.get(c);
    if (cached && cached.key === key && cached.source === mesh) {
      out.push({ node, wire: cached.wire });
      continue;
    }
    let wire: Wire;
    if (c instanceof BoxCollider) wire = boxWire(pose, center, [c.size.x, c.size.y, c.size.z]);
    else if (c instanceof SphereCollider) wire = sphereWire(pose, center, c.radius);
    else if (c instanceof CapsuleCollider) wire = capsuleWire(pose, center, c.radius, c.height, c.direction);
    else {
      let outline = outlines.get(mesh!);
      if (!outline) outlines.set(mesh!, (outline = meshOutline(mesh!.vertices, mesh!.indices)));
      wire = meshWire(pose, center, mesh!.vertices, mesh!.indices, outline);
    }
    wires.set(c, { key, source: mesh, wire });
    out.push({ node, wire });
  }
  return out;
}

/** The handles of a 3D collider being edited, by id. */
export function handles3D(node: GameObject, c: EditableCollider3D): Record<string, V3> {
  const pose = pose3DOf(node), center: V3 = [c.center.x, c.center.y, c.center.z];
  if (c instanceof BoxCollider) return boxHandles3D(pose, center, [c.size.x, c.size.y, c.size.z]);
  if (c instanceof SphereCollider) return sphereHandles3D(pose, center, c.radius);
  return capsuleHandles3D(pose, center, c.radius, c.height, c.direction);
}

/** What to draw this frame: outlines for every collider in the edited scene, handles for the one being edited. */
export function colliderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(selectedNodes().map((s) => s.node));
  for (const { node, points, closed } of colliderShapes(engine)) {
    if (points.length > 1) overlay.lines.push({ points, closed, color: selected.has(node) ? COLOR_SELECTED : COLOR });
  }
  for (const { node, wire } of collider3dShapes(engine)) {
    const color = selected.has(node) ? COLOR_SELECTED : COLOR;
    for (const points of wire) overlay.lines.push({ points, closed: false, color });
  }
  const edited = editedCollider();
  if (edited && is3D(edited.collider)) {
    const handle = viewportColors(theme.peek()).handle;
    for (const [id, position] of Object.entries(handles3D(edited.node, edited.collider))) overlay.handles.push({ id, position, color: id === "center" ? HANDLE_CENTER : handle });
  } else if (edited) {
    const { node } = edited;
    const collider = edited.collider as EditableCollider2D;
    const pose = poseOf(node);
    const center: V2 = [collider.center.x, collider.center.y];
    const handles: Record<string, [number, number, number]> =
      collider instanceof BoxCollider2D
        ? boxHandles(pose, center, [collider.size.x, collider.size.y])
        : collider instanceof CircleCollider2D
          ? circleHandles(pose, center, collider.radius)
          : pointsHandles(pose, center, readPoints(collider.points), collider instanceof PolygonCollider2D);
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    for (const [id, position] of Object.entries(handles)) {
      overlay.handles.push({ id, position, color: id === "center" ? HANDLE_CENTER : id.startsWith("insert:") ? HANDLE_INSERT : handle });
    }
  }
  return overlay;
}

/** Draw collider gizmos and let their handles be dragged. Returns a function that removes them. */
export function installColliderGizmo(engine: Engine): () => void {
  const world = engine.world;
  addEditorOverlay(world, "colliders", () => colliderOverlay(engine), "colliders");

  // Edit mode ends when the selection moves elsewhere (picking a tool ends it too: `pickTool`).
  const stopWatch = effect(() => {
    const key = selection.value, editing = editingCollider.peek();
    if (editing && editing.key !== key) editingCollider.value = null;
  });

  const canvas = viewportCanvas(world);
  if (!canvas) return () => (stopWatch(), removeEditorOverlay(world, "colliders"));

  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // Capture phase: a press on a handle must not also select, orbit or start the transform gizmo.
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || playState.value !== "edit") return;
    const edited = editedCollider();
    const scene = openScene.value;
    if (!edited || !scene) return;
    const at = local(e);
    const handle = overlayHandleAt(world, at.x, at.y);
    if (!handle) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (is3D(edited.collider)) {
      drag3D(e, handle, edited.node, edited.collider, edited.editing);
      return;
    }

    const { node, editing } = edited;
    const collider = edited.collider as EditableCollider2D;
    const pose = poseOf(node); // fixed for the drag
    const startCenter: V2 = [collider.center.x, collider.center.y];
    const startSize: V2 = collider instanceof BoxCollider2D ? [collider.size.x, collider.size.y] : [0, 0];
    const pointer = (m: PointerEvent): V2 | null => {
      const p = local(m);
      const w = pointOnSpritePlane(world, p.x, p.y, pose.position[2]);
      return w ? toLocal(pose, w) : null;
    };
    const grab = pointer(e);
    const offset: V2 = grab ? [grab[0] - startCenter[0], grab[1] - startCenter[1]] : [0, 0];
    const [id, ...target] = editing.key.split("/");
    const written = new Map<string, string>();
    const write = (field: string, value: unknown) => {
      const json = JSON.stringify(value);
      if (written.get(field) === json) return;
      written.set(field, json);
      scene.stack.execute(new SetField(id, editing.type, field, value, { index: editing.index, target }));
    };

    // Polygon and edge colliders: which vertex the drag moves (a new one for an edge's middle handle).
    const parsed = isPoints(collider) ? pointsHandle(handle) : null;
    const closed = collider instanceof PolygonCollider2D;
    let points = isPoints(collider) ? readPoints(collider.points) : [];
    let vertex = -1;
    if (parsed && parsed.kind === "vertex" && (e.ctrlKey || e.metaKey)) {
      // Ctrl+click removes the vertex: one step, no drag.
      const next = removePoint(points, parsed.index, closed);
      if (!next) {
        status.value = { kind: "info", text: `A ${closed ? "polygon" : "edge"} collider needs at least ${closed ? 3 : 2} points.` };
        return;
      }
      scene.stack.beginGroup("Remove collider vertex");
      write("points", next);
      scene.stack.endGroup();
      return;
    }
    canvas.setPointerCapture?.(e.pointerId);
    let label = handle === "center" ? "Move collider center" : "Resize collider";
    if (parsed?.kind === "vertex") {
      vertex = parsed.index;
      label = "Move collider vertex";
    } else if (parsed?.kind === "insert") {
      points = insertPoint(points, parsed.index);
      vertex = parsed.index + 1;
      label = "Add collider vertex";
    }
    scene.stack.beginGroup(label);
    if (parsed?.kind === "insert") write("points", points.map((p) => p.map(tidy)));

    const move = (m: PointerEvent) => {
      const p = pointer(m);
      if (!p) return;
      if (handle === "center") {
        write("center", [tidy(p[0] - offset[0]), tidy(p[1] - offset[1])]);
      } else if (vertex >= 0) {
        const step = snapActive.value ? cleanSnap(snapSettings.value).move : 0;
        const q: V2 = [snapTo(p[0] - startCenter[0], step), snapTo(p[1] - startCenter[1], step)];
        write("points", movePoint(points, vertex, q).map((v) => v.map(tidy)));
      } else if (collider instanceof BoxCollider2D) {
        const r = dragBoxEdge(handle as Exclude<BoxHandle, "center">, p, startCenter, startSize, m.altKey);
        write("size", r.size.map(tidy));
        if (!m.altKey || r.center[0] !== startCenter[0] || r.center[1] !== startCenter[1]) write("center", r.center.map(tidy));
      } else if (collider instanceof CircleCollider2D) {
        write("radius", tidy(dragCircleRadius(pose, p, startCenter)));
      }
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      scene.stack.endGroup();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  };
  /**
   * Drag a 3D collider's handle along its axis (to the point nearest the pointer's ray), or the
   * centre handle across the plane through it that faces the camera.
   */
  const drag3D = (e: PointerEvent, handle: string, node: GameObject, collider: EditableCollider3D, editing: EditingCollider) => {
    const scene = openScene.value!;
    const pose = pose3DOf(node); // fixed for the drag
    const startCenter: V3 = [collider.center.x, collider.center.y, collider.center.z];
    const c0 = worldCenter(pose, startCenter);
    const start = local(e);
    const ray0 = rayAt(world, start.x, start.y);
    if (!ray0) return;
    const [id, ...target] = editing.key.split("/");
    const written = new Map<string, string>();
    const write = (field: string, value: unknown) => {
      const json = JSON.stringify(value);
      if (written.get(field) === json) return;
      written.set(field, json);
      scene.stack.execute(new SetField(id, editing.type, field, value, { index: editing.index, target }));
    };
    const grabbed = handles3D(node, collider)[handle];
    if (!grabbed) return;
    let axis: V3 | null = null;
    if (handle !== "center") {
      if (collider instanceof CapsuleCollider) {
        axis = capsuleHandleAxis(handle, pose, collider.direction);
        if (handle.endsWith("-")) axis = [-axis[0], -axis[1], -axis[2]];
      } else {
        const d = [grabbed[0] - c0[0], grabbed[1] - c0[1], grabbed[2] - c0[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len < 1e-9) return;
        axis = [d[0] / len, d[1] / len, d[2] / len];
      }
    }
    // Where along the handle's line the press was, so the handle doesn't jump to the pointer.
    const t0 = axis ? closestOnAxis(ray0.origin, ray0.direction, c0, axis) : null;
    const handleT = axis ? (grabbed[0] - c0[0]) * axis[0] + (grabbed[1] - c0[1]) * axis[1] + (grabbed[2] - c0[2]) * axis[2] : 0;
    const normal: V3 = [-ray0.direction[0], -ray0.direction[1], -ray0.direction[2]];
    const grab0 = handle === "center" ? pointOnPlane(world, start.x, start.y, normal, c0) : null;
    const startSize: V3 = collider instanceof BoxCollider ? [collider.size.x, collider.size.y, collider.size.z] : [0, 0, 0];
    canvas.setPointerCapture?.(e.pointerId);
    scene.stack.beginGroup(handle === "center" ? "Move collider center" : "Resize collider");
    const move = (m: PointerEvent) => {
      const p = local(m);
      if (handle === "center") {
        const hit = pointOnPlane(world, p.x, p.y, normal, c0);
        if (!hit || !grab0) return;
        const delta = centerDelta(pose, [hit[0] - grab0[0], hit[1] - grab0[1], hit[2] - grab0[2]]);
        write("center", startCenter.map((v, i) => tidy(v + delta[i])));
        return;
      }
      const ray = rayAt(world, p.x, p.y);
      const t = ray && axis ? closestOnAxis(ray.origin, ray.direction, c0, axis) : null;
      if (t === null || t0 === null) return;
      // How far out the handle is now (along its own outward axis).
      const reach = handleT + (t - t0);
      if (collider instanceof BoxCollider) {
        const face = handle as BoxFace3D;
        // dragBoxFace3D takes the signed position along the node's axis.
        const r = dragBoxFace3D(face, face.endsWith("+") ? reach : -reach, pose, startCenter, startSize, m.altKey);
        write("size", r.size.map(tidy));
        if (!m.altKey || r.center.some((v, i) => v !== startCenter[i])) write("center", r.center.map(tidy));
      } else if (collider instanceof SphereCollider) {
        write("radius", tidy(dragSphereRadius(reach, pose)));
      } else if (handle.startsWith("height")) {
        write("height", tidy(dragCapsuleHeight(reach, pose, collider.direction)));
      } else {
        write("radius", tidy(dragCapsuleRadius(reach, pose, collider.direction)));
      }
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      scene.stack.endGroup();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  };
  canvas.addEventListener("pointerdown", onDown, { capture: true });
  return () => {
    stopWatch();
    canvas.removeEventListener("pointerdown", onDown, { capture: true });
    removeEditorOverlay(world, "colliders");
    editingCollider.value = null;
  };
}
