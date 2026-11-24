// Languages in game builds (ADR 0356 §10, §11; 0354 §6; amended by 0357 §1): which languages a build ships, the
// string files it writes and the project files it leaves out. `planWebBuild` (webBuild.ts) runs `planLocalisation`;
// the audio step (audio.ts) reads the same `BuildLanguages` to split packages per language and write the line index.
//
// - **Shipped languages**: `project.json`'s `languages` without the `ship: false` ones, narrowed by `--languages`
//   (which never adds one). `--pseudo` adds the two pseudo-languages (`localisation.pseudo`), which format the
//   reference language's strings. The build's own `project.json` marks every language it left out `ship: false`, so
//   `Locale.languages` and `Audio.languages` list only what the build holds.
// - **String files**: `strings/<code>.json` (`myco.strings.build@1`; fallback messages name their language, ADR 0391) per shipped language, every key resolved through
//   that language's chain (`buildStringsFile`), so each file is complete on its own. A translation that fails the checks
//   (`checkTranslation`: it doesn't parse, uses an argument the reference doesn't, changes an argument's kind, lacks a
//   plural category) is replaced by its fallback. Each language with keys that fell back gets one build warning. The
//   string tables and their translations (notes, status, sources) don't ship.
// - **Localised folders** (`languages.assetRoots` and `audio.json`'s `localisation.roots`): a file under
//   `<root>/<code>/` ships when `<code>` is a shipped language or one a shipped language's chain falls back to, so the
//   runtime's `variantPath` finds in the build what it found in the project; other listed languages' files are left out.
//   A folder whose name isn't a listed language ships as an ordinary folder.
// - **Fonts**: each shipped language's `fonts` that the build ships, in `localisation.fonts`. String files and fonts
//   ship loose, never in `.mycopak` packages.
import { fallbackChain, intlTagOf, languageOf, parseLanguages, shippedLanguages, type LanguageSettings } from "../engine/localisation/languages";
import { isRecord } from "../engine/localisation/lenient";
import { checkTranslation } from "../engine/localisation/message/check";
import { buildStringsFile, formatBuildStrings, type BuildStringsSource } from "../engine/localisation/runtime/buildFile";
import { ProjectStrings } from "../engine/localisation/runtime/strings";
import { stringsPathKind } from "../engine/localisation/strings/format";
import { localisedParts } from "../engine/localisation/variants";
import { parseAudioProject } from "../engine/audio/project/format";
import { AUDIO_PROJECT_FILE } from "../engine/audio/project/types";
import type { LocalisationManifest } from "./format";

/** Where a build's string files go (relative to the build's root). */
export const STRINGS_DIR = "strings";
/** The string file of language `code` in a build. */
export const stringsFileOf = (code: string): string => `${STRINGS_DIR}/${code}.json`;

/** The languages a build ships (ADR 0356 §11, 0354 §6). */
export interface BuildLanguages {
  /** `project.json`'s `languages`, parsed. */
  readonly settings: LanguageSettings;
  /** The shipped languages, in the project's order. */
  readonly codes: readonly string[];
  /** The shipped languages and every language their fallback chains reach: the language folders whose files ship. */
  readonly reachable: readonly string[];
  /** `--pseudo`: the pseudo-languages are in the build. */
  readonly pseudo: boolean;
}

/** What the export was asked for: `--languages` and `--pseudo`. */
export interface BuildLanguageOptions {
  /** Narrows the shipped languages (codes matched case-insensitively). Absent: every shipped language. */
  readonly languages?: readonly string[];
  readonly pseudo?: boolean;
}

/**
 * The languages a build of a project with `project.json` `raw` ships. `warnings` name `--languages` codes that aren't
 * shipped languages; `error` says why nothing would ship.
 */
export function buildLanguages(rawProject: unknown, options: BuildLanguageOptions = {}): { languages: BuildLanguages; warnings: string[]; error: string | null } {
  const settings = parseLanguages(isRecord(rawProject) ? rawProject.languages : undefined).languages;
  const warnings: string[] = [];
  let codes = shippedLanguages(settings).map((l) => l.code);
  if (options.languages) {
    const wanted = new Set<string>();
    for (const asked of options.languages) {
      const def = languageOf(settings, asked);
      if (!def) warnings.push(`--languages: "${asked}" isn't a language of the project (${settings.list.map((l) => l.code).join(", ")}); ignored.`);
      else if (!def.ship) warnings.push(`--languages: "${def.code}" has ship: false in project.json; left out.`);
      else wanted.add(def.code);
    }
    codes = codes.filter((c) => wanted.has(c));
  }
  const reachable = [...new Set(codes.flatMap((c) => fallbackChain(settings, c)))];
  const error = codes.length === 0 ? `No language ships: ${options.languages ? "--languages names none of the project's shipped languages" : "every language in project.json has ship: false"}.` : null;
  return { languages: { settings, codes, reachable, pseudo: options.pseudo === true }, warnings, error };
}

/** The localised roots of a project: `languages.assetRoots` and `audio.json`'s `localisation.roots`. */
export function localisedRoots(languages: LanguageSettings, audioJson: unknown): string[] {
  const audio = audioJson === undefined ? [] : (parseAudioProject(audioJson).project.localisation?.roots ?? []);
  return [...new Set([...languages.assetRoots, ...audio])];
}

/**
 * Whether the build ships `path`: false for a file under a localised root whose language folder is a listed language
 * that no shipped language reaches (see the file header).
 */
export function shipsVariant(path: string, roots: readonly string[], languages: BuildLanguages): boolean {
  const parts = localisedParts(path, roots);
  if (!parts) return true;
  const def = languageOf(languages.settings, parts.code);
  if (!def) return true;
  return languages.reachable.includes(def.code);
}

/**
 * `messages` with the checks applied (ADR 0356 §11): a translation that fails `checkTranslation` against the reference
 * language's message reads as missing, so `buildStringsFile` takes its fallback; `failed` collects each one.
 */
function checkedSource(settings: LanguageSettings, messages: ProjectStrings, failed: { key: string; code: string; why: string }[]): BuildStringsSource {
  const seen = new Set<string>();
  return {
    keys: () => messages.keys(),
    message(key, code) {
      const text = messages.message(key, code);
      if (text === undefined || code.toLowerCase() === settings.reference.toLowerCase()) return text;
      const reference = messages.message(key, settings.reference);
      if (reference === undefined) return text;
      const error = checkTranslation(reference, text, intlTagOf(settings, code), languageOf(settings, code)?.name ?? code).find((p) => p.severity === "error");
      if (!error) return text;
      if (!seen.has(`${code}\u0000${key}`)) {
        seen.add(`${code}\u0000${key}`);
        failed.push({ key, code, why: error.message });
      }
      return undefined;
    },
  };
}

/** Up to `n` items, then "and N more". */
function listSome(items: readonly string[], n = 8): string {
  return items.length <= n ? items.join(", ") : `${items.slice(0, n).join(", ")} and ${items.length - n} more`;
}

/** What a project's languages add to and take from its build. */
export interface LocalisationPlan {
  readonly languages: BuildLanguages;
  /** The build's copies without the files it leaves out (string tables, other languages' variants). */
  readonly copies: readonly string[];
  /** Files written from text, by build path: the string files, and the build's own `project.json` when it narrows. */
  readonly generated: ReadonlyMap<string, string>;
  /** `game.json`'s `localisation`; null when the project has neither a `languages` section nor string tables. */
  readonly manifest: LocalisationManifest | null;
  /** Build warnings: `--languages` codes ignored, keys that fell back, translations that failed the checks. */
  readonly warnings: readonly string[];
  /** Why nothing can ship (`--languages` named no shipped language). */
  readonly error: string | null;
}

/**
 * The localisation of a build (see the file header). `json` holds every JSON file's text by project path (the
 * project's own, not yet copied); `copies` are the project files the build ships so far; `projectFile` is where
 * `project.json` is written in the build.
 */
export function planLocalisation(json: ReadonlyMap<string, string>, copies: readonly string[], options: BuildLanguageOptions, projectFile: string): LocalisationPlan {
  const parse = (path: string): unknown => {
    const text = json.get(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const rawProject = parse("project.json");
  const { languages, warnings, error } = buildLanguages(rawProject, options);
  const roots = localisedRoots(languages.settings, parse(AUDIO_PROJECT_FILE));
  const tables = copies.filter((p) => stringsPathKind(p) !== null);
  const opted = (isRecord(rawProject) && rawProject.languages !== undefined) || tables.length > 0;
  const generated = new Map<string, string>();
  let kept = copies.filter((p) => shipsVariant(p, roots, languages));
  if (!opted || error) return { languages, copies: kept, generated, manifest: null, warnings, error };

  // String files, one per shipped language (and the reference's for the pseudo-languages, which format it).
  const messages = new ProjectStrings(tables.map((p) => [p, parse(p)] as const));
  const failed: { key: string; code: string; why: string }[] = [];
  const source = checkedSource(languages.settings, messages, failed);
  const written = [...languages.codes];
  if (languages.pseudo && !written.includes(languages.settings.reference)) written.push(languages.settings.reference);
  const strings: Record<string, { url: string; bytes: number }> = {};
  const encoder = new TextEncoder();
  for (const code of written) {
    const { file, fellBack } = buildStringsFile(languages.settings, code, source);
    const text = formatBuildStrings(file);
    generated.set(stringsFileOf(code), text);
    strings[code] = { url: stringsFileOf(code), bytes: encoder.encode(text).length };
    if (fellBack.length > 0) {
      const describe = fellBack.map((f) => `${f.key} (${f.from ?? "missing"})`);
      warnings.push(`strings/${code}.json: ${fellBack.length} key${fellBack.length === 1 ? "" : "s"} fell back to another language: ${listSome(describe)}.`);
    }
  }
  for (const f of failed) warnings.push(`strings: the ${f.code} translation of "${f.key}" fails the checks (${f.why}); its fallback ships instead.`);
  // The tables and translations themselves don't ship (notes, status, sources and examples never do).
  kept = kept.filter((p) => stringsPathKind(p) === null);

  // Fonts of the shipped languages that the build ships.
  const fonts: Record<string, string[]> = {};
  const shipped = new Set(kept);
  for (const code of languages.codes) {
    const list = (languageOf(languages.settings, code)?.fonts ?? []).map((f) => f.trim().replace(/^\.?\//, "")).filter((f) => shipped.has(f));
    if (list.length) fonts[code] = list.map((f) => `${projectFile.slice(0, projectFile.length - "project.json".length)}${f}`);
  }

  // The build's project.json lists only what it ships: every other language is marked ship: false.
  const listed = languages.settings.list.filter((l) => l.ship).map((l) => l.code);
  if (listed.some((c) => !languages.codes.includes(c)) && isRecord(rawProject) && isRecord(rawProject.languages) && Array.isArray(rawProject.languages.list)) {
    const list = rawProject.languages.list.map((row) => {
      const r = typeof row === "string" ? { code: row } : row;
      if (!isRecord(r) || typeof r.code !== "string") return row;
      const def = languageOf(languages.settings, r.code);
      return def && !languages.codes.includes(def.code) ? { ...r, ship: false } : r;
    });
    generated.set(projectFile, `${JSON.stringify({ ...rawProject, languages: { ...rawProject.languages, list } }, null, 2)}\n`);
  }

  const manifest: LocalisationManifest = { strings, fonts, ...(languages.pseudo ? { pseudo: true as const } : {}) };
  return { languages, copies: kept, generated, manifest, warnings, error };
}
