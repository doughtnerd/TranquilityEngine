/**
 * Message checks over whole files (ADR 0356 §2): every key of a string table checked in its reference language, and
 * every entry of a translation checked against the table's reference text (argument names and kinds, plural
 * categories, syntax). Entries whose key the table lacks are reported too. The editor, the export and the import preview
 * read these; a translation with an error is skipped at runtime for the next language of the chain.
 *
 * Pure; no plugin, no DOM.
 */
import type { MessageProblem } from "../message/ast";
import { checkMessage, checkTranslation } from "../message/check";
import type { StringTable } from "./format";
import type { TranslationFile } from "./translation";

/** The problems of one key. */
export interface KeyProblems {
  key: string;
  problems: MessageProblem[];
}

/** The keys of `table` with problems in its reference language (`intlTag`: the language's `intl`, else its code). */
export function validateStringTable(table: StringTable, intlTag: string = table.language, languageName?: string): KeyProblems[] {
  const out: KeyProblems[] = [];
  for (const e of table.strings) {
    const problems = checkMessage(e.text, intlTag, languageName);
    if (problems.length) out.push({ key: e.key, problems });
  }
  return out;
}

/** The entries of `translation` with problems against `table` (`intlTag`: the translation language's `intl` tag). */
export function validateTranslation(table: StringTable, translation: TranslationFile, intlTag: string = translation.language, languageName?: string): KeyProblems[] {
  const reference = new Map(table.strings.map((e) => [e.key, e.text] as const));
  const out: KeyProblems[] = [];
  for (const [key, entry] of Object.entries(translation.strings)) {
    const ref = reference.get(key);
    const problems = ref === undefined
      ? [{ severity: "warning" as const, message: `"${key}" isn't a key of the table; it is never used`, start: 0, end: 0 }]
      : checkTranslation(ref, entry.text, intlTag, languageName);
    if (problems.length) out.push({ key, problems });
  }
  return out;
}
