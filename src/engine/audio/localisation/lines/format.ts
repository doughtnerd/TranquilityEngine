/**
 * Line tables (ADR 0340 §5, amended by 0343 §1, extended by 0341 §4): parse and write `*.lines.json`
 * (`myco.lines@1`). The shapes are the contract in `../types.ts`.
 *
 * The parse is lenient (bad values fall back to defaults with one problem line; it never throws) and canonical: keys
 * are valid and unique in the table, `textKey` equal to the key is dropped, limits (declared once in `LINE_LIMITS`)
 * drop what is over them. 0340's retired `text` is kept as read with a problem line (0343: "Move subtitles to the string
 * table"). `lineTableToJson` writes the canonical form in a stable key order, leaving out defaults, so
 * `parseLineTable(lineTableToJson(x)).table` deep-equals `x`.
 *
 * Pure; no plugin, no DOM.
 */
import { canonicalLanguageCode, cleanFolder } from "../../../localisation/languages";
import { isStringKey, STRINGS_SUFFIX } from "../../../localisation/strings/format";
import { isRecord, LenientReader, type JsonRecord } from "../../lenientRead";
import { LINES_FORMAT, LINES_SUFFIX, type LineRow, type LineTable, type LineTableParse } from "../types";

/** Limits of a line table, declared once (ADR 0306, 0340 §5). */
export const LINE_LIMITS = Object.freeze({
  lines: 20_000,
  tags: 64,
  speakers: 256,
  /** Characters of a key. */
  keyLength: 64,
  /** Seconds of a line's cooldown. */
  cooldown: 3600,
  priority: [0, 100] as readonly [number, number],
});

const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** True for a valid line key (`[A-Za-z0-9_.-]{1,64}`; a line key is a valid string key, 0343). */
export const isLineKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key) && key !== "__proto__";

/** True for a line table path. */
export const isLineTablePath = (path: string): boolean => path.toLowerCase().endsWith(LINES_SUFFIX);

export const emptyLineTable = (): LineTable => ({ format: LINES_FORMAT, root: null, folder: "", output: null, template: null, priority: 50, speakers: [], strings: null, lines: [] });

/** A line with every optional field at its default. */
export const lineRow = (key: string, speaker: string | null = null): LineRow => ({ key, speaker, file: null, files: {}, tags: [], cooldown: 0, once: false });

/** The string key of a line's subtitle (0343 §1): its `textKey`, else its key; null when never subtitled. */
export const subtitleKeyOf = (line: LineRow): string | null => (line.textKey === undefined ? line.key : line.textKey);

/** The string table of the table at `path` (0343 §1): its `strings`, else `<stem>.strings.json` beside it. */
export function stringTablePathOf(path: string, table: LineTable): string {
  if (table.strings !== null) return table.strings;
  const stem = isLineTablePath(path) ? path.slice(0, path.length - LINES_SUFFIX.length) : path.replace(/\.json$/i, "");
  return `${stem}${STRINGS_SUFFIX}`;
}

function parseLine(raw: unknown, where: string, r: LenientReader): LineRow | null {
  if (!isRecord(raw)) return void r.problem(where, "a line must be an object with a key; dropped."), null;
  if (!isLineKey(raw.key)) return void r.problem(`${where}.key`, `${JSON.stringify(raw.key)} isn't a line key (letters, digits, _ . -, at most ${LINE_LIMITS.keyLength}); dropped.`), null;
  const out = lineRow(raw.key);
  const speaker = r.strOrNull(raw.speaker, `${where}.speaker`, null);
  out.speaker = speaker === null || speaker.trim() === "" ? null : speaker;
  if (raw.textKey === null) out.textKey = null;
  else if (raw.textKey !== undefined) {
    if (!isStringKey(raw.textKey)) r.problem(`${where}.textKey`, `${JSON.stringify(raw.textKey)} isn't a string key; using the line key.`);
    else if (raw.textKey !== raw.key) out.textKey = raw.textKey;
  }
  const notes = r.optStr(raw.notes, `${where}.notes`);
  if (notes) out.notes = notes;
  const file = r.strOrNull(raw.file, `${where}.file`, null);
  if (file !== null) {
    if (file.trim() === "" || /[\\/]/.test(file)) r.problem(`${where}.file`, `"${file}" isn't a file name stem; using the key.`);
    else if (file !== raw.key) out.file = file;
  }
  const files = r.record(raw.files, `${where}.files`);
  for (const [code, path] of Object.entries(files ?? {})) {
    const c = canonicalLanguageCode(code);
    if (c === null) { r.problem(`${where}.files.${code}`, "isn't a language code; dropped."); continue; }
    if (typeof path !== "string" || path.trim() === "") { r.problem(`${where}.files.${code}`, "must be a project path; dropped."); continue; }
    out.files[c] = path;
  }
  out.tags = [];
  r.list(raw.tags, `${where}.tags`).forEach((t, i) => {
    if (typeof t !== "string" || t === "") return void r.problem(`${where}.tags[${i}]`, "must be a non-empty string; dropped.");
    if (out.tags.length >= LINE_LIMITS.tags) return void r.problem(`${where}.tags[${i}]`, `at most ${LINE_LIMITS.tags} tags; dropped.`);
    if (!out.tags.includes(t)) out.tags.push(t);
  });
  out.cooldown = r.num(raw.cooldown, `${where}.cooldown`, 0, 0, LINE_LIMITS.cooldown);
  out.once = r.bool(raw.once, `${where}.once`, false);
  if (raw.text !== undefined) {
    const text = r.record(raw.text, `${where}.text`);
    const kept: Record<string, string> = {};
    for (const [code, v] of Object.entries(text ?? {})) {
      const c = canonicalLanguageCode(code);
      if (c !== null && typeof v === "string") kept[c] = v;
    }
    if (Object.keys(kept).length) {
      out.text = kept;
      r.problem(`${where}.text`, "subtitles live in the string table now (ADR 0343); kept until moved, and not shown.");
    }
  }
  return out;
}

/** A line table, leniently (never throws). */
export function parseLineTable(raw: unknown, path = "lines"): LineTableParse {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  const table = emptyLineTable();
  if (!isRecord(raw)) {
    r.problem(path, "a line table must be an object; using an empty table.");
    return { table, problems };
  }
  if (raw.format !== LINES_FORMAT) r.problem(`${path}.format`, `expected "${LINES_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${LINES_FORMAT}.`);
  const root = r.strOrNull(raw.root, `${path}.root`, null);
  if (root !== null) {
    const c = cleanFolder(root);
    if (c === null) r.problem(`${path}.root`, `"${root}" isn't a project folder; using the first localised root.`);
    else table.root = c;
  }
  const folder = r.str(raw.folder, `${path}.folder`, "");
  if (folder.trim() !== "") {
    const c = cleanFolder(folder);
    if (c === null) r.problem(`${path}.folder`, `"${folder}" isn't a folder; using the language folder itself.`);
    else table.folder = c;
  }
  const output = r.strOrNull(raw.output, `${path}.output`, null);
  table.output = output === null || output.trim() === "" ? null : output;
  const template = r.strOrNull(raw.template, `${path}.template`, null);
  table.template = template === null || template.trim() === "" ? null : template;
  table.priority = r.int(raw.priority, `${path}.priority`, 50, ...LINE_LIMITS.priority);
  r.list(raw.speakers, `${path}.speakers`).forEach((s, i) => {
    if (typeof s !== "string" || s.trim() === "") return void r.problem(`${path}.speakers[${i}]`, "must be a name; dropped.");
    if (table.speakers.length >= LINE_LIMITS.speakers) return void r.problem(`${path}.speakers[${i}]`, `at most ${LINE_LIMITS.speakers} speakers; dropped.`);
    if (!table.speakers.includes(s)) table.speakers.push(s);
  });
  const strings = r.strOrNull(raw.strings, `${path}.strings`, null);
  if (strings !== null) {
    if (!strings.toLowerCase().endsWith(STRINGS_SUFFIX)) r.problem(`${path}.strings`, `"${strings}" isn't a .strings.json path; using the table beside this one.`);
    else table.strings = strings;
  }
  const seen = new Set<string>();
  r.list(raw.lines, `${path}.lines`).forEach((l, i) => {
    const w = `${path}.lines[${i}]`;
    if (table.lines.length >= LINE_LIMITS.lines) return void r.problem(w, `at most ${LINE_LIMITS.lines} lines; dropped.`);
    const line = parseLine(l, w, r);
    if (!line) return;
    if (seen.has(line.key)) return void r.problem(`${w}.key`, `"${line.key}" is used twice; dropped.`);
    seen.add(line.key);
    table.lines.push(line);
  });
  return { table, problems };
}

function lineToJson(l: LineRow): JsonRecord {
  const out: JsonRecord = { key: l.key };
  if (l.speaker !== null) out.speaker = l.speaker;
  if (l.textKey !== undefined) out.textKey = l.textKey;
  if (l.notes !== undefined) out.notes = l.notes;
  if (l.file !== null) out.file = l.file;
  if (Object.keys(l.files).length) out.files = { ...l.files };
  if (l.tags.length) out.tags = [...l.tags];
  if (l.cooldown !== 0) out.cooldown = l.cooldown;
  if (l.once) out.once = true;
  if (l.text !== undefined) out.text = { ...l.text };
  return out;
}

/** A line table as JSON: `format` first, stable key order, defaults left out. */
export function lineTableToJson(t: LineTable): JsonRecord {
  const out: JsonRecord = { format: LINES_FORMAT };
  if (t.root !== null) out.root = t.root;
  if (t.folder !== "") out.folder = t.folder;
  if (t.output !== null) out.output = t.output;
  if (t.template !== null) out.template = t.template;
  if (t.priority !== 50) out.priority = t.priority;
  if (t.speakers.length) out.speakers = [...t.speakers];
  if (t.strings !== null) out.strings = t.strings;
  out.lines = t.lines.map(lineToJson);
  return out;
}

/** The table's file text: two-space JSON and a final newline. */
export const formatLineTable = (t: LineTable): string => `${JSON.stringify(lineTableToJson(t), null, 2)}\n`;
