// The occluder gizmo (ADR 0162 E2, api-and-models §7), the Audio plugin's viewport tool `myco.audio.occluders`: the
// colliders an AudioOccluder applies to (those of its node and of descendants without an occluder of their own, as
// `nearestOccluder` finds it) are outlined in the occluder's material tint, bright while the occluder's node is selected
// and dim otherwise, and dimmer as `openness` opens the wall. Colliders no occluder applies to are left to the Physics
// gizmo. A capsule is drawn as its bounding box and a mesh collider as its model's bounding box: the outline says which
// colliders count, not their exact shape (the Physics gizmo draws that).
import { GameObject, type Engine } from "../../../engine";
import { type EditorOverlay, meshTriangleData } from "../../../engine/editor";
import { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider } from "../../physics/runtime";
import { nearestOccluder } from "../runtime/AudioOccluder";
import { zoneGeometry, zoneVolumeWire, type ZoneGeometry } from "./zoneMath";
import { zonePoseOf } from "./AudioReverbZoneGizmo";
import { audioOfProject, blendColor, materialTint } from "./audioInspectorModel";
import { editor, type ViewportToolContribution } from "../../../editor/sdk";

/** The tool's id: also its overlay id. */
export const OCCLUDER_TOOL_ID = "myco.audio.occluders";

/** What unselected outlines fade toward, and how far; `openness` fades them further. */
const DIM_TOWARD = 0x161c1e;
const DIM_AMOUNT = 0.5;
const OPEN_DIM = 0.6;

/** A mesh's local bounding box, worked out once per triangle data object. */
const bounds = new WeakMap<object, { center: [number, number, number]; size: [number, number, number] }>();

function meshBounds(data: { readonly vertices: readonly number[] }): { center: [number, number, number]; size: [number, number, number] } | null {
  const known = bounds.get(data);
  if (known) return known;
  const v = data.vertices;
  if (v.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < v.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, v[i + a]!);
      hi[a] = Math.max(hi[a]!, v[i + a]!);
    }
  }
  const box = { center: [0, 1, 2].map((a) => (lo[a]! + hi[a]!) / 2) as [number, number, number], size: [0, 1, 2].map((a) => hi[a]! - lo[a]!) as [number, number, number] };
  bounds.set(data, box);
  return box;
}

/** A 3D collider's outline volume in world space, or null when it can't be drawn (a mesh still loading). */
export function colliderVolume(c: Collider): ZoneGeometry | null {
  const node = c.node;
  const pose = zonePoseOf(node);
  const center = [c.center.x, c.center.y, c.center.z];
  if (c instanceof BoxCollider) return zoneGeometry(pose, "box", center, [c.size.x, c.size.y, c.size.z], 0);
  if (c instanceof SphereCollider) return zoneGeometry(pose, "sphere", center, [0, 0, 0], c.radius);
  if (c instanceof CapsuleCollider) {
    const d = 2 * c.radius, h = Math.max(c.height, d);
    return zoneGeometry(pose, "box", center, c.direction === "x" ? [h, d, d] : c.direction === "z" ? [d, d, h] : [d, h, d], 0);
  }
  if (c instanceof MeshCollider) {
    const data = meshTriangleData(c.mesh, node);
    const box = data && meshBounds(data);
    return box ? zoneGeometry(pose, "box", [center[0]! + box.center[0], center[1]! + box.center[1], center[2]! + box.center[2]], box.size, 0) : null;
  }
  return null;
}

/** What to draw this frame: every collider an occluder applies to, in the occluder's material tint. */
export function occluderOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const colliders = GameObject.findObjectsOfType(Collider);
  if (colliders.length === 0) return overlay;
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  const audio = audioOfProject(editor.project.current?.settings);
  for (const c of colliders) {
    const node = c.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const occluder = nearestOccluder(node);
    if (!occluder) continue;
    const volume = colliderVolume(c);
    if (!volume) continue;
    const open = Math.min(1, Math.max(0, Number.isFinite(occluder.openness) ? occluder.openness : 0));
    let dim = selected.has(occluder.node) || selected.has(node) ? 0 : DIM_AMOUNT;
    dim = 1 - (1 - dim) * (1 - OPEN_DIM * open);
    const color = blendColor(materialTint(audio, occluder.material), DIM_TOWARD, dim);
    for (const points of zoneVolumeWire(volume)) overlay.lines.push({ points, closed: false, color });
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
