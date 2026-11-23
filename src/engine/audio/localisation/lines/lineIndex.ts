/**
 * The line index (ADR 0354 §6, 0355 §1): where the runtime finds a project's line tables (`*.lines.json`) and dialogue
 * files (`*.dialogue.json`). Lines and events are played by key and name (no path), and asset sources can't be listed,
 * so the runtime reads this one file at a fixed path, `audio/lines/index.json` (`myco.lineindex@1`), then the files it
 * names through the asset sources:
 *
 * ```jsonc
 * { "format": "myco.lineindex@1", "tables": ["audio/vo/ch1.lines.json"], "dialogue": ["audio/barks.dialogue.json"] }
 * ```
 *
 * An export writes it (0354 L3) beside the files it names; the editor's Play and the Studio serve the same file from their
 * project tree (an asset source holding it). Parsed leniently (never throws; one problem line per bad value).
 *
 * Pure; no plugin, no DOM.
 */
import { isRecord, LenientReader, type JsonRecord } from "../../lenientRead";
import { DIALOGUE_SUFFIX } from "../../dialogue/types";
import { LINES_SUFFIX } from "../types";

export const LINE_INDEX_PATH = "audio/lines/index.json";
export const LINE_INDEX_FORMAT = "myco.lineindex@1";

/** Limits of the index, declared once (ADR 0306). */
export const LINE_INDEX_LIMITS = Object.freeze({ tables: 4096, dialogue: 4096 });

export interface LineIndex {
  /** Line table paths, sorted (the runtime's first-definition rule follows path order). */
  tables: string[];
  /** Dialogue file paths, sorted. */
  dialogue: string[];
}

export const emptyLineIndex = (): LineIndex => ({ tables: [], dialogue: [] });

function paths(raw: unknown, where: string, suffix: string, max: number, r: LenientReader): string[] {
  const out = new Set<string>();
  r.list(raw, where).forEach((p, i) => {
    if (typeof p !== "string" || !p.toLowerCase().endsWith(suffix)) return void r.problem(`${where}[${i}]`, `must be a ${suffix} path; dropped.`);
    if (out.size >= max) return void r.problem(`${where}[${i}]`, `at most ${max} files; dropped.`);
    out.add(p.replace(/^\/+/, ""));
  });
  return [...out].sort();
}

/** The index file, leniently (never throws). */
export function parseLineIndex(raw: unknown, where = LINE_INDEX_PATH): { index: LineIndex; problems: string[] } {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  if (!isRecord(raw)) {
    r.problem(where, "the line index must be an object; no lines or dialogue events.");
    return { index: emptyLineIndex(), problems };
  }
  if (raw.format !== LINE_INDEX_FORMAT) r.problem(`${where}.format`, `expected "${LINE_INDEX_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${LINE_INDEX_FORMAT}.`);
  return {
    index: {
      tables: paths(raw.tables, `${where}.tables`, LINES_SUFFIX, LINE_INDEX_LIMITS.tables, r),
      dialogue: paths(raw.dialogue, `${where}.dialogue`, DIALOGUE_SUFFIX, LINE_INDEX_LIMITS.dialogue, r),
    },
    problems,
  };
}

/** The index of a project's files (any order; non-matching paths are left out). */
export function lineIndexOf(projectPaths: Iterable<string>): LineIndex {
  const tables: string[] = [];
  const dialogue: string[] = [];
  for (const p of projectPaths) {
    const lower = p.toLowerCase();
    if (lower.endsWith(LINES_SUFFIX)) tables.push(p);
    else if (lower.endsWith(DIALOGUE_SUFFIX)) dialogue.push(p);
  }
  return { tables: tables.sort(), dialogue: dialogue.sort() };
}

/** The index as JSON. */
export const lineIndexToJson = (index: LineIndex): JsonRecord => ({ format: LINE_INDEX_FORMAT, tables: [...index.tables], dialogue: [...index.dialogue] });
