import { describe, expect, it } from "vitest";
import { checkMessage, checkTranslation, messageArguments, pluralProblems } from "./check";
import { parseMessage } from "./parse";

const messages = (ps: { message: string }[]) => ps.map((p) => p.message);

describe("messageArguments", () => {
  it("lists every argument with its kinds, nested ones included", () => {
    const args = messageArguments(parseMessage("{a} {n, plural, one {{g, select, other {{d, date}}}} other {{a, number}}} {o, selectordinal, other {#}}").ast);
    expect(Object.fromEntries([...args].map(([k, v]) => [k, [...v]]))).toEqual({ a: ["simple", "number"], n: ["plural"], g: ["select"], d: ["date"], o: ["selectordinal"] });
  });
});

describe("checkTranslation", () => {
  const ref = "{count, plural, =0 {No coins} one {# coin} other {# coins}} for {name}";

  it("passes a good translation", () => {
    expect(checkTranslation(ref, "{count, plural, =0 {Aucune pièce} one {# pièce} many {# de pièces} other {# pièces}} pour {name}", "fr")).toEqual([]);
    expect(checkTranslation(ref, "{name}に{count}枚", "ja")).toEqual([]);
  });

  it("refuses argument names the reference doesn't use, pointing at them", () => {
    const tr = "{count, plural, one {# pièce} many {#} other {# pièces}} pour {nom}";
    const problems = checkTranslation(ref, tr, "fr");
    expect(messages(problems)).toEqual(['"nom" isn\'t an argument of the reference text']);
    expect(problems[0].start).toBe(tr.indexOf("{nom}"));
  });

  it("refuses a change of kind", () => {
    expect(messages(checkTranslation(ref, "{count, select, other {x}} {name}", "en"))).toEqual(['"count" is a plural in the reference text, not a select']);
    expect(messages(checkTranslation("{d, date, short}", "{d, number}", "en"))).toEqual(['"d" is a date in the reference text, not a number']);
    expect(checkTranslation("{n, plural, one {#} other {#}}", "{n, number}", "en")).toEqual([]);
  });

  it("asks for each plural category the language needs", () => {
    expect(messages(checkTranslation(ref, "{count, plural, one {# moneta} other {# monety}} {name}", "pl", "Polish"))).toEqual(['Polish needs few and many in the plural of "count"']);
    expect(messages(checkTranslation(ref, "{count, plural, one {#} few {#} many {#} other {#}} {name}", "pl"))).toEqual([]);
    expect(messages(checkTranslation(ref, "{count, plural, one {#} other {#}} {name}", "ar", "Arabic"))).toEqual(['Arabic needs few, many, two and zero in the plural of "count"']);
    expect(messages(checkTranslation("{n, selectordinal, other {#.}}", "{n, selectordinal, one {#st} other {#th}}", "en"))).toEqual(['en needs few and two in the selectordinal of "n"']);
  });

  it("reports parse errors of the translation", () => {
    expect(checkTranslation(ref, "{count, plural, one {#}", "en").map((p) => p.severity)).toContain("error");
  });
});

describe("checkMessage and pluralProblems", () => {
  it("checks a reference message in its own language", () => {
    expect(checkMessage("{n, plural, one {# coin} other {# coins}}", "en")).toEqual([]);
    expect(messages(checkMessage("{n, plural, one {# coin}}", "en"))).toEqual(['a plural needs an "other" branch; the first branch is used instead']);
    expect(messages(pluralProblems(parseMessage("{n, plural, one {#} other {#}}").ast, "ru", "Russian"))).toEqual(['Russian needs few and many in the plural of "n"']);
    expect(pluralProblems(parseMessage("{n, plural, other {#}}").ast, "ja")).toEqual([]);
  });
});
