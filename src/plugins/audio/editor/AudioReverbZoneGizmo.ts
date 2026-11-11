// The reverb zone gizmo (ADR 0162 E1, api-and-models §7), the Audio plugin's viewport tool `myco.audio.zones`: every
// `AudioReverbZone` in the edited scene is drawn as its volume (a box or a sphere) and, when `blendDistance` is above 0,
// its blend shell (the surface where the zone has faded to nothing), selected zones bright and the others dim. With
// "Edit Zone" on (the Inspector's header action), the zone gets handles: a box's six face centres resize it (Alt: both
// faces move), a sphere's rim handles set the radius, and the blend handle on the outside of the volume's x/y edge sets
// `blendDistance`. Each drag is one undo step (the fields are written through `SetField`, an override on prefab
// instances). Editing a zone is the tool being active: picking a transform tool, Escape, play or another tool ends it,
// and so do selecting another node and switching scenes.
import { effect, signal } from "@preact/signals";
import { GameObject, type Engine } from "../../../engine";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { AudioReverbZone } from "../runtime";
import {
  BLEND_HANDLE,
  blendAxis,
  blendHandle,
  closestOnAxis,
  dragBlend,
  dragZoneFace,
  dragZoneRadius,
  tidy,
  zoneFaceHandles,
  zoneGeometry,
  zoneRadiusHandles,
  zoneShellWire,
  zoneVolumeWire,
  type Pose3D,
  type V3,
  type ZoneFace,
  type ZoneGeometry,
} from "./zoneMath";
import { type ViewportDrag, type ViewportPointer, type ViewportToolContribution, editor, SetField, type OpenScene, theme, viewportColors } from "../../../editor/sdk";

/** The zone tool's id: also its overlay id and its active-tool id. */
export const ZONE_TOOL_ID = "myco.audio.zones";
/** The component type the tool and the Edit Zone action work on. */
export const ZONE_TYPE = "engine.AudioReverbZone";

/** The zone whose handles are showing ("Edit Zone"), or null. */
export interface EditingZone {
  /** Path key of the node (see `selection`). */
  key: string;
  /** Which `AudioReverbZone` on the node. */
  index: number;
}
/** Set by the Inspector's Edit Zone button; non-null exactly while the zone tool is active. */
export const editingZone = signal<EditingZone | null>(null);

// Volume cyan and shell amber (the faded part of the zone), bright when the node is selected, dim otherwise.
const VOLUME = 0x4cc9f0;
const VOLUME_DIM = 0x2a6f85;
const SHELL = 0xf0a64c;
const SHELL_DIM = 0x7a5a2d;

/** A node's world pose for zone math. */
export function zonePoseOf(node: GameObject): Pose3D {
  const t = node.transform!;
  const p = t.worldPosition, q = t.worldRotation, s = t.worldScale;
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
}

/** A zone's volume in world space. */
export function geometryOf(node: GameObject, zone: AudioReverbZone): ZoneGeometry {
  return zoneGeometry(zonePoseOf(node), zone.shape, [zone.center.x, zone.center.y, zone.center.z], [zone.size.x, zone.size.y, zone.size.z], zone.radius);
}

/** The zone being edited, if it's still there. */
function editedZone(): { node: GameObject; zone: AudioReverbZone; editing: EditingZone } | null {
  const editing = editingZone.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  const zone = node.getBehaviors(AudioReverbZone)[editing.index];
  return zone ? { node, zone, editing } : null;
}

/** The handles of a zone being edited, by id. */
export function zoneHandles(g: ZoneGeometry, blendDistance: number): Record<string, V3> {
  return { ...(g.shape === "sphere" ? zoneRadiusHandles(g) : zoneFaceHandles(g)), [BLEND_HANDLE]: blendHandle(g, blendDistance) };
}

/** What to draw this frame: every zone in the edited scene, handles for the one being edited. */
export function zoneOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  for (const zone of GameObject.findObjectsOfType(AudioReverbZone)) {
    const node = zone.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const g = geometryOf(node, zone), on = selected.has(node);
    for (const points of zoneVolumeWire(g)) overlay.lines.push({ points, closed: false, color: on ? VOLUME : VOLUME_DIM });
    for (const points of zoneShellWire(g, zone.blendDistance)) overlay.lines.push({ points, closed: false, color: on ? SHELL : SHELL_DIM });
  }
  const edited = editedZone();
  if (edited) {
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    for (const [id, position] of Object.entries(zoneHandles(geometryOf(edited.node, edited.zone), edited.zone.blendDistance))) overlay.handles.push({ id, position, color: id === BLEND_HANDLE ? SHELL : handle });
  }
  return overlay;
}

/** The scene view's zone tool: outlines and handles, handle drags. */
export const zoneTool: ViewportToolContribution = {
  id: ZONE_TOOL_ID,
  install(view) {
    const { engine, world } = view;
    view.overlay(() => zoneOverlay(engine), { kind: "other" });

    // Editing a zone makes the tool active; anything else becoming active ends editing.
    const stopEditing = effect(() => {
      if (editingZone.value) {
        if (!view.active.peek()) view.activate();
      } else view.deactivate();
    });
    const stopActive = effect(() => {
      if (!view.active.value && editingZone.peek()) editingZone.value = null;
    });
    // Edit mode ends when the selection moves elsewhere or another scene opens.
    const stopWatch = effect(() => {
      const key = editor.scene.selection.active, editing = editingZone.peek();
      if (editing && editing.key !== key) editingZone.value = null;
    });
    let scene = editor.scene.peekOpen();
    const stopScene = effect(() => {
      const next = editor.scene.open;
      if (next === scene) return;
      scene = next;
      editingZone.value = null;
    });

    view.onPress((p) => {
      if (p.button !== 0) return null;
      const edited = editedZone();
      const open = editor.scene.peekOpen();
      if (!edited || !open) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!handle) return null;
      // A press on a handle never also selects, orbits or starts the transform gizmo, even when it changes nothing.
      return startZoneDrag((x, y) => viewport(world).rayAt(x, y), open, p, handle, edited.node, edited.zone, edited.editing) ?? {};
    });

    return () => {
      stopEditing();
      stopActive();
      stopWatch();
      stopScene();
      editingZone.value = null;
    };
  },
};

/** Writes one zone field as a command, skipping values it already wrote. */
function fieldWriter(scene: OpenScene, editing: EditingZone): (field: string, value: unknown) => void {
  const written = new Map<string, string>();
  return (field, value) => {
    const json = JSON.stringify(value);
    if (written.get(field) === json) return;
    written.set(field, json);
    const [id, ...target] = editing.key.split("/");
    scene.stack.execute(new SetField(id!, ZONE_TYPE, field, value, { index: editing.index, target }));
  };
}

/** A drag that is one undo step named `label`: the group closes on release and on cancel. */
function grouped(scene: OpenScene, label: string, move: (p: ViewportPointer) => void): ViewportDrag {
  scene.stack.beginGroup(label);
  let open = true;
  const close = () => {
    if (open) scene.stack.endGroup();
    open = false;
  };
  return { move, end: close, cancel: close };
}

/** The pointer ray at a canvas point: what the viewport gives, or a stand-in in tests. */
export type RayAt = (x: number, y: number) => { origin: readonly number[]; direction: readonly number[] } | null;

/**
 * Press on a zone handle: drag it along its axis, to the point on the axis nearest the pointer's ray (face and radius
 * handles along the line out from the centre, the blend handle along the x/y diagonal). One undo step; writes `size` and
 * `center` (box), `radius` (sphere) or `blendDistance`. Null when the handle isn't on this zone or its axis can't be
 * worked out.
 */
export function startZoneDrag(rayAt: RayAt, scene: OpenScene, press: { x: number; y: number }, handle: string, node: GameObject, zone: AudioReverbZone, editing: EditingZone): ViewportDrag | null {
  const pose = zonePoseOf(node); // fixed for the drag
  const g = geometryOf(node, zone);
  const handles = zoneHandles(g, zone.blendDistance);
  const grabbed = handles[handle];
  const ray0 = rayAt(press.x, press.y);
  if (!grabbed || !ray0) return null;
  const startCenter: V3 = [zone.center.x, zone.center.y, zone.center.z];
  const startSize: V3 = [zone.size.x, zone.size.y, zone.size.z];
  const startBlend = zone.blendDistance;
  let origin: V3 = g.center, axis: V3, start: number;
  if (handle === BLEND_HANDLE) {
    ({ origin, direction: axis } = blendAxis(g));
    start = startBlend;
  } else {
    const d = [grabbed[0] - g.center[0], grabbed[1] - g.center[1], grabbed[2] - g.center[2]];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (len < 1e-9) return null;
    axis = [d[0]! / len, d[1]! / len, d[2]! / len];
    start = len;
  }
  // Where along the handle's line the press was, so the handle doesn't jump to the pointer.
  const t0 = closestOnAxis(ray0.origin, ray0.direction, origin, axis);
  if (t0 === null) return null;
  const write = fieldWriter(scene, editing);
  return grouped(scene, handle === BLEND_HANDLE ? "Resize zone blend" : "Resize zone", (p) => {
    const ray = rayAt(p.x, p.y);
    const t = ray ? closestOnAxis(ray.origin, ray.direction, origin, axis) : null;
    if (t === null) return;
    const reach = start + (t - t0); // how far out the handle is now, along its own outward axis
    if (handle === BLEND_HANDLE) write("blendDistance", tidy(dragBlend(reach)));
    else if (g.shape === "sphere") write("radius", tidy(dragZoneRadius(reach, pose)));
    else {
      const r = dragZoneFace(handle as ZoneFace, reach, pose, startCenter, startSize, p.alt);
      write("size", r.size.map(tidy));
      if (!p.alt || r.center.some((v, i) => v !== startCenter[i])) write("center", r.center.map(tidy));
    }
  });
}
