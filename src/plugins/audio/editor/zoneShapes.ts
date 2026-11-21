// The zone shape table (ADR 0295; ADR 0162 E1, api-and-models §1.5 and §7): one entry per reverb zone shape, a box zone
// and a sphere zone, giving its volume and blend shell as wireframes, its handles and what a press on a handle writes,
// as a patch of the zone's fields. Both entries carry the blend-shell handle. The zone gizmo (`AudioReverbZoneGizmo.ts`)
// is a loop over this table, built like the Physics plugin's collider shape table from the 3D shape kit's rules (pose
// maths, the face, radius and blend-shell handle rules, the axis drag).
//
// The volume is the runtime's by construction: `zoneVolumeFromMatrix` (`runtime/core/zoneWeights.ts`), which the zone
// manager sizes zones with, given the node's pose as its world matrix. Entries work on plain field values in local
// units (`blendDistance` in world units), never on the Component, so they're tested without an editor.
import { shapeKit3d } from "../../../editor/sdk";
import { makeZoneVolume, zoneVolumeFromMatrix, ZONE_SHAPE_BOX, ZONE_SHAPE_SPHERE } from "../runtime/core/zoneWeights";
import type { AudioReverbZone } from "../runtime";

type V3 = shapeKit3d.V3;
type Pose3D = shapeKit3d.Pose3D;
type Wire = shapeKit3d.Wire;
type Volume3D = shapeKit3d.Volume3D;
const kit = shapeKit3d;

/** A zone's fields as the gizmo reads them: `center`, `size` and `radius` in local units, `blendDistance` in world units. */
export interface ZoneFields {
  readonly center: V3;
  readonly size: V3;
  readonly radius: number;
  readonly blendDistance: number;
}

/** A zone shape's entry. */
export interface ZoneShape extends shapeKit3d.HandleShape3D<ZoneFields> {
  /** The `shape` field's value. */
  readonly shape: "box" | "sphere";
  /** The volume in world space, as the zone manager sizes it, with the node's turned axes. */
  volume(f: ZoneFields, pose: Pose3D): Volume3D;
  /** The blend shell (where the zone has faded to nothing) in world space; none on a hard edge. */
  shell(f: ZoneFields, pose: Pose3D): Wire;
}

const scratch = makeZoneVolume();

/**
 * The zone's volume: `zoneVolumeFromMatrix` for the pose's T·R·S matrix. Its box rows are the node's turned axes up to
 * sign (a mirrored axis flips its row, and a box is symmetric), so the handles turn with the node's rotation, as every
 * kit gizmo's do.
 */
function zoneVolume(shape: "box" | "sphere", f: ZoneFields, pose: Pose3D): Volume3D {
  const v = zoneVolumeFromMatrix(scratch, kit.poseMatrix(pose), 0, shape === "sphere" ? ZONE_SHAPE_SPHERE : ZONE_SHAPE_BOX, f.center[0], f.center[1], f.center[2], f.size[0], f.size[1], f.size[2], f.radius);
  return { shape, center: [v.cx, v.cy, v.cz], axes: kit.axesOf(pose), half: [v.hx, v.hy, v.hz], radius: v.radius };
}

function zoneShape(shape: "box" | "sphere"): ZoneShape {
  const volume = (f: ZoneFields, pose: Pose3D) => zoneVolume(shape, f, pose);
  return {
    shape,
    volume,
    wire: (f, pose) => kit.volumeWire(volume(f, pose)),
    shell: (f, pose) => kit.shellWire(volume(f, pose), f.blendDistance),
    // A box's face centres or a sphere's rim handles, and the blend handle outside the volume's +x/+y edge.
    handles(f, pose) {
      const g = volume(f, pose);
      return { ...(shape === "sphere" ? kit.radiusHandles(g) : kit.faceHandles(g)), [kit.BLEND_HANDLE]: kit.blendHandle(g, f.blendDistance) };
    },
    // The blend handle moves along the diagonal the shell is measured on; the others out from the centre.
    handleAxis: (f, pose, handle) => (handle === kit.BLEND_HANDLE ? kit.blendAxis(volume(f, pose)).direction : undefined),
    press(f, pose, handle) {
      if (handle === kit.BLEND_HANDLE) return kit.blendPress(volume(f, pose));
      return shape === "sphere" ? kit.radiusPress(pose, handle) : kit.facePress(f, pose, handle);
    },
  };
}

/** Every zone shape, by the `shape` field's value. */
export const ZONE_SHAPES = { box: zoneShape("box"), sphere: zoneShape("sphere") } as const;

/** The entry for a zone's `shape` field (anything but "sphere" is a box, as the zone manager reads it). */
export const zoneShapeFor = (shape: string): ZoneShape => (shape === "sphere" ? ZONE_SHAPES.sphere : ZONE_SHAPES.box);

/** A zone's fields as plain values. */
export function readZone(zone: AudioReverbZone): ZoneFields {
  return { center: [zone.center.x, zone.center.y, zone.center.z], size: [zone.size.x, zone.size.y, zone.size.z], radius: zone.radius, blendDistance: zone.blendDistance };
}
