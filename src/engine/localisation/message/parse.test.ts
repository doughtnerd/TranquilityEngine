import { describe, expect, it } from "vitest";
import type { MessageNode } from "./ast";
import { isWellFormed, MESSAGE_LIMITS, parseMessage } from "./parse";

/** The tree without spans, for readable expectations. */
function shape(nodes: readonly MessageNode[]): unknown[] {
  return nodes.map((n) => {
    switch (n.type) {
      case "text": return n.value;
      case "pound": return "#";
      case "argument": return { arg: n.name };
      case "number": case "date": case "time": return { [n.type]: n.name, style: n.style };
      case "select": return { select: n.name, options: Object.fromEntries(n.options.map((o) => [o.key, shape(o.value)])) };
      case "plural": return { [n.ordinal ? "selectordinal" : "plural"]: n.name, offset: n.offset, options: Object.fromEntries(n.options.map((o) => [o.key, shape(o.value)])) };
    }
  });
}

const ok = (message: string) => {
  const parse = parseMessage(message);
  expect(parse.problems).toEqual([]);
  return shape(parse.ast);
};

describe("parseMessage: well-formed messages", () => {
  it("reads text and simple arguments", () => {
    expect(ok("Start game")).toEqual(["Start game"]);
    expect(ok("Hello, {name}!")).toEqual(["Hello, ", { arg: "name" }, "!"]);
    expect(ok("{ name }")).toEqual([{ arg: "name" }]);
    expect(ok("{0} and {1}")).toEqual([{ arg: "0" }, " and ", { arg: "1" }]);
    expect(ok("{名前}さん")).toEqual([{ arg: "名前" }, "さん"]);
    expect(ok("")).toEqual([]);
  });

  it("reads number, date and time arguments with styles and skeletons", () => {
    expect(ok("{n, number}")).toEqual([{ number: "n", style: null }]);
    expect(ok("{n, number, integer}")).toEqual([{ number: "n", style: "integer" }]);
    expect(ok("{n,number,percent}")).toEqual([{ number: "n", style: "percent" }]);
    expect(ok("{n, number, ::compact-short currency/EUR .00 group-off sign-always}")).toEqual([{ number: "n", style: "::compact-short currency/EUR .00 group-off sign-always" }]);
    expect(ok("{d, date, short} {t, time, full}")).toEqual([{ date: "d", style: "short" }, " ", { time: "t", style: "full" }]);
    expect(ok("{d, date}")).toEqual([{ date: "d", style: null }]);
  });

  it("reads plural with offset, exact matches and #", () => {
    expect(ok("{count, plural, =0 {No coins} one {# coin} other {# coins}}")).toEqual([
      { plural: "count", offset: 0, options: { "=0": ["No coins"], one: ["#", " coin"], other: ["#", " coins"] } },
    ]);
    expect(ok("{n, plural, offset:1 =0 {nobody} =1 {{host}} one {{host} and # other} other {{host} and # others}}")).toEqual([
      { plural: "n", offset: 1, options: { "=0": ["nobody"], "=1": [{ arg: "host" }], one: [{ arg: "host" }, " and ", "#", " other"], other: [{ arg: "host" }, " and ", "#", " others"] } },
    ]);
  });

  it("reads selectordinal and select, nested", () => {
    expect(ok("{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}")).toEqual([
      { selectordinal: "n", offset: 0, options: { one: ["#", "st"], two: ["#", "nd"], few: ["#", "rd"], other: ["#", "th"] } },
    ]);
    expect(ok("{gender, select, female {{n, plural, one {She has # coin} other {She has # coins}}} other {{n, plural, one {They have #} other {They have #}}}}")).toEqual([
      {
        select: "gender",
        options: {
          female: [{ plural: "n", offset: 0, options: { one: ["She has ", "#", " coin"], other: ["She has ", "#", " coins"] } }],
          other: [{ plural: "n", offset: 0, options: { one: ["They have ", "#"], other: ["They have ", "#"] } }],
        },
      },
    ]);
  });

  it("keeps # literal outside a plural branch and inside a select nested in one (as ICU does)", () => {
    expect(ok("#1 player")).toEqual(["#1 player"]);
    expect(ok("{n, plural, other {{g, select, other {#}}}}")).toEqual([{ plural: "n", offset: 0, options: { other: [{ select: "g", options: { other: ["#"] } }] } }]);
  });

  it("resolves apostrophe quoting as ICU's default mode", () => {
    expect(ok("l'heure, don't")).toEqual(["l'heure, don't"]);
    expect(ok("It''s")).toEqual(["It's"]);
    expect(ok("'{name}' is literal")).toEqual(["{name} is literal"]);
    expect(ok("a '{'b'}' c")).toEqual(["a {b} c"]);
    expect(ok("'{it''s}'")).toEqual(["{it's}"]);
    expect(ok("{n, plural, other {'#' is # }}")).toEqual([{ plural: "n", offset: 0, options: { other: ["# is ", "#", " "] } }]);
    expect(ok("'#' outside")).toEqual(["'#' outside"]);
    expect(ok("unterminated '{ quote")).toEqual(["unterminated { quote"]);
  });

  it("records source spans", () => {
    const { ast } = parseMessage("Hi {name}, {n, number}");
    expect(ast.map((n) => [n.start, n.end])).toEqual([[0, 3], [3, 9], [9, 11], [11, 22]]);
  });
});

describe("parseMessage: problems", () => {
  const problems = (m: string) => parseMessage(m).problems.map((p) => [p.severity, p.message, p.start]);

  it("reports a malformed argument once, with its position, and keeps it as written", () => {
    const parse = parseMessage("Hi {name, foo} there");
    expect(problems("Hi {name, foo} there")).toEqual([["error", '"foo" isn\'t number, date, time, plural, selectordinal or select', 10]]);
    expect(shape(parse.ast)).toEqual(["Hi {name, foo} there"]);
    expect(isWellFormed(parse)).toBe(false);
  });

  it("reports unclosed and stray braces", () => {
    expect(problems("Hi {name")).toEqual([["error", "expected , or }", 8]]);
    expect(shape(parseMessage("Hi {name").ast)).toEqual(["Hi {name"]);
    expect(problems("Hi } there")).toEqual([["warning", "this } closes nothing; kept as text", 3]]);
    expect(problems("{}")).toEqual([["error", "an argument needs a name", 1]]);
    expect(problems("{n, plural, one {x}")).toEqual([["error", "expected }", 19]]);
  });

  it("reports bad branches", () => {
    expect(problems("{n, plural, one {a} one {b} other {c}}")[0]).toEqual(["error", 'the branch "one" is there twice', 20]);
    expect(problems("{n, select, =0 {a} other {b}}")[0]).toEqual(["error", "=0 works only in a plural", 12]);
    expect(problems("{n, plural, }")[0]).toEqual(["error", "a choice needs at least one branch", 12]);
    expect(problems("{n, plural, one}")[0]).toEqual(["error", 'expected { after "one"', 15]);
  });

  it("warns, without making it malformed, for a missing other and unknown styles", () => {
    const missingOther = parseMessage("{n, plural, one {a}}");
    expect(missingOther.problems.map((p) => p.severity)).toEqual(["warning"]);
    expect(isWellFormed(missingOther)).toBe(true);
    expect(problems("{n, number, ::scientific .00}")).toEqual([["warning", 'unknown number style "scientific"; ignored', 11]]);
    expect(problems("{n, number, currency}")).toEqual([["warning", 'unknown number style "currency"; ignored', 11]]);
    expect(problems("{d, date, ::yMMMd}")).toEqual([["warning", '"::yMMMd" isn\'t short, medium, long or full; using medium', 9]]);
  });

  it("applies the limits", () => {
    const many = Array.from({ length: MESSAGE_LIMITS.placeholders + 1 }, (_, i) => `{a${i}}`).join("");
    expect(problems(many)).toEqual([["error", `at most ${MESSAGE_LIMITS.placeholders} arguments in a message`, many.lastIndexOf("{")]]);
    let deep = "x";
    for (let i = 0; i < MESSAGE_LIMITS.depth + 1; i++) deep = `{v${i}, select, other {${deep}}}`;
    expect(problems(deep).filter(([s]) => s === "error")).toEqual([["error", `choices nest at most ${MESSAGE_LIMITS.depth} deep`, deep.indexOf("{v0")]]);
    expect(problems("a".repeat(MESSAGE_LIMITS.length + 1))).toEqual([["error", `at most ${MESSAGE_LIMITS.length} characters in a message`, MESSAGE_LIMITS.length]]);
  });

  it("never throws, whatever the input", () => {
    // A seeded generator of messages from the syntax's own characters.
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const alphabet = ["{", "}", ",", "#", "'", " ", "n", "x", "plural", "select", "selectordinal", "number", "date", "other", "one", "=0", "offset:1", "::", "é", "\u{1F3AE}"];
    for (let i = 0; i < 3000; i++) {
      const m = Array.from({ length: Math.floor(rnd() * 30) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      const parse = parseMessage(m);
      expect(Array.isArray(parse.ast)).toBe(true);
      for (const p of parse.problems) expect(p.start).toBeLessThanOrEqual(m.length);
    }
    expect(() => parseMessage(undefined as unknown as string)).not.toThrow();
    expect(() => parseMessage("{".repeat(10_000))).not.toThrow();
    expect(() => parseMessage("{a, select, other {".repeat(2_000))).not.toThrow();
  });
});
