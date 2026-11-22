/**
 * A build's string files (ADR 0342 §11): `strings/<code>.json` (`myco.strings.build@1`), one per shipped language,
 * holding the language, its text direction and, per key, the message resolved through that language's fallback chain,
 * so each file is complete on its own. Notes, status, length limits, examples and sources never ship.
 *
 * The reader here is what the player loads with (`BuildStrings`); the writer and `game.json`'s `localisation` section
 * are what the export (0342 T8) writes. Parsed leniently (never throws). Pure; no plugin, no DOM.
 */
import { defaultDirection, fallbackChain, languageOf, type LanguageSettings, type TextDirection } from "../languages";
import { isRecord, Reader, type JsonRecord } from "../lenient";
import { parseMessage } from "../message/parse";
import { isStringKey, STRINGS_LIMITS } from "../strings/format";

export const BUILD_STRINGS_FORMAT = "myco.strings.build@1";

/** One language's build file. */
export interface BuildStringsFile {
  format: typeof BUILD_STRINGS_FORMAT;
  language: string;
  direction: TextDirection;
  /** Key → message (ICU MessageFormat 1), already resolved through the language's chain. */
  strings: Record<string, string>;
}

/** A build file, leniently: bad keys and non-string messages dropped with a problem each. */
export function parseBuildStrings(raw: unknown, where = "strings"): { file: BuildStringsFile; problems: string[] } {
  const problems: string[] = [];
  const r = new Reader(problems);
  const file: BuildStringsFile = { format: BUILD_STRINGS_FORMAT, language: "en", direction: "ltr", strings: {} };
  if (!isRecord(raw)) {
    r.problem(where, "a build string file must be an object; using no strings.");
    return { file, problems };
  }
  if (raw.format !== BUILD_STRINGS_FORMAT) r.problem(`${where}.format`, `expected "${BUILD_STRINGS_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${BUILD_STRINGS_FORMAT}.`);
  file.language = r.str(raw.language, `${where}.language`, "en");
  file.direction = r.pick(raw.direction, `${where}.direction`, ["ltr", "rtl"] as const, defaultDirection(file.language));
  const strings = r.record(raw.strings, `${where}.strings`) ?? {};
  for (const [key, text] of Object.entries(strings)) {
    if (!isStringKey(key)) r.problem(`${where}.strings.${key}`, "isn't a key; dropped.");
    else if (typeof text !== "string") r.problem(`${where}.strings.${key}`, "must be a message string; dropped.");
    else file.strings[key] = text.length > STRINGS_LIMITS.message ? text.slice(0, STRINGS_LIMITS.message) : text;
  }
  return { file, problems };
}

/** Where a build's messages come from, for the writer: the message `key` has in `code`, as written. */
export interface BuildStringsSource {
  message(key: string, code: string): string | undefined;
  keys(): Iterable<string>;
}

/**
 * The build file of `code`: every key resolved to the first language of `code`'s chain whose message parses, as the
 * runtime resolves it. `fellBack` lists the keys that came from a later language than `code` (or from nowhere: then the
 * key is left out and the runtime shows the key), for the export's build warnings.
 */
export function buildStringsFile(languages: LanguageSettings, code: string, source: BuildStringsSource): { file: BuildStringsFile; fellBack: { key: string; from: string | null }[] } {
  const chain = fallbackChain(languages, code);
  const def = languageOf(languages, code);
  const file: BuildStringsFile = { format: BUILD_STRINGS_FORMAT, language: def?.code ?? code, direction: def?.direction ?? defaultDirection(code), strings: {} };
  const fellBack: { key: string; from: string | null }[] = [];
  for (const key of source.keys()) {
    let from: string | null = null;
    for (const c of chain) {
      const text = source.message(key, c);
      if (text === undefined || parseMessage(text).problems.some((p) => p.severity === "error")) continue;
      file.strings[key] = text;
      from = c;
      break;
    }
    if (from !== chain[0]) fellBack.push({ key, from });
  }
  return { file, fellBack };
}

/** A build file as JSON. */
export const buildStringsToJson = (f: BuildStringsFile): JsonRecord => ({ format: BUILD_STRINGS_FORMAT, language: f.language, direction: f.direction, strings: { ...f.strings } });

/** The build file's text: compact JSON (it ships) and a final newline. */
export const formatBuildStrings = (f: BuildStringsFile): string => `${JSON.stringify(buildStringsToJson(f))}\n`;

/** `game.json`'s `localisation` section (ADR 0342 §11) as the player reads it. */
export interface BuildLocalisation {
  /** Language code → the URL of its string file (relative to the build). */
  strings: Record<string, string>;
  /** Language code → font file URLs (fonts also resolve through the build's asset files). */
  fonts: Record<string, string[]>;
  /** The build holds the pseudo-languages (`--pseudo`). */
  pseudo: boolean;
}

/** `game.json`'s `localisation`, leniently; null when the build has none (it was exported before string files). */
export function readBuildLocalisation(raw: unknown): BuildLocalisation | null {
  if (!isRecord(raw)) return null;
  const out: BuildLocalisation = { strings: {}, fonts: {}, pseudo: raw.pseudo === true };
  if (isRecord(raw.strings)) {
    for (const [code, v] of Object.entries(raw.strings)) {
      const url = typeof v === "string" ? v : isRecord(v) && typeof v.url === "string" ? v.url : null;
      if (url) out.strings[code] = url;
    }
  }
  if (isRecord(raw.fonts)) {
    for (const [code, v] of Object.entries(raw.fonts)) if (Array.isArray(v)) out.fonts[code] = v.filter((u): u is string => typeof u === "string");
  }
  return out;
}
