/**
 * Key gathering (ADR 0356 §7, Unreal's text gathering run as a report): where each string key is used in a project,
 * and the report lists built from it.
 *
 * **Uses** come from:
 * - Svelte UI (`*.svelte` components and `*.svelte.ts` rune modules, ADR 0419): literal first arguments of `t(…)` and
 *   `tHtml(…)` (the `myco` imports), and of `Locale.t(…)`, `Locale.text(…)` and `Locale.has(…)`;
 * - scripts (`.ts`, `.js`, …): literal first arguments of `Locale.t(…)`, `Locale.text(…)` and `Locale.has(…)`;
 * - line tables (`*.lines.json`, 0357 §1): each line's subtitle key (its `textKey`, else its key; `null`: none);
 * - playlists (`*.playlist.json`, 0357 §4): the caption's key.
 *
 * Code is read by a text search (best effort: a key built at runtime isn't seen).
 *
 * **Lists:** keys used but defined in no table (`undefinedKeys`), keys defined but never used (`unused`), translations
 * missing per key in the shipped languages (`missing`, with whether the key is used) and needing review
 * (`needsReview`), per-language counts, and keys defined in two tables (`duplicates`).
 *
 * Scenes and prefabs aren't read: game UI is built only from Svelte components (ADR 0417, 0419), so a scene holds no UI
 * text. ADR 0419 retired UI documents, and with them the `t:` attributes and the unkeyed-text list read from their markup.
 *
 * Localisation is engine-level and imports nothing from audio: line tables and playlists are read here for the one or
 * two fields gathering needs.
 *
 * Pure; no plugin, no DOM.
 */
import { shippedLanguages, type LanguageSettings } from "../languages";
import { isRecord } from "../lenient";
import { parseStringTable, stringsPathKind } from "../strings/format";
import { effectiveStatus, parseTranslation, type TranslationFile } from "../strings/translation";

export type KeyUseKind = "component" | "script" | "line" | "caption";

/** One place a key is used. */
export interface KeyUse {
  readonly key: string;
  readonly path: string;
  readonly kind: KeyUseKind;
  /** Where in the file: `line 3` for a component or script, the line key for a line table. */
  readonly where: string;
}

/** A key a table defines. */
export interface DefinedKey {
  readonly key: string;
  readonly table: string;
  readonly text: string;
}

export interface LanguageCounts {
  translated: number;
  needsReview: number;
  missing: number;
}

export interface GatherReport {
  readonly defined: readonly DefinedKey[];
  readonly uses: readonly KeyUse[];
  readonly undefinedKeys: readonly { readonly key: string; readonly uses: readonly KeyUse[] }[];
  readonly unused: readonly DefinedKey[];
  readonly missing: readonly { readonly key: string; readonly table: string; readonly languages: readonly string[]; readonly used: boolean }[];
  readonly needsReview: readonly { readonly key: string; readonly table: string; readonly languages: readonly string[] }[];
  readonly duplicates: readonly { readonly key: string; readonly tables: readonly string[] }[];
  /** Per shipped language other than the reference. */
  readonly counts: Readonly<Record<string, LanguageCounts>>;
}

export interface GatherInput {
  /** Project files by path: parsed JSON for `.json` files, text for text files (components, scripts). */
  readonly files: Iterable<readonly [string, unknown]>;
  readonly languages: LanguageSettings;
}

const SCRIPT = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/i;
const LOCALE_CALL = /\bLocale\s*\.\s*(?:t|text|has)\s*\(\s*(["'`])([A-Za-z0-9_.{}-]{1,128})\1/g;
/** Svelte UI (ADR 0419): `myco`'s reactive `t(…)` and `tHtml(…)`, not as a member (`x.t(…)`) or part of a longer name. */
const UI_CALL = /(?<![\w$.])(?:t|tHtml)\s*\(\s*(["'`])([A-Za-z0-9_.{}-]{1,128})\1/g;
const UI_CODE = /\.svelte$|\.svelte\.(ts|js)$/i;

function scriptUses(path: string, text: string, kind: KeyUseKind, uses: KeyUse[]): void {
  const found: { index: number; key: string }[] = [];
  for (const pattern of kind === "component" ? [LOCALE_CALL, UI_CALL] : [LOCALE_CALL]) {
    for (const m of text.matchAll(pattern)) {
      if (m[1] === "`" && m[2].includes("${")) continue;
      found.push({ index: m.index, key: m[2] });
    }
  }
  for (const f of found.sort((a, b) => a.index - b.index)) uses.push({ key: f.key, path, kind, where: `line ${text.slice(0, f.index).split("\n").length}` });
}

function lineTableUses(path: string, json: unknown, uses: KeyUse[]): void {
  if (!isRecord(json) || !Array.isArray(json.lines)) return;
  for (const l of json.lines) {
    if (!isRecord(l) || typeof l.key !== "string") continue;
    const key = l.textKey === null ? null : typeof l.textKey === "string" && l.textKey.trim() ? l.textKey.trim() : l.key;
    if (key) uses.push({ key, path, kind: "line", where: l.key });
  }
}

function captionUses(path: string, json: unknown, uses: KeyUse[]): void {
  if (isRecord(json) && isRecord(json.caption) && typeof json.caption.key === "string" && json.caption.key.trim()) {
    uses.push({ key: json.caption.key.trim(), path, kind: "caption", where: "caption" });
  }
}

/** Gather every key use and the report lists over the project's files. */
export function gatherKeys(input: GatherInput): GatherReport {
  const files = new Map<string, unknown>();
  for (const [p, v] of input.files) files.set(p, v);
  const paths = [...files.keys()].sort();
  const uses: KeyUse[] = [];
  const defined: DefinedKey[] = [];
  const owners = new Map<string, string[]>();
  const translations = new Map<string, TranslationFile[]>(); // table → its translations
  for (const path of paths) {
    const value = files.get(path);
    const lower = path.toLowerCase();
    const kind = stringsPathKind(path);
    if (kind?.kind === "table") {
      for (const e of parseStringTable(value, path).table.strings) {
        const list = owners.get(e.key) ?? [];
        list.push(path);
        owners.set(e.key, list);
        if (list.length === 1) defined.push({ key: e.key, table: path, text: e.text });
      }
    } else if (kind?.kind === "translation") {
      const list = translations.get(kind.table) ?? [];
      list.push(parseTranslation(value, path).translation);
      translations.set(kind.table, list);
    } else if (UI_CODE.test(path) && typeof value === "string") scriptUses(path, value, "component", uses);
    else if (lower.endsWith(".lines.json")) lineTableUses(path, value, uses);
    else if (lower.endsWith(".playlist.json")) captionUses(path, value, uses);
    else if (SCRIPT.test(path) && !lower.endsWith(".d.ts") && typeof value === "string") scriptUses(path, value, "script", uses);
  }

  const definedKeys = new Set(defined.map((d) => d.key));
  const used = new Set(uses.map((u) => u.key));
  const isUsed = (key: string) => used.has(key);

  const undefinedMap = new Map<string, KeyUse[]>();
  for (const u of uses) {
    if (definedKeys.has(u.key)) continue;
    const list = undefinedMap.get(u.key) ?? [];
    list.push(u);
    undefinedMap.set(u.key, list);
  }

  const reference = input.languages.reference;
  const targets = shippedLanguages(input.languages).map((l) => l.code).filter((c) => c !== reference);
  const counts: Record<string, LanguageCounts> = Object.fromEntries(targets.map((c) => [c, { translated: 0, needsReview: 0, missing: 0 }]));
  const missing: GatherReport["missing"][number][] = [];
  const needsReview: GatherReport["needsReview"][number][] = [];
  for (const d of defined) {
    const trs = translations.get(d.table) ?? [];
    const miss: string[] = [];
    const review: string[] = [];
    for (const code of targets) {
      const tr = trs.find((t) => t.language.toLowerCase() === code.toLowerCase());
      const status = effectiveStatus(tr?.strings[d.key], d.text);
      counts[code][status]++;
      if (status === "missing") miss.push(code);
      else if (status === "needsReview") review.push(code);
    }
    if (miss.length) missing.push({ key: d.key, table: d.table, languages: miss, used: isUsed(d.key) });
    if (review.length) needsReview.push({ key: d.key, table: d.table, languages: review });
  }

  return {
    defined,
    uses,
    undefinedKeys: [...undefinedMap].map(([key, list]) => ({ key, uses: list })),
    unused: defined.filter((d) => !isUsed(d.key)),
    missing,
    needsReview,
    duplicates: [...owners].filter(([, t]) => t.length > 1).map(([key, tables]) => ({ key, tables })),
    counts,
  };
}
