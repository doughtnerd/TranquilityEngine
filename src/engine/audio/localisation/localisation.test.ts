import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../project/format";
import { audioLocalisationToJson, defaultAudioLocalisation, durationMismatch, parseAudioLocalisation } from "./format";
import {
  emptyLineTable, formatLineTable, isLineKey, lineTableToJson, parseLineTable, stringTablePathOf, subtitleKeyOf, LINE_LIMITS,
} from "./lines/format";
import { isRecorded, lineFile, lineKeyIndex } from "./lines/resolve";

describe("audio.json localisation", () => {
  it("parses, round-trips and writes defaults as nothing", () => {
    const raw = { roots: ["audio/vo", "audio/barks/"], loudness: { mode: "loudness", target: -20 }, durationTolerance: 0.3, missing: "silent", captions: "strings/cc.strings.json" };
    const problems: string[] = [];
    const s = parseAudioLocalisation(raw, problems);
    expect(problems).toEqual([]);
    expect(s).toEqual({ ...raw, roots: ["audio/vo", "audio/barks"] });
    expect(parseAudioLocalisation(audioLocalisationToJson(s), [])).toEqual(s);
    expect(audioLocalisationToJson(defaultAudioLocalisation())).toBeNull();
    expect(parseAudioLocalisation(undefined, [])).toEqual(defaultAudioLocalisation());
  });

  it("drops roots that aren't folders, repeat or overlap, one problem each", () => {
    const problems: string[] = [];
    const s = parseAudioLocalisation({ roots: ["audio/vo", "../up", 4, "audio/vo/radio", "audio/vo"], missing: "loud", captions: "x.json" }, problems);
    expect(s.roots).toEqual(["audio/vo"]);
    expect(s.missing).toBe("subtitleOnly");
    expect(problems).toEqual([
      'localisation.roots[1]: "../up" isn\'t a project folder; dropped.',
      "localisation.roots[2]: 4 isn't a project folder; dropped.",
      'localisation.roots[3]: "audio/vo/radio" overlaps "audio/vo"; dropped.',
      'localisation.roots[4]: "audio/vo" is listed twice; dropped.',
      'localisation.missing: must be one of subtitleOnly, silent; using "subtitleOnly".',
      'localisation.captions: must be a .strings.json path; using "strings/captions.strings.json".',
    ]);
  });

  it("is part of audio.json, absent at the defaults", () => {
    const base = { format: "myco.audio@1" };
    const { project } = parseAudioProject({ ...base, localisation: { roots: ["audio/vo"] } });
    expect(project.localisation?.roots).toEqual(["audio/vo"]);
    expect(audioProjectToJson(project).localisation).toEqual({ roots: ["audio/vo"] });
    expect(parseAudioProject(audioProjectToJson(project)).project).toEqual(project);
    const plain = parseAudioProject(base).project;
    expect(plain.localisation).toBeUndefined();
    expect("localisation" in audioProjectToJson(plain)).toBe(false);
  });

  it("flags a duration mismatch past max(0.5 s, tolerance × reference)", () => {
    expect(durationMismatch(2.4, 2, 0.25)).toBe(false);
    expect(durationMismatch(2.6, 2, 0.25)).toBe(true);
    expect(durationMismatch(13, 10, 0.25)).toBe(true);
    expect(durationMismatch(12.4, 10, 0.25)).toBe(false);
  });
});

const CH1 = {
  format: "myco.lines@1",
  root: "audio/vo",
  folder: "ch1",
  output: "Voice",
  template: "audio/radio.playlist.json",
  priority: 60,
  speakers: ["Ava", "Guard"],
  strings: "audio/vo/ch1.strings.json",
  lines: [
    { key: "intro_01", speaker: "Ava", notes: "Whispered, out of breath", tags: ["main"] },
    { key: "intro_02", speaker: "Ava", textKey: "ch1.ava.late", files: { de: "audio/vo/de/ch1/intro_02_alt.wav" } },
    { key: "breath_03", speaker: "Ava", textKey: null, file: "breath", cooldown: 5, once: true },
  ],
};

describe("line tables", () => {
  it("parse the records' example and round-trip", () => {
    const { table, problems } = parseLineTable(CH1, "audio/vo/ch1.lines.json");
    expect(problems).toEqual([]);
    expect(table.lines.map(subtitleKeyOf)).toEqual(["intro_01", "ch1.ava.late", null]);
    expect(table.lines[2]).toMatchObject({ file: "breath", cooldown: 5, once: true });
    expect(lineTableToJson(table)).toEqual(CH1);
    expect(parseLineTable(lineTableToJson(table))).toEqual({ table, problems: [] });
    expect(formatLineTable(emptyLineTable())).toBe('{\n  "format": "myco.lines@1",\n  "lines": []\n}\n');
  });

  it("drop bad and repeated keys, a textKey equal to the key, and repair values", () => {
    const { table, problems } = parseLineTable({
      format: "myco.lines@1", folder: "../x", priority: 120, speakers: ["Ava", "", "Ava"],
      lines: [
        { key: "a" }, { key: "a" }, { key: "bad key" }, { key: "b", textKey: "b" }, { key: "c", textKey: "no spaces allowed" },
        { key: "d", files: { xx_1: "a.wav", fr: "" }, cooldown: -1, tags: ["t", "t", 3] },
      ],
    }, "t");
    expect(table.folder).toBe("");
    expect(table.priority).toBe(100);
    expect(table.speakers).toEqual(["Ava"]);
    expect(table.lines.map((l) => l.key)).toEqual(["a", "b", "c", "d"]);
    expect(table.lines[1].textKey).toBeUndefined();
    expect(table.lines[2].textKey).toBeUndefined();
    expect(table.lines[3]).toMatchObject({ files: {}, cooldown: 0, tags: ["t"] });
    expect(problems).toEqual([
      't.folder: "../x" isn\'t a folder; using the language folder itself.',
      "t.priority: 120 is outside 0..100; using 100.",
      "t.speakers[1]: must be a name; dropped.",
      't.lines[1].key: "a" is used twice; dropped.',
      't.lines[2].key: "bad key" isn\'t a line key (letters, digits, _ . -, at most 64); dropped.',
      't.lines[4].textKey: "no spaces allowed" isn\'t a string key; using the line key.',
      "t.lines[5].files.xx_1: isn't a language code; dropped.",
      "t.lines[5].files.fr: must be a project path; dropped.",
      "t.lines[5].tags[2]: must be a non-empty string; dropped.",
      "t.lines[5].cooldown: -1 is outside 0..3600; using 0.",
    ]);
  });

  it("keep 0340's retired text as read, with a problem, until it is moved", () => {
    const raw = { format: "myco.lines@1", lines: [{ key: "intro_01", text: { en: "We're late.", fr: "On est en retard." } }] };
    const { table, problems } = parseLineTable(raw);
    expect(table.lines[0].text).toEqual({ en: "We're late.", fr: "On est en retard." });
    expect(problems).toEqual(["lines.lines[0].text: subtitles live in the string table now (ADR 0343); kept until moved, and not shown."]);
    expect(lineTableToJson(table)).toEqual(raw);
  });

  it("find their string table: named, else beside the table", () => {
    expect(stringTablePathOf("audio/vo/ch1.lines.json", parseLineTable(CH1).table)).toBe("audio/vo/ch1.strings.json");
    expect(stringTablePathOf("dialogue/guards.lines.json", emptyLineTable())).toBe("dialogue/guards.strings.json");
  });

  it("apply the line limit and never throw", () => {
    const lines = Array.from({ length: LINE_LIMITS.lines + 2 }, (_, i) => ({ key: `k${i}` }));
    const { table, problems } = parseLineTable({ format: "myco.lines@1", lines });
    expect(table.lines.length).toBe(LINE_LIMITS.lines);
    expect(problems).toHaveLength(2);
    for (const junk of [null, 1, [], { lines: "x" }, { lines: [null, { key: 1 }] }, { root: 3, strings: 4 }]) expect(() => parseLineTable(junk)).not.toThrow();
    expect(isLineKey("intro_01")).toBe(true);
    expect(isLineKey("x".repeat(65))).toBe(false);
  });
});

describe("line files", () => {
  const { table } = parseLineTable(CH1);
  const [intro1, intro2, breath] = table.lines;
  const files = new Set(["audio/vo/en/ch1/intro_01.wav", "audio/vo/fr/ch1/intro_01.ogg", "audio/vo/en/ch1/intro_02.flac", "audio/vo/de/ch1/intro_02_alt.wav", "audio/vo/en/ch1/breath.sample.json"]);
  const exists = (p: string) => files.has(p);

  it("resolves through the chain: explicit files, then the folder rule by extension", () => {
    expect(lineFile(table, intro1, ["fr", "en"], [], exists)).toEqual({ path: "audio/vo/fr/ch1/intro_01.ogg", language: "fr" });
    expect(lineFile(table, intro2, ["fr", "en"], [], exists)).toEqual({ path: "audio/vo/en/ch1/intro_02.flac", language: "en" });
    expect(lineFile(table, intro2, ["de", "en"], [], exists)).toEqual({ path: "audio/vo/de/ch1/intro_02_alt.wav", language: "de" });
    expect(lineFile(table, breath, ["ja", "en"], [], exists)).toEqual({ path: "audio/vo/en/ch1/breath.sample.json", language: "en" });
    expect(lineFile(table, intro1, ["ja"], [], exists)).toBeNull();
  });

  it("uses the first localised root when the table names none", () => {
    const own = { ...table, root: null };
    expect(lineFile(own, intro1, ["en"], ["audio/vo"], exists)?.path).toBe("audio/vo/en/ch1/intro_01.wav");
    expect(lineFile(own, intro1, ["en"], [], exists)).toBeNull();
  });

  it("counts a line recorded in a language only by its own file", () => {
    expect(isRecorded(table, intro1, "fr", [], exists)).toBe(true);
    expect(isRecorded(table, intro2, "fr", [], exists)).toBe(false);
  });

  it("indexes keys across tables, first by path, reporting duplicates", () => {
    const a = parseLineTable({ format: "myco.lines@1", lines: [{ key: "x" }, { key: "y" }] }).table;
    const b = parseLineTable({ format: "myco.lines@1", lines: [{ key: "y" }, { key: "z" }] }).table;
    const { keys, duplicates } = lineKeyIndex([{ path: "b.lines.json", table: b }, { path: "a.lines.json", table: a }]);
    expect([...keys].map(([k, v]) => [k, v.path])).toEqual([["x", "a.lines.json"], ["y", "a.lines.json"], ["z", "b.lines.json"]]);
    expect(duplicates).toEqual([{ key: "y", paths: ["a.lines.json", "b.lines.json"] }]);
  });
});
