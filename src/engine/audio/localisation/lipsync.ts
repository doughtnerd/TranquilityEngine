/**
 * Rhubarb Lip Sync import (ADR 0354 §7): the Studio reads Rhubarb's TSV or JSON output into a sample sidecar's
 * `lipsync` block (`{ set: "rhubarb", keys: [[seconds, viseme], …] }`); it never runs Rhubarb. Batch import matches an
 * output file to a line's audio by file name (`intro_01.wav` + `intro_01.txt` or `intro_01.json`).
 *
 * - **TSV** (`rhubarb -f tsv`, the default): one `<seconds>\t<viseme>` row per mouth cue.
 * - **JSON** (`rhubarb -f json`): `{ metadata, mouthCues: [{ start, end, value }] }`.
 *
 * Parses are lenient (ADR 0306): bad rows are dropped with one problem each, the keys then go through the sidecar's own
 * `lipsync` validation (Rhubarb visemes A–H and X, time order, the 20,000-key limit), so the limits stay declared once.
 * A key repeating the viseme before it is dropped (it changes nothing). Never throws.
 *
 * Pure; no plugin, no DOM.
 */
import { parseSampleEdits } from "../sample/format";
import type { SampleEdits, SampleLipsync } from "../sample/types";

/** What an import reads: the lip-sync block (null when nothing usable is left) and the problems found. */
export interface LipsyncImport {
  lipsync: SampleLipsync | null;
  problems: string[];
}

/** The file extensions Rhubarb writes that the import reads. */
export const LIPSYNC_EXTENSIONS: readonly string[] = ["txt", "tsv", "json"];

/** True for a file name the import reads (a Rhubarb TSV or JSON output). */
export const isLipsyncFile = (name: string): boolean => LIPSYNC_EXTENSIONS.includes(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

/** Keys after validation by the sidecar format, with repeats of the same viseme dropped. */
function finish(raw: [number, string][], where: string, problems: string[]): LipsyncImport {
  const parsed = parseSampleEdits({ lipsync: { set: "rhubarb", keys: raw } }, where, problems).lipsync;
  if (!parsed) return { lipsync: null, problems };
  const keys = parsed.keys.filter((k, i) => i === 0 || parsed.keys[i - 1]![1] !== k[1]);
  return { lipsync: { set: "rhubarb", keys }, problems };
}

/** Rhubarb's TSV output: `<seconds>\t<viseme>` rows (blank lines skipped; spaces between the columns accepted). */
export function parseRhubarbTsv(text: string, where = "rhubarb"): LipsyncImport {
  const problems: string[] = [];
  const raw: [number, string][] = [];
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((line, i) => {
    const row = line.trim();
    if (row === "") return;
    const m = /^(\d+(?:\.\d+)?)\s+(\S+)$/.exec(row);
    if (!m) return void problems.push(`${where}:${i + 1}: must be "<seconds>\t<viseme>"; dropped.`);
    raw.push([Number(m[1]), m[2]!.toUpperCase()]);
  });
  return finish(raw, where, problems);
}

/** Rhubarb's JSON output (`mouthCues`, each `{ start, end, value }`), parsed or as text. */
export function parseRhubarbJson(input: unknown, where = "rhubarb"): LipsyncImport {
  const problems: string[] = [];
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input.replace(/^﻿/, ""));
    } catch (e) {
      problems.push(`${where}: isn't JSON (${e instanceof Error ? e.message : String(e)}).`);
      return { lipsync: null, problems };
    }
  }
  const cues = typeof doc === "object" && doc !== null ? (doc as { mouthCues?: unknown }).mouthCues : undefined;
  if (!Array.isArray(cues)) {
    problems.push(`${where}: has no mouthCues list (is it Rhubarb's JSON output?).`);
    return { lipsync: null, problems };
  }
  const raw: [number, string][] = [];
  cues.forEach((c, i) => {
    const cue = c as { start?: unknown; value?: unknown } | null;
    if (typeof cue !== "object" || cue === null || typeof cue.start !== "number" || typeof cue.value !== "string") return void problems.push(`${where}.mouthCues[${i}]: must be { start, end, value }; dropped.`);
    raw.push([cue.start, cue.value.toUpperCase()]);
  });
  return finish(raw, where, problems);
}

/** A Rhubarb output file by its name: `.json` as JSON, `.txt` and `.tsv` as TSV. */
export function parseRhubarb(text: string, fileName: string): LipsyncImport {
  return fileName.toLowerCase().endsWith(".json") ? parseRhubarbJson(text, fileName) : parseRhubarbTsv(text, fileName);
}

/** A sample's edits with `lipsync` set (or removed with null), as one edit step: `{ next, label }`, or `{ refused }`. */
export function withLipsync(e: SampleEdits, imported: LipsyncImport | null): { readonly next: SampleEdits; readonly label: string } | { readonly refused: string } {
  if (imported === null) {
    if (!e.lipsync) return { refused: "the sample has no lip-sync data" };
    const { lipsync: _gone, ...rest } = e;
    return { next: rest, label: "Clear lip-sync" };
  }
  if (!imported.lipsync) return { refused: imported.problems[0] ?? "the file has no mouth cues" };
  return { next: { ...e, lipsync: imported.lipsync }, label: `Import lip-sync (${imported.lipsync.keys.length} keys)` };
}
