/**
 * The audio language at runtime (ADR 0354 §4, amended by 0357 §2): `Audio.language`, `setLanguage`, `pendingLanguage`,
 * `subtitleLanguage` and `languages`, the start selector, and the project data the localisation runtime reads.
 *
 * - **Project data.** The language list is `project.json`'s `languages` (the active World's settings); the localised
 *   roots and the missing-line rule are `audio.json`'s `localisation` (read from the asset sources, as packages read
 *   theirs); the reading-speed rule is `project.json`'s `subtitles`.
 * - **Start language** (Unity's selector chain), decided once a session: the remembered language (player storage,
 *   namespace `settings`, key `myco.audio.language`, when `remember`; loaded before the first scene by
 *   `prepareStartLanguage`), else the best system match (`navigator.languages`, BCP 47 lookup, when
 *   `useSystemLanguage`), else `default`. Only shipped voice languages count. Under `languages.voice: "followText"` a
 *   started text language decides it instead (its voice language, `voiceLanguageFor`).
 * - **A switch is atomic.** The new language's parts load first (package parts arrive with 0354 L3; with none the switch
 *   completes at once), then `Audio.language` changes in one step, then it is remembered. `playing: "finish"` (default)
 *   lets voices that resolved a localised file finish in the old language; `"stop"` stops them with a 50 ms fade. An
 *   unknown or unshipped code rejects with one warning and changes nothing; a second switch supersedes a pending one.
 * - **Voice follows text** (0357 §2): with `followText` the audio language takes part in `Locale.setLanguage`'s atomic
 *   switch through 0356's participant seam (`runtime/participants.ts`) and changes with it; the start language is then
 *   the text language's voice language. With `"separate"` the two start and switch independently.
 * - **Subtitle language**: `subtitleLanguage` when set, else the text language (`Locale.language`); subtitle text is
 *   `Locale.t(textKey)` (`subtitleText`).
 */
import { World } from "../../../../engine/core/World";
import { Assets } from "../../../../engine/scene/Assets";
import { Storage } from "../../../../engine/platform/Storage";
import { AUDIO_PROJECT_FILE } from "../../../../engine/audio/project/types";
import { parseAudioLocalisation, defaultAudioLocalisation } from "../../../../engine/audio/localisation/format";
import type { AudioLocalisation } from "../../../../engine/audio/localisation/types";
import { canonicalLanguageCode, defaultLanguages, fallbackChain, intlTagOf, languageOf, lookupLanguage, shippedLanguages, voiceLanguageFor, type LanguageSettings } from "../../../../engine/localisation/languages";
import { readingRule, type ReadingRule } from "../../../../engine/localisation/subtitles";
import { isWellFormed, parseMessage } from "../../../../engine/localisation/message/parse";
import { formatMessage } from "../../../../engine/localisation/message/format";
import { Locale, localeStrings } from "../../../../engine/localisation/Locale";
import { registerLanguageParticipant } from "../../../../engine/localisation/runtime/participants";
import { warnOnce } from "../core/handle";
import { onAudioSessionReleased } from "../audioSession";
import type { AudioVoice } from "../backend";
import { committedPackageLanguage, switchPackageLanguage } from "../media/packages";

/** A shipped voice language as game code sees it (`Audio.languages`). */
export interface AudioLanguage {
  readonly code: string;
  readonly name: string;
  readonly fallback: readonly string[];
}

/** What `Audio.setLanguage` does with voice-over playing in the old language. */
export interface SetLanguageOptions {
  /** "finish" (default): voices that resolved a localised file finish in the old language. "stop": they stop with a 50 ms fade. */
  playing?: "finish" | "stop";
}

/** The player storage key the language is remembered under (namespace `settings`). */
export const LANGUAGE_STORAGE_KEY = "myco.audio.language";
const STOP_FADE = 0.05;
const MISSING_KEPT = 32;

// --- project data --------------------------------------------------------------------------------------------------------

/** The project's languages (the active World's `project.json` settings; English only without one). */
export function projectLanguages(): LanguageSettings {
  return World.active?.settings.languages ?? DEFAULT_LANGUAGES;
}
const DEFAULT_LANGUAGES = defaultLanguages();

let localisationFrom: { raw: unknown; value: AudioLocalisation } | null = null;

/** `audio.json`'s `localisation` section (the defaults, with no localised roots, when there is none). */
export function audioLocalisation(): AudioLocalisation {
  let raw: unknown;
  try {
    raw = Assets.has(AUDIO_PROJECT_FILE) ? Assets.get(AUDIO_PROJECT_FILE) : undefined;
  } catch {
    raw = undefined;
  }
  if (localisationFrom !== null && localisationFrom.raw === raw) return localisationFrom.value;
  const section = raw !== null && typeof raw === "object" ? (raw as { localisation?: unknown }).localisation : undefined;
  const value = section === undefined ? defaultAudioLocalisation() : parseAudioLocalisation(section, []);
  localisationFrom = { raw, value };
  return value;
}

/** The reading rule of `code` (0357 §3): its reading speed and the project's minimum display time. */
export function readingRuleOf(code: string): ReadingRule {
  return readingRule(code, projectLanguages(), World.active?.settings.subtitles ?? null);
}

/** The shipped voice languages (0357 §2: a row with `voice: false` isn't one). */
function voiceLanguages(s: LanguageSettings) {
  return shippedLanguages(s).filter((l) => l.voice);
}

// --- state ---------------------------------------------------------------------------------------------------------------

let current: string | null = null;
let pending: { code: string; serial: number } | null = null;
let serial = 0;
let subtitles: string | null = null;
let remembered: Promise<void> | null = null;
/** Voices playing a localised file, with the language they resolved (for `playing: "stop"`). */
const localisedVoices = new Map<AudioVoice, string>();
const missing: { path: string; language: string }[] = [];
const changeListeners = new Set<(audio: string, subtitles: string | null) => void>();

onAudioSessionReleased(() => {
  current = null;
  pending = null;
  serial++;
  subtitles = null;
  remembered = null;
  localisedVoices.clear();
  missing.length = 0;
  localisationFrom = null;
});

/** The start language without player storage: the text language's voice language, a system match, else the default. */
function startLanguage(s: LanguageSettings): string {
  const voice = voiceLanguages(s).map((l) => l.code);
  if (s.voice === "followText") {
    const v = voiceLanguageFor(s, Locale.language);
    if (v !== null) return v;
  }
  if (s.useSystemLanguage) {
    const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
    const requested = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
    const hit = lookupLanguage(requested, voice);
    if (hit !== null) return hit;
  }
  if (voice.includes(s.default)) return s.default;
  return voice[0] ?? s.default;
}

/** `Audio.language`: the current audio language (started on first use). */
export function audioLanguage(): string {
  if (current === null) current = startLanguage(projectLanguages());
  return current;
}

/** `Audio.pendingLanguage`. */
export const pendingAudioLanguage = (): string | null => pending?.code ?? null;

/** The fallback chain of the current audio language. */
export const audioChain = (): string[] => fallbackChain(projectLanguages(), audioLanguage());

/** The language subtitles resolve in now: `subtitleLanguage`, else the text language (`Locale.language`). */
export function effectiveSubtitleLanguage(): string {
  return subtitles ?? Locale.language;
}

const asts = new Map<string, ReturnType<typeof parseMessage>["ast"] | null>();

/**
 * The text of string key `key` in the subtitle language (0357 §1): `Locale.t(key)` when subtitles follow the text
 * language (the default), else the key through the explicit subtitle language's chain in `Locale`'s strings. Null when
 * no language of the chain has it.
 */
export function subtitleText(key: string): string | null {
  if (subtitles === null || subtitles.toLowerCase() === Locale.language.toLowerCase()) return Locale.has(key) ? Locale.t(key) : null;
  const langs = projectLanguages();
  const strings = localeStrings();
  for (const code of fallbackChain(langs, subtitles)) {
    const message = strings.message(key, code);
    if (message === undefined) continue;
    let ast = asts.get(message);
    if (ast === undefined) {
      const p = parseMessage(message);
      ast = isWellFormed(p) ? p.ast : null;
      if (asts.size > 1024) asts.clear();
      asts.set(message, ast);
    }
    if (ast !== null) return formatMessage(ast, null, intlTagOf(langs, code));
  }
  return null;
}

/** `Audio.subtitleLanguage` (null: follows the text language). */
export const subtitleLanguageSetting = (): string | null => subtitles;

/** Sets `Audio.subtitleLanguage`; a code that isn't a project language is ignored with one warning. */
export function setSubtitleLanguage(code: string | null): void {
  if (code === null) { subtitles = null; notify(); return; }
  const def = typeof code === "string" ? languageOf(projectLanguages(), code) : undefined;
  if (!def) {
    warnOnce(`subtitleLanguage:${String(code)}`, `Audio.subtitleLanguage: "${String(code)}" isn't a project language; unchanged.`);
    return;
  }
  subtitles = def.code;
  notify();
}

/** `Audio.languages`: the shipped voice languages. */
export function audioLanguages(): readonly AudioLanguage[] {
  return voiceLanguages(projectLanguages()).map((l) => Object.freeze({ code: l.code, name: l.name, fallback: Object.freeze([...l.fallback]) }));
}

/** @internal Hears every change of the audio or subtitle language (the take's `language` record, the line runtime). */
export function onAudioLanguageChange(fn: (audio: string, subtitles: string | null) => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

function notify(): void {
  const audio = audioLanguage();
  for (const fn of [...changeListeners]) {
    try { fn(audio, subtitles); } catch (e) { console.error("[myco] audio: a language listener threw:", e); }
  }
}

/** The shipped voice language `code` names (case-insensitively), or null. */
function voiceLanguage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const canonical = canonicalLanguageCode(code);
  if (canonical === null) return null;
  const def = languageOf(projectLanguages(), canonical);
  return def && def.ship && def.voice ? def.code : null;
}

/** The switch's commit: the language changes in one step, the old language's voices stop (`"stop"`), it is remembered. */
function commit(code: string, playing: "finish" | "stop"): void {
  const before = audioLanguage();
  current = code;
  if (playing === "stop") {
    for (const [voice, language] of [...localisedVoices]) {
      if (language === code) continue;
      try { voice.stop(STOP_FADE); } catch { /* gone */ }
    }
  }
  if (projectLanguages().remember && before !== code) void Storage.save(LANGUAGE_STORAGE_KEY, code, "settings").catch(() => undefined);
  if (before !== code) notify();
}

/**
 * `Audio.setLanguage(code, options)`: atomic (see the header). Resolves when the language changed (at once without
 * packages); rejects, changing nothing, for a code that isn't a shipped voice language.
 */
export function setAudioLanguage(code: string, options?: SetLanguageOptions): Promise<void> {
  const target = voiceLanguage(code);
  if (target === null) {
    warnOnce(`setLanguage:${String(code)}`, `Audio.setLanguage: "${String(code)}" isn't a shipped voice language of the project; unchanged.`);
    return Promise.reject(new Error(`"${String(code)}" isn't a shipped voice language`));
  }
  const playing = options?.playing === "stop" ? "stop" : "finish";
  const mine = ++serial;
  pending = { code: target, serial: mine };
  // 0354 L3: every loaded package's part in the new language loads first; a later call supersedes this one.
  const done = () => {
    if (pending?.serial === mine) {
      pending = null;
      commit(target, playing);
    }
  };
  const parts = switchPackageLanguage(target, { playing });
  // No part to load: the switch completes in this call, as without packages.
  if (committedPackageLanguage() === target) {
    done();
    return Promise.resolve();
  }
  return parts.then(done);
}

/**
 * @internal Before the first scene (the packages World service): the remembered language, once a session, when the
 * project remembers it and it is still a shipped voice language.
 */
export function prepareStartLanguage(): Promise<void> {
  if (remembered) return remembered;
  remembered = (async () => {
    const s = projectLanguages();
    // Under followText the voice language is the text language's (Locale's start selector and storage decide it).
    if (!s.remember || s.voice === "followText") return;
    let value: unknown;
    try { value = await Storage.load(LANGUAGE_STORAGE_KEY, "settings"); } catch { return; }
    const code = voiceLanguage(value);
    if (code !== null && pending === null) {
      const before = current;
      current = code;
      if (before !== null && before !== code) notify();
    }
  })();
  return remembered;
}

// --- voices and missing files ----------------------------------------------------------------------------------------------

/** @internal A voice started on a localised file in `language`: `setLanguage(…, { playing: "stop" })` stops it. */
export function noteLocalisedVoice(voice: AudioVoice, language: string): void {
  if (localisedVoices.size > 256) for (const v of [...localisedVoices.keys()]) if (!(v.alive ?? v.playing)) localisedVoices.delete(v);
  localisedVoices.set(voice, language);
}

/** @internal No language of the chain has `path`: one warning per path and language, and the debug list (the last 32). */
export function noteMissingLanguage(path: string, language: string): void {
  warnOnce(`missingLanguage:${path}:${language}`, `"${path}" has no file in ${language} or its fallbacks; it plays nothing (reason "missingLanguage").`);
  const i = missing.findIndex((m) => m.path === path && m.language === language);
  if (i >= 0) missing.splice(i, 1);
  missing.push({ path, language });
  if (missing.length > MISSING_KEPT) missing.shift();
}

/** `Audio.debug().language`. */
export interface AudioLanguageDebug {
  current: string;
  subtitles: string;
  pending: string | null;
  missing: { path: string; language: string }[];
}

export function languageDebug(): AudioLanguageDebug {
  return { current: audioLanguage(), subtitles: effectiveSubtitleLanguage(), pending: pendingAudioLanguage(), missing: missing.map((m) => ({ ...m })) };
}

// --- voice follows text (0357 §2) -------------------------------------------------------------------------------------------

// The voice language takes part in `Locale.setLanguage`'s atomic switch (0356's participant seam): `prepare` runs before
// the text switch commits (0354 L3 loads the voice language's package parts there; none yet), and the voice changes in
// the same step as the text, from `Locale.onChange`, which the switch calls as it commits.
registerLanguageParticipant({
  name: "voice",
  prepare(text) {
    const s = projectLanguages();
    if (s.voice !== "followText") return;
    // 0354 L3: every loaded package's part in the voice language loads before the switch commits.
    const voice = voiceLanguageFor(s, text);
    if (voice !== null) return switchPackageLanguage(voice);
  },
});

Locale.onChange(({ language }) => {
  const s = projectLanguages();
  if (s.voice !== "followText") return;
  const voice = voiceLanguageFor(s, language);
  pending = null;
  serial++;
  if (voice !== null && voiceLanguage(voice) !== null) commit(voice, "finish");
  else notify(); // subtitles follow the text language
});
