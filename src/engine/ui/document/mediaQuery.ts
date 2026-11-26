/**
 * Canvas media queries (ADR 0418 wave 5): a hand-written reader for media query lists (`(min-width: 600px) and
 * (orientation: landscape), print`) into data (`UIMediaQuery`), and their evaluation against a canvas in UI pixels.
 * No CSS parser: the stylesheet parser reads `@media` preludes with it when styles compile, and the Svelte renderer's
 * `window.matchMedia` reads queries with it in games.
 *
 * Features: `width`, `height`, `aspect-ratio` (each with `min-`/`max-`, and in range form `(400px <= width < 800px)`)
 * and `orientation`, and (ADR 0427) the user-preference features `prefers-reduced-motion` (`no-preference`, `reduce`)
 * and `prefers-color-scheme` (`light`, `dark`) from `UIPreferences`, which match with or without a canvas. Lengths are `px` (`em`/`rem` are 16px, as in browsers' media queries); ratios are `16/9` or a
 * number. Media types `all` and `screen` match, any other never does. An unknown feature is unknown, which never
 * matches (`not` of it neither), as in Media Queries level 4; a query that can't be read matches nothing (`not all`).
 */
import type { UIMediaCondition, UIMediaEnvironment, UIMediaQuery } from "./types";
import { UIPreferences } from "../preferences";

/** A query that never matches: what a query that can't be read becomes. */
const NEVER: UIMediaQuery = { not: true, type: "all" };

/**
 * Read a media query list. Throws an Error saying what's wrong when `strict`; otherwise a query that can't be read
 * becomes one that never matches, as browsers treat it.
 */
export function parseMediaQueryList(text: string, strict = false): UIMediaQuery[] {
  const out: UIMediaQuery[] = [];
  for (const part of splitTop(text, ",")) {
    try {
      out.push(readQuery(part));
    } catch (err) {
      if (strict) throw new Error(`"${part.trim()}": ${(err as Error).message}`);
      out.push(NEVER);
    }
  }
  return out;
}

/** True when any query of the list matches `env` (an empty list matches, as `@media {}` does). */
export function matchMediaQueries(list: readonly UIMediaQuery[], env: UIMediaEnvironment | null | undefined): boolean {
  if (list.length === 0) return true;
  return list.some((q) => matchQuery(q, env));
}

// --- Evaluating ---------------------------------------------------------------------------------------

function matchQuery(q: UIMediaQuery, env: UIMediaEnvironment | null | undefined): boolean {
  const type = (q.type ?? "all").toLowerCase();
  const typeOk = type === "all" || type === "screen";
  const cond = q.condition ? evaluate(q.condition, env) : true;
  if (cond === null) return false; // unknown: neither the query nor its `not` matches
  const result = typeOk && cond;
  return q.not ? !result : result;
}

/** True, false, or null for unknown (an unknown feature, or a size before the canvas has one). */
function evaluate(c: UIMediaCondition, env: UIMediaEnvironment | null | undefined): boolean | null {
  if ("and" in c) {
    let unknown = false;
    for (const x of c.and) {
      const v = evaluate(x, env);
      if (v === false) return false;
      if (v === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ("or" in c) {
    let unknown = false;
    for (const x of c.or) {
      const v = evaluate(x, env);
      if (v === true) return true;
      if (v === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ("not" in c) {
    const v = evaluate(c.not, env);
    return v === null ? null : !v;
  }
  return feature(c.feature, c.op, c.value, env);
}

/** User-preference features (ADR 0427): their values, the first being the one that's false in a boolean context. */
const PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  "prefers-reduced-motion": ["no-preference", "reduce"],
  "prefers-color-scheme": ["light", "dark"],
};

/** A user-preference feature from `UIPreferences`, with or without a canvas. */
function preference(name: string, op: string | undefined, value: number | string | undefined): boolean | null {
  const actual = name === "prefers-reduced-motion" ? (UIPreferences.reducedMotion ? "reduce" : "no-preference") : UIPreferences.colorScheme;
  // Boolean context: `prefers-color-scheme` has no "none" value, so it's always true (Media Queries level 5).
  if (op === undefined) return name === "prefers-color-scheme" || actual !== PREFERENCES[name][0];
  if (op !== "=" || typeof value !== "string" || !PREFERENCES[name].includes(value.toLowerCase())) return null;
  return actual === value.toLowerCase();
}

function feature(name: string, op: string | undefined, value: number | string | undefined, env: UIMediaEnvironment | null | undefined): boolean | null {
  if (name in PREFERENCES) return preference(name, op, value);
  if (!env) return null;
  const { width, height } = env;
  let actual: number | string;
  switch (name) {
    case "width":
      actual = width;
      break;
    case "height":
      actual = height;
      break;
    case "aspect-ratio":
      actual = height > 0 ? width / height : 0;
      break;
    case "orientation":
      actual = height >= width ? "portrait" : "landscape";
      break;
    default:
      return null;
  }
  if (op === undefined) return typeof actual === "string" ? true : actual !== 0;
  if (typeof actual === "string" || typeof value === "string") return op === "=" ? actual === value : null;
  const v = value ?? 0;
  // Sizes compare to a hundredth of a pixel, so a canvas scaled to exactly 600 UI pixels is 600.
  const a = Math.round(actual * 1e4) / 1e4;
  const b = Math.round(v * 1e4) / 1e4;
  switch (op) {
    case "=":
      return a === b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
  return null;
}

// --- Reading -------------------------------------------------------------------------------------------

const FEATURES: ReadonlySet<string> = new Set(["width", "height", "aspect-ratio", "orientation"]);

interface Reader {
  readonly text: string;
  i: number;
}

/** `text` split on `sep` outside parentheses. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function space(r: Reader): void {
  while (r.i < r.text.length && /\s/.test(r.text[r.i])) r.i++;
}

function word(r: Reader): string | null {
  space(r);
  const m = /^[A-Za-z][\w-]*/.exec(r.text.slice(r.i));
  return m ? m[0] : null;
}

function takeWord(r: Reader, w: string): boolean {
  const got = word(r);
  if (got?.toLowerCase() !== w) return false;
  r.i += got.length;
  return true;
}

function readQuery(text: string): UIMediaQuery {
  const r: Reader = { text, i: 0 };
  space(r);
  if (r.i >= text.length) throw new Error("an empty query");
  let result: UIMediaQuery;
  if (text[r.i] === "(" || word(r)?.toLowerCase() === "not" && peekParen(r)) {
    result = { condition: readCondition(r) };
  } else {
    const not = takeWord(r, "not");
    if (!not) takeWord(r, "only");
    const type = word(r);
    if (!type) throw new Error("expected a media type or a condition");
    r.i += type.length;
    space(r);
    let condition: UIMediaCondition | undefined;
    if (r.i < text.length) {
      if (!takeWord(r, "and")) throw new Error(`expected "and" after ${type}`);
      condition = readCondition(r, true);
    }
    result = { ...(not ? { not: true } : {}), type: type.toLowerCase(), ...(condition ? { condition } : {}) };
  }
  space(r);
  if (r.i < text.length) throw new Error(`unexpected "${text.slice(r.i).trim()}"`);
  return result;
}

/** After `not`, a `(`: the condition form (`not (width < 600px)`) rather than a negated media type. */
function peekParen(r: Reader): boolean {
  const at = r.i;
  takeWord(r, "not");
  space(r);
  const paren = r.text[r.i] === "(";
  r.i = at;
  return paren;
}

/** A condition: `not <term>`, or terms joined all by `and` or all by `or`. `andOnly` after a media type. */
function readCondition(r: Reader, andOnly = false): UIMediaCondition {
  space(r);
  if (takeWord(r, "not")) return { not: readTerm(r) };
  const first = readTerm(r);
  const terms = [first];
  let joiner: "and" | "or" | null = null;
  for (;;) {
    space(r);
    const w = word(r)?.toLowerCase();
    if (w !== "and" && w !== "or") break;
    if (andOnly && w === "or") throw new Error(`"or" can't follow a media type`);
    if (joiner && joiner !== w) throw new Error(`"and" and "or" can't mix without parentheses`);
    joiner = w;
    r.i += w.length;
    terms.push(readTerm(r));
  }
  if (terms.length === 1) return first;
  return joiner === "or" ? { or: terms } : { and: terms };
}

/** `( condition )` or `( feature )`. */
function readTerm(r: Reader): UIMediaCondition {
  space(r);
  if (r.text[r.i] !== "(") throw new Error(`expected "("`);
  // Find the matching close paren.
  let depth = 0;
  let j = r.i;
  for (; j < r.text.length; j++) {
    if (r.text[j] === "(") depth++;
    else if (r.text[j] === ")" && --depth === 0) break;
  }
  if (j >= r.text.length) throw new Error(`"(" isn't closed`);
  const inner = r.text.slice(r.i + 1, j);
  r.i = j + 1;
  const trimmed = inner.trim();
  if (trimmed.startsWith("(") || /^not\s*\(/i.test(trimmed)) {
    const sub: Reader = { text: inner, i: 0 };
    const c = readCondition(sub);
    space(sub);
    if (sub.i < inner.length) throw new Error(`unexpected "${inner.slice(sub.i).trim()}"`);
    return c;
  }
  return readFeature(trimmed);
}

const RANGE_OPS = /^(<=|>=|<|>|=)/;
const FLIP: Readonly<Record<string, "=" | "<" | "<=" | ">" | ">=">> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

/** `name`, `name: value`, `name op value`, `value op name`, `value op name op value`. */
function readFeature(text: string): UIMediaCondition {
  const colon = text.indexOf(":");
  if (colon >= 0) {
    const raw = text.slice(0, colon).trim().toLowerCase();
    const valueText = text.slice(colon + 1).trim();
    const prefix = raw.startsWith("min-") ? "min" : raw.startsWith("max-") ? "max" : null;
    const name = prefix ? raw.slice(4) : raw;
    if (!/^[a-z][\w-]*$/.test(name)) throw new Error(`"${raw}" isn't a media feature`);
    if (!FEATURES.has(name)) return { feature: name, op: "=", value: valueText };
    const value = featureValue(name, valueText);
    if (prefix && name === "orientation") throw new Error(`orientation has no ${prefix}- form`);
    return { feature: name, op: prefix === "min" ? ">=" : prefix === "max" ? "<=" : "=", value };
  }
  if (/^[a-z][\w-]*$/i.test(text)) {
    const name = text.toLowerCase();
    if (name.startsWith("min-") || name.startsWith("max-")) throw new Error(`${name} needs a value`);
    return { feature: name };
  }
  // Range form.
  const tokens: string[] = [];
  let rest = text;
  while (rest.length) {
    rest = rest.trimStart();
    const op = RANGE_OPS.exec(rest);
    if (op) {
      tokens.push(op[0]);
      rest = rest.slice(op[0].length);
      continue;
    }
    const m = /^[^<>=]+/.exec(rest);
    if (!m) break;
    tokens.push(m[0].trim());
    rest = rest.slice(m[0].length);
  }
  const isName = (t: string) => /^[a-z][\w-]*$/i.test(t) && !/^\d/.test(t);
  if (tokens.length === 3) {
    const [a, op, b] = tokens;
    if (isName(a)) return range(a.toLowerCase(), op as never, b);
    if (isName(b)) return range(b.toLowerCase(), FLIP[op], a);
  } else if (tokens.length === 5 && isName(tokens[2])) {
    const name = tokens[2].toLowerCase();
    const [lo, op1, , op2, hi] = tokens;
    if (!/^</.test(op1) && !/^>/.test(op1)) throw new Error("a range with two ends compares with < or >");
    return { and: [range(name, FLIP[op1], lo), range(name, op2 as never, hi)] };
  }
  throw new Error(`"${text}" isn't a media feature`);
}

function range(name: string, op: "=" | "<" | "<=" | ">" | ">=", valueText: string): UIMediaCondition {
  if (!FEATURES.has(name)) return { feature: name, op, value: valueText.trim() };
  if (name === "orientation") throw new Error("orientation can't be a range");
  return { feature: name, op, value: featureValue(name, valueText.trim()) as number };
}

function featureValue(name: string, text: string): number | string {
  if (name === "orientation") {
    const v = text.toLowerCase();
    if (v !== "portrait" && v !== "landscape") throw new Error("orientation is portrait or landscape");
    return v;
  }
  if (name === "aspect-ratio") {
    const m = /^(\d+\.?\d*|\.\d+)\s*(?:\/\s*(\d+\.?\d*|\.\d+))?$/.exec(text);
    if (!m) throw new Error(`"${text}" isn't a ratio (16/9 or 1.5)`);
    const r = parseFloat(m[1]) / (m[2] !== undefined ? parseFloat(m[2]) : 1);
    if (!Number.isFinite(r)) throw new Error(`"${text}" isn't a ratio`);
    return r;
  }
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|em|rem)?$/i.exec(text);
  if (!m || (m[2] === undefined && parseFloat(m[1]) !== 0)) throw new Error(`"${text}" isn't a length (px)`);
  const n = parseFloat(m[1]);
  return m[2] && m[2].toLowerCase() !== "px" ? n * 16 : n;
}
