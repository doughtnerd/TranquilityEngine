// Collider gizmos (ADR 0022, 0039, 0045), like Unity's, as the Physics plugin's viewport tool
// `myco.physics.colliders` (ADR 0138, 0142): every 2D and 3D collider in the scene is
// outlined in green (selected nodes' brighter): 3D ones as wireframes, mesh colliders by their
// triangles. With "Edit Collider" on, the collider gets handles: box edges (2D) or faces (3D)
// resize it (Alt: symmetric), circle and sphere handles set the radius, capsule handles its radius
// and height, polygon and edge vertices drag (snapping with Ctrl or "always snap"), a press on an
// edge's middle handle adds a vertex there and drags it, Ctrl+click on a vertex removes it, and
// the centre handle moves the offset. Each drag or click is one undo step (an override on prefab
// instances; Escape mid-drag puts it back). Editing a collider is the tool's mode (ADR 0231), which the
// viewport tool host ends: picking a transform tool, Escape, play, another tool, selecting another node
// or switching scenes. 2D collider outlines are also selectable: a click inside one picks its node.
// What each collider type looks like and how its handles change it is its entry in the collider shape
// table (`colliderShapes.ts`, ADR 0288); this module is the loop over it: drawing, picking, and turning
// pointer moves into the entry's field patches (a 3D handle through the 3D shape kit's axis drag, ADR 0295). It
// also offers the 3D colliders' wireframes to other plugins' tools (`colliderWireframes`, ADR 0295: the Audio
// plugin's occluder tool draws them).
import { RAD2DEG } from "../../../engine/core/math";
import type { ReadonlySignal } from "@preact/signals";
import { GameObject, type Engine } from "../../../engine";
import { Collider, Collider2D } from "../runtime";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { toLocal, type Pose2D, type V2 } from "./colliderMath";
import { COLLIDER_SHAPES, colliderShapeFor, colliderShapeOf, type AnyColliderShape2D, type AnyColliderShape3D, type EditableColliderType, type FieldPatch } from "./colliderShapes";
import { type ComponentEditMode, type ComponentWireframeContribution, type ViewportDrag, type ViewportPointer, type ViewportToolContext, type ViewportToolContribution, editor, type OpenScene, shapeKit3d, theme, viewportColors } from "../../../editor/sdk";

const { centerDelta, pose3DOf, tidy, worldCenter } = shapeKit3d;
type Pose3D = shapeKit3d.Pose3D;
type V3 = shapeKit3d.V3;
type Wire = shapeKit3d.Wire;

/** The collider tool's id: also its overlay id and its active-tool id. */
export const COLLIDER_TOOL_ID = "myco.physics.colliders";

/** The collider whose handles are showing ("Edit Collider", like Unity), or null. */
export interface EditingCollider extends ComponentEditMode {
  readonly type: EditableColliderType;
}
/** The collider tool's mode: entered by the Inspector's Edit Collider toggle, non-null exactly while the tool is active. */
export const editingCollider: ReadonlySignal<EditingCollider | null> = editor.viewport.mode<EditingCollider>(COLLIDER_TOOL_ID);

const COLOR = 0x3fae5a;
const COLOR_SELECTED = 0x9dff9d;
const HANDLE_CENTER = 0xffffff;
const HANDLE_INSERT = 0x9a7bd8;

/** A node's 2D world pose for collider math. */
export function poseOf(node: GameObject): Pose2D {
  const t = node.transform!;
  const p = t.worldPosition, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: t.worldRotation2D * RAD2DEG, scale: [s.x, s.y] }; // Pose2D is in degrees
}

/** The pose a collider's shape is placed with: upright (no rotation) for a character controller's capsule. */
const shapePose2D = (node: GameObject, shape: AnyColliderShape2D): Pose2D => (shape.upright ? { ...poseOf(node), rotation: 0 } : poseOf(node));
const shapePose3D = (node: GameObject, shape: AnyColliderShape3D): Pose3D => (shape.upright ? { ...pose3DOf(node), rotation: [0, 0, 0, 1] } : pose3DOf(node));

/** The collider types "Edit Collider" works on. */
export const EDITABLE_COLLIDERS: ReadonlySet<string> = new Set(COLLIDER_SHAPES.map((s) => s.type));

type Edited =
  | { node: GameObject; editing: EditingCollider; dimension: "2d"; shape: AnyColliderShape2D; fields: { center: V2 } }
  | { node: GameObject; editing: EditingCollider; dimension: "3d"; shape: AnyColliderShape3D; fields: { center: V3 } };

/** The collider being edited, if it's still there, with its entry and fields now. */
function editedCollider(): Edited | null {
  const editing = editingCollider.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  const shape = colliderShapeFor(editing.type);
  const collider = shape && node.getBehaviors(shape.cls)[editing.index];
  const fields = collider && shape.read(collider);
  if (!shape || !fields) return null;
  return shape.dimension === "2d" ? { node, editing, dimension: "2d", shape, fields } : { node, editing, dimension: "3d", shape, fields };
}

/** Every 2D collider in the edited scene, with its outline in world space (open for edge colliders). */
function colliderShapes(engine: Engine): { node: GameObject; points: [number, number, number][]; closed: boolean }[] {
  const out: { node: GameObject; points: [number, number, number][]; closed: boolean }[] = [];
  for (const c of GameObject.findObjectsOfType(Collider2D)) {
    const node = c.node, shape = colliderShapeOf(c);
    if (!shape || !node.transform || !engine.world.inEditMode(node.entity)) continue;
    const fields = shape.read(c);
    if (fields) out.push({ node, ...shape.outline(fields, shapePose2D(node, shape)) });
  }
  return out;
}

/** Each 3D collider's last wireframe and what it was made from (shape, pose and centre), so an unchanged one isn't rebuilt every frame. */
const wires = new WeakMap<Collider, { key: string; wire: Wire }>();

/** A 3D collider's wireframe in world space, as its entry draws it; null for one the table doesn't hold, or a mesh collider whose model is loading. */
function colliderWire(c: Collider): Wire | null {
  const node = c.node, shape = colliderShapeOf(c);
  if (!shape || !node.transform) return null;
  const fields = shape.read(c);
  if (!fields) return null;
  const pose = shapePose3D(node, shape);
  const key = `${shape.signature(fields)}|${pose.position}|${pose.rotation}|${pose.scale}|${fields.center}`;
  let cached = wires.get(c);
  if (!cached || cached.key !== key) wires.set(c, (cached = { key, wire: shape.wire(fields, pose) }));
  return cached.wire;
}

/** Every 3D collider in the edited scene, as a wireframe in world space. Mesh colliders whose model is loading are left out. */
function collider3dShapes(engine: Engine): { node: GameObject; wire: Wire }[] {
  const out: { node: GameObject; wire: Wire }[] = [];
  for (const c of GameObject.findObjectsOfType(Collider)) {
    if (!c.node.transform || !engine.world.inEditMode(c.node.entity)) continue;
    const wire = colliderWire(c);
    if (wire) out.push({ node: c.node, wire });
  }
  return out;
}

/** The 3D colliders' wireframes, offered to other plugins' scene-view tools (ADR 0295): the same wireframes the collider tool draws. */
export const colliderWireframes: ComponentWireframeContribution = {
  id: "myco.physics.colliders",
  types: new Set(COLLIDER_SHAPES.filter((s) => s.dimension === "3d").map((s) => s.type)),
  wire: (c) => (c instanceof Collider ? colliderWire(c) : null),
};

/** The handles of the collider being edited, by id, in world space. */
const handlesOf = (e: Edited): Record<string, readonly number[]> => (e.dimension === "2d" ? e.shape.handles(e.fields, shapePose2D(e.node, e.shape)) : e.shape.handles(e.fields, shapePose3D(e.node, e.shape)));

/** What to draw this frame: outlines for every collider in the edited scene, handles for the one being edited. */
function colliderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  for (const { node, points, closed } of colliderShapes(engine)) {
    if (points.length > 1) overlay.lines.push({ points, closed, color: selected.has(node) ? COLOR_SELECTED : COLOR });
  }
  for (const { node, wire } of collider3dShapes(engine)) {
    const color = selected.has(node) ? COLOR_SELECTED : COLOR;
    for (const points of wire) overlay.lines.push({ points, closed: false, color });
  }
  const edited = editedCollider();
  if (edited) {
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    for (const [id, position] of Object.entries(handlesOf(edited))) {
      overlay.handles.push({ id, position: position as [number, number, number], color: id === "center" ? HANDLE_CENTER : id.startsWith("insert:") ? HANDLE_INSERT : handle });
    }
  }
  return overlay;
}

/** The scene view's collider tool: outlines and handles, handle drags, 2D outlines selectable. */
export const colliderTool: ViewportToolContribution<EditingCollider> = {
  id: COLLIDER_TOOL_ID,
  // Each editable collider card's Edit Collider toggle (ADR 0266): the host adds it, enters this tool with the card's
  // collider, and ends editing when the collider is removed or the selection moves to another node.
  editsComponents: {
    types: EDITABLE_COLLIDERS,
    label: "Edit Collider",
    hint: (type) => colliderShapeFor(type)?.hint ?? "Show handles in the viewport to resize this collider and move its center",
    stopHint: "Stop editing the collider (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { engine, world } = view;
    view.overlay(() => colliderOverlay(engine), { kind: "colliders" });
    view.selectable(() => colliderShapes(engine));

    view.onPress((p) => {
      if (p.button !== 0) return null;
      const edited = editedCollider();
      const scene = editor.scene.peekOpen();
      if (!edited || !scene) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!handle) return null;
      // A press on a handle never also selects, orbits or starts the transform gizmo, even when it changes nothing.
      const drag = edited.dimension === "3d" ? drag3D(view, scene, p, handle, edited) : drag2D(view, scene, p, handle, edited);
      return drag ?? {};
    });
  },
};

/** Round float noise out of every number in a field value. */
const tidied = (v: unknown): unknown => (typeof v === "number" ? tidy(v) : Array.isArray(v) ? v.map(tidied) : v);

/** Writes a patch of the edited collider's fields through the component field write (ADR 0257). */
function patchWriter(scene: OpenScene, editing: EditingCollider): (patch: FieldPatch) => void {
  const place = { scene, path: editing.key.split("/"), type: editing.type, index: editing.index };
  return (patch) => {
    for (const [field, value] of Object.entries(patch)) void editor.scene.writeField(place, field, tidied(value));
  };
}

/** Press on a 2D collider's handle: the centre moves the offset; any other handle does what its entry says. */
function drag2D(view: ViewportToolContext<EditingCollider>, scene: OpenScene, press: ViewportPointer, handle: string, edited: Extract<Edited, { dimension: "2d" }>): ViewportDrag | null {
  const { world } = view;
  const { node, shape, fields } = edited;
  const pose = shapePose2D(node, shape); // fixed for the drag
  const pointer = (m: ViewportPointer): V2 | null => {
    const w = viewport(world).pointOnPlane(m.x, m.y, [0, 0, 1], [0, 0, pose.position[2]]);
    return w ? toLocal(pose, w) : null;
  };
  const write = patchWriter(scene, edited.editing);
  if (handle === "center") {
    const grab = pointer(press);
    const offset: V2 = grab ? [grab[0] - fields.center[0], grab[1] - fields.center[1]] : [0, 0];
    return view.gesture("Move collider center", {
      move: (m) => {
        const p = pointer(m);
        if (p) write({ center: [p[0] - offset[0], p[1] - offset[1]] });
      },
    });
  }
  const action = shape.press(fields, pose, handle, { ctrl: press.ctrl || press.meta });
  if (!action) return null;
  if ("refused" in action) {
    editor.messages.info(action.refused);
    return null;
  }
  if ("edit" in action) {
    view.edit(action.label, () => write(action.edit));
    return null;
  }
  const drag = view.gesture(action.label, {
    move: (m) => {
      const p = pointer(m);
      if (p) write(action.drag(p, m.alt, (n) => view.snap(n)));
    },
  });
  if (drag && action.start) write(action.start);
  return drag;
}

/**
 * Drag a 3D collider's handle along its axis (the kit's axis drag: to the point nearest the pointer's ray), or the
 * centre handle across the plane through it that faces the camera.
 */
function drag3D(view: ViewportToolContext<EditingCollider>, scene: OpenScene, press: ViewportPointer, handle: string, edited: Extract<Edited, { dimension: "3d" }>): ViewportDrag | null {
  const { world } = view;
  const { node, shape, fields } = edited;
  const pose = shapePose3D(node, shape); // fixed for the drag
  const ray0 = viewport(world).rayAt(press.x, press.y);
  if (!ray0) return null;
  const write = patchWriter(scene, edited.editing);
  if (handle === "center") {
    const c0 = worldCenter(pose, fields.center);
    const normal: V3 = [-ray0.direction[0], -ray0.direction[1], -ray0.direction[2]];
    const grab0 = viewport(world).pointOnPlane(press.x, press.y, normal, c0);
    return view.gesture("Move collider center", {
      move: (p) => {
        const hit = viewport(world).pointOnPlane(p.x, p.y, normal, c0);
        if (!hit || !grab0) return;
        const delta = centerDelta(pose, [hit[0] - grab0[0], hit[1] - grab0[1], hit[2] - grab0[2]]);
        write({ center: fields.center.map((v, i) => v + delta[i]) });
      },
    });
  }
  const drag = shapeKit3d.axisDrag(shape, fields, pose, handle, ray0);
  if (!drag) return null;
  return view.gesture("Resize collider", {
    move: (p) => {
      const patch = drag(viewport(world).rayAt(p.x, p.y), p.alt);
      if (patch) write(patch);
    },
  });
}
