// Selector lists for queries (`UIView.query("#play")`, ADR 0423), read without a CSS parser: the
// cascade's selector grammar (tags, `*`, `#id`, `.class`, `:hover`/`:pressed`/`:focus`/`:disabled`,
// `:lang()`, `:is()`/`:where()`/`:not()`, the structural pseudo-classes, `:empty`, `:root`, attribute
// selectors, and the descendant, child and sibling combinators, ADR 0422 wave 5; `:has()` with relative selectors and
// a trailing pseudo-element, `::before`, ADR 0432) as the same `Selector`
// data the stylesheet parser makes, so games using only Svelte UI can query without loading css-tree.
// The stylesheet parser reads attribute selectors and the wave 5 pseudo-classes with it too
// (`parseCompoundText`), so rule data and queries read them alike.
import { isKnownTag, PSEUDO, PSEUDO_ELEMENTS, selectorSpecificity, type SelectorGroup } from "./cascade";
import type { Combinator, Selector, SimpleSelector, UIAttributeSelector, UINthSelector, UIPseudo, UIPseudoElement } from "./types";

type Compound = {
  tag: string | null;
  id: string | null;
  classes: string[];
  pseudo: UIPseudo[];
  lang: string[];
  is?: SelectorGroup[];
  not?: Selector[][];
  nth?: UINthSelector[];
  attributes?: UIAttributeSelector[];
  empty?: boolean;
  root?: boolean;
  has?: Selector[][];
};

const IDENT = /^-?(?:[A-Za-z_]|[^\x00-\x7f]|\\.)(?:[\w-]|[^\x00-\x7f]|\\.)*/;

/** The UI's pseudo-classes and (ADR 0432) pseudo-elements, for messages. */
const supported = (): string => `:hover, :pressed (or :active), :focus, :disabled, :lang(), :is(), :where(), :not(), :first-child, :last-child, :only-child, :nth-child(), :nth-last-child(), :first-of-type, :last-of-type, :only-of-type, :nth-of-type(), :nth-last-of-type(), :empty, :root and :has(); pseudo-elements: ${[...PSEUDO_ELEMENTS].map((n) => `::${n}`).join(", ")}`;

/**
 * Parse a selector list (`#shop .row > span, button:hover`) into selectors to match. Throws an Error
 * that says what's wrong for anything outside the grammar the cascade matches. `anyTag` takes any element name
 * (the Svelte renderer's nodes keep tags no UI element has, such as `output`); otherwise only known ones.
 */
export function parseSelectorQuery(text: string, options?: { anyTag?: boolean }): Selector[] {
  const reader = { text, i: 0, anyTag: options?.anyTag ?? false };
  const list = readList(reader);
  skipSpace(reader);
  if (reader.i < text.length) fail(reader, `unexpected "${text[reader.i]}"`);
  return list;
}

/**
 * The compound selector `text` is (`[data-open]`, `:nth-child(2n+1 of .row)`, `li.a:not(.b)`): what the stylesheet
 * parser hands over for the parts it doesn't read itself. Throws an Error saying what's wrong.
 */
export function parseCompoundText(text: string): SimpleSelector {
  const reader = { text, i: 0 };
  const compound = readCompound(reader);
  if (!compound || reader.i < text.length) fail(reader, `"${text}" isn't one compound selector`);
  return compound;
}

interface Reader {
  readonly text: string;
  /** Element names needn't be known UI tags. */
  readonly anyTag?: boolean;
  i: number;
  /** Inside `:has()`, where another `:has()` isn't supported (ADR 0432). */
  inHas?: boolean;
  /** How many functional pseudo-classes it's inside (ADR 0432: pseudo-elements only at the top). */
  depth?: number;
  /** ADR 0432: the pseudo-element the compound just read ends with, which its selector takes. */
  pseudoElement?: UIPseudoElement;
}

function fail(r: Reader, why: string): never {
  throw new Error(`${why} at ${r.i + 1}`);
}

function skipSpace(r: Reader): boolean {
  const start = r.i;
  while (r.i < r.text.length && /\s/.test(r.text[r.i])) r.i++;
  return r.i > start;
}

/** An identifier, with CSS escapes (`\:`) undone. */
function ident(r: Reader, what: string): string {
  const m = IDENT.exec(r.text.slice(r.i));
  if (!m) fail(r, `expected ${what}`);
  r.i += m[0].length;
  return m[0].replace(/\\(.)/g, "$1");
}

/** A comma-separated list, up to the end or a `)`. */
function readList(r: Reader): Selector[] {
  const out: Selector[] = [];
  for (;;) {
    out.push(readComplex(r));
    skipSpace(r);
    if (r.text[r.i] !== ",") return out;
    r.i++;
  }
}

/** A complex selector; `leading` (ADR 0432): a relative selector's combinator, which its first part carries. */
function readComplex(r: Reader, leading: Combinator | null = null): Selector {
  skipSpace(r);
  const parts: { selector: SimpleSelector; combinator: Combinator | null }[] = [];
  let combinator: Combinator | null = null;
  let pseudoElement: UIPseudoElement | undefined;
  for (;;) {
    const compound = readCompound(r);
    if (!compound) {
      if (parts.length === 0 || (combinator !== null && combinator !== " ")) fail(r, "expected a selector");
      break;
    }
    parts.push({ selector: compound, combinator: parts.length === 0 ? leading : (combinator ?? " ") });
    if (r.pseudoElement) {
      // ADR 0432: a pseudo-element ends its selector.
      pseudoElement = r.pseudoElement;
      r.pseudoElement = undefined;
      skipSpace(r);
      const next = r.text[r.i];
      if (next !== undefined && next !== "," && next !== ")") fail(r, `a pseudo-element (::${pseudoElement}) ends its selector`);
      break;
    }
    const spaced = skipSpace(r);
    const c = r.text[r.i];
    if (c === ">" || c === "+" || c === "~") {
      r.i++;
      skipSpace(r);
      combinator = c;
    } else if (spaced && c !== undefined && c !== "," && c !== ")") combinator = " ";
    else break;
  }
  const only = parts.length === 1 && !pseudoElement ? parts[0].selector : null;
  const root = !leading && !!only?.root && !only.tag && !only.id && !only.classes.length && !only.pseudo.length && !only.lang.length && !only.is && !only.not && !only.nth && !only.attributes && !only.empty && !only.has;
  const specificity = selectorSpecificity(parts, pseudoElement);
  return pseudoElement ? { parts, specificity, root, pseudoElement } : { parts, specificity, root };
}

/** `:has()`'s argument (ADR 0432): relative selectors, each with an optional leading `>`, `+` or `~` (descendants without). */
function readRelativeList(r: Reader): Selector[] {
  const out: Selector[] = [];
  for (;;) {
    skipSpace(r);
    let leading: Combinator = " ";
    const c = r.text[r.i];
    if (c === ">" || c === "+" || c === "~") {
      r.i++;
      leading = c;
    }
    out.push(readComplex(r, leading));
    skipSpace(r);
    if (r.text[r.i] !== ",") return out;
    r.i++;
  }
}

/** A compound selector, or null when none starts here. */
function readCompound(r: Reader): SimpleSelector | null {
  const out: Compound = { tag: null, id: null, classes: [], pseudo: [], lang: [] };
  let any = false;
  if (r.text[r.i] === "*") {
    r.i++;
    any = true;
  } else if (IDENT.test(r.text.slice(r.i))) {
    const at = r.i;
    const tag = ident(r, "an element");
    if (!r.anyTag && !isKnownTag(tag)) {
      r.i = at;
      fail(r, `unknown element "${tag}"`);
    }
    out.tag = tag;
    any = true;
  }
  for (;;) {
    const c = r.text[r.i];
    if (c === "#") {
      r.i++;
      out.id = ident(r, "an id");
    } else if (c === ".") {
      r.i++;
      out.classes.push(ident(r, "a class"));
    } else if (c === ":") {
      r.i++;
      if (r.text[r.i] === ":") {
        r.i++;
        readPseudoElement(r, ident(r, "a pseudo-element").toLowerCase());
        any = true;
        break;
      }
      readPseudo(r, out);
      if (r.pseudoElement) {
        any = true;
        break; // `:before`, `:after`
      }
    } else if (c === "[") {
      (out.attributes ??= []).push(readAttribute(r));
    } else break;
    any = true;
  }
  return any ? out : null;
}

/** ADR 0432: a pseudo-element's name (`::before`): known, outside functional pseudo-classes, ending its compound. */
function readPseudoElement(r: Reader, name: string): void {
  const at = r.i - name.length;
  if (!PSEUDO_ELEMENTS.has(name)) {
    r.i = at;
    fail(r, `::${name} isn't supported; UI pseudo-elements are ${[...PSEUDO_ELEMENTS].map((n) => `::${n}`).join(", ")}`);
  }
  if (r.depth) {
    r.i = at;
    fail(r, `a pseudo-element (::${name}) can't be inside a pseudo-class's argument`);
  }
  const next = r.text[r.i];
  if (next === "." || next === "#" || next === ":" || next === "[") fail(r, `nothing may follow a pseudo-element (::${name}) in its compound`);
  r.pseudoElement = name as UIPseudoElement;
}

const NTH: Readonly<Record<string, { last?: true; ofType?: true }>> = {
  "nth-child": {},
  "nth-last-child": { last: true },
  "nth-of-type": { ofType: true },
  "nth-last-of-type": { last: true, ofType: true },
};

function readPseudo(r: Reader, out: Compound): void {
  const at = r.i;
  const name = ident(r, "a pseudo-class").toLowerCase();
  if (PSEUDO.has(name)) out.pseudo.push(name as UIPseudo);
  else if (name === "active") out.pseudo.push("pressed"); // ADR 0432: CSS's name for `:pressed`
  else if (name === "before" || name === "after") readPseudoElement(r, name); // CSS 2's one-colon form
  else if (name === "is" || name === "where") {
    open(r, name);
    const selectors = readList(r);
    close(r, name);
    (out.is ??= []).push({ selectors, zero: name === "where" });
  } else if (name === "not") {
    open(r, name);
    const selectors = readList(r);
    close(r, name);
    (out.not ??= []).push(selectors);
  } else if (name === "has") {
    if (r.inHas) {
      r.i = at;
      fail(r, ":has() inside :has() isn't supported");
    }
    open(r, name);
    r.inHas = true;
    try {
      (out.has ??= []).push(readRelativeList(r));
    } finally {
      r.inHas = false;
    }
    close(r, name);
  } else if (name === "lang") {
    open(r, name);
    skipSpace(r);
    const range = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*/.exec(r.text.slice(r.i));
    if (!range) fail(r, ":lang() takes one language code, such as :lang(de)");
    r.i += range[0].length;
    out.lang.push(range[0]);
    close(r, name);
  } else if (name === "first-child" || name === "first-of-type") (out.nth ??= []).push({ a: 0, b: 1, ...(name === "first-of-type" ? { ofType: true } : {}) });
  else if (name === "last-child" || name === "last-of-type") (out.nth ??= []).push({ a: 0, b: 1, last: true, ...(name === "last-of-type" ? { ofType: true } : {}) });
  else if (name === "only-child" || name === "only-of-type") {
    const ofType = name === "only-of-type" ? { ofType: true as const } : {};
    (out.nth ??= []).push({ a: 0, b: 1, ...ofType }, { a: 0, b: 1, last: true, ...ofType });
  } else if (NTH[name]) {
    open(r, name);
    skipSpace(r);
    const { a, b } = readAnPlusB(r, name);
    skipSpace(r);
    let of: Selector[] | undefined;
    if (/^of\s/i.test(r.text.slice(r.i))) {
      if (NTH[name].ofType) fail(r, `:${name}() takes no "of" selector`);
      r.i += 2;
      of = readList(r);
    }
    close(r, name);
    (out.nth ??= []).push({ a, b, ...NTH[name], ...(of ? { of } : {}) });
  } else if (name === "empty") out.empty = true;
  else if (name === "root") out.root = true;
  else {
    r.i = at;
    fail(r, `:${name} isn't supported; UI pseudo-classes are ${supported()}`);
  }
}

/** `an+b`, `odd`, `even`, `3`, `-n+2`… */
function readAnPlusB(r: Reader, name: string): { a: number; b: number } {
  const rest = r.text.slice(r.i);
  const word = /^(odd|even)(?![\w-])/i.exec(rest);
  if (word) {
    r.i += word[0].length;
    return word[1].toLowerCase() === "odd" ? { a: 2, b: 1 } : { a: 2, b: 0 };
  }
  const m = /^([+-]?\d*)n(?:\s*([+-])\s*(\d+))?|^([+-]?\d+)/i.exec(rest);
  if (!m) fail(r, `:${name}() takes an+b (2n+1, odd, even, 3)`);
  r.i += m[0].length;
  if (m[4] !== undefined) return { a: 0, b: parseInt(m[4], 10) };
  const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10);
  const b = m[3] !== undefined ? parseInt(m[3], 10) * (m[2] === "-" ? -1 : 1) : 0;
  return { a, b };
}

/** `[name]`, `[name op value]`, `[name op "value" i]`. */
function readAttribute(r: Reader): UIAttributeSelector {
  r.i++; // [
  skipSpace(r);
  const name = ident(r, "an attribute name").toLowerCase();
  skipSpace(r);
  if (r.text[r.i] === "]") {
    r.i++;
    return { name };
  }
  const op = /^([~|^$*]?=)/.exec(r.text.slice(r.i));
  if (!op) fail(r, `expected "]" or an attribute operator (=, ~=, |=, ^=, $=, *=)`);
  r.i += op[1].length;
  skipSpace(r);
  let value: string;
  const q = r.text[r.i];
  if (q === '"' || q === "'") {
    const end = r.text.indexOf(q, r.i + 1);
    if (end < 0) fail(r, "the attribute value's quote isn't closed");
    value = r.text.slice(r.i + 1, end).replace(/\\(.)/g, "$1");
    r.i = end + 1;
  } else value = ident(r, "an attribute value");
  skipSpace(r);
  let insensitive = false;
  const flag = /^([is])(?![\w-])/i.exec(r.text.slice(r.i));
  if (flag) {
    insensitive = flag[1].toLowerCase() === "i";
    r.i += 1;
    skipSpace(r);
  }
  if (r.text[r.i] !== "]") fail(r, `the attribute selector isn't closed with "]"`);
  r.i++;
  return { name, op: op[1] as UIAttributeSelector["op"], value, ...(insensitive ? { insensitive } : {}) };
}

function open(r: Reader, name: string): void {
  if (r.text[r.i] !== "(") fail(r, `:${name}() needs its argument in parentheses`);
  r.i++;
  r.depth = (r.depth ?? 0) + 1;
}

function close(r: Reader, name: string): void {
  skipSpace(r);
  if (r.text[r.i] !== ")") fail(r, `:${name}( isn't closed`);
  r.i++;
  r.depth = (r.depth ?? 1) - 1;
}
