// The Voices panel and the plan's rays (ADR 0333 "The Voices table reads the runtime's own debug rows"; the prototype's
// Voices table, B.4): one row per emitter, audio zone and 2D sound with how it is heard, read from the test scene
// player's `voices()` readout, never simulated. A ray runs from the active listener to each playing positioned sound:
// solid when it is heard clear, dashed when something occludes it.
//
// Pure: no DOM, no signals.
import type { TestSceneRendering, TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { findObject } from "./sceneEdits";

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
}

const dbOf = (gain: number) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);

/** The Occlusion column: "Clear", "−9 dB · low-pass 1.2 kHz · wood", or why it isn't traced. */
export function occlusionText(row: TestSceneVoiceRow): string {
  if (row.kind === "sound2d") return "not traced (2D)";
  if (!row.playing) return "—";
  if (row.rendered === "bed" || row.rendered === "ambisonic") return "not traced (bed)";
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

/** The table's rows, in the readout's order, named from the scene. */
export function voiceTable(scene: AudioTestScene, rows: readonly TestSceneVoiceRow[], silenced: (id: string) => boolean = () => false): VoiceTableRow[] {
  return rows.map((r) => {
    const o = findObject(scene, r.id);
    return {
      id: r.id,
      name: o?.obj.name ?? r.id,
      kind: r.kind,
      playing: r.playing,
      rendered: r.rendered,
      renderedText: silenced(r.id) ? "Muted" : !r.playing ? "Not playing" : r.rendered ? RENDERED_LABEL[r.rendered] : "—",
      distanceText: distanceText(r),
      occlusionText: occlusionText(r),
      dopplerText: dopplerText(r),
      silenced: silenced(r.id),
    };
  });
}

/** A ray from the active listener: to each playing emitter or audio zone heard in place (not 2D, not a bed). */
export interface Ray {
  readonly id: string;
  readonly occluded: boolean;
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
