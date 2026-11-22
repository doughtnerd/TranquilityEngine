/**
 * @internal The minimal text-localisation runtime audio needs before 0342's full `Locale` (T2) lands, kept small so T2
 * can absorb it: `Locale.setLanguage` becomes the caller of `switchTextLanguage`, `Locale.t` reuses `lookupString`.
 *
 * - **The text language** (0342 §6): the language the player reads; null until something starts one (then subtitles
 *   follow the audio language, 0340 §4). `switchTextLanguage` is atomic (0343 §2): every **language participant**
 *   (0342's internal seam; audio's voice language under `languages.voice: "followText"`) prepares the new language,
 *   then all of them commit in one step, then the text language changes and listeners hear it. A second switch while
 *   one is pending supersedes it.
 * - **String lookup** (0342 §1, §3): a key in one string table (`*.strings.json`) and its translation files
 *   (`<stem>.<code>.strings.json`), resolved through a fallback chain: the first language with the key whose message
 *   parses, the reference language's text from the table itself; formatted with no arguments in that language.
 *
 * Not public API (0342's `Locale` is). Engine-level: no audio import, no plugin, no DOM.
 */
import { isWellFormed, parseMessage } from "./message/parse";
import { formatMessage } from "./message/format";
import type { MessageNode } from "./message/ast";
import { parseStringTable, translationPath, type StringTable } from "./strings/format";
import { parseTranslation, type TranslationFile } from "./strings/translation";

// --- the text language and its participants -------------------------------------------------------------------------

/** Something that follows the text language (0342's internal language-participant seam). */
export interface LanguageParticipant {
  /** Load what `code` needs; the switch waits for every participant. A rejection fails the switch (nothing changes). */
  prepare(code: string): Promise<void> | void;
  /** Change to `code`: every participant commits in the same step, after all have prepared. */
  commit(code: string): void;
}

let textLanguage: string | null = null;
let pending: { code: string; serial: number } | null = null;
let serial = 0;
const participants = new Set<LanguageParticipant>();
const listeners = new Set<(e: { language: string; previous: string | null }) => void>();

/** The text language now; null before one starts. */
export const currentTextLanguage = (): string | null => textLanguage;

/** The text language a pending switch goes to; null when none is pending. */
export const pendingTextLanguage = (): string | null => pending?.code ?? null;

/** Adds a participant; returns its removal. */
export function addLanguageParticipant(p: LanguageParticipant): () => void {
  participants.add(p);
  return () => { participants.delete(p); };
}

/** Hears each text language change (after every participant committed); returns the unsubscribe. */
export function onTextLanguageChange(fn: (e: { language: string; previous: string | null }) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Switches the text language atomically (see the header). Resolves once it changed; resolves without changing anything
 * when a later switch superseded it; rejects (changing nothing) when a participant's `prepare` rejects.
 */
export async function switchTextLanguage(code: string): Promise<void> {
  const mine = ++serial;
  pending = { code, serial: mine };
  const list = [...participants];
  const waits = list.map((p) => {
    try { return p.prepare(code); } catch (e) { return Promise.reject(e); }
  });
  if (waits.some((w) => w instanceof Promise)) {
    try { await Promise.all(waits); } catch (e) {
      if (pending?.serial === mine) pending = null;
      throw e;
    }
  }
  if (pending?.serial !== mine) return; // superseded
  pending = null;
  for (const p of list) {
    try { p.commit(code); } catch (e) { console.error("[myco] a language participant failed to switch:", e); }
  }
  const previous = textLanguage;
  textLanguage = code;
  if (previous === code) return;
  for (const fn of [...listeners]) {
    try { fn({ language: code, previous }); } catch (e) { console.error("[myco] a text language listener threw:", e); }
  }
}

/** Forgets the text language (a project closed): back to none, nothing pending. Participants and listeners stay. */
export function resetTextLanguage(): void {
  textLanguage = null;
  pending = null;
  serial++;
}

// --- string lookup -----------------------------------------------------------------------------------------------------

/** Reads a project JSON file's value; undefined when there is none. */
export type StringFileReader = (path: string) => unknown;

/** What a key resolved to: the formatted text and the language it came from. */
export interface StringMatch {
  text: string;
  language: string;
}

const tables = new WeakMap<object, StringTable>();
const translations = new WeakMap<object, TranslationFile>();
const messages = new Map<string, readonly MessageNode[] | null>();

function tableOf(raw: unknown, path: string): StringTable | null {
  if (typeof raw !== "object" || raw === null) return null;
  let t = tables.get(raw);
  if (!t) tables.set(raw, (t = parseStringTable(raw, path).table));
  return t;
}

function translationOf(raw: unknown, path: string): TranslationFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  let t = translations.get(raw);
  if (!t) translations.set(raw, (t = parseTranslation(raw, path).translation));
  return t;
}

/** A message's AST, or null when it doesn't parse (cached by text; a long-lived cache of short strings). */
function astOf(message: string): readonly MessageNode[] | null {
  let ast = messages.get(message);
  if (ast === undefined) {
    const parse = parseMessage(message);
    ast = isWellFormed(parse) ? parse.ast : null;
    if (messages.size > 4096) messages.clear();
    messages.set(message, ast);
  }
  return ast;
}

/**
 * `key` in the string table at `tablePath` through `chain` (`fallbackChain(languages, code)`): for each language, the
 * table's own text when it is the table's reference language, else its translation file's entry (translated or needs
 * review), the first whose message parses; formatted with no arguments in that language's `Intl` tag (`intlTag`,
 * default the code). Null when no language of the chain has it, or the table is missing.
 */
export function lookupString(key: string, tablePath: string, chain: readonly string[], read: StringFileReader, intlTag: (code: string) => string = (c) => c): StringMatch | null {
  const table = tableOf(read(tablePath), tablePath);
  if (!table) return null;
  for (const code of chain) {
    let message: string | undefined;
    if (code.toLowerCase() === table.language.toLowerCase()) message = table.strings.find((s) => s.key === key)?.text;
    else {
      const path = translationPath(tablePath, code);
      message = translationOf(read(path), path)?.strings[key]?.text;
    }
    if (message === undefined) continue;
    const ast = astOf(message);
    if (ast === null) continue;
    return { text: formatMessage(ast, null, intlTag(code)), language: code };
  }
  return null;
}
