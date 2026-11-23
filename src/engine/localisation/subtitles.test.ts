import { describe, expect, it } from "vitest";
import { parseLanguages } from "./languages";
import { defaultSubtitleProjectSettings, parseSubtitlePlayerSettings, parseSubtitleSettings, subtitleSettingsToJson } from "./subtitleSettings";
import {
  characterCount, charactersPerSecond, fitsLines, pageTimes, pushRow, readingRule, readingSpeed, readingTime, splitPages, subMarkerTimes, type SubtitleRow,
} from "./subtitles";

describe("reading speed and time", () => {
  const { languages } = parseLanguages({ list: ["en", "ja", "zh-Hant", "ko", { code: "de", readingSpeed: 13 }, "fr"] });

  it("uses the language's own speed, then the built-in defaults, then the project's", () => {
    expect([["en", 15], ["ja", 4], ["zh-Hant", 9], ["zh", 9], ["ko", 12], ["de", 13], ["fr", 15]].map(([c]) => [c, readingSpeed(c as string, languages)])).toEqual(
      [["en", 15], ["ja", 4], ["zh-Hant", 9], ["zh", 9], ["ko", 12], ["de", 13], ["fr", 15]],
    );
    expect(readingSpeed("fr", languages, 17)).toBe(17);
    expect(readingSpeed("ja")).toBe(4);
    expect(readingRule("en", languages, { readingSpeed: 20, minDisplay: 2 })).toEqual({ speed: 20, minDisplay: 2 });
    expect(readingRule("ja", null, null)).toEqual({ speed: 4, minDisplay: 1.5 });
  });

  it("is max(minDisplay, characters / speed), counting graphemes and spaces", () => {
    const en = { speed: 15, minDisplay: 1.5 };
    const table: [string, { speed: number; minDisplay: number }, number][] = [
      ["We're late.", en, 1.5],
      ["x".repeat(30), en, 2],
      ["x".repeat(45), en, 3],
      ["遅れてるよ。", { speed: 4, minDisplay: 1.5 }, 1.5],
      ["今日はとても遅れてしまいました。", { speed: 4, minDisplay: 1.5 }, 4],
      ["", en, 1.5],
    ];
    for (const [text, rule, want] of table) expect(readingTime(text, rule), text).toBeCloseTo(want, 9);
    expect(characterCount("👩‍👩‍👧 é")).toBe(3);
    expect(characterCount("two\nlines")).toBe(8);
    expect(charactersPerSecond("x".repeat(42), 2)).toBe(21);
  });
});

describe("splitPages", () => {
  const fits = fitsLines(20, 1);

  it("keeps text that fits on one page", () => {
    expect(splitPages("We're late.", fits)).toEqual(["We're late."]);
    expect(splitPages("   ", fits)).toEqual([]);
  });

  it("splits at sentence ends first, balancing the halves", () => {
    expect(splitPages("Run. We are late for the meeting.", fitsLines(30, 1))).toEqual(["Run.", "We are late for the meeting."]);
    expect(splitPages("One two. Three four. Five six.", fitsLines(20, 1))).toEqual(["One two.", "Three four.", "Five six."]);
    expect(splitPages("One two. Three four. Five six.", fitsLines(21, 1))).toEqual(["One two.", "Three four. Five six."]);
  });

  it("then at clause marks, then at words", () => {
    expect(splitPages("If you go now, you will be early", fits)).toEqual(["If you go now,", "you will be early"]);
    expect(splitPages("alpha beta gamma delta epsilon", fits)).toEqual(["alpha beta gamma", "delta epsilon"]);
  });

  it("splits Japanese and Chinese at their own marks, then anywhere", () => {
    expect(splitPages("今日はとても暑いですね。明日は雨が降るでしょう。", fitsLines(14, 1))).toEqual(["今日はとても暑いですね。", "明日は雨が降るでしょう。"]);
    expect(splitPages("我们今天去，你明天来", fitsLines(6, 1))).toEqual(["我们今天去，", "你明天来"]);
    expect(splitPages("あいうえおかきくけこ", fitsLines(5, 1))).toEqual(["あいうえお", "かきくけこ"]);
  });

  it("forces a break at a blank line", () => {
    expect(splitPages("Short.\n\nAlso short.", fitsLines(42, 2))).toEqual(["Short.", "Also short."]);
  });

  it("measures by characters per line and lines per page", () => {
    expect(fitsLines(10, 2)("aaaa bbbb cccc")).toBe(true);
    expect(fitsLines(10, 2)("aaaa bbbb cccc dddd eeee")).toBe(false);
    expect(fitsLines(42, 2)("x".repeat(84))).toBe(true);
    expect(fitsLines(42, 2)("x".repeat(85))).toBe(false);
  });
});

describe("page times", () => {
  const rule = { speed: 15, minDisplay: 1.5 };

  it("shares the duration by characters without markers", () => {
    const pages = ["x".repeat(30), "x".repeat(15)];
    expect(pageTimes(pages, 6, rule)).toEqual([{ text: pages[0], start: 0, end: 4 }, { text: pages[1], start: 4, end: 6 }]);
  });

  it("times page changes with sub markers", () => {
    const pages = ["x".repeat(15), "x".repeat(15), "x".repeat(15)];
    expect(pageTimes(pages, 9, rule, [2, 6]).map((p) => [p.start, p.end])).toEqual([[0, 2], [2, 6], [6, 9]]);
    // One marker for three pages: the pages after it share the rest.
    expect(pageTimes(pages, 9, rule, [3]).map((p) => [p.start, p.end])).toEqual([[0, 3], [3, 6], [6, 9]]);
  });

  it("gives each page its reading time, the last lingering past the audio", () => {
    const pages = ["x".repeat(45), "x".repeat(45)];
    expect(pageTimes(pages, 4, rule).map((p) => [p.start, p.end])).toEqual([[0, 3], [3, 6]]);
    expect(pageTimes(["Hi."], 0.4, rule)).toEqual([{ text: "Hi.", start: 0, end: 1.5 }]);
    expect(pageTimes([], 3, rule)).toEqual([]);
  });

  it("reads sub markers from Cue markers", () => {
    expect(subMarkerTimes([{ type: "cue", name: "sub", at: 3 }, { type: "note", name: "sub", at: 1 }, { type: "cue", name: "sub", at: 1.5 }, { type: "cue", name: "beat", at: 2 }, { type: "cue", name: "sub", at: 9 }], 5)).toEqual([1.5, 3]);
  });
});

describe("rows", () => {
  const row = (id: number, kind: SubtitleRow["kind"], speaker: string | null = null): SubtitleRow => ({ id, kind, speaker });

  it("replaces a speaker's row and keeps the newest last", () => {
    expect(pushRow([row(1, "speech", "Ava"), row(2, "speech", "Guard")], row(3, "speech", "Ava"), 3).map((r) => r.id)).toEqual([2, 3]);
  });

  it("drops a caption before speech, then the oldest row", () => {
    expect(pushRow([row(1, "speech", "Ava"), row(2, "caption"), row(3, "speech", "Guard")], row(4, "speech", "Sniper"), 3).map((r) => r.id)).toEqual([1, 3, 4]);
    expect(pushRow([row(1, "speech", "Ava"), row(2, "speech", "Guard"), row(3, "speech", "Bob")], row(4, "caption"), 3).map((r) => r.id)).toEqual([2, 3, 4]);
    expect(pushRow([row(1, "caption")], row(2, "caption"), 1).map((r) => r.id)).toEqual([2]);
  });
});

describe("subtitles section", () => {
  it("parses, defaults and round-trips", () => {
    const raw = { defaults: { size: "large", captions: true }, readingSpeed: 17, minDisplay: 1, speakers: { Ava: { name: "speaker.ava", color: "#ffcc00" }, Guard: {} } };
    const { subtitles, problems } = parseSubtitleSettings(raw);
    expect(problems).toEqual([]);
    expect(subtitles).toEqual({
      defaults: { enabled: true, size: "large", background: 0.6, speakerNames: true, captions: true },
      readingSpeed: 17, minDisplay: 1, speakers: { Ava: { name: "speaker.ava", color: "#ffcc00" }, Guard: {} },
    });
    expect(subtitleSettingsToJson(subtitles)).toEqual(raw);
    expect(parseSubtitleSettings(subtitleSettingsToJson(subtitles))).toEqual({ subtitles, problems: [] });
    expect(parseSubtitleSettings(undefined)).toEqual({ subtitles: defaultSubtitleProjectSettings(), problems: [] });
    expect(subtitleSettingsToJson(defaultSubtitleProjectSettings())).toEqual({});
  });

  it("repairs bad values, one problem each", () => {
    const { subtitles, problems } = parseSubtitleSettings({ defaults: { size: "huge", background: 2 }, readingSpeed: 0, speakers: { Ava: { color: "red" }, Bob: 3 } });
    expect(subtitles.defaults).toMatchObject({ size: "medium", background: 1 });
    expect(subtitles.readingSpeed).toBe(1);
    expect(subtitles.speakers).toEqual({ Ava: {} });
    expect(problems).toEqual([
      'subtitles.defaults.size: must be one of small, medium, large, extraLarge; using "medium".',
      "subtitles.defaults.background: 2 is outside 0..1; using 1.",
      "subtitles.readingSpeed: 0 is outside 1..60; using 1.",
      "subtitles.speakers.Ava.color: must be a colour such as #ffcc00; dropped.",
      "subtitles.speakers.Bob: must be an object with name and colour; dropped.",
    ]);
    expect(parseSubtitlePlayerSettings({ enabled: false }, "stored", [], subtitles.defaults)).toMatchObject({ enabled: false, size: "medium" });
  });
});
