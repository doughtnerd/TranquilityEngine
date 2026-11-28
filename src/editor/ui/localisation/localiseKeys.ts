// The Inspector's Localise control's keys (ADR 0356 §9, ADR 0423 wave F): bind a Svelte element's literal text (its
// text content or a text attribute) to a string key — pick one (search keys and their text, with each one's text in the
// preview language), or **Extract to string table**: a key suggested from the component's file name and the element's
// id, added to a chosen table with the literal text as its reference text, while the source says `{t("key")}` instead
// (one undo step; `uiViewEdits.ts` writes both files). Each choice is refused or next (0313). Restored from what
// UI documents had (`localiseModel.ts`, retired with them by ADR 0423 wave D).
//
// Pure.
import { fallbackChain, type LanguageSettings } from "../../../engine/localisation/languages";
import { messageArguments } from "../../../engine/localisation/message/check";
import { parseMessage } from "../../../engine/localisation/message/parse";
import { isPseudoLanguage } from "../../../engine/localisation/pseudo";
import { emptyStringTable, isStringKey, parseStringTable, STRINGS_LIMITS, stringsPathKind, type StringTable } from "../../../engine/localisation/strings/format";
import { translationOf, type ExchangeProject } from "../../../engine/localisation/exchange/model";
import { accept, refuse, type EditResult } from "../../sdk/editResult";
import { tableOfKey } from "./stringsModel";
import { UNDERSCORED, uniqueName } from "../../../engine/core/uniqueName";

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

/** A component file's name as a key prefix: `ui/PauseMenu.svelte` → `pauseMenu`. */
function sourceName(sourcePath: string): string {
  const name = slug(sourcePath.slice(sourcePath.lastIndexOf("/") + 1).replace(/\.svelte$/i, ""));
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * A free key for an element's text: the component's name and the element's id (`ui/Menu.svelte`, `#title` →
 * `menu.title`; a text attribute: `menu.title_placeholder`), else its field and tag (`menu.text_p`); `_2`, `_3`… when taken.
 */
export function suggestKey(project: ExchangeProject, sourcePath: string, elementId: string | null, tag: string, field: string): string {
  const f = slug(field);
  const base = `${sourceName(sourcePath) || "ui"}.${elementId ? slug(elementId) || f : `${f}_${tag.toLowerCase()}`}${elementId && field !== "text" ? `_${f}` : ""}`.slice(0, STRINGS_LIMITS.keyLength - 4);
  return uniqueName(base, (key) => !!tableOfKey(project, key), UNDERSCORED);
}

/** The table a new key goes in by default: the component's own (`ui/Menu.svelte` → a table named `menu`), else the first. */
export function suggestTable(project: ExchangeProject, sourcePath: string): string {
  const name = sourceName(sourcePath);
  const own = project.tables.find((t) => t.path.slice(t.path.lastIndexOf("/") + 1).toLowerCase() === `${name.toLowerCase()}.strings.json`);
  return own?.path ?? project.tables[0]?.path ?? `strings/${name || "ui"}.strings.json`;
}

/**
 * The literal text Unlink writes back for `key`: its reference text, or refused when no table defines it or its message
 * takes arguments (it can't be written as plain text then).
 */
export function unlinkText(project: ExchangeProject, key: string): EditResult<string> {
  const entry = project.tables.flatMap((t) => t.table.strings).find((e) => e.key === key);
  if (!entry) return refuse(`no table defines "${key}"`);
  const args = [...messageArguments(parseMessage(entry.text).ast).keys()];
  if (args.length) return refuse(`its message takes arguments (${args.join(", ")}), so it can't be written as plain text`);
  return accept(entry.text);
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
