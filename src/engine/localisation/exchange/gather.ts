/**
 * Key gathering (ADR 0356 §7, Unreal's text gathering run as a report): where each string key is used in a project,
 * and the report lists built from it.
 *
 * **Uses** come from:
 * - UI documents (`*.ui.xml`): `t:<field>="key"` attributes; a key with `{name}` bindings (`weapon.{id}.name`) is a
 *   template, which covers every key it matches;
 * - scripts (`.ts`, `.js`, …): literal first arguments of `Locale.t(…)`, `Locale.text(…)` and `Locale.has(…)`, found by
 *   a text search (best effort: a key built at runtime isn't seen);
 * - line tables (`*.lines.json`, 0357 §1): each line's subtitle key (its `textKey`, else its key; `null`: none);
 * - playlists (`*.playlist.json`, 0357 §4): the caption's key.
 *
 * **Lists:** keys used but defined in no table (`undefinedKeys`), keys defined but never used (`unused`), translations
 * missing per key in the shipped languages (`missing`, with whether the key is used) and needing review
 * (`needsReview`), per-language counts, keys defined in two tables (`duplicates`), and **unkeyed text**: literal text
 * in UI documents (a `Text`'s or `Button`'s content, an `InputField`'s value, `text` and `placeholder` attributes),
 * with letters in it, not marked `translate="no"` (on the element or an ancestor), and not bound to a key; dismissed
 * ones (`.myco/localisation-ignore.json`, by `unkeyedId`) are left out.
 *
 * Scenes and prefabs aren't read: game UI is built only from UI documents (ADR 0417), so a scene holds no UI text.
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
import { hasBinding, parseBindings, parseMarkup } from "../../ui/document/markup";
import type { MarkupElement } from "../../ui/document/types";

export type KeyUseKind = "document" | "script" | "line" | "caption";

/** One place a key is used. */
export interface KeyUse {
  /** The key as written (a template keeps its `{name}` parts). */
  readonly key: string;
  readonly path: string;
  readonly kind: KeyUseKind;
  /** Where in the file: `#id` or the element's tag for a document, `line 3` for a script, the line key for a line table. */
  readonly where: string;
  /** A key with `{name}` bindings, covering every key it matches. */
  readonly template: boolean;
}

/** A key a table defines. */
export interface DefinedKey {
  readonly key: string;
  readonly table: string;
  readonly text: string;
}

/** Literal text that isn't bound to a key. */
export interface UnkeyedText {
  readonly path: string;
  /** The field it sets (`text`, `placeholder`, `value`). */
  readonly field: string;
  readonly text: string;
  /** `#id` or the element's tag. */
  readonly where: string;
  /** The element's id, when it has one (Extract to string table suggests a key from it). */
  readonly id: string | null;
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
  readonly unkeyed: readonly UnkeyedText[];
  /** Per shipped language other than the reference. */
  readonly counts: Readonly<Record<string, LanguageCounts>>;
}

export interface GatherInput {
  /** Project files by path: parsed JSON for `.json` files, text for text files (`.ui.xml`, scripts). */
  readonly files: Iterable<readonly [string, unknown]>;
  readonly languages: LanguageSettings;
  /** Dismissed unkeyed text, by `unkeyedId`. */
  readonly ignore?: readonly string[];
}

/** The id a dismissal of unkeyed text is kept under: its file, where and field, and the text. */
export const unkeyedId = (u: Pick<UnkeyedText, "path" | "where" | "field" | "text">): string => `${u.path}|${u.where}|${u.field}|${u.text}`;

const SCRIPT = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/i;
const LOCALE_CALL = /\bLocale\s*\.\s*(?:t|text|has)\s*\(\s*(["'`])([A-Za-z0-9_.{}-]{1,128})\1/g;

/** A key template (`weapon.{id}.name`) as a pattern over keys. */
function templatePattern(key: string): RegExp {
  const source = parseBindings(key).map((p) => ("binding" in p ? "[A-Za-z0-9_.-]+" : p.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`);
}

const hasLetters = (text: string): boolean => /\p{L}/u.test(parseBindings(text).map((p) => ("text" in p ? p.text : "")).join(""));

function documentUses(path: string, source: string, read: (p: string) => string | null, uses: KeyUse[], unkeyed: UnkeyedText[]): void {
  const markup = parseMarkup(source, path, read);
  const walk = (el: MarkupElement, noTranslate: boolean) => {
    if (el.file !== path) return; // a used document reports its own
    const id = el.attributes.find((a) => a.name === "id")?.value ?? null;
    const where = id ? `#${id}` : el.tag;
    const off = noTranslate || el.attributes.some((a) => a.name === "translate" && a.value.trim().toLowerCase() === "no");
    const keyed = new Set<string>();
    for (const a of el.attributes) {
      if (!a.name.startsWith("t:") || a.name.length <= 2) continue;
      keyed.add(a.name.slice(2));
      const key = a.value.trim();
      if (key) uses.push({ key, path, kind: "document", where, template: hasBinding(key) });
    }
    if (!off) {
      const contentField = el.tag === "InputField" ? "value" : "text";
      const literal = (field: string, text: string | null | undefined) => {
        if (!text || keyed.has(field) || !hasLetters(text)) return;
        unkeyed.push({ path, field, text, where, id });
      };
      const textAttr = el.attributes.find((a) => a.name === contentField)?.value;
      literal(contentField, textAttr ?? el.text);
      if (el.tag === "InputField") literal("placeholder", el.attributes.find((a) => a.name === "placeholder")?.value);
    }
    for (const c of el.children) walk(c, off);
    if (el.template) walk(el.template, off);
  };
  if (markup.root) walk(markup.root, false);
}

function scriptUses(path: string, text: string, uses: KeyUse[]): void {
  for (const m of text.matchAll(LOCALE_CALL)) {
    const line = text.slice(0, m.index).split("\n").length;
    const key = m[2];
    if (m[1] === "`" && key.includes("${")) continue;
    uses.push({ key, path, kind: "script", where: `line ${line}`, template: false });
  }
}

function lineTableUses(path: string, json: unknown, uses: KeyUse[]): void {
  if (!isRecord(json) || !Array.isArray(json.lines)) return;
  for (const l of json.lines) {
    if (!isRecord(l) || typeof l.key !== "string") continue;
    const key = l.textKey === null ? null : typeof l.textKey === "string" && l.textKey.trim() ? l.textKey.trim() : l.key;
    if (key) uses.push({ key, path, kind: "line", where: l.key, template: false });
  }
}

function captionUses(path: string, json: unknown, uses: KeyUse[]): void {
  if (isRecord(json) && isRecord(json.caption) && typeof json.caption.key === "string" && json.caption.key.trim()) {
    uses.push({ key: json.caption.key.trim(), path, kind: "caption", where: "caption", template: false });
  }
}

/** Gather every key use and the report lists over the project's files. */
export function gatherKeys(input: GatherInput): GatherReport {
  const files = new Map<string, unknown>();
  for (const [p, v] of input.files) files.set(p, v);
  const read = (p: string): string | null => {
    const v = files.get(p);
    return typeof v === "string" ? v : null;
  };
  const paths = [...files.keys()].sort();
  const uses: KeyUse[] = [];
  const unkeyed: UnkeyedText[] = [];
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
    } else if (lower.endsWith(".ui.xml") && typeof value === "string") documentUses(path, value, read, uses, unkeyed);
    else if (lower.endsWith(".lines.json")) lineTableUses(path, value, uses);
    else if (lower.endsWith(".playlist.json")) captionUses(path, value, uses);
    else if (SCRIPT.test(path) && !lower.endsWith(".d.ts") && typeof value === "string") scriptUses(path, value, uses);
  }

  const definedKeys = new Set(defined.map((d) => d.key));
  const templates = uses.filter((u) => u.template).map((u) => templatePattern(u.key));
  const plainUsed = new Set(uses.filter((u) => !u.template).map((u) => u.key));
  const isUsed = (key: string) => plainUsed.has(key) || templates.some((t) => t.test(key));

  const undefinedMap = new Map<string, KeyUse[]>();
  for (const u of uses) {
    const known = u.template ? defined.some((d) => templatePattern(u.key).test(d.key)) : definedKeys.has(u.key);
    if (known) continue;
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

  const ignored = new Set(input.ignore ?? []);
  return {
    defined,
    uses,
    undefinedKeys: [...undefinedMap].map(([key, list]) => ({ key, uses: list })),
    unused: defined.filter((d) => !isUsed(d.key)),
    missing,
    needsReview,
    duplicates: [...owners].filter(([, t]) => t.length > 1).map(([key, tables]) => ({ key, tables })),
    unkeyed: unkeyed.filter((u) => !ignored.has(unkeyedId(u))),
    counts,
  };
}
