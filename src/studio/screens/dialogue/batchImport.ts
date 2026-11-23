// Batch import of a voice-over delivery (ADR 0340 §9 "Batch import", §8, 0343 §1): picked files are matched to line
// keys and languages by a naming pattern with the tokens `{lang}`, `{key}`, `{table}` and `{ignore}` (presets
// `{lang}/{key}`, `{key}_{lang}`, `{lang}_{key}`: Wwise and FMOD deliveries use the first two), matched against each
// file's path relative to what was picked, without its extension (leading folders allowed). The preview sorts every
// file into matched, replace-existing, unknown key (create rows or skip), unknown language (skip), conflicts and
// unmatched; the plan copies each to `<root>/<lang>/<folder>/<file ?? key>.<ext>` and gives each sidecar its `vo`
// (key and the reference text's hash) and `normalize` from `localisation.loudness`. Pure; the dialog reads the files,
// copies them and writes the sidecars.
//
// Lip-sync (ADR 0340 §7): a Rhubarb Lip Sync output file (`.txt`/`.tsv` or `.json`) picked beside a line's audio with
// the same name (`fr/intro_01.wav` + `fr/intro_01.txt`) rides along with it: it gets no row of its own, and applying
// writes its keys into the copied file's sidecar `lipsync` block in the same step.
import { isLipsyncFile } from "../../../engine/audio/localisation/lipsync";
import { lineRow, LINE_LIMITS } from "../../../engine/audio/localisation/lines/format";
import type { LineTable } from "../../../engine/audio/localisation/types";
import type { SampleEdits, SampleLipsync, SampleVo } from "../../../engine/audio/sample/types";
import { languageOf } from "../../../engine/localisation/languages";
import { textHash } from "../../../engine/localisation/textHash";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { normalizeGain, type Measured } from "../samples/sampleEditing";
import { fileIn, findLine, recordingPath, referenceText, type DialogueData, type LineRef, type TableDoc } from "./dialogueData";
import { tableStem } from "./scriptCsv";

export const PATTERN_PRESETS = ["{lang}/{key}", "{key}_{lang}", "{lang}_{key}"] as const;

const TOKENS: Readonly<Record<string, string>> = {
  lang: "(?<lang>[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)",
  key: "(?<key>[A-Za-z0-9_.-]{1,64})",
  table: "(?<table>[A-Za-z0-9_.-]+)",
  ignore: "(?:.*?)",
};

/** A compiled naming pattern, or why it can't be one. */
export function compilePattern(pattern: string): { re: RegExp } | { refused: string } {
  const p = pattern.trim().replace(/^\/+|\/+$/g, "");
  if (!/\{key\}/.test(p)) return { refused: "a pattern needs {key}" };
  if ((p.match(/\{key\}/g) ?? []).length > 1 || (p.match(/\{lang\}/g) ?? []).length > 1 || (p.match(/\{table\}/g) ?? []).length > 1) return { refused: "each of {key}, {lang} and {table} at most once" };
  let source = "";
  let at = 0;
  for (const m of p.matchAll(/\{(\w+)\}/g)) {
    const token = TOKENS[m[1]];
    if (token === undefined) return { refused: `{${m[1]}} isn't a token: use {lang}, {key}, {table} or {ignore}` };
    source += escape(p.slice(at, m.index)) + token;
    at = m.index! + m[0].length;
  }
  source += escape(p.slice(at));
  return { re: new RegExp(`^(?:.*/)?${source}$`) };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A picked file's path without its audio extension, and the extension. */
export function splitExtension(rel: string): { stem: string; ext: string } | null {
  const m = /^(.*)\.(wav|flac|ogg|mp3|m4a)$/i.exec(rel.replace(/\\/g, "/"));
  return m ? { stem: m[1], ext: m[2].toLowerCase() } : null;
}

/** What a pattern reads from one file name. */
export interface PatternMatch {
  readonly key: string;
  readonly lang: string | null;
  readonly table: string | null;
}

/** The tokens a file's relative path gives under `pattern`, or null when it doesn't match. */
export function matchFile(pattern: RegExp, rel: string): PatternMatch | null {
  const s = splitExtension(rel);
  if (!s) return null;
  const m = pattern.exec(s.stem);
  if (!m?.groups) return null;
  return { key: m.groups.key, lang: m.groups.lang ?? null, table: m.groups.table ?? null };
}

export type BatchStatus = "matched" | "replace" | "unknownKey" | "unknownLanguage" | "conflict" | "duplicate" | "unmatched";

export interface BatchRow {
  readonly rel: string;
  readonly status: BatchStatus;
  readonly key: string | null;
  /** The listed language (canonical case). */
  readonly lang: string | null;
  readonly table: string | null;
  /** Where the file goes (null when skipped). */
  readonly dest: string | null;
  readonly note: string;
  /** The Rhubarb output picked beside it (its relative path), imported into its sidecar's `lipsync`. */
  readonly lipsync?: string;
}

/** A picked file's path without its extension. */
const stemOf = (rel: string): string => rel.replace(/\\/g, "/").replace(/\.[^./]*$/, "");

/** The picked lip-sync files that sit beside a picked audio file of the same name, by that audio file's stem. */
export function lipsyncCompanions(files: readonly string[]): Map<string, string> {
  const audio = new Set(files.filter((f) => splitExtension(f)).map(stemOf));
  const out = new Map<string, string>();
  for (const f of files) if (isLipsyncFile(f) && audio.has(stemOf(f)) && !out.has(stemOf(f))) out.set(stemOf(f), f);
  return out;
}

export interface BatchOptions {
  /** The language of files whose pattern has no `{lang}`. */
  readonly language: string;
  /** The table unknown keys become rows of (null: they are skipped). */
  readonly createIn: string | null;
}

/** The preview: every picked file sorted by what applying would do. */
export function previewBatch(data: DialogueData, files: readonly string[], pattern: string, options: BatchOptions): { rows: BatchRow[] } | { refused: string } {
  const compiled = compilePattern(pattern);
  if ("refused" in compiled) return compiled;
  const taken = new Map<string, string>();
  const companions = lipsyncCompanions(files);
  const riders = new Set(companions.values());
  const rows = files.filter((f) => !riders.has(f)).map((rel): BatchRow => {
    const skip = (status: BatchStatus, note: string, m?: Partial<PatternMatch> & { lang?: string | null }): BatchRow => ({ rel, status, key: m?.key ?? null, lang: m?.lang ?? null, table: m?.table ?? null, dest: null, note });
    const m = matchFile(compiled.re, rel);
    if (!m) return skip("unmatched", splitExtension(rel) ? `doesn't match ${pattern}` : "not an audio file");
    const def = languageOf(data.languages, m.lang ?? options.language);
    if (!def) return skip("unknownLanguage", `"${m.lang}" isn't a project language`, m);
    const lang = def.code;
    const ext = splitExtension(rel)!.ext;
    let ref: LineRef | null = findLine(data, m.key);
    if (ref && m.table !== null && tableStem(ref.doc.path) !== m.table) ref = null;
    let status: BatchStatus = "matched";
    let note = "";
    if (!ref) {
      const doc: TableDoc | undefined = options.createIn === null ? undefined : data.tables.find((t) => t.path === options.createIn);
      if (!doc) return skip("unknownKey", m.table ? `no line "${m.key}" in table ${m.table}` : `no line "${m.key}"`, { ...m, lang });
      ref = { doc, line: lineRow(m.key) };
      status = "unknownKey";
      note = `new row in ${tableStem(doc.path)}`;
    }
    const existing = status === "unknownKey" ? null : fileIn(data, ref, lang);
    let dest = recordingPath(data, ref, lang, ext);
    if (dest === null) return skip("conflict", "the project has no localised root (Languages tab)", { ...m, lang });
    if (existing !== null) {
      if (!existing.toLowerCase().endsWith(`.${ext}`)) return skip("conflict", `${lang} already has ${existing} in another format`, { ...m, lang });
      dest = existing;
      status = "replace";
      note = "the old audio is kept as a source version";
    }
    const id = `${ref.line.key}\n${lang}`;
    const first = taken.get(id);
    if (first !== undefined) return skip("duplicate", `${first} already gives ${ref.line.key} in ${lang}`, { ...m, lang });
    taken.set(id, rel);
    const lipsync = companions.get(stemOf(rel));
    return { rel, status, key: ref.line.key, lang, table: ref.doc.path, dest, note, ...(lipsync ? { lipsync } : {}) };
  });
  return { rows };
}

/** The rows applying copies. */
export const copiedRows = (rows: readonly BatchRow[]): BatchRow[] => rows.filter((r) => r.dest !== null);

/** The preview's counts by status. */
export function batchCounts(rows: readonly BatchRow[]): Record<BatchStatus, number> {
  const out: Record<BatchStatus, number> = { matched: 0, replace: 0, unknownKey: 0, unknownLanguage: 0, conflict: 0, duplicate: 0, unmatched: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}

/** The new rows a table gets for unknown keys (one undo step of the table). */
export function rowsToCreate(table: LineTable, rows: readonly BatchRow[], path: string): EditResult<LineTable> {
  const keys = [...new Set(rows.filter((r) => r.status === "unknownKey" && r.table === path && r.key !== null).map((r) => r.key!))].filter((k) => !table.lines.some((l) => l.key === k));
  if (keys.length === 0) return { next: table };
  if (table.lines.length + keys.length > LINE_LIMITS.lines) return { refused: `a table holds at most ${LINE_LIMITS.lines} lines` };
  return { next: { ...table, lines: [...table.lines, ...keys.map((k) => lineRow(k))] } };
}

/** The `vo` block a copied file's sidecar gets: its key and the hash of the reference text now (null without text). */
export function voBlock(data: DialogueData, key: string): SampleVo | null {
  const ref = findLine(data, key);
  const text = ref ? referenceText(data, ref) : null;
  return text === null ? null : { key, textHash: textHash(text) };
}

/**
 * A sidecar's `sample` block after import: `vo` set (or removed without text) and `normalize` from
 * `localisation.loudness`, its gain from `measured` (0 until measured); `lipsync` set when a Rhubarb file came with it.
 */
export function importedBlock(e: SampleEdits, vo: SampleVo | null, loudness: DialogueData["localisation"]["loudness"], measured: Measured | null, lipsync: SampleLipsync | null = null): SampleEdits {
  const { vo: _old, ...rest } = e;
  const normalize = { mode: loudness.mode, target: loudness.target, gainDb: normalizeGain(loudness.mode, loudness.target, measured) };
  return { ...rest, normalize, ...(vo ? { vo } : {}), ...(lipsync ? { lipsync } : {}) };
}
