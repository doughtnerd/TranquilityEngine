// The audio zone gizmo (ADR 0333), the Audio plugin's viewport tool `myco.audio.audioZones`: every `AudioZone` in the
// edited scene is drawn as its upright box (bottom and top rectangles turned by the zone's yaw, and the vertical edges)
// and, for an inside zone, its feather ring, selected zones bright and the others dim. The box is the zone's own world
// box (`AudioZone._worldBox`), the one the runtime places the sound by. Resizing is through the Inspector's fields.
import { GameObject, type Engine } from "../../../engine";
import type { EditorOverlay } from "../../../engine/editor";
import { AudioZone } from "../runtime/AudioZone";
import { audioZoneOutline } from "./audioZoneGizmoModel";
import { editor, type ViewportToolContribution } from "../../../editor/sdk";

/** The tool's id: also its overlay id. */
export const AUDIO_ZONE_TOOL_ID = "myco.audio.audioZones";

// Volume green and feather amber, bright when the node is selected, dim otherwise.
const VOLUME = 0x6ee7a0;
const VOLUME_DIM = 0x2f6b4a;
const FEATHER = 0xf0a64c;
const FEATHER_DIM = 0x7a5a2d;

/** What to draw this frame: every audio zone in the edited scene. */
function audioZoneOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  for (const zone of GameObject.findObjectsOfType(AudioZone)) {
    const node = zone.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const on = selected.has(node);
    const { volume, feather } = audioZoneOutline(zone._worldBox(), zone.heard, zone.feather);
    for (const points of volume) overlay.lines.push({ points, closed: false, color: on ? VOLUME : VOLUME_DIM });
    for (const points of feather) overlay.lines.push({ points, closed: false, color: on ? FEATHER : FEATHER_DIM });
  }
  return overlay;
}

/** The scene view's audio zone tool: the zones' outlines. */
export const audioZoneTool: ViewportToolContribution = {
  id: AUDIO_ZONE_TOOL_ID,
  install(view) {
    view.overlay(() => audioZoneOverlay(view.engine), { kind: "other" });
    return () => {};
  },
};
