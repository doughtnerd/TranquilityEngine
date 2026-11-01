// Collider gizmos (ADR 0022), like Unity's: every 2D collider in the scene is outlined in green
// (the selected node's brighter). With "Edit Collider" on, the collider gets handles: box edges
// resize it (Alt: symmetric), circle rim handles set the radius, and the centre handle moves its
// offset. Each drag is one undo step (an override on prefab instances).
import { effect } from "@preact/signals";
import { BoxCollider2D, CircleCollider2D, Collider2D, GameObject, type Engine } from "../engine";
import { overlayHandleAt, pointOnSpritePlane, setEditorOverlay, viewportCanvas, type EditorOverlay } from "../engine/editor";
import { boxCorners, boxHandles, circleHandles, circlePoints, dragBoxEdge, dragCircleRadius, tidy, toLocal, type BoxHandle, type CircleHandle, type Pose2D, type V2 } from "./colliderMath";
import { SetField } from "./document";
import { editingCollider, openScene, playState, selectedWorldNode, selection, type EditingCollider } from "./state";

const COLOR = 0x3fae5a;
const COLOR_SELECTED = 0x9dff9d;
const HANDLE = 0x4c8dff;
const HANDLE_CENTER = 0xffffff;

/** A node's 2D world pose for collider math. */
export function poseOf(node: GameObject): Pose2D {
  const t = node.transform!;
  const p = t.worldPosition, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: t.worldRotation2D, scale: [s.x, s.y] };
}

const classOf = (type: EditingCollider["type"]) => (type === "engine.BoxCollider2D" ? BoxCollider2D : CircleCollider2D);

/** The collider being edited, if it's still there. */
function editedCollider(): { node: GameObject; collider: BoxCollider2D | CircleCollider2D; editing: EditingCollider } | null {
  const editing = editingCollider.value;
  const node = selectedWorldNode();
  if (!editing || !node?.transform || selection.value !== editing.key) return null;
  const collider = node.getBehaviors(classOf(editing.type) as typeof Collider2D)[editing.index] as BoxCollider2D | CircleCollider2D | undefined;
  return collider ? { node, collider, editing } : null;
}

/** What to draw this frame: outlines for every collider in the edited scene, handles for the one being edited. */
export function colliderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = selectedWorldNode();
  for (const c of GameObject.findObjectsOfType(Collider2D)) {
    const node = c.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const pose = poseOf(node);
    const color = node === selected ? COLOR_SELECTED : COLOR;
    const center: V2 = [c.center.x, c.center.y];
    if (c instanceof BoxCollider2D) overlay.lines.push({ points: boxCorners(pose, center, [c.size.x, c.size.y]), closed: true, color });
    else if (c instanceof CircleCollider2D) overlay.lines.push({ points: circlePoints(pose, center, c.radius), closed: true, color });
  }
  const edited = editedCollider();
  if (edited) {
    const { node, collider } = edited;
    const pose = poseOf(node);
    const center: V2 = [collider.center.x, collider.center.y];
    const handles: Record<string, [number, number, number]> =
      collider instanceof BoxCollider2D ? boxHandles(pose, center, [collider.size.x, collider.size.y]) : circleHandles(pose, center, collider.radius);
    for (const [id, position] of Object.entries(handles)) overlay.handles.push({ id, position, color: id === "center" ? HANDLE_CENTER : HANDLE });
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
    const handle = overlayHandleAt(world, at.x, at.y) as BoxHandle | CircleHandle | null;
    if (!handle) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);

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
    scene.stack.beginGroup(handle === "center" ? "Move collider center" : "Resize collider");

    const move = (m: PointerEvent) => {
      const p = pointer(m);
      if (!p) return;
      if (handle === "center") {
        write("center", [tidy(p[0] - offset[0]), tidy(p[1] - offset[1])]);
      } else if (collider instanceof BoxCollider2D) {
        const r = dragBoxEdge(handle as Exclude<BoxHandle, "center">, p, startCenter, startSize, m.altKey);
        write("size", r.size.map(tidy));
        if (!m.altKey || r.center[0] !== startCenter[0] || r.center[1] !== startCenter[1]) write("center", r.center.map(tidy));
      } else {
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
