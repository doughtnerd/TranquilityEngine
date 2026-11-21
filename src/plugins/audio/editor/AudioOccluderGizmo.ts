// The occluder gizmo (ADR 0162 E2, api-and-models §7), the Audio plugin's viewport tool `myco.audio.occluders`: the
// colliders an AudioOccluder applies to (those of its node and of descendants without an occluder of their own, as
// `nearestOccluder` finds it) are outlined in the occluder's material tint, bright while the occluder's node is selected
// and dim otherwise, and dimmer as `openness` opens the wall. Colliders no occluder applies to are left to the Physics
// gizmo. Each collider is drawn as the Physics plugin's collider tool draws it: its wireframe comes from the Physics
// plugin's collider shape table through the editor's component wireframes (ADR 0295), so the outline is the simulated
// shape; the Audio plugin never imports the Physics plugin's code. With the Physics plugin off nothing is drawn (and
// occlusion is inert: no 3D physics service).
import { GameObject, type Engine } from "../../../engine";
import type { EditorOverlay } from "../../../engine/editor";
import { nearestOccluder } from "../runtime/AudioOccluder";
import { blendColor, colliderClass, materialTint } from "./audioInspectorModel";
import { audioSettings } from "./audioDraft";
import { componentWireframe, editor, type ViewportToolContribution } from "../../../editor/sdk";

/** The tool's id: also its overlay id. */
export const OCCLUDER_TOOL_ID = "myco.audio.occluders";

/** What unselected outlines fade toward, and how far; `openness` fades them further. */
const DIM_TOWARD = 0x161c1e;
const DIM_AMOUNT = 0.5;
const OPEN_DIM = 0.6;

/** What to draw this frame: every collider an occluder applies to, in the occluder's material tint. */
function occluderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const base = colliderClass();
  const colliders = base ? GameObject.findObjectsOfType(base) : [];
  if (colliders.length === 0) return overlay;
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  const audio = audioSettings.read(editor.project.current?.settings);
  for (const c of colliders) {
    const node = c.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const occluder = nearestOccluder(node);
    if (!occluder) continue;
    const wire = componentWireframe(c);
    if (!wire) continue;
    const open = Math.min(1, Math.max(0, Number.isFinite(occluder.openness) ? occluder.openness : 0));
    let dim = selected.has(occluder.node) || selected.has(node) ? 0 : DIM_AMOUNT;
    dim = 1 - (1 - dim) * (1 - OPEN_DIM * open);
    const color = blendColor(materialTint(audio, occluder.material), DIM_TOWARD, dim);
    for (const points of wire) overlay.lines.push({ points, closed: false, color });
  }
  return overlay;
}

/** The scene view's occluder tool: the colliders occluders apply to, outlined by material. */
export const occluderTool: ViewportToolContribution = {
  id: OCCLUDER_TOOL_ID,
  install(view) {
    view.overlay(() => occluderOverlay(view.engine), { kind: "other" });
    return () => {};
  },
};
