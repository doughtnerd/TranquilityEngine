// The Localisation panel's view of the project (ADR 0342 §9): its string tables with their translations, as the
// exchange modules read them (`ExchangeProject`), and who owns each table (0327, 0342 §9, 0343 §1): the editor owns
// string tables, except those audio data names — each line table's string table and `audio.json`'s captions table —
// which the Studio owns. Each app writes the other's tables only while that app holds no lock on the project; until
// then they show read-only with "Edit in the Studio".
//
// Pure: the panel hands it the project's files (path → parsed JSON or a strings file value) and the Studio's lock.
import { stringTablePathOf, parseLineTable, isLineTablePath } from "../../../engine/audio/localisation/lines/format";
import { DEFAULT_CAPTIONS_TABLE, parseAudioLocalisation } from "../../../engine/audio/localisation/format";
import type { LanguageSettings } from "../../../engine/localisation/languages";
import { languageOf } from "../../../engine/localisation/languages";
import { isRecord } from "../../../engine/localisation/lenient";
import { emptyStringTable, parseStringTable, stringsPathKind, type StringTable } from "../../../engine/localisation/strings/format";
import { parseTranslation, type TranslationFile } from "../../../engine/localisation/strings/translation";
import type { ExchangeProject, ExchangeTable } from "../../../engine/localisation/exchange/model";
import type { StringsFile } from "./stringsKind";

const isStringsFile = (v: unknown): v is StringsFile => isRecord(v) && (v.kind === "table" || v.kind === "translation") && ("table" in v || "translation" in v);

/**
 * The project's tables and translations, by path order, from its files (a strings file's value as its asset document
 * holds it, or the file's parsed JSON). A translation is listed under its table by its language (as the project lists
 * it, else as the file names it); one whose table doesn't exist is left out.
 */
export function exchangeProjectOf(languages: LanguageSettings, files: Iterable<readonly [string, unknown]>): ExchangeProject {
  const tables = new Map<string, { table: StringTable; translations: Record<string, TranslationFile> }>();
  const translations: [string, TranslationFile][] = [];
  for (const [path, value] of files) {
    const kind = stringsPathKind(path);
    if (!kind) continue;
    if (kind.kind === "table") {
      const table = isStringsFile(value) ? (value.kind === "table" ? value.table : emptyStringTable()) : parseStringTable(value, path).table;
      tables.set(path, { table, translations: {} });
    } else {
      const tr = isStringsFile(value) ? (value.kind === "translation" ? value.translation : null) : parseTranslation(value, path).translation;
      if (tr) translations.push([kind.table, tr]);
    }
  }
  for (const [table, tr] of translations) {
    const t = tables.get(table);
    if (!t) continue;
    const code = languageOf(languages, tr.language)?.code ?? tr.language;
    t.translations[code] = tr;
  }
  const list: ExchangeTable[] = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, t]) => ({ path, table: t.table, translations: t.translations }));
  return { languages, tables: list };
}

/** The string tables audio data names (0343 §1, §4): each line table's string table and the captions table. */
export function studioOwnedTables(files: Iterable<readonly [string, unknown]>): Set<string> {
  const out = new Set<string>();
  let captions = DEFAULT_CAPTIONS_TABLE;
  for (const [path, value] of files) {
    if (isLineTablePath(path)) out.add(stringTablePathOf(path, parseLineTable(value, path).table));
    else if (path === "audio.json" && isRecord(value)) captions = parseAudioLocalisation(value.localisation, []).captions;
  }
  out.add(captions);
  return out;
}

/** Whether another app holds the project: held, not held, or not known yet (still being read). */
export type LockState = "held" | "none" | "unknown";

/** Whether the editor may write a table now, and why not. */
export type TableAccess = { readonly editable: true } | { readonly editable: false; readonly reason: string; readonly editInStudio: boolean };

/**
 * The ownership rule (0342 §9): the editor writes its own tables whenever the project can be saved, and the Studio's
 * (`studioOwned`) only while the Studio holds no lock; translations follow their table.
 */
export function tableAccess(f: { readonly canSave: boolean; readonly studioOwned: boolean; readonly studioLock: LockState }): TableAccess {
  if (!f.canSave) return { editable: false, reason: "The project is read-only.", editInStudio: false };
  if (!f.studioOwned) return { editable: true };
  if (f.studioLock === "held") return { editable: false, reason: "The Audio Studio has this project open, and this table holds subtitles or captions, which are the Studio's: edit them there.", editInStudio: true };
  if (f.studioLock === "unknown") return { editable: false, reason: "Checking whether the Audio Studio has this project open…", editInStudio: false };
  return { editable: true };
}
