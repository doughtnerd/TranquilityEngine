// The decal projector gizmo (ADR 0395), the Decals plugin's viewport tool `myco.decals.bounds`: every `DecalProjector`
// in the edited scene is drawn as its box, with an arrow along its projection (+Z) and a cross at the node, selected
// ones bright and the others dim. With "Edit Bounds" on (the Inspector card's header toggle, ADR 0266), the box gets face
// handles: dragging one resizes the box with the opposite face fixed (Alt: about the centre), writing `size` and
// `pivot` in one undo step through the component field write (ADR 0257), snapped like the transform gizmo. Editing is the
// tool's mode (ADR 0231), which the host ends on a transform tool, Escape, play, another tool, or another selection.
import type { ReadonlySignal } from "@preact/signals";
import { GameObject, type Engine } from "../../../engine";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { DecalProjector } from "../runtime";
import { DECAL_BOX, decalPatch, readDecalBox } from "./decalShape";
import { type ComponentEditMode, type ViewportDrag, type ViewportToolContext, type ViewportToolContribution, editor, type OpenScene, shapeKit3d, theme, viewportColors } from "../../../editor/sdk";

/** The tool's id: also its overlay id and its active-tool id. */
export const DECAL_TOOL_ID = "myco.decals.bounds";
/** The component type the tool and its Edit Bounds toggle work on. */
export const DECAL_TYPE = "engine.DecalProjector";

/** The tool's mode: which projector's handles show, non-null exactly while the tool is active. */
export const editingDecal: ReadonlySignal<ComponentEditMode | null> = editor.viewport.mode<ComponentEditMode>(DECAL_TOOL_ID);

// Decal boxes in violet: bright when the node is selected, dim otherwise.
const BOX = 0xb48cf2;
const BOX_DIM = 0x5c4a7a;

/** The projector being edited, if it's still there. */
function editedDecal(): { node: GameObject; decal: DecalProjector; editing: ComponentEditMode } | null {
  const editing = editingDecal.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  const decal = node.getComponents(DecalProjector)[editing.index];
  return decal ? { node, decal, editing } : null;
}

/** What to draw this frame: every projector's box in the edited scene, handles for the one being edited. */
function decalOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  for (const decal of GameObject.findObjectsOfType(DecalProjector)) {
    const node = decal.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const on = selected.has(node);
    for (const points of DECAL_BOX.wire(readDecalBox(decal), shapeKit3d.pose3DOf(node))) overlay.lines.push({ points, closed: false, color: on ? BOX : BOX_DIM });
  }
  const edited = editedDecal();
  if (edited) {
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    for (const [id, position] of Object.entries(DECAL_BOX.handles(readDecalBox(edited.decal), shapeKit3d.pose3DOf(edited.node)))) overlay.handles.push({ id, position, color: handle });
  }
  return overlay;
}

/** The scene view's decal tool: boxes, and face handles on the one being edited. */
export const decalTool: ViewportToolContribution<ComponentEditMode> = {
  id: DECAL_TOOL_ID,
  editsComponents: {
    types: [DECAL_TYPE],
    label: "Edit Bounds",
    hint: "Show handles in the viewport: drag a face of the decal's box to resize it (Alt: about its centre)",
    stopHint: "Stop editing the decal's box (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { engine, world } = view;
    view.overlay(() => decalOverlay(engine), { kind: "other" });
    view.onPress((p) => {
      if (p.button !== 0) return null;
      const edited = editedDecal();
      const open = editor.scene.peekOpen();
      if (!edited || !open) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!handle) return null;
      return startDecalDrag(view, open, p, handle, edited.node, edited.decal, edited.editing) ?? {};
    });
  },
};

/** Press on a face handle: the kit's axis drag, its `size` / `center` patch written as `size` / `pivot`, snapped and tidied. */
function startDecalDrag(view: ViewportToolContext<ComponentEditMode>, scene: OpenScene, press: { x: number; y: number }, handle: string, node: GameObject, decal: DecalProjector, editing: ComponentEditMode): ViewportDrag | null {
  const ray0 = viewport(view.world).rayAt(press.x, press.y);
  if (!ray0) return null;
  const drag = shapeKit3d.axisDrag(DECAL_BOX, readDecalBox(decal), shapeKit3d.pose3DOf(node), handle, ray0);
  if (!drag) return null;
  const place = { scene, path: editing.key.split("/"), type: DECAL_TYPE, index: editing.index };
  const tidied = (v: unknown): unknown => (typeof v === "number" ? shapeKit3d.tidy(view.snap(v)) : Array.isArray(v) ? v.map(tidied) : v);
  return view.gesture("Resize decal", {
    move: (p) => {
      const patch = drag(viewport(view.world).rayAt(p.x, p.y), p.alt);
      if (!patch) return;
      for (const [field, value] of Object.entries(decalPatch(patch))) void editor.scene.writeField(place, field, tidied(value));
    },
  });
}
