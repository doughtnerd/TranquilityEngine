/**
 * Differential test (ADR 0342 §2): the engine's ICU MessageFormat 1 parser against `@formatjs/icu-messageformat-parser`,
 * a dev dependency used only here. Well-formed messages must give the same tree; malformed ones must be refused by both.
 * Skipped, with a message saying why, when the package isn't installed.
 */
import { describe, expect, it } from "vitest";
import type { MessageNode } from "./ast";
import { parseMessage } from "./parse";

const ORACLE = "@formatjs/icu-messageformat-parser";

interface OracleModule { parse(message: string, options?: { ignoreTag?: boolean; requiresOtherClause?: boolean }): unknown[] }
let oracle: OracleModule | null = null;
try {
  oracle = (await import(/* @vite-ignore */ ORACLE)) as OracleModule;
} catch {
  oracle = null;
}

type Shape = string | { [k: string]: unknown };

const merge = (list: Shape[]): Shape[] => list.reduce<Shape[]>((out, s) => {
  if (typeof s === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] = (out[out.length - 1] as string) + s;
  else out.push(s);
  return out;
}, []).filter((s) => s !== "");

const skeleton = (style: string | null) => (style?.startsWith("::") ? `::${style.slice(2).trim().split(/\s+/).join(" ")}` : style);

function ours(nodes: readonly MessageNode[]): Shape[] {
  return merge(nodes.map((n): Shape => {
    switch (n.type) {
      case "text": return n.value;
      case "pound": return { pound: true };
      case "argument": return { arg: n.name };
      case "number": return { number: n.name, style: skeleton(n.style) };
      case "date": case "time": return { [n.type]: n.name, style: skeleton(n.style) };
      case "select": return { select: n.name, options: Object.fromEntries(n.options.map((o) => [o.key, ours(o.value)])) };
      case "plural": return { plural: n.name, ordinal: n.ordinal, offset: n.offset, options: Object.fromEntries(n.options.map((o) => [o.key, ours(o.value)])) };
    }
  }));
}

/** formatjs's element types: 0 literal, 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural, 7 pound. */
function theirs(nodes: unknown[]): Shape[] {
  return merge(nodes.map((raw): Shape => {
    const n = raw as { type: number; value: string; style?: unknown; options?: Record<string, { value: unknown[] }>; offset?: number; pluralType?: string };
    const style = (s: unknown): string | null => {
      if (s === null || s === undefined) return null;
      if (typeof s === "string") return s.trim();
      const o = s as { tokens?: { stem: string; options: string[] }[]; pattern?: string };
      if (o.tokens) return `::${o.tokens.map((t) => [t.stem, ...t.options].join("/")).join(" ")}`;
      return `::${o.pattern ?? ""}`;
    };
    const options = () => Object.fromEntries(Object.entries(n.options ?? {}).map(([k, v]) => [k, theirs(v.value)]));
    switch (n.type) {
      case 0: return n.value;
      case 1: return { arg: n.value };
      case 2: return { number: n.value, style: style(n.style) };
      case 3: return { date: n.value, style: style(n.style) };
      case 4: return { time: n.value, style: style(n.style) };
      case 5: return { select: n.value, options: options() };
      case 6: return { plural: n.value, ordinal: n.pluralType === "ordinal", offset: n.offset ?? 0, options: options() };
      case 7: return { pound: true };
      default: return { unknown: n.type };
    }
  }));
}

const WELL_FORMED = [
  "Start game",
  "Hello, {name}!",
  "{ name }",
  "{0} and {1}",
  "{名前}さん",
  "{n, number}",
  "{n, number, integer}",
  "{n, number, percent}",
  "{n, number, ::compact-short}",
  "{n, number, ::currency/EUR .00}",
  "{n, number, ::unit/kilometer-per-hour group-off sign-always}",
  "{n, number, ::.0#}",
  "{d, date, short} at {d, time, short}",
  "{d, date}",
  "{d, date, full}",
  "{count, plural, =0 {No coins} one {# coin} other {# coins}}",
  "{n, plural, offset:1 =0 {nobody} =1 {{host}} one {{host} and # other} other {{host} and # others}}",
  "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
  "{gender, select, female {She} male {He} other {They}}",
  "{gender, select, female {{n, plural, one {She has # coin} other {She has # coins}}} other {{n, plural, one {They have #} other {They have #}}}}",
  "{n, plural, other {{g, select, other {#}}}}",
  "#1 player",
  "l'heure, don't",
  "It''s",
  "'{name}' is literal",
  "a '{'b'}' c",
  "'{it''s}'",
  "{n, plural, other {'#' is # }}",
  "'#' outside",
  "{n, plural, one {# монета} few {# монеты} many {# монет} other {# монеты}}",
  "{n, plural, zero {لا عملات} one {عملة واحدة} two {عملتان} few {# عملات} many {# عملة} other {# عملة}}",
  "{n,plural,one{#}other{#}}",
  "  spaced   text  ",
  "{a}{b}{c}",
  "Line\nbreak {x}",
  "Hi } stray",
];

const MALFORMED = [
  "Hi {name",

  "{}",
  "{name, foo}",
  "{n, plural, one {x}",
  "{n, plural, one {a} one {b} other {c}}",
  "{n, select, =0 {a} other {b}}",
  "{n, plural, }",
  "{n, plural, one}",
  "{n, plural, one {a}}",
  "{n, select, x {a}}",
  "{n, number, }",
  "{n,}",
  "{{n}}",
];

describe.skipIf(!oracle)(`parser against ${ORACLE}`, () => {
  for (const m of WELL_FORMED) {
    it(`same tree: ${JSON.stringify(m)}`, () => {
      const mine = parseMessage(m);
      expect(mine.problems.filter((p) => p.severity === "error")).toEqual([]);
      expect(ours(mine.ast)).toEqual(theirs(oracle!.parse(m, { ignoreTag: true })));
    });
  }
  for (const m of MALFORMED) {
    it(`both refuse: ${JSON.stringify(m)}`, () => {
      expect(() => oracle!.parse(m, { ignoreTag: true })).toThrow();
      expect(parseMessage(m).problems.length).toBeGreaterThan(0);
    });
  }
});

describe.skipIf(!oracle)(`parser against ${ORACLE}: generated messages`, () => {
  it("agrees on 5,000 seeded messages built from the syntax's own pieces", () => {
    let s = 2026;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const pieces = ["{", "}", ", ", ",", "#", "'", " ", "n", "x", "plural", "select", "selectordinal", "number", "date", "other", "one", "=0", "offset:1 ", "::", "{n}", "{n, plural, ", "{g, select, ", "other {", "one {", "é"];
    const disagreements: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const m = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("");
      let theirTree: Shape[] | null;
      try { theirTree = theirs(oracle!.parse(m, { ignoreTag: true })); } catch { theirTree = null; }
      const mine = parseMessage(m);
      // formatjs refuses what we refuse or lint (a missing `other` is our warning); what it reads we read the same.
      const agrees = theirTree === null
        ? mine.problems.length > 0
        : !mine.problems.some((p) => p.severity === "error") && JSON.stringify(ours(mine.ast)) === JSON.stringify(theirTree);
      if (!agrees) disagreements.push(m);
    }
    expect(disagreements.slice(0, 20)).toEqual([]);
  });
});

describe.runIf(!oracle)(`parser against ${ORACLE}`, () => {
  it.skip(`skipped: ${ORACLE} isn't installed (a dev dependency, ADR 0342 §2)`, () => {});
});
