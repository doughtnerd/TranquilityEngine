// The reverb zone gizmo (ADR 0162 E1, api-and-models §7), the Audio plugin's viewport tool `myco.audio.zones`: every
// `AudioReverbZone` in the edited scene is drawn as its volume (a box or a sphere) and, when `blendDistance` is above 0,
// its blend shell (the surface where the zone has faded to nothing), selected zones bright and the others dim. With
// "Edit Zone" on (the Inspector's header action), the zone gets handles: a box's six face centres resize it (Alt: both
// faces move), a sphere's rim handles set the radius, and the blend handle on the outside of the volume's x/y edge sets
// `blendDistance`. Each drag is one undo step (the fields are written through `editor.scene.writeField`, an override on prefab
// instances; Escape mid-drag puts it back). Editing a zone is the tool's mode (ADR 0231), which the viewport tool host
// ends: picking a transform tool, Escape, play, another tool, selecting another node or switching scenes.
// What each zone shape looks like and how its handles change it is its entry in the zone shape table (`zoneShapes.ts`,
// ADR 0295); this module is the loop over it, with the 3D shape kit's axis drag turning pointer moves into patches.
import type { ReadonlySignal } from "@preact/signals";
import { GameObject, type Engine } from "../../../engine";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { AudioReverbZone } from "../runtime";
import { readZone, zoneShapeFor } from "./zoneShapes";
import { type ComponentEditMode, type ViewportDrag, type ViewportToolContext, type ViewportToolContribution, editor, type OpenScene, shapeKit3d, theme, viewportColors } from "../../../editor/sdk";

/** The zone tool's id: also its overlay id and its active-tool id. */
export const ZONE_TOOL_ID = "myco.audio.zones";
/** The component type the tool and its Edit Zone toggle work on. */
export const ZONE_TYPE = "engine.AudioReverbZone";

/** The zone whose handles are showing ("Edit Zone"), or null: which `AudioReverbZone` (`type` is `ZONE_TYPE`) on which node. */
export type EditingZone = ComponentEditMode;
/** The zone tool's mode: entered by the Inspector's Edit Zone toggle, non-null exactly while the tool is active. */
export const editingZone: ReadonlySignal<EditingZone | null> = editor.viewport.mode<EditingZone>(ZONE_TOOL_ID);

// Volume cyan and shell amber (the faded part of the zone), bright when the node is selected, dim otherwise.
const VOLUME = 0x4cc9f0;
const VOLUME_DIM = 0x2a6f85;
const SHELL = 0xf0a64c;
const SHELL_DIM = 0x7a5a2d;

/** The zone being edited, if it's still there. */
function editedZone(): { node: GameObject; zone: AudioReverbZone; editing: EditingZone } | null {
  const editing = editingZone.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  const zone = node.getBehaviors(AudioReverbZone)[editing.index];
  return zone ? { node, zone, editing } : null;
}

/** What to draw this frame: every zone in the edited scene, handles for the one being edited. */
function zoneOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  for (const zone of GameObject.findObjectsOfType(AudioReverbZone)) {
    const node = zone.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const shape = zoneShapeFor(zone.shape), f = readZone(zone), pose = shapeKit3d.pose3DOf(node), on = selected.has(node);
    for (const points of shape.wire(f, pose)) overlay.lines.push({ points, closed: false, color: on ? VOLUME : VOLUME_DIM });
    for (const points of shape.shell(f, pose)) overlay.lines.push({ points, closed: false, color: on ? SHELL : SHELL_DIM });
  }
  const edited = editedZone();
  if (edited) {
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    const handles = zoneShapeFor(edited.zone.shape).handles(readZone(edited.zone), shapeKit3d.pose3DOf(edited.node));
    for (const [id, position] of Object.entries(handles)) overlay.handles.push({ id, position, color: id === shapeKit3d.BLEND_HANDLE ? SHELL : handle });
  }
  return overlay;
}

/** The scene view's zone tool: outlines and handles, handle drags. */
export const zoneTool: ViewportToolContribution<EditingZone> = {
  id: ZONE_TOOL_ID,
  // Each zone card's Edit Zone toggle (ADR 0266): the host adds it, enters this tool with the card's zone, and ends
  // editing when the zone is removed or the selection moves to another node.
  editsComponents: {
    types: [ZONE_TYPE],
    label: "Edit Zone",
    hint: "Show handles in the viewport: drag a face to resize a box zone, a rim handle to set a sphere's radius, the outer handle to set the blend distance",
    stopHint: "Stop editing the zone (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { engine, world } = view;
    view.overlay(() => zoneOverlay(engine), { kind: "other" });

    view.onPress((p) => {
      if (p.button !== 0) return null;
      const edited = editedZone();
      const open = editor.scene.peekOpen();
      if (!edited || !open) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!handle) return null;
      // A press on a handle never also selects, orbits or starts the transform gizmo, even when it changes nothing.
      return startZoneDrag(view, open, p, handle, edited.node, edited.zone, edited.editing) ?? {};
    });
  },
};

/** Writes a patch of the edited zone's fields through the component field write (ADR 0257), tidied. */
function patchWriter(scene: OpenScene, editing: EditingZone): (patch: shapeKit3d.FieldPatch) => void {
  const place = { scene, path: editing.key.split("/"), type: ZONE_TYPE, index: editing.index };
  const tidied = (v: unknown): unknown => (typeof v === "number" ? shapeKit3d.tidy(v) : Array.isArray(v) ? v.map(tidied) : v);
  return (patch) => {
    for (const [field, value] of Object.entries(patch)) void editor.scene.writeField(place, field, tidied(value));
  };
}

/**
 * Press on a zone handle: the entry's drag along the handle's axis (face and radius handles out from the centre, the
 * blend handle along the x/y diagonal), to the point on the axis nearest the pointer's ray. One undo step; writes `size`
 * and `center` (a box face; `size` alone with Alt), `radius` (a sphere) or `blendDistance`. Null when the handle isn't on
 * this zone or its axis can't be followed (the camera sees it end-on).
 */
function startZoneDrag(view: ViewportToolContext<EditingZone>, scene: OpenScene, press: { x: number; y: number }, handle: string, node: GameObject, zone: AudioReverbZone, editing: EditingZone): ViewportDrag | null {
  const ray0 = viewport(view.world).rayAt(press.x, press.y);
  if (!ray0) return null;
  const drag = shapeKit3d.axisDrag(zoneShapeFor(zone.shape), readZone(zone), shapeKit3d.pose3DOf(node), handle, ray0); // fields and pose fixed for the drag
  if (!drag) return null;
  const write = patchWriter(scene, editing);
  return view.gesture(handle === shapeKit3d.BLEND_HANDLE ? "Resize zone blend" : "Resize zone", {
    move: (p) => {
      const patch = drag(viewport(view.world).rayAt(p.x, p.y), p.alt);
      if (patch) write(patch);
    },
  });
}
