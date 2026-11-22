// What a detection changes in a sample block (ADR 0328 "detection of what's missing"): the detected tempo (its map
// too) and root note, with `source: "detected"`. At import ("Detect what's missing") only a missing or earlier
// detected value is filled, and only from a confident result: a value from the file or set by the user is never
// overwritten. On demand (Detect in the popovers) the user asked, so any value is replaced, unless the result is too
// weak to use. Pure.
import type { DetectKind, SampleDetection } from "../../../engine/audio/sample/detect/detect";
import { ROOT_CONFIDENCE_FLOOR } from "../../../engine/audio/sample/detect/pitch";
import { TEMPO_CONFIDENCE_FLOOR } from "../../../engine/audio/sample/detect/tempo";
import type { SampleEdits, SampleRoot, SampleTempo } from "../../../engine/audio/sample/types";
import type { SampleEdit } from "./sampleEditing";

/** The least confidence each kind needs at import. */
export const IMPORT_FLOOR: Readonly<Record<DetectKind, number>> = { tempo: TEMPO_CONFIDENCE_FLOOR, root: ROOT_CONFIDENCE_FLOOR };
/** The least confidence Detect accepts when asked (lower: the user sees the confidence and can Clear). */
export const DEMAND_FLOOR = 0.2;

const NAMES: Readonly<Record<DetectKind, string>> = { tempo: "tempo", root: "root note" };

/** The kinds a block lacks or only has detected (what "Detect what's missing" may fill). */
export function detectionNeeded(e: { readonly tempo: SampleTempo | null; readonly root: SampleRoot | null }): DetectKind[] {
  const out: DetectKind[] = [];
  if (!e.tempo || e.tempo.source === "detected") out.push("tempo");
  if (!e.root || e.root.source === "detected") out.push("root");
  return out;
}

const percent = (c: number) => `${Math.round(c * 100)} %`;

/** A kind's result and its confidence, or null when the analyser found nothing. */
function resultOf(d: SampleDetection, kind: DetectKind): { confidence: number } | null {
  return kind === "tempo" ? d.tempo : d.root;
}

/** The block with `kind` taken from `d`. */
function withDetected(e: SampleEdits, d: SampleDetection, kind: DetectKind): SampleEdits {
  if (kind === "tempo" && d.tempo) {
    return { ...e, tempo: { bpm: d.tempo.bpm, meter: e.tempo?.meter ?? "4/4", map: d.tempo.map.map((m) => ({ ...m })), source: "detected" } };
  }
  if (kind === "root" && d.root) return { ...e, root: { note: d.root.note, cents: d.root.cents, source: "detected" } };
  return e;
}

const labelOf = (kinds: readonly DetectKind[]) => `Detect ${kinds.map((k) => NAMES[k]).join(" and ")}`;

/**
 * The block after applying `d` for `kinds`, at import or on demand (see the file header), with the step's label; or
 * why nothing changes.
 */
export function detectedEdit(e: SampleEdits, d: SampleDetection, kinds: readonly DetectKind[], at: "import" | "demand"): SampleEdit {
  if (at === "import") {
    const open = detectionNeeded(e).filter((k) => kinds.includes(k));
    if (open.length === 0) return { refused: `the ${kinds.map((k) => NAMES[k]).join(" and ")} ${kinds.length > 1 ? "are" : "is"} already set` };
    const used = open.filter((k) => (resultOf(d, k)?.confidence ?? 0) >= IMPORT_FLOOR[k]);
    if (used.length === 0) return { refused: "nothing clear was detected" };
    return { next: used.reduce((acc, k) => withDetected(acc, d, k), e), label: labelOf(used) };
  }
  for (const k of kinds) {
    const r = resultOf(d, k);
    if (!r) return { refused: `no ${NAMES[k]} could be found` };
    if (r.confidence < DEMAND_FLOOR) return { refused: `no clear ${NAMES[k]} was found (confidence ${percent(r.confidence)})` };
  }
  return { next: kinds.reduce((acc, k) => withDetected(acc, d, k), e), label: labelOf(kinds) };
}

/** Use a half or double tempo candidate (the detected tempo's octave is a matter of feel): still `detected`. */
export function tempoCandidateEdit(e: SampleEdits, bpm: number): SampleEdit {
  if (!e.tempo) return { refused: "there's no tempo to change" };
  return { next: { ...e, tempo: { ...e.tempo, bpm, map: e.tempo.map.map((m) => ({ ...m, bpm: Math.round(m.bpm * (bpm / e.tempo!.bpm) * 100) / 100 })), source: "detected" } }, label: "Detect tempo" };
}

/** "Detected 128 BPM · 90 % sure" / "Detected A3 −12 ct · 95 % sure", for the popovers' status line. */
export function detectionSummary(d: SampleDetection, kind: DetectKind): string | null {
  if (kind === "tempo" && d.tempo) return `Detected ${d.tempo.bpm} BPM${d.tempo.map.length ? ` with ${d.tempo.map.length} tempo change${d.tempo.map.length === 1 ? "" : "s"}` : ""} · ${percent(d.tempo.confidence)} sure`;
  if (kind === "root" && d.root) return `Detected ${d.root.note}${d.root.cents ? ` ${d.root.cents > 0 ? "+" : "−"}${Math.abs(d.root.cents)} ct` : ""} (${d.root.hz} Hz) · ${percent(d.root.confidence)} sure`;
  return null;
}
