/**
 * Where the `Locale` runtime's messages come from (ADR 0356 §6, §11): a string-table registry over the project's
 * `*.strings.json` tables and their translations (the editor's Play and the Studio, which hold every project file), or
 * the build's `strings/<code>.json` files, one per shipped language, each loaded when its language becomes current.
 *
 * Both answer one question, `message(key, code)`: the message `key` has in language `code`, as written. Fallback
 * chains, parsing and formatting are `Locale`'s. Nothing here is public API.
 */
import { stringsPathKind, parseStringTable } from "../strings/format";
import { parseTranslation } from "../strings/translation";
import { parseBuildStrings } from "./buildFile";

/** The messages `Locale` resolves keys in. */
export interface LocaleStrings {
  /** True: pseudo-languages may be chosen (project strings: the editor and the Studio; a `--pseudo` build). */
  readonly pseudo: boolean;
  /** Make `code`'s messages available (a build fetches its file); rejects when they can't load. */
  load(code: string): Promise<void>;
  /** The message `key` has in `code` as written, or undefined when that language has none (or isn't loaded). */
  message(key: string, code: string): string | undefined;
  /**
   * The language `code`'s message for `key` is written in, when it isn't `code` (a build file holds its fallbacks, ADR
   * 0391): its plural and number rules format it. Absent or undefined: `code`.
   */
  sourceOf?(key: string, code: string): string | undefined;
  /** Every key there is a message for, in table order (a build: the loaded languages' keys). */
  keys(): Iterable<string>;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[myco] ${message}`);
}

interface KeyEntry {
  readonly table: string;
  readonly language: string;
  readonly text: string;
}

/** No messages at all (before a project is configured, and headless runs without tables). */
export const noStrings: LocaleStrings = {
  pseudo: false,
  load: () => Promise.resolve(),
  message: () => undefined,
  keys: () => [],
};

/**
 * The project's string tables and translations as a registry (ADR 0356 §1): keys are unique across the project, so the
 * first table in path order that has a key owns it (a later one is warned about once and ignored); a translation file
 * gives its table's keys in its language (`translated` and `needsReview` entries alike: a translation that needs review
 * is still better than a fallback). Problems in the files are warned about once each.
 */
export class ProjectStrings implements LocaleStrings {
  readonly pseudo = true;
  private readonly entries = new Map<string, KeyEntry>();
  /** Lower-case language code → key → text. */
  private readonly translations = new Map<string, Map<string, string>>();

  /** `files`: project paths and their parsed JSON; paths that aren't string tables or translations are skipped. */
  constructor(files: Iterable<readonly [string, unknown]>) {
    const tables: [string, unknown][] = [];
    const translations: [string, unknown, string][] = [];
    for (const [path, value] of files) {
      const kind = stringsPathKind(path);
      if (kind?.kind === "table") tables.push([path, value]);
      else if (kind?.kind === "translation") translations.push([path, value, kind.table]);
    }
    tables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [path, value] of tables) {
      const { table, problems } = parseStringTable(value, path);
      for (const p of problems) warnOnce(p);
      for (const e of table.strings) {
        const owner = this.entries.get(e.key);
        if (owner) {
          warnOnce(`${path}: the key "${e.key}" is also in ${owner.table}; using ${owner.table}'s.`);
          continue;
        }
        this.entries.set(e.key, { table: path, language: table.language, text: e.text });
      }
    }
    translations.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [path, value, tablePath] of translations) {
      const { translation, problems } = parseTranslation(value, path);
      for (const p of problems) warnOnce(p);
      if (!tables.some(([t]) => t === tablePath)) {
        warnOnce(`${path}: there's no table ${tablePath} for this translation; it is never used.`);
        continue;
      }
      const code = translation.language.toLowerCase();
      let map = this.translations.get(code);
      if (!map) this.translations.set(code, (map = new Map()));
      for (const [key, entry] of Object.entries(translation.strings)) {
        if (this.entries.get(key)?.table !== tablePath) continue; // not this table's key (or owned by an earlier table)
        map.set(key, entry.text);
      }
    }
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  message(key: string, code: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.language.toLowerCase() === code.toLowerCase()) return entry.text;
    return this.translations.get(code.toLowerCase())?.get(key);
  }

  keys(): Iterable<string> {
    return this.entries.keys();
  }
}

/**
 * A build's string files (ADR 0356 §11): `strings/<code>.json` per shipped language, each complete on its own (the
 * export resolved every key through that language's chain), fetched by `fetchFile` when the language is loaded.
 */
export class BuildStrings implements LocaleStrings {
  private readonly loaded = new Map<string, Map<string, string>>();
  /** Lower-case language code → key → the language its message is written in, where that differs (ADR 0391). */
  private readonly sources = new Map<string, Map<string, string>>();
  private readonly loading = new Map<string, Promise<void>>();

  /**
   * `fetchFile(code)`: the parsed `strings/<code>.json` of a language, or null when the build has none for it (its keys
   * then fall back through the chain). `pseudo`: the build holds the pseudo-languages (`--pseudo`).
   */
  constructor(private readonly fetchFile: (code: string) => Promise<unknown | null>, readonly pseudo = false) {}

  load(code: string): Promise<void> {
    const lower = code.toLowerCase();
    if (this.loaded.has(lower)) return Promise.resolve();
    let p = this.loading.get(lower);
    if (!p) {
      p = this.fetchFile(code).then(
        (raw) => {
          this.loading.delete(lower);
          if (raw === null) {
            this.loaded.set(lower, new Map());
            return;
          }
          const { file, problems } = parseBuildStrings(raw, `strings/${code}.json`);
          for (const problem of problems) warnOnce(problem);
          this.loaded.set(lower, new Map(Object.entries(file.strings)));
          this.sources.set(lower, new Map(Object.entries(file.sources)));
        },
        (err: unknown) => {
          this.loading.delete(lower);
          throw err;
        },
      );
      this.loading.set(lower, p);
    }
    return p;
  }

  message(key: string, code: string): string | undefined {
    return this.loaded.get(code.toLowerCase())?.get(key);
  }

  sourceOf(key: string, code: string): string | undefined {
    return this.sources.get(code.toLowerCase())?.get(key);
  }

  *keys(): Iterable<string> {
    const seen = new Set<string>();
    for (const map of this.loaded.values()) {
      for (const k of map.keys()) {
        if (seen.has(k)) continue;
        seen.add(k);
        yield k;
      }
    }
  }
}
