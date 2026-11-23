/**
 * The project's languages (ADR 0354 §1, extended by 0356 §3 and 0357 §2–§3): `project.json`'s `languages` section,
 * the one language list for text and audio. Parsed leniently (never throws; one problem line per bad value) and
 * written back minimal; plus the pure rules on it: fallback chains, BCP 47 lookup, default text direction, the voice
 * language a text language follows.
 *
 * Pure, engine-level: no audio import, no plugin, no DOM.
 */
import { isRecord, Reader, type JsonRecord } from "./lenient";

/** Limits of the section, declared once (ADR 0306). */
export const LANGUAGE_LIMITS = Object.freeze({
  /** Languages in the list. */
  languages: 64,
  /** Entries of one language's own `fallback` and of the project's. */
  fallback: 16,
  /** Font files of one language. */
  fonts: 16,
  /** `fontReplace` pairs of one language. */
  fontReplace: 64,
  /** `assetRoots`. */
  assetRoots: 32,
  /** Characters of a language's display name. */
  name: 64,
  /** A language's reading speed, characters per second. */
  readingSpeed: [1, 60] as readonly [number, number],
});

export type TextDirection = "ltr" | "rtl";
export type VoiceMode = "followText" | "separate";

/** One language row. */
export interface LanguageDef {
  /** A BCP 47 tag in canonical case (`en`, `en-GB`, `zh-Hans`). */
  code: string;
  name: string;
  /** Languages tried after this one, before the project's `fallback` (each one listed). */
  fallback: string[];
  /** False: work in progress, left out of exports and the runtime's language lists. */
  ship: boolean;
  /** Base text direction (0356 §5); absent in the file: `defaultDirection(code)`. */
  direction: TextDirection;
  /** Font files tried after a text's own font and before Inter (0356 §5). */
  fonts: string[];
  /** A text whose font is the key draws in the value in this language. */
  fontReplace: Record<string, string>;
  /** The BCP 47 tag `Intl` formats with; null: the code. */
  intl: string | null;
  /** False: translated but not recorded (0357 §2): not a voice language. */
  voice: boolean;
  /** Subtitle reading speed, characters per second (0357 §3); null: the built-in default for the language. */
  readingSpeed: number | null;
}

/** The `languages` section. */
export interface LanguageSettings {
  list: LanguageDef[];
  /** The language references are authored in (string tables' text, localised roots' reference files); listed. */
  reference: string;
  /** The start language when nothing else picks one; listed. */
  default: string;
  /** The chain every language ends with; absent in the file: `[reference]`. */
  fallback: string[];
  useSystemLanguage: boolean;
  remember: boolean;
  /** Folders whose first sub-folder is a language code (0356 §10). */
  assetRoots: string[];
  /** Voice follows the text language, or the two switch separately (0357 §2). */
  voice: VoiceMode;
}

export interface LanguagesParse {
  languages: LanguageSettings;
  problems: string[];
}

// --- BCP 47 ----------------------------------------------------------------------------------------------------------

const SUBTAG = /^[A-Za-z0-9]{1,8}$/;
const LANGUAGE = /^[A-Za-z]{2,3}$/;

/**
 * A language tag in canonical case (BCP 47 §2.1.1: language lower case, a four-letter script title case, a two-letter
 * region upper case, everything else lower case), or null when it isn't a well-formed tag of the forms games use
 * (`language[-script][-region][-variant…]`, with extensions and private use after a singleton kept lower case).
 */
export function canonicalLanguageCode(tag: string): string | null {
  const parts = tag.split("-");
  if (parts.length === 0 || !LANGUAGE.test(parts[0]) || !parts.every((p) => SUBTAG.test(p))) return null;
  const out = [parts[0].toLowerCase()];
  let afterSingleton = false;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (afterSingleton) out.push(p.toLowerCase());
    else if (p.length === 1) {
      afterSingleton = true;
      if (i === parts.length - 1) return null; // a singleton needs a subtag after it
      out.push(p.toLowerCase());
    } else if (i === 1 && p.length === 4 && /^[A-Za-z]{4}$/.test(p)) out.push(p[0].toUpperCase() + p.slice(1).toLowerCase());
    else if (out.length <= 2 && /^([A-Za-z]{2}|\d{3})$/.test(p)) out.push(p.toUpperCase());
    else if (/^([A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3})$/.test(p)) out.push(p.toLowerCase());
    else return null;
  }
  return out.join("-");
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "ps", "sd", "yi", "dv", "ckb"]);

/** The text direction a language has when its row sets none (0356 §3). */
export function defaultDirection(code: string): TextDirection {
  const parts = code.split("-");
  if (RTL_LANGUAGES.has(parts[0].toLowerCase())) return "rtl";
  return parts.slice(1).some((p) => /^(arab|hebr)$/i.test(p)) ? "rtl" : "ltr";
}

/**
 * BCP 47 lookup (RFC 4647 §3.4): for each requested tag in order, the available tag equal to it (case-insensitively),
 * else to it with its last subtag dropped (and a singleton left at the end dropped with it), repeatedly. Returns the
 * available tag as written there, or null when nothing matches.
 */
export function lookupLanguage(requested: readonly string[], available: readonly string[]): string | null {
  const byLower = new Map(available.map((a) => [a.toLowerCase(), a] as const));
  for (const tag of requested) {
    let parts = tag.toLowerCase().split("-").filter((p) => p !== "");
    while (parts.length > 0) {
      const hit = byLower.get(parts.join("-"));
      if (hit !== undefined) return hit;
      parts = parts.slice(0, -1);
      if (parts.length > 0 && parts[parts.length - 1].length === 1) parts = parts.slice(0, -1);
    }
  }
  return null;
}

// --- defaults --------------------------------------------------------------------------------------------------------

/** A language row with every optional field at its default. */
export function languageDef(code: string, name = code): LanguageDef {
  return { code, name, fallback: [], ship: true, direction: defaultDirection(code), fonts: [], fontReplace: {}, intl: null, voice: true, readingSpeed: null };
}

/** A project without a `languages` section: one implicit language, `en`. */
export function defaultLanguages(): LanguageSettings {
  return { list: [languageDef("en", "English")], reference: "en", default: "en", fallback: ["en"], useSystemLanguage: true, remember: true, assetRoots: [], voice: "followText" };
}

// --- parse -----------------------------------------------------------------------------------------------------------

/** A project path folder: no leading or trailing slash, no `..`, no backslash. */
export function cleanFolder(raw: string): string | null {
  const f = raw.trim().replace(/^\/+|\/+$/g, "");
  if (f === "" || f.includes("\\") || f.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return f;
}

function parseRow(raw: unknown, where: string, r: Reader, seen: Map<string, string>): LanguageDef | null {
  if (typeof raw === "string") raw = { code: raw };
  if (!isRecord(raw)) return void r.problem(where, "a language must be an object with a code; dropped."), null;
  if (typeof raw.code !== "string") return void r.problem(`${where}.code`, "must be a language tag such as \"fr\" or \"pt-BR\"; dropped."), null;
  const code = canonicalLanguageCode(raw.code);
  if (code === null) return void r.problem(`${where}.code`, `"${raw.code}" isn't a language tag such as "fr" or "pt-BR"; dropped.`), null;
  if (code !== raw.code) r.problem(`${where}.code`, `"${raw.code}" is written "${code}"; using "${code}".`);
  const lower = code.toLowerCase();
  if (seen.has(lower)) {
    // Codes become folder names, so two that differ only in case are the same language (CLAUDE.md's case rule).
    return void r.problem(`${where}.code`, `"${code}" is listed twice${seen.get(lower) !== code ? ` (as "${seen.get(lower)}")` : ""}; dropped.`), null;
  }
  seen.set(lower, code);
  const out = languageDef(code);
  let name = r.str(raw.name, `${where}.name`, code).trim();
  if (name === "") name = code;
  if (name.length > LANGUAGE_LIMITS.name) {
    r.problem(`${where}.name`, `at most ${LANGUAGE_LIMITS.name} characters; cut.`);
    name = name.slice(0, LANGUAGE_LIMITS.name);
  }
  out.name = name;
  out.fallback = r.strings(raw.fallback, `${where}.fallback`, LANGUAGE_LIMITS.fallback);
  out.ship = r.bool(raw.ship, `${where}.ship`, true);
  out.direction = r.pick(raw.direction, `${where}.direction`, ["ltr", "rtl"] as const, out.direction);
  out.fonts = r.strings(raw.fonts, `${where}.fonts`, LANGUAGE_LIMITS.fonts).filter((f, i, all) => {
    if (f.trim() === "") return void r.problem(`${where}.fonts[${i}]`, "must be a font file path; dropped."), false;
    if (all.indexOf(f) !== i) return void r.problem(`${where}.fonts[${i}]`, `"${f}" is listed twice; dropped.`), false;
    return true;
  });
  const replace = r.record(raw.fontReplace, `${where}.fontReplace`);
  if (replace) {
    for (const [from, to] of Object.entries(replace)) {
      if (Object.keys(out.fontReplace).length >= LANGUAGE_LIMITS.fontReplace) { r.problem(`${where}.fontReplace`, `at most ${LANGUAGE_LIMITS.fontReplace} replacements; the rest are dropped.`); break; }
      if (typeof to !== "string" || to.trim() === "" || from.trim() === "") { r.problem(`${where}.fontReplace.${from}`, "must map a font file to a font file; dropped."); continue; }
      out.fontReplace[from] = to;
    }
  }
  const intl = r.strOrNull(raw.intl, `${where}.intl`, null);
  if (intl !== null) {
    const c = canonicalLanguageCode(intl);
    if (c === null) r.problem(`${where}.intl`, `"${intl}" isn't a language tag; using the code.`);
    else out.intl = c === code ? null : c;
  }
  out.voice = r.bool(raw.voice, `${where}.voice`, true);
  if (raw.readingSpeed !== undefined && raw.readingSpeed !== null) {
    const [lo, hi] = LANGUAGE_LIMITS.readingSpeed;
    out.readingSpeed = r.num(raw.readingSpeed, `${where}.readingSpeed`, 15, lo, hi);
  }
  return out;
}

/**
 * `project.json`'s `languages` section, leniently. Absent: `defaultLanguages()`. Repairs, each with a problem line:
 * malformed or duplicate codes dropped (codes differing only in case count as duplicates), non-canonical case fixed,
 * a fallback naming an unlisted language (or itself) dropped, a reference or default that isn't listed replaced by the
 * first language, an empty list replaced by `en`.
 */
export function parseLanguages(raw: unknown, where = "languages"): LanguagesParse {
  const problems: string[] = [];
  const r = new Reader(problems);
  const out = defaultLanguages();
  if (raw === undefined || raw === null) return { languages: out, problems };
  if (!isRecord(raw)) {
    r.problem(where, "must be an object; using English only.");
    return { languages: out, problems };
  }
  const seen = new Map<string, string>();
  const list: LanguageDef[] = [];
  r.list(raw.list, `${where}.list`).forEach((row, i) => {
    const w = `${where}.list[${i}]`;
    if (list.length >= LANGUAGE_LIMITS.languages) return void r.problem(w, `at most ${LANGUAGE_LIMITS.languages} languages; dropped.`);
    const def = parseRow(row, w, r, seen);
    if (def) list.push(def);
  });
  if (list.length === 0) {
    if (raw.list !== undefined) r.problem(`${where}.list`, "has no language; using English.");
    list.push(languageDef("en", "English"));
  }
  out.list = list;
  const codes = new Map(list.map((l) => [l.code.toLowerCase(), l.code] as const));
  /** A listed code (matched case-insensitively), or null with a problem. */
  const listed = (v: string, w: string, then: string): string | null => {
    const hit = codes.get(v.toLowerCase());
    if (hit === undefined) return void r.problem(w, `"${v}" isn't a listed language; ${then}.`), null;
    return hit;
  };

  for (const [i, def] of list.entries()) {
    const w = `${where}.list[${i}].fallback`;
    def.fallback = dedupe(def.fallback.map((c, j) => {
      const hit = listed(c, `${w}[${j}]`, "dropped");
      if (hit === def.code) return void r.problem(`${w}[${j}]`, "a language can't fall back to itself; dropped."), null;
      return hit;
    }).filter((c): c is string => c !== null));
  }

  const first = list[0].code;
  out.reference = typeof raw.reference === "string" ? listed(raw.reference, `${where}.reference`, `using "${first}"`) ?? first : first;
  if (raw.reference !== undefined && typeof raw.reference !== "string") r.problem(`${where}.reference`, `must be a language code; using "${first}".`);
  out.default = typeof raw.default === "string" ? listed(raw.default, `${where}.default`, `using "${out.reference}"`) ?? out.reference : out.reference;
  if (raw.default !== undefined && typeof raw.default !== "string") r.problem(`${where}.default`, `must be a language code; using "${out.reference}".`);
  if (raw.fallback === undefined) out.fallback = [out.reference];
  else {
    out.fallback = dedupe(r.strings(raw.fallback, `${where}.fallback`, LANGUAGE_LIMITS.fallback)
      .map((c, j) => listed(c, `${where}.fallback[${j}]`, "dropped"))
      .filter((c): c is string => c !== null));
  }
  out.useSystemLanguage = r.bool(raw.useSystemLanguage, `${where}.useSystemLanguage`, true);
  out.remember = r.bool(raw.remember, `${where}.remember`, true);
  out.assetRoots = dedupe(r.strings(raw.assetRoots, `${where}.assetRoots`, LANGUAGE_LIMITS.assetRoots).map((f, i) => {
    const c = cleanFolder(f);
    if (c === null) r.problem(`${where}.assetRoots[${i}]`, `"${f}" isn't a project folder; dropped.`);
    return c;
  }).filter((c): c is string => c !== null));
  out.voice = r.pick(raw.voice, `${where}.voice`, ["followText", "separate"] as const, "followText");
  if (!list.some((l) => l.ship)) problems.push(`${where}: no language is shipped; exports would have none.`);
  return { languages: out, problems };
}

const dedupe = (list: string[]): string[] => [...new Set(list)];

// --- write -----------------------------------------------------------------------------------------------------------

function rowToJson(l: LanguageDef): JsonRecord {
  const out: JsonRecord = { code: l.code, name: l.name };
  if (l.fallback.length) out.fallback = [...l.fallback];
  if (!l.ship) out.ship = false;
  if (l.direction !== defaultDirection(l.code)) out.direction = l.direction;
  if (l.fonts.length) out.fonts = [...l.fonts];
  if (Object.keys(l.fontReplace).length) out.fontReplace = { ...l.fontReplace };
  if (l.intl !== null) out.intl = l.intl;
  if (!l.voice) out.voice = false;
  if (l.readingSpeed !== null) out.readingSpeed = l.readingSpeed;
  return out;
}

/** The section as JSON: stable key order, defaults left out; `parseLanguages(languagesToJson(x)).languages` equals `x`. */
export function languagesToJson(s: LanguageSettings): JsonRecord {
  const out: JsonRecord = { list: s.list.map(rowToJson), reference: s.reference, default: s.default };
  if (s.fallback.length !== 1 || s.fallback[0] !== s.reference) out.fallback = [...s.fallback];
  if (!s.useSystemLanguage) out.useSystemLanguage = false;
  if (!s.remember) out.remember = false;
  if (s.assetRoots.length) out.assetRoots = [...s.assetRoots];
  if (s.voice !== "followText") out.voice = s.voice;
  return out;
}

// --- rules -----------------------------------------------------------------------------------------------------------

/** The row of `code` (case-insensitively), or undefined. */
export function languageOf(s: LanguageSettings, code: string): LanguageDef | undefined {
  const lower = code.toLowerCase();
  return s.list.find((l) => l.code.toLowerCase() === lower);
}

/**
 * The fallback chain of `code` (0354 §1): the language itself, its own `fallback` list in order, then the project's
 * `fallback`, duplicates removed. An unlisted code gives itself then the project's chain.
 */
export function fallbackChain(s: LanguageSettings, code: string): string[] {
  const def = languageOf(s, code);
  return dedupe([def?.code ?? code, ...(def?.fallback ?? []), ...s.fallback]);
}

/** The shipped languages (`ship` not false), in list order. */
export const shippedLanguages = (s: LanguageSettings): LanguageDef[] => s.list.filter((l) => l.ship);

/**
 * The voice language a text language plays in under `voice: "followText"` (0357 §2): the text language when it is a
 * voice language, else the first language of its chain that is (shipped and `voice` not false); null when none is.
 */
export function voiceLanguageFor(s: LanguageSettings, code: string): string | null {
  for (const c of fallbackChain(s, code)) {
    const def = languageOf(s, c);
    if (def && def.voice && def.ship) return def.code;
  }
  return null;
}

/** The tag `Intl` formats `code` with (its `intl`, else the code). */
export const intlTagOf = (s: LanguageSettings, code: string): string => languageOf(s, code)?.intl ?? code;
