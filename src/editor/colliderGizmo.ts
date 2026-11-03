// Collider gizmos (ADR 0022, 0039), like Unity's: every 2D collider in the scene is outlined in
// green (selected nodes' brighter). With "Edit Collider" on, the collider gets handles: box edges
// resize it (Alt: symmetric), circle rim handles set the radius, polygon and edge vertices drag
// (snapping with Ctrl or "always snap"), a press on an edge's middle handle adds a vertex there and
// drags it, Ctrl+click on a vertex removes it, and the centre handle moves the offset. Each drag
// or click is one undo step (an override on prefab instances).
import { effect } from "@preact/signals";
import { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, GameObject, PolygonCollider2D, type Engine } from "../engine";
import { overlayHandleAt, pointOnSpritePlane, setEditorOverlay, viewportCanvas, type EditorOverlay } from "../engine/editor";
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

const COLOR = 0x3fae5a;
const COLOR_SELECTED = 0x9dff9d;
const HANDLE = 0x4c8dff;
const HANDLE_CENTER = 0xffffff;
const HANDLE_INSERT = 0x9a7bd8;

/** A node's 2D world pose for collider math. */
export function poseOf(node: GameObject): Pose2D {
  const t = node.transform!;
  const p = t.worldPosition, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: t.worldRotation2D, scale: [s.x, s.y] };
}

type EditableCollider = BoxCollider2D | CircleCollider2D | PolygonCollider2D | EdgeCollider2D;

const CLASSES: Record<EditingCollider["type"], typeof Collider2D> = {
  "engine.BoxCollider2D": BoxCollider2D,
  "engine.CircleCollider2D": CircleCollider2D,
  "engine.PolygonCollider2D": PolygonCollider2D,
  "engine.EdgeCollider2D": EdgeCollider2D,
};

/** The collider types "Edit Collider" works on. */
export const EDITABLE_COLLIDERS: ReadonlySet<string> = new Set(Object.keys(CLASSES));

/** The collider being edited, if it's still there. */
function editedCollider(): { node: GameObject; collider: EditableCollider; editing: EditingCollider } | null {
  const editing = editingCollider.value;
  const node = selectedWorldNode();
  if (!editing || !node?.transform || selection.value !== editing.key) return null;
  const collider = node.getBehaviors(CLASSES[editing.type])[editing.index] as EditableCollider | undefined;
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

/** What to draw this frame: outlines for every collider in the edited scene, handles for the one being edited. */
export function colliderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(selectedNodes().map((s) => s.node));
  for (const { node, points, closed } of colliderShapes(engine)) {
    if (points.length > 1) overlay.lines.push({ points, closed, color: selected.has(node) ? COLOR_SELECTED : COLOR });
  }
  const edited = editedCollider();
  if (edited) {
    const { node, collider } = edited;
    const pose = poseOf(node);
    const center: V2 = [collider.center.x, collider.center.y];
    const handles: Record<string, [number, number, number]> =
      collider instanceof BoxCollider2D
        ? boxHandles(pose, center, [collider.size.x, collider.size.y])
        : collider instanceof CircleCollider2D
          ? circleHandles(pose, center, collider.radius)
          : pointsHandles(pose, center, readPoints(collider.points), collider instanceof PolygonCollider2D);
    for (const [id, position] of Object.entries(handles)) {
      overlay.handles.push({ id, position, color: id === "center" ? HANDLE_CENTER : id.startsWith("insert:") ? HANDLE_INSERT : HANDLE });
    }
  }
  return overlay;
}

/** Draw collider gizmos and let their handles be dragged. Returns a function that removes them. */
export function installColliderGizmo(engine: Engine): () => void {
  const world = engine.world;
  setEditorOverlay(world, () => colliderOverlay(engine));

  // Edit mode ends when the selection moves elsewhere (picking a tool ends it too: `pickTool`).
  const stopWatch = effect(() => {
    const key = selection.value, editing = editingCollider.peek();
    if (editing && editing.key !== key) editingCollider.value = null;
  });

  const canvas = viewportCanvas(world);
  if (!canvas) return () => (stopWatch(), setEditorOverlay(world, null));

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

    const { node, collider, editing } = edited;
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
  canvas.addEventListener("pointerdown", onDown, { capture: true });
  return () => {
    stopWatch();
    canvas.removeEventListener("pointerdown", onDown, { capture: true });
    setEditorOverlay(world, null);
    editingCollider.value = null;
  };
}
