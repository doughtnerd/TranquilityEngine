/**
 * String tables (ADR 0342 §1): `*.strings.json` (`myco.strings@1`), a table of keys with the reference language's text,
 * notes for translators, length limits, tags and example arguments. Translations sit beside it, one file per language
 * (`<stem>.<code>.strings.json`, `translation.ts`). Parsed leniently (never throws; one problem line per bad value) and
 * written back minimal, so `parseStringTable(stringTableToJson(x)).table` equals `x`.
 *
 * Message syntax isn't checked here (the editor and the export run `message/check.ts`); only the limits are.
 *
 * Pure; no plugin, no DOM.
 */
import { canonicalLanguageCode } from "../languages";
import { isFiniteNumber, isRecord, Reader, type JsonRecord } from "../lenient";
import { MESSAGE_LIMITS } from "../message/parse";

export const STRINGS_FORMAT = "myco.strings@1";
export const STRINGS_SUFFIX = ".strings.json";

/** Limits of a string table and its translations, declared once (ADR 0306, 0342 §1). */
export const STRINGS_LIMITS = Object.freeze({
  /** Keys of one table (and entries of one translation file). */
  keys: 20_000,
  /** Characters of one message (the message parser's limit). */
  message: MESSAGE_LIMITS.length,
  /** Tags of one key. */
  tags: 64,
  /** Example arguments of one key. */
  examples: 32,
  /** Characters of one key. */
  keyLength: 128,
  /** Characters of a table's stem. */
  stemLength: 64,
});

const KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const STEM = /^[A-Za-z0-9_-]{1,64}$/;

/** True for a valid string key (`[A-Za-z0-9_.-]{1,128}`; line keys are valid string keys, 0343). */
export const isStringKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key) && key !== "__proto__";

/** One key of a table. */
export interface StringEntry {
  key: string;
  /** The message in the table's reference language (ICU MessageFormat 1). */
  text: string;
  /** For translators; never shipped. */
  notes?: string;
  /** Graphemes the text may take in any language (§8); absent: no limit. */
  maxLength?: number;
  tags: string[];
  /** Sample arguments for previews and fit checks. */
  examples: Record<string, string | number>;
}

/** The table file. */
export interface StringTable {
  format: typeof STRINGS_FORMAT;
  /** The reference language its text is written in (checked against `project.json` by the caller). */
  language: string;
  strings: StringEntry[];
}

export interface StringTableParse {
  table: StringTable;
  problems: string[];
}

// --- paths -----------------------------------------------------------------------------------------------------------

/** What a `*.strings.json` path is: a table (`menu.strings.json`) or a translation (`menu.fr.strings.json`). */
export type StringsPathKind =
  | { kind: "table"; stem: string }
  | { kind: "translation"; stem: string; code: string; table: string };

/** The kind of a strings path, or null when it isn't one (a stem with dots, a malformed code). */
export function stringsPathKind(path: string): StringsPathKind | null {
  if (!path.toLowerCase().endsWith(STRINGS_SUFFIX)) return null;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1, path.length - STRINGS_SUFFIX.length);
  const dot = name.indexOf(".");
  if (dot < 0) return STEM.test(name) ? { kind: "table", stem: name } : null;
  const stem = name.slice(0, dot);
  const code = name.slice(dot + 1);
  if (!STEM.test(stem) || canonicalLanguageCode(code) === null) return null;
  return { kind: "translation", stem, code, table: `${dir}${stem}${STRINGS_SUFFIX}` };
}

/** The path of `tablePath`'s translation into `code`. */
export function translationPath(tablePath: string, code: string): string {
  const base = tablePath.slice(0, tablePath.length - STRINGS_SUFFIX.length);
  return `${base}.${code}${STRINGS_SUFFIX}`;
}

// --- parse -----------------------------------------------------------------------------------------------------------

export const emptyStringTable = (language = "en"): StringTable => ({ format: STRINGS_FORMAT, language, strings: [] });

/** A message's text cut to the limit (with a problem). */
export function messageText(raw: unknown, where: string, r: Reader): string | null {
  if (typeof raw !== "string") return void r.problem(where, "must be a string; dropped."), null;
  if (raw.length > STRINGS_LIMITS.message) {
    r.problem(where, `at most ${STRINGS_LIMITS.message} characters; cut.`);
    return raw.slice(0, STRINGS_LIMITS.message);
  }
  return raw;
}

function parseEntry(raw: unknown, where: string, r: Reader): StringEntry | null {
  if (!isRecord(raw)) return void r.problem(where, "a string must be an object with a key and text; dropped."), null;
  if (!isStringKey(raw.key)) return void r.problem(`${where}.key`, `${JSON.stringify(raw.key)} isn't a key (letters, digits, _ . -, at most ${STRINGS_LIMITS.keyLength}); dropped.`), null;
  const text = raw.text === undefined ? "" : messageText(raw.text, `${where}.text`, r);
  if (text === null) return null;
  const out: StringEntry = { key: raw.key, text, tags: [], examples: {} };
  const notes = r.optStr(raw.notes, `${where}.notes`);
  if (notes) out.notes = notes;
  if (raw.maxLength !== undefined && raw.maxLength !== null) {
    if (Number.isInteger(raw.maxLength) && (raw.maxLength as number) >= 1) out.maxLength = raw.maxLength as number;
    else r.problem(`${where}.maxLength`, "must be a whole number of characters ≥ 1; dropped.");
  }
  out.tags = [...new Set(r.strings(raw.tags, `${where}.tags`, STRINGS_LIMITS.tags))];
  const ex = r.record(raw.examples, `${where}.examples`);
  if (ex) {
    for (const [name, v] of Object.entries(ex)) {
      if (Object.keys(out.examples).length >= STRINGS_LIMITS.examples) { r.problem(`${where}.examples`, `at most ${STRINGS_LIMITS.examples} examples; the rest are dropped.`); break; }
      if (!/^[\p{L}\p{N}\p{M}_]+$/u.test(name) || name === "__proto__") r.problem(`${where}.examples.${name}`, "isn't an argument name; dropped.");
      else if (typeof v === "string" || isFiniteNumber(v)) out.examples[name] = v;
      else r.problem(`${where}.examples.${name}`, "must be a string or a number; dropped.");
    }
  }
  return out;
}

/** A string table, leniently. Repairs, each with a problem line: bad keys and repeated keys dropped, limits applied. */
export function parseStringTable(raw: unknown, path = "strings"): StringTableParse {
  const problems: string[] = [];
  const r = new Reader(problems);
  const table = emptyStringTable();
  if (!isRecord(raw)) {
    r.problem(path, "a string table must be an object; using an empty table.");
    return { table, problems };
  }
  if (raw.format !== STRINGS_FORMAT) r.problem(`${path}.format`, `expected "${STRINGS_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${STRINGS_FORMAT}.`);
  if (raw.language === undefined) r.problem(`${path}.language`, 'missing; using "en".');
  else {
    const code = typeof raw.language === "string" ? canonicalLanguageCode(raw.language) : null;
    if (code === null) r.problem(`${path}.language`, `${JSON.stringify(raw.language)} isn't a language tag; using "en".`);
    else table.language = code;
  }
  const seen = new Set<string>();
  r.list(raw.strings, `${path}.strings`).forEach((e, i) => {
    const w = `${path}.strings[${i}]`;
    if (table.strings.length >= STRINGS_LIMITS.keys) return void r.problem(w, `at most ${STRINGS_LIMITS.keys} keys; dropped.`);
    const entry = parseEntry(e, w, r);
    if (!entry) return;
    if (seen.has(entry.key)) return void r.problem(`${w}.key`, `"${entry.key}" is used twice; dropped.`);
    seen.add(entry.key);
    table.strings.push(entry);
  });
  return { table, problems };
}

// --- write -----------------------------------------------------------------------------------------------------------

function entryToJson(e: StringEntry): JsonRecord {
  const out: JsonRecord = { key: e.key, text: e.text };
  if (e.notes !== undefined) out.notes = e.notes;
  if (e.maxLength !== undefined) out.maxLength = e.maxLength;
  if (e.tags.length) out.tags = [...e.tags];
  if (Object.keys(e.examples).length) out.examples = { ...e.examples };
  return out;
}

/** A table as JSON: stable key order, defaults left out. */
export const stringTableToJson = (t: StringTable): JsonRecord => ({ format: STRINGS_FORMAT, language: t.language, strings: t.strings.map(entryToJson) });

/** The table's file text: two-space JSON and a final newline. */
export const formatStringTable = (t: StringTable): string => `${JSON.stringify(stringTableToJson(t), null, 2)}\n`;
