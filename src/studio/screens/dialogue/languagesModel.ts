// The Languages tab's model (ADR 0340 §1, §2, §9): who may edit `project.json`'s `languages` (the editor owns the file;
// the Studio edits the section only while no editor holds the project lock, else shows it read-only with "Edit in the
// editor"), the section's edits — add and remove a language (a regional code pre-fills its parent as fallback), name,
// ship, reference, default, fallback chains — and `audio.json`'s `localisation` settings (roots, loudness, duration
// tolerance, what a missing line does), each refused or next (0313). And the per-user preview language. Pure.
import { AUDIO_LOCALISATION_LIMITS, defaultAudioLocalisation } from "../../../engine/audio/localisation/format";
import type { AudioLocalisation } from "../../../engine/audio/localisation/types";
import type { AudioProject } from "../../../engine/audio/project/types";
import {
  canonicalLanguageCode, cleanFolder, LANGUAGE_LIMITS, languageDef, languageOf, type LanguageDef, type LanguageSettings,
} from "../../../engine/localisation/languages";
import type { EditResult } from "../../../plugins/audio/editor/editResult";

// --- the lock rule -------------------------------------------------------------------------------------------------------

/** Whether the Studio may edit `project.json`'s languages now, and why not. */
export type LanguagesAccess =
  | { readonly editable: true }
  | { readonly editable: false; readonly reason: string; readonly editInEditor: boolean };

export interface AccessFacts {
  /** The project can be saved to (not a sample, not opened read-only). */
  readonly canSave: boolean;
  /** The editor's lock on the project: held, not held, or not known yet (still being read). */
  readonly editorLock: "held" | "none" | "unknown";
}

/** 0340 §1 ownership: editable only with a writable project and no editor holding it. */
export function languagesAccess(f: AccessFacts): LanguagesAccess {
  if (!f.canSave) return { editable: false, reason: "The project is read-only.", editInEditor: false };
  if (f.editorLock === "held") return { editable: false, reason: "The editor has this project open, and project.json is the editor's: change languages in its Project Settings.", editInEditor: true };
  if (f.editorLock === "unknown") return { editable: false, reason: "Checking whether the editor has this project open…", editInEditor: false };
  return { editable: true };
}

// --- language edits ------------------------------------------------------------------------------------------------------

const refuse = (refused: string) => ({ refused });

const replaceRow = (s: LanguageSettings, code: string, change: (l: LanguageDef) => LanguageDef): EditResult<LanguageSettings> => {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  return { next: { ...s, list: s.list.map((l) => (l === def ? change(l) : l)) } };
};

/**
 * Add a language. The code must be a BCP 47 tag not listed yet (case doesn't make a new language: codes are folder
 * names); a regional code whose parent is listed (`fr-CA` with `fr`) falls back to it.
 */
export function addLanguage(s: LanguageSettings, rawCode: string, name = ""): EditResult<LanguageSettings> {
  const code = canonicalLanguageCode(rawCode.trim());
  if (code === null) return refuse(`"${rawCode}" isn't a language tag such as "fr" or "pt-BR"`);
  if (languageOf(s, code)) return refuse(`${code} is already a project language`);
  if (s.list.length >= LANGUAGE_LIMITS.languages) return refuse(`a project has at most ${LANGUAGE_LIMITS.languages} languages`);
  const def = languageDef(code, name.trim().slice(0, LANGUAGE_LIMITS.name) || displayName(code));
  const parent = code.split("-").slice(0, -1).join("-");
  if (parent && languageOf(s, parent)) def.fallback = [languageOf(s, parent)!.code];
  return { next: { ...s, list: [...s.list, def] } };
}

/** A language's name in itself where the platform knows it ("Français (Canada)"), else the code. */
export function displayName(code: string): string {
  try {
    const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return n ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
  } catch {
    return code;
  }
}

/** Remove a language (not the reference or the default); fallbacks naming it lose it. */
export function removeLanguage(s: LanguageSettings, code: string): EditResult<LanguageSettings> {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  if (def.code === s.reference) return refuse(`${def.code} is the reference language: choose another first`);
  if (def.code === s.default) return refuse(`${def.code} is the start language: choose another first`);
  const list = s.list.filter((l) => l !== def).map((l) => (l.fallback.includes(def.code) ? { ...l, fallback: l.fallback.filter((c) => c !== def.code) } : l));
  const fallback = s.fallback.filter((c) => c !== def.code);
  return { next: { ...s, list, fallback: fallback.length ? fallback : [s.reference] } };
}

export function renameLanguage(s: LanguageSettings, code: string, name: string): EditResult<LanguageSettings> {
  const n = name.trim();
  if (n === "") return refuse("a language needs a name");
  if (n.length > LANGUAGE_LIMITS.name) return refuse(`a name has at most ${LANGUAGE_LIMITS.name} characters`);
  return replaceRow(s, code, (l) => ({ ...l, name: n }));
}

/** Ship a language or keep it out of exports (work in progress); the last shipped language stays shipped. */
export function setShip(s: LanguageSettings, code: string, ship: boolean): EditResult<LanguageSettings> {
  if (!ship && s.list.filter((l) => l.ship).length === 1 && languageOf(s, code)?.ship) return refuse("at least one language must ship");
  return replaceRow(s, code, (l) => ({ ...l, ship }));
}

export function setReference(s: LanguageSettings, code: string): EditResult<LanguageSettings> {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  // The project chain follows the reference when it was the default chain.
  const fallback = s.fallback.length === 1 && s.fallback[0] === s.reference ? [def.code] : s.fallback;
  return { next: { ...s, reference: def.code, fallback } };
}

export function setDefault(s: LanguageSettings, code: string): EditResult<LanguageSettings> {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  return { next: { ...s, default: def.code } };
}

/** A fallback list from typed codes: listed, not `self`, each once. */
function chainOf(s: LanguageSettings, codes: readonly string[], self: string | null): EditResult<string[]> {
  const out: string[] = [];
  for (const raw of codes) {
    const def = languageOf(s, raw.trim());
    if (!def) return refuse(`"${raw.trim()}" isn't a project language`);
    if (def.code === self) return refuse("a language can't fall back to itself");
    if (!out.includes(def.code)) out.push(def.code);
  }
  if (out.length > LANGUAGE_LIMITS.fallback) return refuse(`a chain has at most ${LANGUAGE_LIMITS.fallback} languages`);
  return { next: out };
}

/** A language's own fallback list (tried before the project's). */
export function setLanguageFallback(s: LanguageSettings, code: string, codes: readonly string[]): EditResult<LanguageSettings> {
  const def = languageOf(s, code);
  if (!def) return refuse(`"${code}" isn't a project language`);
  const chain = chainOf(s, codes, def.code);
  if ("refused" in chain) return chain;
  return replaceRow(s, code, (l) => ({ ...l, fallback: chain.next }));
}

/** The chain every language ends with. */
export function setProjectFallback(s: LanguageSettings, codes: readonly string[]): EditResult<LanguageSettings> {
  const chain = chainOf(s, codes, null);
  if ("refused" in chain) return chain;
  return { next: { ...s, fallback: chain.next } };
}

/** Typed codes ("fr, en") as a list. */
export const codesOf = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

// --- audio.json localisation ---------------------------------------------------------------------------------------------

const withLocalisation = (p: AudioProject, change: (l: AudioLocalisation) => AudioLocalisation): EditResult<AudioProject> =>
  ({ next: { ...p, localisation: change(p.localisation ?? defaultAudioLocalisation()) } });

/** The localised roots, from typed folders. */
export function setRoots(p: AudioProject, folders: readonly string[]): EditResult<AudioProject> {
  const roots: string[] = [];
  for (const f of folders) {
    const c = cleanFolder(f);
    if (c === null) return refuse(`"${f}" isn't a project folder`);
    const clash = roots.find((x) => x === c || c.startsWith(`${x}/`) || x.startsWith(`${c}/`));
    if (clash !== undefined) return refuse(`"${c}" ${clash === c ? "is listed twice" : `overlaps "${clash}"`}`);
    roots.push(c);
  }
  if (roots.length > AUDIO_LOCALISATION_LIMITS.roots) return refuse(`at most ${AUDIO_LOCALISATION_LIMITS.roots} roots`);
  return withLocalisation(p, (l) => ({ ...l, roots }));
}

export function setLoudness(p: AudioProject, mode: AudioLocalisation["loudness"]["mode"], target: number): EditResult<AudioProject> {
  const [lo, hi] = AUDIO_LOCALISATION_LIMITS.target;
  if (!(target >= lo && target <= hi)) return refuse(`the target is ${lo} to ${hi}`);
  return withLocalisation(p, (l) => ({ ...l, loudness: { mode, target } }));
}

export function setTolerance(p: AudioProject, share: number): EditResult<AudioProject> {
  const [lo, hi] = AUDIO_LOCALISATION_LIMITS.durationTolerance;
  if (!(share >= lo && share <= hi)) return refuse(`the tolerance is ${lo * 100}% to ${hi * 100}%`);
  return withLocalisation(p, (l) => ({ ...l, durationTolerance: share }));
}

export const setMissing = (p: AudioProject, missing: AudioLocalisation["missing"]): EditResult<AudioProject> => withLocalisation(p, (l) => ({ ...l, missing }));

// --- preview language ----------------------------------------------------------------------------------------------------

/** The preview language (0340 §1, per user): the stored one when it is a project language, else the start language. */
export const previewLanguageOf = (stored: string | null, s: LanguageSettings): string => (stored ? languageOf(s, stored)?.code : undefined) ?? s.default;
