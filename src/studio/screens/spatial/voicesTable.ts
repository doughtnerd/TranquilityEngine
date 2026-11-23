// The Voices panel and the plan's rays (ADR 0347 "The Voices table reads the runtime's own debug rows"; the prototype's
// Voices table, B.4): one row per emitter, audio zone and 2D sound with how it is heard, read from the test scene
// player's `voices()` readout, never simulated; the base game scene's own emitters and audio zones follow the scene's
// (decision log D43: they play underneath, so they are heard too), marked as the base's. A moving emitter's distance is
// read each animation frame from where it is now (`liveMotion.ts`). A ray runs from the active listener to each playing
// positioned sound, a moving emitter where it is now: solid when it is heard clear, dashed when something occludes it.
//
// Pure: no DOM, no signals.
import type { BaseSoundRef, TestSceneMotionRow, TestSceneRendering, TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { BaseSceneImport, BaseSceneObject } from "../../../engine/audio/spatial/baseScene";
import type { AudioTestScene, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { nearestOnBox, type P2 } from "./geometry";
import { liveDistanceText, placeNow } from "./liveMotion";
import { activeListener, boxOf, findObject } from "./sceneEdits";

/** The id a base scene's sound has in the readout (apart from the scene's own ids). */
export const baseSoundId = (key: string): string => `base:${key}`;

/** The base scene's object a readout id names, or null for the scene's own. */
export function baseObjectOf(base: BaseSceneImport | null | undefined, id: string): BaseSceneObject | null {
  if (!base || !id.startsWith("base:")) return null;
  const key = id.slice(5);
  return base.objects.find((o) => o.key === key) ?? null;
}

/**
 * The base scene's sounds for the player to read (`PlayAudioTestSceneOptions.base`): each active emitter and audio zone,
 * by the `replace` key of its component (`"Cave/Campfire/AudioSource"`, `[i]` past the first of its type on the node).
 */
export function baseSoundRefs(base: BaseSceneImport | null | undefined): BaseSoundRef[] {
  if (!base) return [];
  return base.objects
    .filter((o) => o.active && (o.kind === "emitter" || o.kind === "audioZone"))
    .map((o) => {
      const short = o.type.replace(/^engine\./, "");
      return { id: baseSoundId(o.key), path: `${o.path}/${short}${o.index > 0 ? `[${o.index}]` : ""}` };
    });
}

/** What the Rendered column says for each rendering (the legend's words). */
export const RENDERED_LABEL: Readonly<Record<TestSceneRendering, string>> = {
  hrtf: "HRTF",
  panned: "Panned",
  bed: "Ambisonic bed",
  ambisonic: "Ambisonic bed",
  "2d": "2D",
};

/** Occlusion this close to open (gain) reads as clear. */
export const CLEAR_GAIN = 0.98;

export interface VoiceTableRow {
  readonly id: string;
  readonly name: string;
  readonly kind: TestSceneVoiceRow["kind"];
  readonly playing: boolean;
  readonly rendered: TestSceneRendering | null;
  readonly renderedText: string;
  readonly distanceText: string;
  readonly occlusionText: string;
  readonly dopplerText: string;
  /** Muted or not soloed in the audition. */
  readonly silenced: boolean;
  /** One of the base game scene's own sounds (read-only, not in the scene). */
  readonly base: boolean;
}

const dbOf = (gain: number) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);

/**
 * The Occlusion column: "Clear", "−9 dB · low-pass 1.2 kHz · wood", or why it isn't traced. `on` false: the sound's own
 * setting turns occlusion off (a playlist's spatial block), so it reads "Off", never "Clear" through a wall.
 */
export function occlusionText(row: TestSceneVoiceRow, on = true): string {
  if (row.kind === "sound2d") return "not traced (2D)";
  if (!row.playing) return "—";
  if (row.rendered === "bed" || row.rendered === "ambisonic") return "not traced (bed)";
  if (!on && row.kind === "emitter") return "Off (this sound)";
  const o = row.occlusion;
  if (!o) return "—";
  if (o.gain >= CLEAR_GAIN) return "Clear";
  const db = dbOf(o.gain);
  const parts = [Number.isFinite(db) ? `${db.toFixed(1).replace("-", "−")} dB` : "silent"];
  if (o.cutoffHz !== null && o.cutoffHz < 20000) parts.push(`low-pass ${hz(o.cutoffHz)}`);
  if (o.material) parts.push(o.material);
  return parts.join(" · ");
}

/** The Doppler column: "+35 ct", "−12 ct", "—" when none or unknown. */
export function dopplerText(row: TestSceneVoiceRow): string {
  const c = row.dopplerCents;
  if (c === null || !row.playing || Math.abs(c) < 0.5) return "—";
  return `${c > 0 ? "+" : "−"}${Math.round(Math.abs(c))} ct`;
}

export const distanceText = (row: TestSceneVoiceRow): string => (row.distance === null ? "—" : `${row.distance.toFixed(1)} m`);

/** What else the table reads: the base scene (names its sounds) and, while playing, where each emitter is now. */
export interface VoiceTableContext {
  readonly base?: BaseSceneImport | null;
  readonly motion?: readonly TestSceneMotionRow[];
  /** Whether an emitter's sound is traced for occlusion (false: its playlist turns it off); default true. */
  readonly occlusionOn?: (id: string) => boolean;
}

/**
 * The table's rows, in the readout's order, named from the scene (a base sound by its node's name). A moving emitter's
 * distance is from where it is now when `motion` has it (read every frame), else the readout's.
 */
export function voiceTable(scene: AudioTestScene, rows: readonly TestSceneVoiceRow[], silenced: (id: string) => boolean = () => false, ctx: VoiceTableContext = {}): VoiceTableRow[] {
  const listener = activeListener(scene).position;
  return rows.map((r) => {
    const o = findObject(scene, r.id);
    const b = o ? null : baseObjectOf(ctx.base, r.id);
    const moving = o?.kind === "emitter" && o.obj.kind === "moving" && ctx.motion?.some((m) => m.id === r.id);
    const quiet = !b && silenced(r.id);
    return {
      id: r.id,
      name: o?.obj.name ?? b?.name ?? r.id,
      kind: r.kind,
      playing: r.playing,
      rendered: r.rendered,
      renderedText: quiet ? "Muted" : !r.playing ? "Not playing" : r.rendered ? RENDERED_LABEL[r.rendered] : "—",
      distanceText: moving && o ? liveDistanceText(placeNow(o, ctx.motion!)!, listener) : distanceText(r),
      occlusionText: occlusionText(r, ctx.occlusionOn?.(r.id) ?? true),
      dopplerText: dopplerText(r),
      silenced: quiet,
      base: b !== null,
    };
  });
}

/** A ray from the active listener: to each playing emitter or audio zone heard in place (not 2D, not a bed). */
export interface Ray {
  readonly id: string;
  readonly occluded: boolean;
}

/**
 * Where a ray to readout row `id` ends: a moving emitter where it is now (`motion`), a zone's nearest point to the
 * listener, a point object where it is; a base sound at its object's place (a box zone's nearest point). Null when the
 * id names nothing on the plan.
 */
export function rayEnd(scene: AudioTestScene, id: string, listener: Vec3, motion: readonly TestSceneMotionRow[], base?: BaseSceneImport | null): P2 | null {
  const o = findObject(scene, id);
  if (o) {
    const box = boxOf(o);
    return box ? nearestOnBox(box, listener) : placeNow(o, motion);
  }
  const b = baseObjectOf(base, id);
  if (!b) return null;
  return b.box ? nearestOnBox(b.box, listener) : b.position;
}

export function raysOf(rows: readonly TestSceneVoiceRow[]): Ray[] {
  return rows
    .filter((r) => r.playing && r.kind !== "sound2d" && r.rendered !== "2d" && r.rendered !== "bed" && r.rendered !== "ambisonic")
    .map((r) => ({ id: r.id, occluded: !!r.occlusion && r.occlusion.gain < CLEAR_GAIN }));
}

/** The legend (the prototype's): what each mark on the plan means. */
export const LEGEND: readonly { readonly id: string; readonly label: string }[] = [
  { id: "hrtf", label: "HRTF" },
  { id: "panned", label: "Panned" },
  { id: "bed", label: "Bed" },
  { id: "zone", label: "Audio zone" },
  { id: "edge", label: "Zone edge" },
  { id: "occluded", label: "Occluded" },
];
