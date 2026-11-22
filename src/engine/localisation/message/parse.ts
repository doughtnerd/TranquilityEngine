/**
 * The engine's ICU MessageFormat 1 parser (ADR 0342 §2): `{name}`, `{n, number[, style]}`, `{d, date|time[, style]}`,
 * `{n, plural, [offset:k] =0 {…} one {…} other {…}}` with `#`, `{n, selectordinal, …}` and `{x, select, …}`, with
 * ICU's default apostrophe quoting (`''` is one apostrophe, `'{…}'` literal text, a lone apostrophe literal).
 *
 * It never throws. A malformed argument is reported with its position and kept in the tree as the text it was written
 * as (from its `{` to its matching `}`, or to the end); a lint (no `other` branch, an unknown style token) is a warning.
 * `#` is special only directly in a plural or selectordinal branch, as in ICU and `@formatjs/icu-messageformat-parser`.
 *
 * Pure; no plugin, no DOM.
 */
import type { MessageNode, MessageParse, MessageProblem, OptionNode } from "./ast";
import { DATE_STYLES, numberStyleOptions } from "./numberStyle";

/** Limits of one message, declared once (ADR 0306, 0342 §1). */
export const MESSAGE_LIMITS = Object.freeze({
  /** Characters (UTF-16 units). */
  length: 4000,
  /** Arguments of any kind, nested ones included. */
  placeholders: 64,
  /** Plural, selectordinal and select arguments inside one another. */
  depth: 8,
});

const NAME = /[\p{L}\p{N}\p{M}_]+/uy;
const SELECTOR = /=-?\d+(?:\.\d+)?|[\p{L}\p{N}\p{M}_]+/uy;
const WORD = /[A-Za-z]+/y;
const SPACE = /\s*/y;
const OFFSET = /offset:\s*(-?\d+)/y;

/** Thrown inside the parser only, caught by the argument it broke. */
class Broken {
  constructor(readonly message: string, readonly at: number) {}
}

class Parser {
  i = 0;
  placeholders = 0;
  constructor(readonly s: string, readonly problems: MessageProblem[]) {}

  problem(severity: MessageProblem["severity"], message: string, start: number, end = start + 1): void {
    this.problems.push({ severity, message, start, end: Math.min(Math.max(end, start), this.s.length) });
  }

  match(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (m) this.i = re.lastIndex;
    return m;
  }

  space(): void {
    this.match(SPACE);
  }

  expect(c: string, what: string): void {
    if (this.s[this.i] !== c) throw new Broken(`expected ${what}`, this.i);
    this.i++;
  }

  /** Nodes until the end, or (in a branch) until the `}` closing it, which is left for the caller. */
  message(depth: number, inPlural: boolean, inBranch: boolean): MessageNode[] {
    const out: MessageNode[] = [];
    const text = (value: string, start: number) => {
      const last = out[out.length - 1];
      if (last?.type === "text" && last.end === start) { last.value += value; last.end = this.i; }
      else out.push({ type: "text", value, start, end: this.i });
    };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      const start = this.i;
      if (c === "{") {
        const node = this.argument(depth);
        if (typeof node === "string") text(node, start);
        else out.push(node);
      } else if (c === "}") {
        if (inBranch) break;
        this.i++;
        this.problem("warning", "this } closes nothing; kept as text", start);
        text("}", start);
      } else if (c === "#" && inPlural) {
        this.i++;
        out.push({ type: "pound", start, end: this.i });
      } else text(this.text(inPlural), start);
    }
    return out;
  }

  /** Literal text up to the next `{`, `}` (or `#` in a plural branch), resolving apostrophe quoting. */
  text(inPlural: boolean): string {
    const s = this.s;
    const special = (ch: string | undefined) => ch === "{" || ch === "}" || (inPlural && ch === "#");
    let out = "";
    while (this.i < s.length && !special(s[this.i])) {
      const c = s[this.i];
      if (c !== "'") { out += c; this.i++; continue; }
      const next = s[this.i + 1];
      if (next === "'") { out += "'"; this.i += 2; continue; }
      if (!special(next)) { out += "'"; this.i++; continue; }
      // A quoted run: literal up to the next lone apostrophe (`''` inside it is one); unterminated, to the end.
      this.i++;
      while (this.i < s.length) {
        if (s[this.i] === "'") {
          if (s[this.i + 1] === "'") { out += "'"; this.i += 2; continue; }
          this.i++;
          break;
        }
        out += s[this.i++];
      }
    }
    return out;
  }

  /** An argument at `{`; when broken, its source text (with the problem reported). */
  argument(depth: number): MessageNode | string {
    const start = this.i;
    const before = this.problems.length;
    try {
      return this.argumentNode(depth);
    } catch (e) {
      if (!(e instanceof Broken)) throw e;
      // Keep only the outermost failure's problem; the broken part stays as written, to its matching brace.
      this.problems.length = before;
      this.problem("error", `${e.message}`, e.at);
      let level = 0;
      let j = start;
      for (; j < this.s.length; j++) {
        if (this.s[j] === "{") level++;
        else if (this.s[j] === "}" && --level === 0) break;
      }
      this.i = Math.min(j + 1, this.s.length);
      return this.s.slice(start, this.i);
    }
  }

  argumentNode(depth: number): MessageNode {
    const start = this.i++;
    this.space();
    const name = this.match(NAME)?.[0];
    if (!name) throw new Broken("an argument needs a name", this.i);
    if (++this.placeholders === MESSAGE_LIMITS.placeholders + 1) this.problem("error", `at most ${MESSAGE_LIMITS.placeholders} arguments in a message`, start);
    this.space();
    if (this.s[this.i] === "}") return { type: "argument", name, start, end: ++this.i };
    this.expect(",", ", or }");
    this.space();
    const typeAt = this.i;
    const type = this.match(WORD)?.[0] ?? "";
    this.space();
    switch (type) {
      case "number": case "date": case "time": {
        let style: string | null = null;
        if (this.s[this.i] === ",") {
          this.i++;
          const styleAt = this.i;
          const close = this.s.indexOf("}", this.i);
          if (close < 0) throw new Broken("this argument isn't closed", start);
          style = this.s.slice(this.i, close).trim();
          this.i = close;
          if (style === "") throw new Broken(`a ${type} style is empty`, styleAt);
          if (type === "number") {
            const { unknown } = numberStyleOptions(style);
            if (unknown.length) this.problem("warning", `unknown number style ${unknown.map((u) => `"${u}"`).join(", ")}; ignored`, styleAt, close);
          } else if (!(DATE_STYLES as readonly string[]).includes(style)) {
            this.problem("warning", `"${style}" isn't short, medium, long or full; using medium`, styleAt, close);
          }
        }
        this.expect("}", "}");
        return { type, name, style, start, end: this.i };
      }
      case "plural": case "selectordinal": case "select": {
        this.expect(",", `, before the ${type} branches`);
        this.space();
        let offset = 0;
        if (type !== "select") {
          const m = this.match(OFFSET);
          if (m) offset = Number(m[1]);
          this.space();
        }
        const options = this.options(depth, type !== "select", start);
        this.expect("}", "}");
        if (!options.some((o) => o.key === "other")) this.problem("warning", `a ${type} needs an "other" branch; the first branch is used instead`, start, this.i);
        return type === "select" ? { type: "select", name, options, start, end: this.i } : { type: "plural", name, ordinal: type === "selectordinal", offset, options, start, end: this.i };
      }
      default:
        throw new Broken(type ? `"${type}" isn't number, date, time, plural, selectordinal or select` : "expected an argument type", typeAt);
    }
  }

  options(depth: number, plural: boolean, argStart: number): OptionNode[] {
    if (depth + 1 > MESSAGE_LIMITS.depth) throw new Broken(`choices nest at most ${MESSAGE_LIMITS.depth} deep`, argStart);
    const out: OptionNode[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "}") {
      const start = this.i;
      const key = this.match(SELECTOR)?.[0];
      if (!key) throw new Broken("expected a branch name such as one, other or =0", this.i);
      if (key.startsWith("=") && !plural) throw new Broken(`${key} works only in a plural`, start);
      this.space();
      this.expect("{", `{ after "${key}"`);
      const value = this.message(depth + 1, plural, true);
      this.expect("}", "}");
      if (out.some((o) => o.key === key)) throw new Broken(`the branch "${key}" is there twice`, start);
      out.push({ key, value, start, end: this.i });
      this.space();
    }
    if (out.length === 0) throw new Broken("a choice needs at least one branch", this.i);
    return out;
  }
}

/** A message's tree and problems. Never throws. */
export function parseMessage(source: string): MessageParse {
  const problems: MessageProblem[] = [];
  const s = typeof source === "string" ? source : String(source);
  const p = new Parser(s, problems);
  if (s.length > MESSAGE_LIMITS.length) p.problem("error", `at most ${MESSAGE_LIMITS.length} characters in a message`, MESSAGE_LIMITS.length, s.length);
  try {
    return { ast: p.message(0, false, false), problems };
  } catch {
    // Unreachable by design (every failure is a `Broken`); kept so a parser bug can't throw into a game.
    return { ast: [{ type: "text", value: s, start: 0, end: s.length }], problems: [{ severity: "error", message: "the message couldn't be read", start: 0, end: s.length }] };
  }
}

/** True when the message has no error (warnings allowed). */
export const isWellFormed = (parse: MessageParse): boolean => !parse.problems.some((p) => p.severity === "error");
