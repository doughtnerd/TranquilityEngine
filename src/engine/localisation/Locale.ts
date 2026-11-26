/**
 * The text localisation runtime (ADR 0356 §6): `Locale`, the script API over string tables. A key resolves through the
 * current language's fallback chain (0354 §1) to an ICU MessageFormat 1 message, formatted on `Intl` with the
 * language's `intl` tag. `LocalText` is a key and arguments resolved when read, so text built from it follows language
 * changes.
 *
 * Like `Storage` and `Graphics`, `Locale` belongs to the player and the process, not to a World: every World shows the
 * same language. The Engine configures it from `project.json`'s `languages` when it boots (`configureLocale`): the
 * strings come from the project's tables in the editor's Play and the Studio, from the build's `strings/<code>.json`
 * files in a build; the start language is the player's remembered one, else the best system match, else the default.
 *
 * A switch is atomic: `setLanguage` loads the language's strings and runs the language participants (fonts, voice)
 * first, then changes `language`, raises `epoch` and calls the `onChange` listeners in one go, then remembers it.
 *
 * Engine-native types and standard `Intl` option types only (ADR 0010).
 */
import { Storage } from "../platform/Storage";
import { canonicalLanguageCode, defaultLanguages, fallbackChain, intlTagOf, languageOf, lookupLanguage, shippedLanguages, type LanguageSettings, type TextDirection } from "./languages";
import type { MessageNode, MessageParse } from "./message/ast";
import { formatMessage, formatMessageText } from "./message/format";
import { parseMessage } from "./message/parse";
import { accentMessage, isPseudoLanguage, PSEUDO_MIRRORED_LANGUAGE, pseudoWrap } from "./pseudo";
import { prepareParticipants } from "./runtime/participants";
import { localiseAssets } from "./runtime/assets";
import { noStrings, type LocaleStrings } from "./runtime/strings";

/** A value a message argument takes; a `LocalText` formats as its current string. */
export type MessageArg = string | number | bigint | boolean | Date | LocalText | null | undefined;
export type MessageArgs = Readonly<Record<string, MessageArg>>;

/** A shipped language, as `Locale.languages` lists it. */
export interface LocaleLanguage {
  readonly code: string;
  /** Its name in itself (`Français`), for a language menu. */
  readonly name: string;
  /** The languages its keys fall back to, in order (its own list, then the project's). */
  readonly fallback: readonly string[];
  readonly direction: "ltr" | "rtl";
}

/** What `Locale.onChange` listeners hear. */
export interface LocaleChange {
  readonly language: string;
  readonly previous: string;
}

/** `Locale.debug()`: for the profiler and tests. */
export interface LocaleDebug {
  readonly language: string;
  readonly pending: string | null;
  /** The last 64 keys that fell back to a later language, or were missing everywhere, with the language asked for. */
  readonly missing: readonly { readonly key: string; readonly language: string }[];
}

/** The player storage key (namespace `settings`) holding the player's language (ADR 0317, 0356 §6). */
export const LOCALE_STORAGE_KEY = "myco.locale.language";

const MISSING_KEPT = 64;

// --- state -----------------------------------------------------------------------------------------------------------

let settings: LanguageSettings = defaultLanguages();
let strings: LocaleStrings = noStrings;
let current = settings.default;
let pending: string | null = null;
let epoch = 0;
let remember = false;
/** Bumped by every switch and configuration: a switch whose number is no longer the latest was superseded. */
let switchSeq = 0;
let shipped: readonly LocaleLanguage[] = languagesOf(settings);
let chainCache: { epoch: number; chain: readonly string[] } | null = null;
const listeners = new Set<(e: LocaleChange) => void>();
const missing: { key: string; language: string }[] = [];
const parsed = new Map<string, MessageParse>();
const accented = new WeakMap<readonly MessageNode[], MessageNode[]>();
const names = new WeakMap<readonly MessageNode[], readonly string[]>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

function languagesOf(s: LanguageSettings): readonly LocaleLanguage[] {
  return Object.freeze(shippedLanguages(s).map((l) => Object.freeze({ code: l.code, name: l.name, fallback: Object.freeze(fallbackChain(s, l.code).slice(1)), direction: l.direction })));
}

const isPseudo = (code: string): boolean => isPseudoLanguage(code);

/** The shipped language (or allowed pseudo-language) `code` names, as it is written there; null when none. */
function knownCode(code: string): string | null {
  if (typeof code !== "string") return null;
  if (isPseudo(code)) return strings.pseudo ? code.toLowerCase() : null;
  const canonical = canonicalLanguageCode(code.trim()) ?? code;
  const lower = canonical.toLowerCase();
  return shipped.find((l) => l.code.toLowerCase() === lower)?.code ?? null;
}

/** The language whose fonts, `intl` tag and text `code` uses: a pseudo-language uses the reference language's. */
const baseOf = (code: string): string => (isPseudo(code) ? settings.reference : code);

/** The languages a key is looked up in, in order, for the current language. */
function chain(): readonly string[] {
  if (chainCache?.epoch !== epoch) {
    const list = isPseudo(current) ? [current, ...fallbackChain(settings, settings.reference)] : fallbackChain(settings, current);
    chainCache = { epoch, chain: list };
  }
  return chainCache.chain;
}

function parse(text: string): MessageParse {
  let p = parsed.get(text);
  if (!p) parsed.set(text, (p = parseMessage(text)));
  return p;
}

interface Resolved {
  readonly ast: readonly MessageNode[];
  /** The language the message is written in. */
  readonly code: string;
}

/** The message `key` resolves to now: the first language of the chain with one that parses; null when none. */
function resolve(key: string, record: boolean): Resolved | null {
  const list = chain();
  for (const code of list) {
    const text = strings.message(key, code);
    if (text === undefined) continue;
    const p = parse(text);
    if (p.problems.some((x) => x.severity === "error")) {
      warnOnce(`malformed|${key}|${code}`, `The "${code}" message of "${key}" is malformed (${p.problems.find((x) => x.severity === "error")!.message}); using the next language.`);
      continue;
    }
    // A build file holds its language's fallbacks and names the language each is written in (ADR 0391).
    const written = strings.sourceOf?.(key, code) ?? code;
    if (record && written !== list[0] && !(isPseudo(current) && written === list[1])) noteMissing(key);
    return { ast: p.ast, code: written };
  }
  if (record) noteMissing(key);
  return null;
}

function noteMissing(key: string): void {
  const i = missing.findIndex((m) => m.key === key && m.language === current);
  if (i >= 0) missing.splice(i, 1);
  missing.push({ key, language: current });
  if (missing.length > MISSING_KEPT) missing.shift();
}

function intlTag(code: string): string {
  return intlTagOf(settings, baseOf(code));
}

function format(key: string, r: Resolved, args: MessageArgs | null | undefined): string {
  const pseudo = isPseudo(current);
  let ast = r.ast;
  if (pseudo) {
    let a = accented.get(ast);
    if (!a) accented.set(ast, (a = accentMessage(ast)));
    ast = a;
  }
  const out = formatMessage(ast, args, intlTag(r.code), (name) => warnOnce(`arg|${key}|${name}`, `The message "${key}" uses {${name}}, but no value was given for it; it shows as {${name}}.`));
  return pseudo ? pseudoWrap(out, current) : out;
}

function t(key: string, args?: MessageArgs | null): string {
  const r = resolve(key, true);
  if (!r) {
    warnOnce(`missing|${key}`, `There's no text for the key "${key}" in "${current}" or any language it falls back to; showing the key.`);
    return key;
  }
  return format(key, r, args);
}

const intlCache = new Map<string, unknown>();

/** A cached `Intl` object for the current language; the runtime's default locale when the tag is refused, plain options when the options are. */
function intlOf<T>(kind: string, make: (tag: string | undefined, options: object) => T, options: object = {}): T {
  const tag = intlTag(current);
  const key = `${kind}|${tag}|${JSON.stringify(options)}`;
  let v = intlCache.get(key) as T | undefined;
  if (v === undefined) {
    for (const [tg, o] of [[tag, options], [undefined, options], [tag, {}], [undefined, {}]] as const) {
      try {
        v = make(tg, o);
        break;
      } catch {
        /* next */
      }
    }
    intlCache.set(key, v);
  }
  return v!;
}

function notify(previous: string): void {
  const e: LocaleChange = Object.freeze({ language: current, previous });
  for (const fn of [...listeners]) {
    try {
      fn(e);
    } catch (err) {
      console.error("[myco] A Locale.onChange listener threw:", err);
    }
  }
}

/** Load what `code` needs: its strings (the reference language's too, for a pseudo-language) and the participants'. */
async function loadLanguage(code: string): Promise<void> {
  const loads = [strings.load(code)];
  if (isPseudo(code)) loads.push(strings.load(settings.reference));
  await Promise.all([...loads, prepareParticipants(baseOf(code))]);
}

// --- the public API --------------------------------------------------------------------------------------------------

/**
 * A key and arguments, resolved when read (Unreal's `FText`): `toString()` is `Locale.t(key, args)` in the current
 * language. `ui.data.title = Locale.text("quest.title", { name })` shows the title and follows language changes.
 */
export class LocalText {
  readonly key: string;
  readonly args: MessageArgs | null;
  private cache: { epoch: number; text: string } | null = null;

  constructor(key: string, args: MessageArgs | null = null) {
    this.key = key;
    this.args = args ? Object.freeze({ ...args }) : null;
  }

  /** The same key with these arguments over its own. */
  with(args: MessageArgs): LocalText {
    return new LocalText(this.key, { ...this.args, ...args });
  }

  /** The message in the current language (cached until the language or the tables change). */
  toString(): string {
    if (this.cache?.epoch !== epoch) this.cache = { epoch, text: t(this.key, this.args) };
    return this.cache.text;
  }
}

/**
 * Localised text and formatting (ADR 0356 §6). `Locale.t("menu.start")` is the message in the current language, the key
 * itself (with one warning) when no language of its chain has it; `Locale.setLanguage("fr")` switches every text.
 */
export const Locale = {
  /** The current text language. */
  get language(): string {
    return current;
  },

  /** The language a switch in progress is loading, else null. */
  get pendingLanguage(): string | null {
    return pending;
  },

  /** The shipped languages, in `project.json`'s order. */
  get languages(): readonly LocaleLanguage[] {
    return shipped;
  },

  /** The current language's text direction. */
  get direction(): "ltr" | "rtl" {
    return directionOf(current);
  },

  /** Rises whenever resolved text can change: a language switch, a table edit in the editor, hot reload. */
  get epoch(): number {
    return epoch;
  },

  /**
   * Switch to a shipped language: its strings and fonts load first, then `language`, `epoch` and the `onChange`
   * listeners change together, and the choice is remembered for the next start (when the project remembers it). An
   * unknown or unshipped code rejects with one warning and changes nothing; a later switch supersedes this one (which
   * then resolves without switching).
   */
  setLanguage(code: string): Promise<void> {
    const target = knownCode(code);
    if (target === null) {
      const message = `Locale.setLanguage("${code}"): that isn't a shipped language (${shipped.map((l) => l.code).join(", ")}).`;
      console.warn(`[myco] ${message}`);
      return Promise.reject(new Error(message));
    }
    const seq = ++switchSeq;
    pending = target;
    return loadLanguage(target).then(
      () => {
        if (seq !== switchSeq) return; // superseded
        const previous = current;
        current = target;
        pending = null;
        epoch++;
        localiseAssets(settings, current); // ADR 0356 §10: textures and fonts follow in the same step
        notify(previous);
        if (remember && settings.remember) Storage.save(LOCALE_STORAGE_KEY, target, "settings").catch((err: unknown) => console.warn(`[myco] Couldn't remember the language "${target}":`, err));
      },
      (err: unknown) => {
        if (seq === switchSeq) pending = null;
        console.warn(`[myco] Locale.setLanguage("${target}"): its strings couldn't load (${(err as Error)?.message ?? err}); keeping "${current}".`);
        throw err;
      },
    );
  },

  /** The message of `key` in the current language, with `args`; the key itself (warned once) when it is missing. */
  t(key: string, args?: MessageArgs): string {
    return t(key, args);
  },

  /** `key` and `args` as a `LocalText`, which resolves in whatever language is current when it is read. */
  text(key: string, args?: MessageArgs): LocalText {
    return new LocalText(key, args ?? null);
  },

  /** True when a language of the current chain has a message for `key`. */
  has(key: string): boolean {
    return resolve(key, false) !== null;
  },

  /** An ICU message written at runtime (mod data, a server's text), formatted in the current language. */
  format(message: string, args?: MessageArgs): string {
    return formatMessageText(message, args, intlTag(current), (name) => warnOnce(`fmt|${message}|${name}`, `Locale.format: the message uses {${name}}, but no value was given for it.`));
  },

  formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string {
    try {
      return intlOf("n", (tag, o) => new Intl.NumberFormat(tag, o), options).format(value);
    } catch {
      return String(value);
    }
  },

  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    try {
      return intlOf("d", (tag, o) => new Intl.DateTimeFormat(tag, o), options).format(value);
    } catch {
      return String(value);
    }
  },

  formatList(items: readonly string[], options?: Intl.ListFormatOptions): string {
    try {
      return intlOf("l", (tag, o) => new Intl.ListFormat(tag, o), options).format(items);
    } catch {
      return items.join(", ");
    }
  },

  formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string {
    try {
      return intlOf("r", (tag, o) => new Intl.RelativeTimeFormat(tag, o), options).format(value, unit);
    } catch {
      return `${value} ${unit}`;
    }
  },

  /** Call `fn` after every language change; returns the unsubscribe function. */
  onChange(fn: (e: LocaleChange) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** The current and pending language and the keys that fell back or were missing lately (the profiler, tests). */
  debug(): LocaleDebug {
    return { language: current, pending, missing: missing.map((m) => ({ ...m })) };
  },
};

function directionOf(code: string): TextDirection {
  if (isPseudo(code)) return code.toLowerCase() === PSEUDO_MIRRORED_LANGUAGE ? "rtl" : "ltr";
  return languageOf(settings, code)?.direction ?? "ltr";
}

// --- the engine's side -----------------------------------------------------------------------------------------------

/** What the Engine configures `Locale` with when it boots. */
export interface LocaleConfig {
  /** `project.json`'s `languages` (resolved). */
  readonly languages: LanguageSettings;
  /** Where messages come from: the project's tables or the build's files. */
  readonly strings: LocaleStrings;
  /** The player's remembered language (storage `settings`/`myco.locale.language`), if read. */
  readonly remembered?: unknown;
  /** The system's preferred languages (`navigator.languages`), for `useSystemLanguage`. */
  readonly system?: readonly string[];
  /** Save the player's choices (a game; not the editor's own World or a server). */
  readonly remember?: boolean;
}

/**
 * The start language (0356 §6, Unity's selector chain): the remembered language when the project remembers it and it
 * is still shipped, else the best system match when `useSystemLanguage`, else `default`. Only shipped languages count.
 */
function startLanguage(s: LanguageSettings, remembered: unknown, system: readonly string[]): string {
  const codes = shippedLanguages(s).map((l) => l.code);
  if (s.remember && typeof remembered === "string") {
    const hit = codes.find((c) => c.toLowerCase() === remembered.toLowerCase());
    if (hit) return hit;
  }
  if (s.useSystemLanguage) {
    const hit = lookupLanguage(system, codes);
    if (hit) return hit;
  }
  return codes.includes(s.default) ? s.default : (codes[0] ?? s.default);
}

/**
 * @internal The Engine's boot (ADR 0356 §6): use these languages and strings, pick the start language and load its
 * strings and fonts before resolving. Supersedes a switch in progress. Listeners hear the change if the language differs.
 */
export async function configureLocale(config: LocaleConfig): Promise<void> {
  const seq = ++switchSeq;
  settings = config.languages;
  strings = config.strings;
  remember = config.remember ?? false;
  shipped = languagesOf(settings);
  missing.length = 0;
  epoch++;
  const start = startLanguage(settings, config.remembered, config.system ?? []);
  pending = start;
  try {
    await loadLanguage(start);
  } catch (err) {
    console.warn(`[myco] The strings of "${start}" couldn't load (${(err as Error)?.message ?? err}); keys show as written.`);
  }
  if (seq !== switchSeq) return;
  const previous = current;
  current = start;
  pending = null;
  epoch++;
  localiseAssets(settings, current);
  if (previous !== start) notify(previous);
}

/** @internal The project's tables changed (the editor saved one, hot reload): resolved text can change. */
export function localeStringsChanged(next?: LocaleStrings): void {
  if (next) strings = next;
  epoch++;
}

/** @internal The strings in use (the editor's hot reload swaps project strings). */
export const localeStrings = (): LocaleStrings => strings;

/** @internal The argument names the message `key` resolves to now uses (UI documents look up only those); null when the key is missing. */
export function localeMessageNames(key: string): readonly string[] | null {
  const r = resolve(key, false);
  if (!r) return null;
  let list = names.get(r.ast);
  if (!list) names.set(r.ast, (list = Object.freeze([...collectNames(r.ast, new Set())])));
  return list;
}

function collectNames(ast: readonly MessageNode[], out: Set<string>): Set<string> {
  for (const n of ast) {
    if (n.type === "text" || n.type === "pound") continue;
    out.add(n.name);
    if (n.type === "plural" || n.type === "select") for (const o of n.options) collectNames(o.value, out);
  }
  return out;
}

/** @internal The font files and replacements of a language (the current one by default; a pseudo-language: the reference's). */
export function localeFonts(code: string = current): { readonly fonts: readonly string[]; readonly fontReplace: Readonly<Record<string, string>> } {
  const def = languageOf(settings, baseOf(code));
  return { fonts: def?.fonts ?? [], fontReplace: def?.fontReplace ?? {} };
}
