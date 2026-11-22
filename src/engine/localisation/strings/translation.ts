/**
 * Translations of a string table (ADR 0342 §1): `<stem>.<code>.strings.json` (`myco.translation@1`) beside the table,
 * one file per language, each key with its text, status (`translated` or `needsReview`; no entry is missing) and
 * `source`, the text hash of the reference text it was translated from. When the reference text changes, the entry's
 * effective status becomes `needsReview` without a write (`effectiveStatus`). Parsed leniently (never throws) and
 * written back minimal.
 *
 * Pure; no plugin, no DOM.
 */
import { canonicalLanguageCode } from "../languages";
import { isRecord, Reader, type JsonRecord } from "../lenient";
import { textHash } from "../textHash";
import { isStringKey, messageText, STRINGS_LIMITS, stringsPathKind } from "./format";

export const TRANSLATION_FORMAT = "myco.translation@1";

export const TRANSLATION_STATUSES = ["translated", "needsReview"] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
/** A key's status in a language, as reports show it. */
export type EffectiveStatus = TranslationStatus | "missing";

export interface TranslationEntry {
  text: string;
  status: TranslationStatus;
  /** `textHash` of the reference text when translated; null when unknown (imported without it). */
  source: string | null;
}

export interface TranslationFile {
  format: typeof TRANSLATION_FORMAT;
  language: string;
  /** Key → entry, in file order. */
  strings: Record<string, TranslationEntry>;
}

export interface TranslationParse {
  translation: TranslationFile;
  problems: string[];
}

const SOURCE = /^[0-9a-f]{16}$/;

export const emptyTranslation = (language: string): TranslationFile => ({ format: TRANSLATION_FORMAT, language, strings: {} });

/**
 * A translation file, leniently. With `path` (`menu.fr.strings.json`), a `language` that differs from the file name's
 * code is reported and the file name's code is used. Repairs, each with a problem line: bad keys, entries and statuses
 * dropped or defaulted, a malformed `source` dropped, limits applied.
 */
export function parseTranslation(raw: unknown, path?: string): TranslationParse {
  const where = path ?? "translation";
  const problems: string[] = [];
  const r = new Reader(problems);
  const named = path ? stringsPathKind(path) : null;
  const fileCode = named?.kind === "translation" ? canonicalLanguageCode(named.code) : null;
  const translation = emptyTranslation(fileCode ?? "en");
  if (!isRecord(raw)) {
    r.problem(where, "a translation must be an object; using an empty one.");
    return { translation, problems };
  }
  if (raw.format !== TRANSLATION_FORMAT) r.problem(`${where}.format`, `expected "${TRANSLATION_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${TRANSLATION_FORMAT}.`);
  const code = typeof raw.language === "string" ? canonicalLanguageCode(raw.language) : null;
  if (code === null) r.problem(`${where}.language`, `${JSON.stringify(raw.language)} isn't a language tag; using "${translation.language}".`);
  else if (fileCode !== null && code !== fileCode) r.problem(`${where}.language`, `"${code}" differs from the file name's "${fileCode}"; using "${fileCode}".`);
  else translation.language = code;
  const strings = r.record(raw.strings, `${where}.strings`) ?? {};
  let count = 0;
  for (const [key, e] of Object.entries(strings)) {
    const w = `${where}.strings.${key}`;
    if (!isStringKey(key)) { r.problem(w, "isn't a key; dropped."); continue; }
    if (count >= STRINGS_LIMITS.keys) { r.problem(w, `at most ${STRINGS_LIMITS.keys} keys; dropped.`); continue; }
    const o = typeof e === "string" ? { text: e } : e;
    if (!isRecord(o)) { r.problem(w, "must be an object with text; dropped."); continue; }
    const text = messageText(o.text, `${w}.text`, r);
    if (text === null) continue;
    const entry: TranslationEntry = { text, status: r.pick(o.status, `${w}.status`, TRANSLATION_STATUSES, "translated"), source: null };
    if (o.source !== undefined && o.source !== null) {
      if (typeof o.source === "string" && SOURCE.test(o.source)) entry.source = o.source;
      else r.problem(`${w}.source`, "must be 16 lower-case hex digits; dropped.");
    }
    translation.strings[key] = entry;
    count++;
  }
  return { translation, problems };
}

/** A translation file as JSON: stable key order, defaults (`status: "translated"`, no source) left out. */
export function translationToJson(t: TranslationFile): JsonRecord {
  return {
    format: TRANSLATION_FORMAT,
    language: t.language,
    strings: Object.fromEntries(Object.entries(t.strings).map(([k, e]) => {
      const out: JsonRecord = { text: e.text };
      if (e.status !== "translated") out.status = e.status;
      if (e.source !== null) out.source = e.source;
      return [k, out];
    })),
  };
}

/** The file's text: two-space JSON and a final newline. */
export const formatTranslation = (t: TranslationFile): string => `${JSON.stringify(translationToJson(t), null, 2)}\n`;

/**
 * A key's status in a language whose entry is `entry`, against the table's current reference text: missing without
 * an entry; `needsReview` when marked so or when its `source` isn't the current reference text's hash; else translated.
 */
export function effectiveStatus(entry: TranslationEntry | undefined, referenceText: string): EffectiveStatus {
  if (!entry) return "missing";
  if (entry.status === "needsReview") return "needsReview";
  return entry.source !== null && entry.source !== textHash(referenceText) ? "needsReview" : "translated";
}

/** An entry for `text` translated now from `referenceText` (status translated, source its hash). */
export const translatedEntry = (text: string, referenceText: string): TranslationEntry => ({ text, status: "translated", source: textHash(referenceText) });
