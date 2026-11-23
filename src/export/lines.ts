// Line tables in game builds (ADR 0354 §5–§6, amended by 0357 §1; L3):
//
// - **The line index**: the export writes `audio/lines/index.json` (`myco.lineindex@1`, `lineIndex.ts`): the line tables
//   and dialogue files the build ships, which the runtime's line registry reads at that fixed project path (asset
//   sources can't be listed in a build).
// - **Line tables ship without what never ships**: actors' `notes` and 0354's retired per-language `text` are taken out
//   (subtitles come from `strings/<code>.json` through each line's `textKey`, 0357 §1); everything the runtime plays by
//   stays.
// - **What a line table brings into a package's language part** (`lineTableFiles`), for the audio step (audio.ts).
//
// Pure.
import { LINE_INDEX_PATH, lineIndexOf, lineIndexToJson } from "../engine/audio/localisation/lines/lineIndex";
import { formatLineTable, isLineTablePath, parseLineTable } from "../engine/audio/localisation/lines/format";
import { lineFile } from "../engine/audio/localisation/lines/resolve";
import type { LineTable } from "../engine/audio/localisation/types";
import { fallbackChain } from "../engine/localisation/languages";
import type { BuildLanguages } from "./strings";

/** The files the lines of `table` play in language `code` (each through the language's chain), sorted. */
export function lineTableFiles(table: LineTable, roots: readonly string[], languages: BuildLanguages, code: string, exists: (path: string) => boolean): string[] {
  const chain = fallbackChain(languages.settings, code);
  const out = new Set<string>();
  for (const line of table.lines) {
    const hit = lineFile(table, line, chain, roots, exists);
    if (hit) out.add(hit.path);
  }
  return [...out].sort();
}

/**
 * The line index and the stripped line tables of a build whose project files are `copies` (JSON text in `json`), as
 * generated project files by project path; none when the build ships no line table or dialogue file.
 */
export function planLineIndex(json: ReadonlyMap<string, string>, copies: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const index = lineIndexOf(copies.filter((p) => p !== LINE_INDEX_PATH));
  if (index.tables.length === 0 && index.dialogue.length === 0) return out;
  out.set(LINE_INDEX_PATH, `${JSON.stringify(lineIndexToJson(index))}\n`);
  for (const path of copies.filter(isLineTablePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(json.get(path) ?? "");
    } catch {
      continue; // shipped as it is: the runtime warns about it as in the editor
    }
    const { table } = parseLineTable(raw, path);
    out.set(path, formatLineTable({ ...table, lines: table.lines.map(({ notes: _notes, text: _text, ...line }) => line) }));
  }
  return out;
}
