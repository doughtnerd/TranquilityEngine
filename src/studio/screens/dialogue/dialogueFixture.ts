// A small dialogue project for the Dialogue screen's tests and stories (ADR 0340, 0341, 0343): English (reference),
// French, Canadian French falling back to French, and German (not shipped); one line table `audio/vo/ch1.lines.json`
// with its string table and French translation; recordings with lengths and sidecars; one dialogue event file. Plain
// values in, a `DialogueData` out.
import { defaultAudioLocalisation } from "../../../engine/audio/localisation/format";
import { parseLineTable } from "../../../engine/audio/localisation/lines/format";
import type { AudioLocalisation, LineTable } from "../../../engine/audio/localisation/types";
import { parseDialogue } from "../../../engine/audio/dialogue/format";
import type { DialogueAsset } from "../../../engine/audio/dialogue/types";
import type { SampleMarker, SampleNormalize, SampleVo } from "../../../engine/audio/sample/types";
import { parseLanguages, type LanguageSettings } from "../../../engine/localisation/languages";
import { parseStringTable, type StringTable } from "../../../engine/localisation/strings/format";
import { parseTranslation, type TranslationFile } from "../../../engine/localisation/strings/translation";
import { defaultSubtitleProjectSettings } from "../../../engine/localisation/subtitleSettings";
import { textHash } from "../../../engine/localisation/textHash";
import type { DialogueData, FileFacts } from "./dialogueData";

export const FIXTURE_LANGUAGES: LanguageSettings = parseLanguages({
  list: [
    { code: "en", name: "English" },
    { code: "fr", name: "Français" },
    { code: "fr-CA", name: "Français (Canada)", fallback: ["fr"] },
    { code: "de", name: "Deutsch", ship: false },
  ],
  reference: "en",
  default: "en",
}).languages;

export const TABLE_PATH = "audio/vo/ch1.lines.json";
export const STRINGS_PATH = "audio/vo/ch1.strings.json";
export const FR_PATH = "audio/vo/ch1.fr.strings.json";

export const fixtureTable = (): LineTable => parseLineTable({
  format: "myco.lines@1",
  folder: "ch1",
  speakers: ["Ava", "Guard"],
  lines: [
    { key: "intro_01", speaker: "Ava", notes: "Whispered, out of breath", tags: ["main"] },
    { key: "intro_02", speaker: "Ava" },
    { key: "guard_01", speaker: "Guard", cooldown: 4 },
    { key: "breath_03", speaker: "Ava", textKey: null },
  ],
}).table;

export const INTRO_01_TEXT = "We're late.";
export const fixtureStrings = (): StringTable => parseStringTable({
  format: "myco.strings@1",
  language: "en",
  strings: [
    { key: "intro_01", text: INTRO_01_TEXT },
    { key: "intro_02", text: "Keep your head down and follow me through the courtyard, quickly, before the bells ring." },
    { key: "guard_01", text: "Halt! Who goes there?" },
  ],
}).table;

export const fixtureFrench = (): TranslationFile => parseTranslation({
  format: "myco.translation@1",
  language: "fr",
  strings: { intro_01: { text: "On est en retard.", source: textHash(INTRO_01_TEXT) } },
}, FR_PATH).translation;

/** Files: English has every line; French has intro_01 (too long) and guard_01 (imported against an old text). */
export const FIXTURE_DURATIONS: Readonly<Record<string, number>> = {
  "audio/vo/en/ch1/intro_01.wav": 1.2,
  "audio/vo/en/ch1/intro_02.wav": 3.0,
  "audio/vo/en/ch1/guard_01.wav": 1.5,
  "audio/vo/en/ch1/breath_03.wav": 0.6,
  "audio/vo/fr/ch1/intro_01.wav": 2.4,
  "audio/vo/fr/ch1/guard_01.ogg": 1.6,
};

export const fixtureLocalisation = (): AudioLocalisation => ({ ...defaultAudioLocalisation(), roots: ["audio/vo"] });

export const fixtureDialogue = (): DialogueAsset => parseDialogue({
  format: "myco.dialogue@1",
  events: [{
    name: "enemy_spotted",
    arguments: [
      { name: "speaker", labels: ["Guard", "Captain", "Sniper"] },
      { name: "weather", labels: ["Clear", "Rain", "Fog"] },
      { name: "distance", labels: ["Near", "Far"] },
    ],
    paths: [
      { path: ["Guard", "*", "Near"], lines: [{ key: "guard_01", weight: 2 }, { key: "intro_02" }] },
      { path: ["Guard", "Rain", "*"], lines: [{ key: "intro_01" }], probability: 0.5 },
      { path: ["Sniper", "*", "*"], lines: [] },
    ],
  }],
}).dialogue;

export interface FixtureOptions {
  readonly table?: LineTable;
  readonly strings?: StringTable | null;
  readonly french?: TranslationFile | null;
  readonly durations?: Readonly<Record<string, number>>;
  readonly vo?: Readonly<Record<string, SampleVo>>;
  readonly normalize?: Readonly<Record<string, SampleNormalize>>;
  readonly markers?: Readonly<Record<string, readonly SampleMarker[]>>;
  readonly lipsync?: Readonly<Record<string, number>>;
  readonly languages?: LanguageSettings;
  readonly localisation?: AudioLocalisation;
}

/** The fixture project as the models read it; options replace parts. */
export function fixtureData(o: FixtureOptions = {}): DialogueData {
  const durations = o.durations ?? FIXTURE_DURATIONS;
  const vo = o.vo ?? { "audio/vo/fr/ch1/guard_01.ogg": { key: "guard_01", textHash: textHash("Stop! Who's there?") }, "audio/vo/fr/ch1/intro_01.wav": { key: "intro_01", textHash: textHash(INTRO_01_TEXT) } };
  const strings = o.strings === undefined ? fixtureStrings() : o.strings;
  const french = o.french === undefined ? fixtureFrench() : o.french;
  return {
    languages: o.languages ?? FIXTURE_LANGUAGES,
    localisation: o.localisation ?? fixtureLocalisation(),
    subtitles: defaultSubtitleProjectSettings(),
    tables: [{ path: TABLE_PATH, table: o.table ?? fixtureTable() }],
    strings: (p) => (p === STRINGS_PATH ? strings : null),
    translation: (p, code) => (p === STRINGS_PATH && code === "fr" ? french : null),
    exists: (p) => p in durations,
    duration: (p) => durations[p] ?? null,
    facts: (p): FileFacts | null => (p in durations ? { vo: vo[p] ?? null, normalize: o.normalize?.[p] ?? null, markers: o.markers?.[p] ?? [], lipsync: o.lipsync?.[p] ?? null } : null),
  };
}
