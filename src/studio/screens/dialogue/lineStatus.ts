// The Lines table's status cell per language (ADR 0340 §8–§9, 0343 §6): whether a line is recorded in a language, heard
// from another one through the fallback chain (named), or missing; and flags on it: a duration mismatch against the
// reference language's file (both durations), a script change (the file's sidecar `vo.textHash` differs from the hash of
// the reference text now), and the reading speed of the language's subtitle over the heard audio. Pure.
import { durationMismatch } from "../../../engine/audio/localisation/format";
import { textHash } from "../../../engine/localisation/textHash";
import { fileIn, heardFile, referenceText, textThrough, type DialogueData, type LineRef } from "./dialogueData";
import { readingFlag, subtitleStrip } from "./subtitleStrip";

export type CellState =
  | { readonly kind: "recorded"; readonly path: string }
  | { readonly kind: "fallback"; readonly path: string; readonly from: string }
  | { readonly kind: "missing" };

export interface LanguageCell {
  readonly code: string;
  readonly state: CellState;
  /** The language's own file is off the reference's by more than the tolerance (seconds of each). */
  readonly mismatch: { readonly duration: number; readonly reference: number } | null;
  /** The reference text changed after the language's file was imported. */
  readonly scriptChanged: boolean;
  /** The subtitle in this language asks more characters per second than its reading speed while the audio plays. */
  readonly readingSpeed: { readonly cps: number; readonly max: number } | null;
}

/** The cell of `ref` in `code`. */
export function languageCell(data: DialogueData, ref: LineRef, code: string): LanguageCell {
  const own = fileIn(data, ref, code);
  const heard = own === null ? heardFile(data, ref, code) : null;
  const state: CellState = own !== null ? { kind: "recorded", path: own } : heard ? { kind: "fallback", path: heard.path, from: heard.language } : { kind: "missing" };
  let mismatch: LanguageCell["mismatch"] = null;
  let scriptChanged = false;
  if (own !== null) {
    const reference = data.languages.reference;
    const refFile = code === reference ? null : fileIn(data, ref, reference);
    const d = data.duration(own), dRef = refFile ? data.duration(refFile) : null;
    if (d !== null && dRef !== null && durationMismatch(d, dRef, data.localisation.durationTolerance)) mismatch = { duration: d, reference: dRef };
    const vo = data.facts(own)?.vo ?? null;
    const text = referenceText(data, ref);
    scriptChanged = vo !== null && text !== null && vo.textHash !== textHash(text);
  }
  let readingSpeed: LanguageCell["readingSpeed"] = null;
  const text = textThrough(data, ref, code);
  const path = own ?? heard?.path ?? null;
  const duration = path ? data.duration(path) : null;
  if (text && duration !== null) {
    readingSpeed = readingFlag(subtitleStrip(text.text, code, duration, data.languages, data.subtitles, path ? data.facts(path)?.markers ?? [] : []));
  }
  return { code, state, mismatch, scriptChanged, readingSpeed };
}

/** One cell per project language, in list order. */
export const languageCells = (data: DialogueData, ref: LineRef): LanguageCell[] => data.languages.list.map((l) => languageCell(data, ref, l.code));

/** A cell's short text and its tooltip. */
export function cellLabel(cell: LanguageCell): { text: string; title: string; tone: "ok" | "fallback" | "missing" | "warn" } {
  const flags: string[] = [];
  if (cell.mismatch) flags.push(`duration ${cell.mismatch.duration.toFixed(1)} s, reference ${cell.mismatch.reference.toFixed(1)} s`);
  if (cell.scriptChanged) flags.push("the reference text changed after this file was imported");
  if (cell.readingSpeed) flags.push(`${cell.readingSpeed.cps} cps, max ${cell.readingSpeed.max}`);
  const s = cell.state;
  const base = s.kind === "recorded" ? "Recorded" : s.kind === "fallback" ? `Heard in ${s.from}` : "Missing";
  const title = [s.kind === "missing" ? `Missing in ${cell.code}: no language of its chain has a file` : `${base}: ${s.path}`, ...flags].join("\n");
  const marks = `${cell.mismatch ? " ⚠" : ""}${cell.scriptChanged ? " ✎" : ""}${cell.readingSpeed ? ` ${cell.readingSpeed.cps}cps` : ""}`;
  const text = s.kind === "recorded" ? `✓${marks}` : s.kind === "fallback" ? `→${s.from}${marks}` : `—${marks}`;
  const tone = flags.length > 0 ? "warn" : s.kind === "recorded" ? "ok" : s.kind === "fallback" ? "fallback" : "missing";
  return { text, title, tone };
}
