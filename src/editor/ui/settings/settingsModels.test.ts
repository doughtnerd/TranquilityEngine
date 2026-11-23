// ADR 0354 L7, 0356 T7, 0357 S5: the Project panel's Languages and Subtitles models — `project.json`'s `languages` and
// `subtitles` sections in the settings draft and their refused-or-next edits — driven through the models' interfaces.
import { describe, expect, it } from "vitest";
import { parseLanguages } from "../../../engine/localisation/languages";
import type { SettingsDraft } from "../../projectSettingsModel";
import type { EditResult } from "../localisation/editResult";
import {
  addFont, addLanguage, codesOf, languagesProblems, languagesSettings, moveLanguage, removeFont, removeLanguage, renameLanguage, setDefault,
  setDirection, setLanguageCode, setLanguageFallback, setLanguageVoice, setProjectFallback, setReference, setRemember, setShip,
  setUseSystemLanguage, setVoiceMode,
} from "./languagesSettingsModel";
import {
  addSpeaker, removeSpeaker, setMinDisplay, setReadingSpeed, setSpeakerColor, setSpeakerName, setSubtitleDefault, subtitlesProblems, subtitlesSettings, unlistedSpeakers,
} from "./subtitlesSettingsModel";

const next = (r: EditResult<SettingsDraft>): SettingsDraft => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = (r: EditResult<SettingsDraft>): string => ("refused" in r ? r.refused : "accepted");

const base: SettingsDraft = { name: "Game", languages: { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], reference: "en", default: "en" } };

describe("Project Settings > Languages", () => {
  it("reads the section leniently and writes it back minimal", () => {
    expect(languagesSettings.read({}).list.map((l) => l.code)).toEqual(["en"]);
    const d = next(setRemember(base, false));
    expect(d.languages).toEqual({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], reference: "en", default: "en", remember: false });
    expect(d.name).toBe("Game");
    expect(languagesProblems(d)).toEqual([]);
    expect(languagesProblems({ languages: { list: [{ code: "en" }, { code: "EN" }] } })[0].field).toBe("languages");
  });

  it("adds a language with its own name, a regional one falling back to its parent, and refuses duplicates and bad tags", () => {
    const d = next(addLanguage(base, "fr-ca"));
    const row = languagesSettings.read(d).list.at(-1)!;
    expect(row).toMatchObject({ code: "fr-CA", fallback: ["fr"] });
    expect(row.name).not.toBe("");
    expect(next(addLanguage(base, "ja", "日本語")).languages).toMatchObject({ list: expect.arrayContaining([{ code: "ja", name: "日本語" }]) });
    expect(refused(addLanguage(base, "FR"))).toBe("fr is already a project language");
    expect(refused(addLanguage(base, "not a tag"))).toMatch(/isn't a language tag/);
  });

  it("removes a language (chains lose it) but not the reference or start language", () => {
    const d = next(setLanguageFallback(next(addLanguage(base, "fr-CA")), "fr-CA", ["fr", "en"]));
    const gone = next(removeLanguage(d, "fr"));
    expect(languagesSettings.read(gone).list.map((l) => [l.code, l.fallback])).toEqual([["en", []], ["fr-CA", ["en"]]]);
    expect(refused(removeLanguage(base, "en"))).toBe("en is the reference language: choose another first");
  });

  it("edits codes, names, order, chains, shipping, direction, voice and fonts", () => {
    let d = next(addLanguage(base, "ar"));
    expect(languagesSettings.read(d).list.at(-1)!.direction).toBe("rtl");
    d = next(setDirection(d, "ar", "ltr"));
    expect((d.languages as { list: { code: string; direction?: string }[] }).list.at(-1)!.direction).toBe("ltr");
    d = next(setLanguageCode(d, "fr", "fr-FR"));
    expect(languagesSettings.read(d).list[1].code).toBe("fr-FR");
    expect(refused(setLanguageCode(d, "fr-FR", "en"))).toBe("en is already a project language");
    d = next(renameLanguage(d, "en", "English (US)"));
    expect(refused(renameLanguage(d, "en", " "))).toBe("a language needs a name");
    d = next(moveLanguage(d, "ar", -1));
    expect(languagesSettings.read(d).list.map((l) => l.code)).toEqual(["en", "ar", "fr-FR"]);
    expect(refused(moveLanguage(d, "en", -1))).toBe("it is first already");
    expect(refused(setLanguageFallback(d, "ar", ["ar"]))).toBe("a language can't fall back to itself");
    d = next(setProjectFallback(d, codesOf("fr-FR, en")));
    expect(languagesSettings.read(d).fallback).toEqual(["fr-FR", "en"]);
    d = next(setShip(d, "ar", false));
    expect(refused(setShip(next(setShip(d, "fr-FR", false)), "en", false))).toBe("at least one language must ship");
    expect(refused(setDefault(d, "ar"))).toBe("ar doesn't ship, so it can't be the start language");
    d = next(setLanguageVoice(d, "ar", false));
    expect(languagesSettings.read(d).list[1].voice).toBe(false);
    d = next(addFont(d, "ar", "fonts/NotoNaskhArabic.woff2"));
    expect(refused(addFont(d, "ar", "fonts/readme.txt"))).toMatch(/isn't a font file/);
    expect(refused(addFont(d, "ar", "fonts/NotoNaskhArabic.woff2"))).toMatch(/already/);
    expect(languagesSettings.read(next(removeFont(d, "ar", "fonts/NotoNaskhArabic.woff2"))).list[1].fonts).toEqual([]);
    d = next(setVoiceMode(next(setUseSystemLanguage(d, false)), "separate"));
    expect(languagesSettings.read(d)).toMatchObject({ useSystemLanguage: false, voice: "separate" });
    expect(parseLanguages(d.languages).problems).toEqual([]);
  });

  it("changes the reference language only while the project has no string tables", () => {
    expect(languagesSettings.read(next(setReference(base, "fr", 0)))).toMatchObject({ reference: "fr", fallback: ["fr"] });
    expect(refused(setReference(base, "fr", 2))).toMatch(/2 string tables are written in en/);
  });
});

describe("Project Settings > Subtitles", () => {
  it("edits the player defaults, reading speed and shortest display, refusing values out of range", () => {
    let d = next(setSubtitleDefault({}, "size", "large"));
    d = next(setSubtitleDefault(d, "background", 0.8));
    d = next(setSubtitleDefault(d, "captions", true));
    d = next(setReadingSpeed(d, 17));
    d = next(setMinDisplay(d, 2));
    expect(d.subtitles).toEqual({ defaults: { size: "large", background: 0.8, captions: true }, readingSpeed: 17, minDisplay: 2 });
    expect(refused(setReadingSpeed(d, 0))).toBe("the reading speed is 1 to 60 characters per second");
    expect(refused(setMinDisplay(d, 11))).toBe("the minimum display time is 0 to 10 seconds");
    expect(refused(setSubtitleDefault(d, "background", 2))).toBe("the background opacity is 0 to 100%");
    expect(subtitlesProblems(d)).toEqual([]);
    // Back to the defaults: the section leaves project.json.
    expect(next(setReadingSpeed(next(setMinDisplay(next(setSubtitleDefault(next(setSubtitleDefault(next(setSubtitleDefault(d, "size", "medium")), "background", 0.6)), "captions", false)), 1.5)), 15)).subtitles).toBeUndefined();
  });

  it("lists speakers with a name key and a colour, offering the line tables' speakers", () => {
    let d = next(addSpeaker({}, "Ava"));
    d = next(setSpeakerName(d, "Ava", "speaker.ava"));
    d = next(setSpeakerColor(d, "Ava", "#FFCC00"));
    expect(subtitlesSettings.read(d).speakers).toEqual({ Ava: { name: "speaker.ava", color: "#ffcc00" } });
    expect(refused(setSpeakerName(d, "Ava", "not a key!"))).toMatch(/isn't a string key/);
    expect(refused(setSpeakerColor(d, "Ava", "yellow"))).toMatch(/isn't a colour/);
    expect(refused(addSpeaker(d, "Ava"))).toBe("Ava is listed already");
    expect(subtitlesSettings.read(next(setSpeakerColor(next(setSpeakerName(d, "Ava", "")), "Ava", null))).speakers).toEqual({ Ava: {} });
    const files: [string, unknown][] = [["audio/vo/ch1.lines.json", { lines: [{ key: "a", speaker: "Ava" }, { key: "b", speaker: "Bo" }, { key: "c" }] }], ["x.json", {}]];
    expect(unlistedSpeakers(d, files)).toEqual(["Bo"]);
    expect(subtitlesSettings.read(next(removeSpeaker(d, "Ava"))).speakers).toEqual({});
  });
});
