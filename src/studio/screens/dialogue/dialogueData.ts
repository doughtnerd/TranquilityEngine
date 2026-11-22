// What every Dialogue screen model reads (ADR 0340 §9, 0343 §1, 0341 §7): the project's languages, `audio.json`'s
// `localisation`, the line tables, their string tables and translations, and per audio file its existence, its length
// and the sidecar's `vo`, `normalize` and markers. The screen builds it from the open project (`dialogueProject.ts`);
// tests and stories build it from plain values. Pure.
import type { AudioLocalisation, LineRow, LineTable } from "../../../engine/audio/localisation/types";
import { lineFile, lineFileIn, lineKeyIndex, lineRoot, type LineFile, type LineLocation } from "../../../engine/audio/localisation/lines/resolve";
import { stringTablePathOf, subtitleKeyOf } from "../../../engine/audio/localisation/lines/format";
import type { SampleMarker, SampleNormalize, SampleVo } from "../../../engine/audio/sample/types";
import { fallbackChain, type LanguageSettings } from "../../../engine/localisation/languages";
import type { StringTable } from "../../../engine/localisation/strings/format";
import type { TranslationFile } from "../../../engine/localisation/strings/translation";
import type { SubtitleProjectSettings } from "../../../engine/localisation/subtitleSettings";

/** A line table and where it is. */
export interface TableDoc {
  readonly path: string;
  readonly table: LineTable;
}

/** What a sidecar says about a file the screen shows. */
export interface FileFacts {
  readonly vo: SampleVo | null;
  readonly normalize: SampleNormalize | null;
  readonly markers: readonly SampleMarker[];
}

export interface DialogueData {
  readonly languages: LanguageSettings;
  readonly localisation: AudioLocalisation;
  readonly subtitles: SubtitleProjectSettings;
  /** Every line table, in path order. */
  readonly tables: readonly TableDoc[];
  /** A string table by path (null when there is none yet). */
  strings(path: string): StringTable | null;
  /** A string table's translation into `code` (null when there is none yet). */
  translation(tablePath: string, code: string): TranslationFile | null;
  exists(path: string): boolean;
  /** Seconds, or null while unknown (not measured yet, or not audio). */
  duration(path: string): number | null;
  /** The file's sidecar facts (null without a sidecar). */
  facts(path: string): FileFacts | null;
}

/** A line with the table it sits in. */
export interface LineRef {
  readonly doc: TableDoc;
  readonly line: LineRow;
}

/** Every line of every table, in table path order then row order. */
export const allLines = (data: DialogueData): LineRef[] => data.tables.flatMap((doc) => doc.table.lines.map((line) => ({ doc, line })));

/** The project's line keys (the first definition wins, as at runtime) and the duplicates. */
export const keyIndex = (data: DialogueData): { keys: Map<string, LineLocation>; duplicates: { key: string; paths: string[] }[] } => lineKeyIndex(data.tables);

/** The line `key` and its table, or null. */
export function findLine(data: DialogueData, key: string): LineRef | null {
  for (const doc of data.tables) {
    const line = doc.table.lines.find((l) => l.key === key);
    if (line) return { doc, line };
  }
  return null;
}

const roots = (data: DialogueData) => data.localisation.roots;

/** The file of `ref` in exactly `code` (no fallback), or null when it isn't recorded there. */
export const fileIn = (data: DialogueData, ref: LineRef, code: string): string | null => lineFileIn(ref.doc.table, ref.line, code, roots(data), data.exists);

/** The file `ref` plays in `code`, through the language's fallback chain. */
export const heardFile = (data: DialogueData, ref: LineRef, code: string): LineFile | null =>
  lineFile(ref.doc.table, ref.line, fallbackChain(data.languages, code), roots(data), data.exists);

/** Where a new recording of `ref` in `code` goes: `<root>/<code>/<folder>/<file ?? key>.<ext>`, or null without a root. */
export function recordingPath(data: DialogueData, ref: LineRef, code: string, ext: string): string | null {
  const root = lineRoot(ref.doc.table, roots(data));
  if (root === null) return null;
  const folder = ref.doc.table.folder ? `${ref.doc.table.folder}/` : "";
  return `${root}/${code}/${folder}${ref.line.file ?? ref.line.key}.${ext}`;
}

/** The string table path of a line table. */
export const stringsPathOf = (doc: TableDoc): string => stringTablePathOf(doc.path, doc.table);

/** The reference text of a line's subtitle (the string table's text), or null (never subtitled, or no string yet). */
export function referenceText(data: DialogueData, ref: LineRef): string | null {
  const key = subtitleKeyOf(ref.line);
  if (key === null) return null;
  const table = data.strings(stringsPathOf(ref.doc));
  return table?.strings.find((s) => s.key === key)?.text ?? null;
}

/**
 * A line's subtitle text in exactly `code` (no fallback): the string table's text when `code` is the table's language
 * (the project reference when there is no table yet), else the translation's; null when there is none.
 */
export function textIn(data: DialogueData, ref: LineRef, code: string): string | null {
  const key = subtitleKeyOf(ref.line);
  if (key === null) return null;
  const path = stringsPathOf(ref.doc);
  const table = data.strings(path);
  if (code === (table?.language ?? data.languages.reference)) return referenceText(data, ref);
  return data.translation(path, code)?.strings[key]?.text ?? null;
}

/** A line's subtitle in `code` through the language's fallback chain, with the language it was found in. */
export function textThrough(data: DialogueData, ref: LineRef, code: string): { text: string; language: string } | null {
  for (const c of fallbackChain(data.languages, code)) {
    const text = textIn(data, ref, c);
    if (text !== null) return { text, language: c };
  }
  return null;
}
