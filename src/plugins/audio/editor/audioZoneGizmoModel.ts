// What the AudioZone Inspector section and gizmo show (ADR 0347), as pure functions of the zone's fields and the
// project's files: the outline of the zone's upright box (its bottom and top rectangles and the four vertical edges)
// and, for an inside zone, the feather ring at mid height; the section's readout and notices. The box is the runtime's
// by construction: the gizmo passes the zone's own world box (`AudioZone._worldBox`, an `UprightBox`).
import type { UprightBox } from "../runtime/core/spatial";
import type { AudioZone } from "../runtime/AudioZone";
import { assetRefTarget } from "../../../editor/sdk";

export type V3 = [number, number, number];

/** The four corners of `box` grown by `grow` at height `y`, in order around it. */
function ring(box: UprightBox, y: number, grow: number): V3[] {
  const hw = box.halfWidth + grow, hd = box.halfDepth + grow;
  const p = { x: 0, z: 0 };
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([sx, sz]): V3 => {
    box.toWorld(sx * hw, sz * hd, p);
    return [p.x, y, p.z];
  });
}

const closed = (pts: V3[]): V3[] => [...pts, pts[0]!];

/**
 * The lines that outline a zone: its bottom and top rectangles and four vertical edges; for an inside zone with a
 * feather, the rectangle `feather` metres out at mid height (where its sound has faded to nothing).
 */
export function audioZoneOutline(box: UprightBox, heard: string, feather: number): { volume: V3[][]; feather: V3[][] } {
  const bottom = ring(box, box.bottom, 0), top = ring(box, box.top, 0);
  const volume: V3[][] = [closed(bottom), closed(top)];
  for (let i = 0; i < 4; i++) volume.push([bottom[i]!, top[i]!]);
  const shell = heard === "inside" && feather > 0 ? [closed(ring(box, (box.bottom + box.top) / 2, feather))] : [];
  return { volume, feather: shell };
}

export interface AudioZoneNotice { kind: "info" | "warning"; text: string }

/** One line saying how the zone is heard. */
export function audioZoneHeardLine(zone: Pick<AudioZone, "heard" | "feather">): string {
  return zone.heard === "inside"
    ? `Heard only inside the box, all around the listener; it fades to silence over ${zone.feather} m outside.`
    : "Heard from the box's nearest point outside it (its spread narrowing with distance) and all around the listener inside.";
}

/** What the Inspector says: no sound, a sound that isn't in the project, a box without height, the inside-bed stand-in. */
export function audioZoneNotices(zone: Pick<AudioZone, "sound" | "heard" | "bottom" | "top">, projectFiles: readonly string[] | null): AudioZoneNotice[] {
  const out: AudioZoneNotice[] = [];
  const sound = assetRefTarget(zone.sound);
  if (sound === "") out.push({ kind: "warning", text: "Pick a sound (a playlist or a sample): the zone is silent without one." });
  else if (projectFiles && !projectFiles.includes(sound)) out.push({ kind: "warning", text: `The sound "${sound}" is not in the project, so the zone is silent.` });
  if (!(zone.top > zone.bottom)) out.push({ kind: "warning", text: "The top is not above the bottom: the box has no height, so only its floor counts as inside." });
  if (zone.heard === "edge") out.push({ kind: "info", text: "Inside, the sound plays at the listener for now; it moves into the bus's ambisonic bed when the audio core can take a voice there." });
  return out;
}
