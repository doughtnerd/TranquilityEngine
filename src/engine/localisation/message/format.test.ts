import { describe, expect, it } from "vitest";
import { formatMessageText as fmt, pluralCategories, type MessageArgs } from "./format";

const num = (tag: string, n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, o).format(n);

describe("formatMessage: arguments", () => {
  it("formats strings, numbers, booleans, dates and objects", () => {
    expect(fmt("Hello, {name}!", { name: "Ava" }, "en")).toBe("Hello, Ava!");
    expect(fmt("{n}", { n: 1234567.5 }, "fr")).toBe(num("fr", 1234567.5));
    expect(fmt("{n}", { n: 12345678901234567890n }, "en")).toBe(new Intl.NumberFormat("en").format(12345678901234567890n));
    expect(fmt("{b}", { b: true }, "en")).toBe("true");
    const d = new Date(Date.UTC(2026, 10, 22, 12));
    expect(fmt("{d}", { d }, "en")).toBe(new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d));
    expect(fmt("{title}", { title: { toString: () => "Quest" } }, "en")).toBe("Quest");
  });

  it("keeps a missing argument as {name} and reports it", () => {
    const missing: string[] = [];
    expect(fmt("Hi {name}, {n, number}", { name: null }, "en", (n) => missing.push(n))).toBe("Hi {name}, {n}");
    expect(missing).toEqual(["name", "n"]);
    expect(fmt("{n, plural, one {# coin} other {# coins}}", {}, "en")).toBe("{n} coins");
  });

  it("formats number styles and skeletons on Intl", () => {
    const table: [string, MessageArgs, string, string][] = [
      ["{n, number}", { n: 1234.5 }, "en", num("en", 1234.5)],
      ["{n, number, integer}", { n: 1234.56 }, "en", num("en", 1234.56, { maximumFractionDigits: 0 })],
      ["{n, number, percent}", { n: 0.25 }, "fr", num("fr", 0.25, { style: "percent" })],
      ["{n, number, ::percent}", { n: 0.5 }, "en", "50%"],
      ["{n, number, ::compact-short}", { n: 12000 }, "en", "12K"],
      ["{n, number, ::compact-long}", { n: 12000 }, "en", "12 thousand"],
      ["{n, number, ::currency/EUR}", { n: 3.5 }, "fr", num("fr", 3.5, { style: "currency", currency: "EUR" })],
      ["{n, number, ::unit/kilometer-per-hour}", { n: 50 }, "en", num("en", 50, { style: "unit", unit: "kilometer-per-hour" })],
      ["{n, number, ::.00}", { n: 3 }, "en", "3.00"],
      ["{n, number, ::.0#}", { n: 3.456 }, "en", "3.46"],
      ["{n, number, ::group-off}", { n: 12345 }, "en", "12345"],
      ["{n, number, ::sign-always}", { n: 5 }, "en", "+5"],
      ["{n, number, ::currency/XYZ!}", { n: 5 }, "en", "5"],
      ["{n, number}", { n: "12" }, "en", "12"],
      ["{n, number}", { n: "abc" }, "en", "abc"],
    ];
    for (const [m, args, tag, want] of table) expect(fmt(m, args, tag), m).toBe(want);
  });

  it("formats dates and times by style", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 15, 4));
    for (const style of ["short", "medium", "long", "full"] as const) {
      expect(fmt(`{d, date, ${style}}`, { d }, "de")).toBe(new Intl.DateTimeFormat("de", { dateStyle: style }).format(d));
      expect(fmt(`{d, time, ${style}}`, { d }, "ja")).toBe(new Intl.DateTimeFormat("ja", { timeStyle: style }).format(d));
    }
    expect(fmt("{d, date}", { d: d.getTime() }, "en")).toBe(new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d));
  });

  it("falls back for a tag Intl refuses, never throwing", () => {
    expect(() => fmt("{n}", { n: 5 }, "not a tag!")).not.toThrow();
    expect(fmt("{n, plural, one {one} other {other}}", { n: 1 }, "!!")).toBe(new Intl.PluralRules().select(1) === "one" ? "one" : "other");
  });
});

// One message per language with every category it has, checked across numbers.
const PLURALS: Record<string, string> = {
  en: "{n, plural, =0 {none} one {# coin} other {# coins}}",
  fr: "{n, plural, =0 {aucune} one {# pièce} many {# de pièces} other {# pièces}}",
  ru: "{n, plural, one {# монета} few {# монеты} many {# монет} other {# монеты}}",
  ar: "{n, plural, zero {لا عملات} one {عملة واحدة} two {عملتان} few {# عملات} many {# عملة} other {# عملة}}",
  ja: "{n, plural, other {#枚のコイン}}",
  pl: "{n, plural, one {# moneta} few {# monety} many {# monet} other {# monety}}",
};

const EXPECTED: Record<string, [number, string][]> = {
  en: [[0, "none"], [1, "1 coin"], [2, "2 coins"], [21, "21 coins"], [1.5, "1.5 coins"]],
  fr: [[0, "aucune"], [1, "1 pièce"], [1.5, `${num("fr", 1.5)} pièce`], [2, "2 pièces"], [1_000_000, `${num("fr", 1_000_000)} de pièces`]],
  ru: [[1, "1 монета"], [2, "2 монеты"], [5, "5 монет"], [11, "11 монет"], [21, "21 монета"], [22, "22 монеты"], [1.5, "1,5 монеты"]],
  ar: [[0, "لا عملات"], [1, "عملة واحدة"], [2, "عملتان"], [3, `${num("ar", 3)} عملات`], [11, `${num("ar", 11)} عملة`], [100, `${num("ar", 100)} عملة`]],
  ja: [[0, "0枚のコイン"], [1, "1枚のコイン"], [1000, `${num("ja", 1000)}枚のコイン`]],
  pl: [[1, "1 moneta"], [2, "2 monety"], [5, "5 monet"], [12, "12 monet"], [22, "22 monety"], [25, "25 monet"], [1.5, "1,5 monety"]],
};

describe("formatMessage: plurals across languages", () => {
  for (const [tag, cases] of Object.entries(EXPECTED)) {
    it(`${tag}: ${pluralCategories(tag).join(", ")}`, () => {
      for (const [n, want] of cases) expect(fmt(PLURALS[tag], { n }, tag), `${tag} ${n}`).toBe(want);
    });
  }

  it("subtracts the offset for categories and #, but matches =N before it", () => {
    const m = "{n, plural, offset:1 =0 {Nobody} =1 {{host}} one {{host} and # other} other {{host} and # others}}";
    expect(fmt(m, { n: 0, host: "Ava" }, "en")).toBe("Nobody");
    expect(fmt(m, { n: 1, host: "Ava" }, "en")).toBe("Ava");
    expect(fmt(m, { n: 2, host: "Ava" }, "en")).toBe("Ava and 1 other");
    expect(fmt(m, { n: 5, host: "Ava" }, "en")).toBe("Ava and 4 others");
  });

  it("picks ordinal categories", () => {
    const m = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map((n) => fmt(m, { n }, "en"))).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st"]);
    expect(fmt("{n, selectordinal, one {le #er} other {le #e}}", { n: 1 }, "fr")).toBe("le 1er");
    expect(fmt("{n, selectordinal, one {le #er} other {le #e}}", { n: 2 }, "fr")).toBe("le 2e");
  });

  it("falls back to other, then to the first branch", () => {
    expect(fmt("{n, plural, one {# monnaie} other {# autres}}", { n: 5 }, "ru")).toBe("5 autres");
    expect(fmt("{n, plural, one {only one}}", { n: 5 }, "en")).toBe("only one");
    expect(fmt("{n, plural, one {#} other {x}}", { n: "seven" }, "en")).toBe("x");
  });

  it("selects and nests", () => {
    const m = "{gender, select, female {{n, plural, one {Elle a # pièce} other {Elle a # pièces}}} male {{n, plural, one {Il a # pièce} other {Il a # pièces}}} other {{n, plural, one {On a # pièce} other {On a # pièces}}}}";
    expect(fmt(m, { gender: "female", n: 1 }, "fr")).toBe("Elle a 1 pièce");
    expect(fmt(m, { gender: "male", n: 3 }, "fr")).toBe("Il a 3 pièces");
    expect(fmt(m, { gender: "robot", n: 0 }, "fr")).toBe("On a 0 pièce");
    expect(fmt("{v, select, 1 {one} other {many}}", { v: 1 }, "en")).toBe("one");
  });

  it("keeps quoted text literal and # outside plurals", () => {
    expect(fmt("'{name}' is {name}, it''s #1", { name: "Ava" }, "en")).toBe("{name} is Ava, it's #1");
    expect(fmt("{n, plural, other {'#' # left}}", { n: 3 }, "en")).toBe("# 3 left");
  });

  it("formats a malformed message best effort, never throwing", () => {
    expect(fmt("Hi {name, foo} {x}", { x: 1 }, "en")).toBe("Hi {name, foo} 1");
    expect(fmt("{n, plural, one {x}", { n: 1 }, "en")).toBe("{n, plural, one {x}");
    expect(() => fmt("}}}{{{", {}, "en")).not.toThrow();
  });
});
