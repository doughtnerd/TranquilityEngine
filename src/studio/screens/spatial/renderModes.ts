// How each emitter will be heard before the scene plays (the prototype's render-mode rings, S:1029-1035, 1130): the
// runtime's rule from the project's Listening settings (ADR 0347: `voices.hrtf` and `bedBeyond`) over the scene as
// placed: an emitter farther from the listening player than the bed distance folds into the ambisonic bed; of the rest,
// the nearest N get HRTF and the others are panned. While the scene plays, the runtime's own rows say instead.
//
// Pure: no DOM, no signals.
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import type { TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import { placeNow } from "./liveMotion";
import { activeListener, allObjects } from "./sceneEdits";

/** How an emitter is drawn: its ring's colour. */
export type RenderMode = "hrtf" | "panned" | "bed";

/** The project's Listening settings the rule reads. */
export interface ListeningSettings {
  /** HRTF for the nearest this many voices. */
  readonly hrtf: number;
  /** Beyond this many metres a sound folds into the ambisonic bed; null: no bed by distance. */
  readonly bedBeyond: number | null;
}

/** Each emitter's predicted mode, by id: the rule applied to where the emitters are (moving ones at their start). */
export function predictModes(scene: AudioTestScene, listening: ListeningSettings): Map<string, RenderMode> {
  const l = activeListener(scene).position;
  const out = new Map<string, RenderMode>();
  const near: { id: string; d: number }[] = [];
  for (const o of allObjects(scene)) {
    if (o.kind !== "emitter") continue;
    const p = placeNow(o, []);
    if (!p) continue;
    const d = Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
    if (listening.bedBeyond !== null && d > listening.bedBeyond) out.set(o.obj.id, "bed");
    else near.push({ id: o.obj.id, d });
  }
  near.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  near.forEach((n, i) => out.set(n.id, i < listening.hrtf ? "hrtf" : "panned"));
  return out;
}

/** The mode a runtime row says (null: not playing, 2D, or no rendering yet). */
export function rowMode(row: TestSceneVoiceRow | undefined): RenderMode | null {
  if (!row?.playing || !row.rendered || row.rendered === "2d") return null;
  return row.rendered === "hrtf" ? "hrtf" : row.rendered === "panned" ? "panned" : "bed";
}

/** The mode to draw emitter `id` with: while playing, the runtime's (null when it isn't heard); stopped, the prediction. */
export function modeOf(id: string, playing: boolean, rows: readonly TestSceneVoiceRow[], predicted: ReadonlyMap<string, RenderMode>): RenderMode | null {
  if (playing) return rowMode(rows.find((r) => r.id === id));
  return predicted.get(id) ?? null;
}
