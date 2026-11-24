// A decal projector's box as the 3D shape kit's table entry (ADR 0395, built like the reverb zone and collider shapes,
// ADR 0295): its wireframe with an arrow along the projection (+Z) and a cross at the node, its six face handles, and
// what a face drag writes (`size`, and `pivot` unless Alt keeps the centre). Entries work on plain field values in node
// units, never on the Component, so they're tested without an editor.
import { shapeKit3d } from "../../../editor/sdk";
import type { DecalProjector } from "../runtime";

type V3 = shapeKit3d.V3;
type Pose3D = shapeKit3d.Pose3D;
const kit = shapeKit3d;

/** A projector's fields as the gizmo reads them: the box's centre (`pivot`, as the kit's `center`) and `size`, in node units. */
export interface DecalBoxFields {
  readonly center: V3;
  readonly size: V3;
}

/** The box in world space. */
export function decalVolume(f: DecalBoxFields, pose: Pose3D): shapeKit3d.Volume3D {
  const half: V3 = [Math.abs(f.size[0] * pose.scale[0]) / 2, Math.abs(f.size[1] * pose.scale[1]) / 2, Math.abs(f.size[2] * pose.scale[2]) / 2];
  return { shape: "box", center: kit.worldCenter(pose, f.center), axes: kit.axesOf(pose), half, radius: 0 };
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** The projection arrow: from the box's back face centre to its front, with a head; and a small cross at the node. */
export function decalMarks(f: DecalBoxFields, pose: Pose3D): shapeKit3d.Wire {
  const g = decalVolume(f, pose);
  const [x, y, z] = g.axes;
  const back = add(g.center, scale(z, -g.half[2])), front = add(g.center, scale(z, g.half[2]));
  const head = Math.max(0.05, Math.min(g.half[0], g.half[1], g.half[2] || 1) * 0.4);
  const tip = (side: V3): V3[] => [front, add(add(front, scale(z, -head)), scale(side, head * 0.5))];
  const at = pose.position as V3, r = head * 0.5;
  return [[back, front], tip(x), tip(scale(x, -1)), tip(y), tip(scale(y, -1)), [add(at, scale(x, -r)), add(at, scale(x, r))], [add(at, scale(y, -r)), add(at, scale(y, r))]];
}

/** The decal box entry: wire and marks, face handles, face presses. */
export const DECAL_BOX: shapeKit3d.HandleShape3D<DecalBoxFields> = {
  wire: (f, pose) => [...kit.volumeWire(decalVolume(f, pose)), ...decalMarks(f, pose)],
  handles: (f, pose) => kit.faceHandles(decalVolume(f, pose)),
  press: (f, pose, handle) => kit.facePress(f, pose, handle),
};

/** A projector's fields as plain values. */
export function readDecalBox(p: DecalProjector): DecalBoxFields {
  return { center: [p.pivot.x, p.pivot.y, p.pivot.z], size: [p.size.x, p.size.y, p.size.z] };
}

/** A shape kit patch (`size`, `center`) as the projector's fields (`size`, `pivot`). */
export function decalPatch(patch: shapeKit3d.FieldPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k === "center" ? "pivot" : k] = v;
  return out;
}
