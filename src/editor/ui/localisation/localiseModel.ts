// The Inspector's Localise control (ADR 0356 §9): bind a UI document element's text field to a string key — pick one
// (search keys and their text, with each one's text in the preview language), or **Extract to string table**: a key
// suggested from the document and the element's id, added to a chosen table with the element's literal text as its
// reference text, while the element's text becomes `t:<field>="key"` (one undo step; `uiDocumentEdits.ts` writes both
// files). Each choice is refused or next (0313).
//
// Pure.
import { fallbackChain, type LanguageSettings } from "../../../engine/localisation/languages";
import { isPseudoLanguage } from "../../../engine/localisation/pseudo";
import { emptyStringTable, isStringKey, parseStringTable, STRINGS_LIMITS, stringsPathKind, type StringTable } from "../../../engine/localisation/strings/format";
import { translationOf, type ExchangeProject } from "../../../engine/localisation/exchange/model";
import { accept, refuse, type EditResult } from "../../sdk/editResult";
import { tableOfKey } from "./stringsModel";

/** One key the picker offers. */
export interface KeyMatch {
  readonly key: string;
  readonly table: string;
  /** Its text in the preview language (through the chain), else the reference text. */
  readonly preview: string;
}

/** The text `key` shows in `code` (a pseudo-language or an unknown code: the reference text), or null when it is no key. */
export function keyPreview(project: ExchangeProject, key: string, code: string): string | null {
  const s = project.languages;
  for (const t of project.tables) {
    const e = t.table.strings.find((x) => x.key === key);
    if (!e) continue;
    if (!isPseudoLanguage(code)) {
      for (const c of fallbackChain(s, code)) {
        if (c === s.reference) return e.text;
        const tr = translationOf(t, c)?.strings[key];
        if (tr) return tr.text;
      }
    }
    return e.text;
  }
  return null;
}

/** Keys whose name or text contains `search` (case-insensitive), at most `limit`, exact key matches first. */
export function keyMatches(project: ExchangeProject, search: string, code: string, limit = 50): KeyMatch[] {
  const needle = search.trim().toLowerCase();
  const out: KeyMatch[] = [];
  for (const t of project.tables) {
    for (const e of t.table.strings) {
      const preview = keyPreview(project, e.key, code) ?? e.text;
      if (needle && !e.key.toLowerCase().includes(needle) && !e.text.toLowerCase().includes(needle) && !preview.toLowerCase().includes(needle)) continue;
      out.push({ key: e.key, table: t.path, preview });
    }
  }
  out.sort((a, b) => Number(b.key.toLowerCase() === needle) - Number(a.key.toLowerCase() === needle));
  return out.slice(0, limit);
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * A free key for an element's text: the document's name and the element's id (`ui/menu.ui.xml`, `#title` →
 * `menu.title`), else its tag and field (`menu.text_label`); `_2`, `_3`… when taken.
 */
export function suggestKey(project: ExchangeProject, documentPath: string, elementId: string | null, tag: string, field: string): string {
  const name = documentPath.slice(documentPath.lastIndexOf("/") + 1).replace(/\.ui\.xml$/i, "");
  const base = `${slug(name) || "ui"}.${elementId ? slug(elementId) || field : `${field}_${tag.toLowerCase()}`}${elementId && field !== "text" ? `_${field}` : ""}`.slice(0, STRINGS_LIMITS.keyLength - 4);
  if (!tableOfKey(project, base)) return base;
  for (let n = 2; ; n++) if (!tableOfKey(project, `${base}_${n}`)) return `${base}_${n}`;
}

/** The table a new key goes in by default: the document's own (`ui/menu.ui.xml` → a table named `menu`), else the first. */
export function suggestTable(project: ExchangeProject, documentPath: string): string {
  const name = slug(documentPath.slice(documentPath.lastIndexOf("/") + 1).replace(/\.ui\.xml$/i, ""));
  return project.tables.find((t) => t.path.endsWith(`/${name}.strings.json`))?.path ?? project.tables[0]?.path ?? `strings/${name || "ui"}.strings.json`;
}

/**
 * The table after extracting `text` under `key`: `tableJson` is the table file's parsed JSON (undefined when it doesn't
 * exist yet: a new table in the reference language). Refused for an invalid or taken key, empty text, or a path that
 * isn't a table.
 */
export function extractToTable(project: ExchangeProject, tablePath: string, tableJson: unknown, rawKey: string, text: string): EditResult<StringTable> {
  if (stringsPathKind(tablePath)?.kind !== "table") return refuse(`${tablePath} isn't a string table path (name.strings.json, no dots in the name)`);
  const key = rawKey.trim();
  if (!isStringKey(key)) return refuse(`"${key}" isn't a key (letters, digits, _ . -)`);
  const owner = tableOfKey(project, key);
  if (owner) return refuse(`"${key}" is a key of ${owner} already`);
  if (text.trim() === "") return refuse("the element has no text to extract");
  const s: LanguageSettings = project.languages;
  const table = tableJson === undefined ? emptyStringTable(s.reference) : parseStringTable(tableJson, tablePath).table;
  if (table.strings.length >= STRINGS_LIMITS.keys) return refuse(`a table has at most ${STRINGS_LIMITS.keys} keys`);
  return accept({ ...table, strings: [...table.strings, { key, text, tags: [], examples: {} }] });
}
