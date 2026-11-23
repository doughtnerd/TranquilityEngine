// The editor's preview language (ADR 0340 §1, 0342 §9): a per-user preference, not project data, kept under the same
// local-storage key as the Audio Studio's language chip (`myco.audio.previewLanguage`), so both apps preview in the
// language last chosen. The Play toolbar's Language menu sets it; editor Play starts in it (remembered and system
// languages are ignored there) and follows a change while playing, through `Locale.setLanguage`, the same call a game's
// language menu makes. The menu also offers the two pseudo-languages (`qps-ploc`, `qps-plocm`), which exist only in the
// editor and in `--pseudo` QA builds.
//
// The Play toolbar's Subtitles overlay toggle (ADR 0343 §6) and its preference are the subtitles plugin's
// (`plugins/subtitles/editor`), there only while the plugin is on.
import { Locale } from "../engine/localisation/Locale";
import { fallbackChain, parseLanguages, shippedLanguages, type LanguageSettings } from "../engine/localisation/languages";
import { isPseudoLanguage, PSEUDO_LANGUAGE, PSEUDO_MIRRORED_LANGUAGE } from "../engine/localisation/pseudo";
import { persisted } from "./preferences";

/** Per user: the language editor Play starts in; null: the project's start language (`languages.default`). */
export const previewLanguage = persisted<string | null>("myco.audio.previewLanguage", null);

/** One entry of the Play toolbar's Language menu. */
export interface PlayLanguageChoice {
  readonly code: string;
  /** What the menu shows: the language's name and code ("Français (fr)"), or the pseudo-language's purpose. */
  readonly label: string;
  readonly pseudo: boolean;
  /** For a hover title: its fallback chain, or what a pseudo-language shows. */
  readonly title: string;
}

/** The project's languages as `project.json` has them (the defaults when it has none). */
export const projectLanguages = (settings: { readonly languages?: unknown }): LanguageSettings => parseLanguages(settings.languages).languages;

/**
 * The menu: the shipped languages in list order (only they can be switched to, as in a build), then the two
 * pseudo-languages.
 */
export function playLanguageChoices(s: LanguageSettings): PlayLanguageChoice[] {
  const languages = shippedLanguages(s).map((l) => ({
    code: l.code,
    label: l.name === l.code ? l.code : `${l.name} (${l.code})`,
    pseudo: false,
    title: `Falls back to ${fallbackChain(s, l.code).slice(1).join(", ") || "nothing"}${l.code === s.default ? " · the start language" : ""}`,
  }));
  return [
    ...languages,
    { code: PSEUDO_LANGUAGE, label: "Pseudo (accented, longer)", pseudo: true, title: "Every keyed string accented and padded inside [!! … !!]: unkeyed text stays plain, cut-off text loses its brackets" },
    { code: PSEUDO_MIRRORED_LANGUAGE, label: "Pseudo, right to left", pseudo: true, title: "The pseudo-language mirrored right to left, to check right-to-left text" },
  ];
}

/** The language Play uses for a stored preference: it when it is shipped or a pseudo-language, else the start language. */
export function playLanguageOf(stored: string | null, s: LanguageSettings): string {
  if (stored !== null) {
    if (isPseudoLanguage(stored)) return stored.toLowerCase();
    const hit = shippedLanguages(s).find((l) => l.code.toLowerCase() === stored.toLowerCase());
    if (hit) return hit.code;
  }
  const shipped = shippedLanguages(s);
  return shipped.some((l) => l.code === s.default) ? s.default : (shipped[0]?.code ?? s.default);
}

/**
 * Switch the running game's text (and, through `Locale`'s participants, voice) to the preview language for `stored`,
 * when it isn't already. Resolves once the switch has happened; a refused switch (the language isn't in the running
 * game's list) is reported by `Locale` and leaves the language as it was.
 */
export async function applyPlayLanguage(stored: string | null, s: LanguageSettings): Promise<void> {
  const code = playLanguageOf(stored, s);
  if (Locale.language === code) return;
  await Locale.setLanguage(code).catch(() => undefined);
}

/** The menu's choice: remember it, and switch the running game when playing (`playing`). */
export function choosePlayLanguage(code: string, s: LanguageSettings, playing: boolean): Promise<void> {
  previewLanguage.value = code;
  return playing ? applyPlayLanguage(code, s) : Promise.resolve();
}
