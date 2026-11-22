// Project Settings > Languages (ADR 0340 §1 L7, extended by 0342 §3 T7 and 0343 §2 S5): `project.json`'s `languages`
// section as part of the settings draft, through its settings section handle (ADR 0253), and the section's edits, each
// refused or next (0313): add, remove, move and rename languages (a regional code pre-fills its parent as fallback), a
// language's code, own fallback chain, `ship`, `direction`, fonts and `voice: false`; the project's reference, start
// language, fallback chain, `useSystemLanguage`, `remember` and `voice` mode (followText or separate).
//
// The editor owns `project.json`; the Studio edits this section only while no editor holds the project (0340 §1), so
// the editor never has to wait for it. Changing the reference language is refused while the project has string tables:
// their text is written in it, and swapping it is the Localisation panel's command (0342 §1).
//
// Pure.
import {
  canonicalLanguageCode, defaultDirection, LANGUAGE_LIMITS, languageDef, languageOf, languagesToJson, parseLanguages,
  type LanguageDef, type LanguageSettings, type TextDirection, type VoiceMode,
} from "../../../engine/localisation/languages";
import type { SettingsDraft, SettingsProblem } from "../../projectSettingsModel";
import { settingsSection } from "../../settingsSection";
import { accept, mapEdit, refuse, type EditResult } from "../localisation/editResult";

/** The `languages` key of the draft: read leniently (English only when absent), written minimal. */
export const languagesSettings = settingsSection<LanguageSettings>({
  key: "languages",
  parse: (written) => {
    const { languages, problems } = parseLanguages(written);
    return { settings: languages, problems };
  },
  write: (draft, s) => ({ ...draft, languages: languagesToJson(s) }),
});

/** What keeps the draft from saving, under `languages`. */
export const languagesProblems = (draft: SettingsDraft): SettingsProblem[] => languagesSettings.problems(draft);

type Edit = EditResult<LanguageSettings>;

/** Lift an edit of the section into the draft. */
const onDraft = (draft: SettingsDraft, edit: (s: LanguageSettings) => Edit): EditResult<SettingsDraft> =>
  mapEdit(edit(languagesSettings.read(draft)), (s) => languagesSettings.write(draft, s));

const row = (s: LanguageSettings, code: string, change: (l: LanguageDef) => LanguageDef | string): Edit => {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  const next = change(def);
  if (typeof next === "string") return refuse(next);
  return accept({ ...s, list: s.list.map((l) => (l === def ? next : l)) });
};

/** A language's name in itself where the platform knows it ("Français (Canada)"), else the code. */
export function nativeName(code: string): string {
  try {
    const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return n ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
  } catch {
    return code;
  }
}

// --- the list ----------------------------------------------------------------------------------------------------------

/** Add a language: a BCP 47 tag not listed yet (case doesn't make a new one); `fr-CA` with `fr` listed falls back to it. */
export function addLanguage(draft: SettingsDraft, rawCode: string, name = ""): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const code = canonicalLanguageCode(rawCode.trim());
    if (code === null) return refuse(`"${rawCode}" isn't a language tag such as "fr" or "pt-BR"`);
    if (languageOf(s, code)) return refuse(`${code} is already a project language`);
    if (s.list.length >= LANGUAGE_LIMITS.languages) return refuse(`a project has at most ${LANGUAGE_LIMITS.languages} languages`);
    const def = languageDef(code, name.trim().slice(0, LANGUAGE_LIMITS.name) || nativeName(code));
    const parent = code.split("-").slice(0, -1).join("-");
    const parentDef = parent ? languageOf(s, parent) : undefined;
    if (parentDef) def.fallback = [parentDef.code];
    return accept({ ...s, list: [...s.list, def] });
  });
}

/** Remove a language (not the reference or the start language); chains naming it lose it. */
export function removeLanguage(draft: SettingsDraft, code: string): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const def = languageOf(s, code);
    if (!def) return refuse(`"${code}" isn't a project language`);
    if (def.code === s.reference) return refuse(`${def.code} is the reference language: choose another first`);
    if (def.code === s.default) return refuse(`${def.code} is the start language: choose another first`);
    if (def.ship && s.list.filter((l) => l.ship).length === 1) return refuse("at least one language must ship");
    const list = s.list.filter((l) => l !== def).map((l) => (l.fallback.includes(def.code) ? { ...l, fallback: l.fallback.filter((c) => c !== def.code) } : l));
    const fallback = s.fallback.filter((c) => c !== def.code);
    return accept({ ...s, list, fallback: fallback.length ? fallback : [s.reference] });
  });
}

/** Move a language up (-1) or down (+1) the list (the order menus show). */
export function moveLanguage(draft: SettingsDraft, code: string, by: -1 | 1): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const i = s.list.findIndex((l) => l.code === languageOf(s, code)?.code);
    if (i < 0) return refuse(`"${code}" isn't a project language`);
    const to = i + by;
    if (to < 0 || to >= s.list.length) return refuse(by < 0 ? "it is first already" : "it is last already");
    const list = [...s.list];
    [list[i], list[to]] = [list[to], list[i]];
    return accept({ ...s, list });
  });
}

export function renameLanguage(draft: SettingsDraft, code: string, name: string): EditResult<SettingsDraft> {
  const n = name.trim();
  return onDraft(draft, (s) => row(s, code, (l) => (n === "" ? "a language needs a name" : n.length > LANGUAGE_LIMITS.name ? `a name has at most ${LANGUAGE_LIMITS.name} characters` : { ...l, name: n })));
}

/**
 * Change a language's code: chains, the reference and the start language follow. Translation files
 * (`<table>.<code>.strings.json`) and localised folders keep their old names; the caller says so.
 */
export function setLanguageCode(draft: SettingsDraft, code: string, rawNext: string): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const def = languageOf(s, code);
    if (!def) return refuse(`"${code}" isn't a project language`);
    const next = canonicalLanguageCode(rawNext.trim());
    if (next === null) return refuse(`"${rawNext}" isn't a language tag such as "fr" or "pt-BR"`);
    if (next === def.code) return accept(s);
    const other = languageOf(s, next);
    if (other && other !== def) return refuse(`${next} is already a project language`);
    const swap = (c: string) => (c === def.code ? next : c);
    const keepDirection = def.direction !== defaultDirection(def.code);
    const list = s.list.map((l) => (l === def ? { ...l, code: next, direction: keepDirection ? l.direction : defaultDirection(next) } : { ...l, fallback: l.fallback.map(swap) }));
    return accept({ ...s, list, reference: swap(s.reference), default: swap(s.default), fallback: s.fallback.map(swap) });
  });
}

/** Ship a language or keep it out of exports and the runtime's lists (work in progress); one language must ship. */
export function setShip(draft: SettingsDraft, code: string, ship: boolean): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    if (!ship && s.list.filter((l) => l.ship).length === 1 && languageOf(s, code)?.ship) return refuse("at least one language must ship");
    if (!ship && languageOf(s, code)?.code === s.default) return refuse("the start language must ship: choose another start language first");
    return row(s, code, (l) => ({ ...l, ship }));
  });
}

export const setDirection = (draft: SettingsDraft, code: string, direction: TextDirection): EditResult<SettingsDraft> =>
  onDraft(draft, (s) => row(s, code, (l) => ({ ...l, direction })));

/** A language's voice-over (0343 §2): false when it is translated but not recorded, so voice follows its chain instead. */
export const setLanguageVoice = (draft: SettingsDraft, code: string, voice: boolean): EditResult<SettingsDraft> =>
  onDraft(draft, (s) => row(s, code, (l) => ({ ...l, voice })));

const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

/** Add a font file to a language's stack (tried after a text's own font, before Inter). */
export function addFont(draft: SettingsDraft, code: string, path: string): EditResult<SettingsDraft> {
  const p = path.trim();
  return onDraft(draft, (s) => row(s, code, (l) => {
    if (!FONT_FILE.test(p)) return `${p || "That"} isn't a font file (.ttf, .otf, .woff, .woff2)`;
    if (l.fonts.includes(p)) return `${p} is in ${l.code}'s fonts already`;
    if (l.fonts.length >= LANGUAGE_LIMITS.fonts) return `a language has at most ${LANGUAGE_LIMITS.fonts} fonts`;
    return { ...l, fonts: [...l.fonts, p] };
  }));
}

export function removeFont(draft: SettingsDraft, code: string, path: string): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => row(s, code, (l) => (l.fonts.includes(path) ? { ...l, fonts: l.fonts.filter((f) => f !== path) } : `${path} isn't one of ${l.code}'s fonts`)));
}

// --- chains and project choices ------------------------------------------------------------------------------------------

/** Typed codes ("fr, en") as a list. */
export const codesOf = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

function chainOf(s: LanguageSettings, codes: readonly string[], self: string | null): EditResult<string[]> {
  const out: string[] = [];
  for (const raw of codes) {
    const def = languageOf(s, raw.trim());
    if (!def) return refuse(`"${raw.trim()}" isn't a project language`);
    if (def.code === self) return refuse("a language can't fall back to itself");
    if (!out.includes(def.code)) out.push(def.code);
  }
  if (out.length > LANGUAGE_LIMITS.fallback) return refuse(`a chain has at most ${LANGUAGE_LIMITS.fallback} languages`);
  return accept(out);
}

/** A language's own fallback list, tried before the project's. */
export function setLanguageFallback(draft: SettingsDraft, code: string, codes: readonly string[]): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const def = languageOf(s, code);
    if (!def) return refuse(`"${code}" isn't a project language`);
    const chain = chainOf(s, codes, def.code);
    return "refused" in chain ? chain : row(s, code, (l) => ({ ...l, fallback: chain.next }));
  });
}

/** The chain every language ends with. */
export function setProjectFallback(draft: SettingsDraft, codes: readonly string[]): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => mapEdit(chainOf(s, codes, null), (fallback) => ({ ...s, fallback })));
}

/** The reference language; refused while the project has string tables (`tableCount`), whose text is written in it. */
export function setReference(draft: SettingsDraft, code: string, tableCount: number): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const def = languageOf(s, code);
    if (!def) return refuse(`"${code}" isn't a project language`);
    if (def.code === s.reference) return accept(s);
    if (tableCount > 0) return refuse(`the project's ${tableCount} string table${tableCount === 1 ? " is" : "s are"} written in ${s.reference}; changing the reference swaps their text with ${def.code}'s translations, which the Localisation panel does`);
    const fallback = s.fallback.length === 1 && s.fallback[0] === s.reference ? [def.code] : s.fallback;
    return accept({ ...s, reference: def.code, fallback });
  });
}

/** The start language when nothing else picks one; it must ship. */
export function setDefault(draft: SettingsDraft, code: string): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    const def = languageOf(s, code);
    if (!def) return refuse(`"${code}" isn't a project language`);
    if (!def.ship) return refuse(`${def.code} doesn't ship, so it can't be the start language`);
    return accept({ ...s, default: def.code });
  });
}

export const setUseSystemLanguage = (draft: SettingsDraft, on: boolean): EditResult<SettingsDraft> => onDraft(draft, (s) => accept({ ...s, useSystemLanguage: on }));
export const setRemember = (draft: SettingsDraft, on: boolean): EditResult<SettingsDraft> => onDraft(draft, (s) => accept({ ...s, remember: on }));
/** Voice follows the text language (`followText`), or the two switch separately (0343 §2). */
export const setVoiceMode = (draft: SettingsDraft, voice: VoiceMode): EditResult<SettingsDraft> => onDraft(draft, (s) => accept({ ...s, voice }));

/** The project's font files, for a language's font picker. */
export const fontFiles = (files: readonly string[]): string[] => files.filter((f) => FONT_FILE.test(f));
