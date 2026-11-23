// ADR 0354 §8–§9, 0357 §6: the Lines table's status per language — recorded, fallback (named), missing — and its flags:
// duration mismatch, script changed (sidecar `vo.textHash` against the reference text now), reading speed.
import { describe, expect, it } from "vitest";
import { textHash } from "../../../engine/localisation/textHash";
import { findLine } from "./dialogueData";
import { FIXTURE_DURATIONS, fixtureData, fixtureStrings, INTRO_01_TEXT, STRINGS_PATH } from "./dialogueFixture";
import { cellLabel, languageCell, languageCells } from "./lineStatus";
import { subtitleStrip } from "./subtitleStrip";

const ref = (data: ReturnType<typeof fixtureData>, key: string) => findLine(data, key)!;

describe("status per language", () => {
  it("is recorded, heard through the chain (named), or missing", () => {
    const data = fixtureData();
    const cells = languageCells(data, ref(data, "intro_01"));
    expect(cells.map((c) => [c.code, c.state.kind, c.state.kind === "fallback" ? c.state.from : null])).toEqual([
      ["en", "recorded", null],
      ["fr", "recorded", null],
      ["fr-CA", "fallback", "fr"],
      ["de", "fallback", "en"],
    ]);
    expect(languageCell(data, ref(data, "guard_01"), "fr").state).toEqual({ kind: "recorded", path: "audio/vo/fr/ch1/guard_01.ogg" });

    const { ["audio/vo/en/ch1/intro_02.wav"]: _gone, ...rest } = FIXTURE_DURATIONS;
    const without = fixtureData({ durations: rest });
    expect(languageCells(without, ref(without, "intro_02")).map((c) => c.state.kind)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(cellLabel(languageCell(without, ref(without, "intro_02"), "fr"))).toMatchObject({ text: "—", tone: "missing" });
  });

  it("flags a duration mismatch with both durations, only past the tolerance", () => {
    const data = fixtureData();
    const fr = languageCell(data, ref(data, "intro_01"), "fr");
    expect(fr.mismatch).toEqual({ duration: 2.4, reference: 1.2 });
    expect(cellLabel(fr).title).toContain("duration 2.4 s, reference 1.2 s");
    expect(languageCell(data, ref(data, "guard_01"), "fr").mismatch).toBeNull(); // 1.6 against 1.5
    expect(languageCell(data, ref(data, "intro_01"), "en").mismatch).toBeNull(); // the reference itself
    // A file not measured yet isn't flagged.
    const unmeasured = fixtureData({ durations: { ...FIXTURE_DURATIONS, "audio/vo/fr/ch1/intro_01.wav": NaN } });
    expect(languageCell({ ...unmeasured, duration: (p) => (p.includes("/fr/") ? null : unmeasured.duration(p)) }, ref(unmeasured, "intro_01"), "fr").mismatch).toBeNull();
  });

  it("flags a script change when the sidecar's text hash isn't the reference text's now", () => {
    const data = fixtureData();
    expect(languageCell(data, ref(data, "guard_01"), "fr").scriptChanged).toBe(true);
    expect(languageCell(data, ref(data, "intro_01"), "fr").scriptChanged).toBe(false);
    // Edit the reference text: the French intro now needs a new take.
    const strings = fixtureStrings();
    strings.strings[0].text = "We're very late.";
    const edited = fixtureData({ strings });
    expect(languageCell(edited, ref(edited, "intro_01"), "fr").scriptChanged).toBe(true);
    expect(cellLabel(languageCell(edited, ref(edited, "intro_01"), "fr")).text).toContain("✎");
    // No `vo` block (not batch imported): nothing to compare.
    const plain = fixtureData({ vo: {} });
    expect(languageCell(plain, ref(plain, "guard_01"), "fr").scriptChanged).toBe(false);
    expect(textHash(INTRO_01_TEXT)).toHaveLength(16);
    expect(STRINGS_PATH).toBe("audio/vo/ch1.strings.json");
  });

  it("flags a subtitle read faster than its language allows while the audio plays", () => {
    const data = fixtureData();
    const en = languageCell(data, ref(data, "intro_02"), "en");
    expect(en.readingSpeed).toEqual({ cps: 29, max: 15 });
    expect(cellLabel(en).text).toBe("✓ 29cps");
    expect(languageCell(data, ref(data, "intro_01"), "en").readingSpeed).toBeNull();
    expect(languageCell(data, ref(data, "breath_03"), "en").readingSpeed).toBeNull(); // never subtitled
  });
});

describe("subtitle strip", () => {
  it("pages a long subtitle, times pages by `sub` markers and warns about reading speed", () => {
    const data = fixtureData();
    const text = fixtureStrings().strings[1].text;
    const strip = subtitleStrip(text, "en", 3, data.languages, data.subtitles);
    expect(strip.pages.length).toBe(2);
    expect(strip.pages.every((p) => p.fast)).toBe(true);
    expect(strip.shown).toBeGreaterThan(3); // lingers after the audio
    expect(strip.warnings[0]).toMatch(/^\d+ cps, max 15/);
    const marked = subtitleStrip(text, "en", 3, data.languages, data.subtitles, [{ type: "cue", name: "sub", at: 2 }]);
    expect(marked.pages[0].cps).toBeLessThan(strip.pages[0].cps); // the first page gets two seconds of audio
    // Japanese reads at 4 characters per second by default.
    expect(subtitleStrip("こんにちは、元気ですか", "ja", 2, data.languages, data.subtitles).rule.speed).toBe(4);
  });
});
