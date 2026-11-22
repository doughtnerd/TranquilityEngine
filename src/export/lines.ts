// The built line index (ADR 0340 §6, amended by 0343 §1; L3): what the export writes as `audio/lines/index.json` from
// the project's line tables, so a build plays lines by key without shipping the tables (their notes never ship). The
// audio step (audio.ts) calls it once sounds are converted, so every file has its duration. Pure.
import { lineFile, lineKeyIndex } from "../engine/audio/localisation/lines/resolve";
import type { LineTable } from "../engine/audio/localisation/types";
import { LINE_INDEX_FORMAT, type LineIndex, type LineIndexEntry } from "../engine/audio/packaging/lineIndex";
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
 * The line index of `tables` for the build's languages: per key (the first table in path order wins, as the runtime's
 * rule), its table's fields and the line's, and per shipped language the file its chain resolves to with
 * `duration(path)` seconds (null when unknown).
 */
export function buildLineIndex(
  tables: readonly { path: string; table: LineTable }[],
  roots: readonly string[],
  languages: BuildLanguages,
  exists: (path: string) => boolean,
  duration: (path: string) => number | null,
): LineIndex {
  const lines: Record<string, LineIndexEntry> = {};
  const chains = languages.codes.map((c) => [c, fallbackChain(languages.settings, c)] as const);
  for (const [key, { path, table, line }] of lineKeyIndex(tables).keys) {
    const files: LineIndexEntry["files"] = {};
    for (const [code, chain] of chains) {
      const hit = lineFile(table, line, chain, roots, exists);
      files[code] = hit ? { path: hit.path, duration: duration(hit.path) } : null;
    }
    lines[key] = {
      table: path, speaker: line.speaker, priority: table.priority, output: table.output, template: table.template,
      ...(line.textKey !== undefined && line.textKey !== key ? { textKey: line.textKey } : {}),
      ...(line.tags.length ? { tags: [...line.tags] } : {}),
      ...(line.cooldown ? { cooldown: line.cooldown } : {}),
      ...(line.once ? { once: true as const } : {}),
      files,
    };
  }
  return { format: LINE_INDEX_FORMAT, languages: [...languages.codes], lines };
}
