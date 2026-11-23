/**
 * Which file a line plays in a language (ADR 0354 §5), and the project's line keys across tables.
 *
 * - `lineFile`: for each language `c` of the chain, the line's `files[c]` when given and present, else
 *   `<root>/<c>/<folder>/<file ?? key>.<ext>` for the first extension of `LINE_EXTENSIONS` that exists. A line is
 *   **recorded** in a language when its own file exists (not by fallback).
 * - `lineKeyIndex`: keys are unique across the project; the first table in path order wins and the rest are reported.
 *
 * Pure; no plugin, no DOM. `exists` is the caller's.
 */
import type { LineRow, LineTable } from "../types";

/** The extensions a line's file may have, in the order they are tried. */
export const LINE_EXTENSIONS = ["wav", "flac", "ogg", "mp3", "m4a", "sample.json"] as const;

/** The file a line plays and the language it is in. */
export interface LineFile {
  path: string;
  language: string;
}

/** The root a table's files live under: its own, else the first localised root; null without one. */
export const lineRoot = (table: LineTable, roots: readonly string[]): string | null => table.root ?? roots[0] ?? null;

/** The file of `line` in exactly language `code` (no fallback), or null when it isn't recorded there. */
export function lineFileIn(table: LineTable, line: LineRow, code: string, roots: readonly string[], exists: (path: string) => boolean): string | null {
  const explicit = line.files[code];
  if (explicit !== undefined && exists(explicit)) return explicit;
  const root = lineRoot(table, roots);
  if (root === null) return null;
  const base = `${root}/${code}/${table.folder ? `${table.folder}/` : ""}${line.file ?? line.key}`;
  for (const ext of LINE_EXTENSIONS) {
    const path = `${base}.${ext}`;
    if (exists(path)) return path;
  }
  return null;
}

/** The file `line` plays in a language whose fallback chain is `chain`, or null when no language of it has one. */
export function lineFile(table: LineTable, line: LineRow, chain: readonly string[], roots: readonly string[], exists: (path: string) => boolean): LineFile | null {
  for (const c of chain) {
    const path = lineFileIn(table, line, c, roots, exists);
    if (path !== null) return { path, language: c };
  }
  return null;
}

/** True when `line` has its own file in `code`. */
export const isRecorded = (table: LineTable, line: LineRow, code: string, roots: readonly string[], exists: (path: string) => boolean): boolean =>
  lineFileIn(table, line, code, roots, exists) !== null;

/** Where a key is defined. */
export interface LineLocation {
  path: string;
  table: LineTable;
  line: LineRow;
}

/**
 * Every line key of the project: the first definition by table path order (the runtime's rule), and the keys defined
 * more than once with every path that defines them (the Studio refuses these on edit; a hand edit can make them).
 */
export function lineKeyIndex(tables: readonly { path: string; table: LineTable }[]): { keys: Map<string, LineLocation>; duplicates: { key: string; paths: string[] }[] } {
  const keys = new Map<string, LineLocation>();
  const dupes = new Map<string, string[]>();
  for (const { path, table } of [...tables].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    for (const line of table.lines) {
      const first = keys.get(line.key);
      if (!first) keys.set(line.key, { path, table, line });
      else {
        const list = dupes.get(line.key) ?? [first.path];
        list.push(path);
        dupes.set(line.key, list);
      }
    }
  }
  return { keys, duplicates: [...dupes].map(([key, paths]) => ({ key, paths })) };
}
