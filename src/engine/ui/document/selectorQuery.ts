// Selector lists for queries (`UIView.query("#play")`, ADR 0419), read without a CSS parser: the
// cascade's selector grammar (tags, `*`, `#id`, `.class`, `:hover`/`:pressed`/`:focus`/`:disabled`,
// `:lang()`, `:is()`/`:where()`, descendant and child combinators) as the same `Selector` data the
// stylesheet parser makes, so games using only Svelte UI can query without loading css-tree.
import { groupSpecificity, isKnownTag, PSEUDO, type SelectorGroup } from "./cascade";
import type { Selector, SimpleSelector, UIPseudo } from "./types";

type Compound = { tag: string | null; id: string | null; classes: string[]; pseudo: UIPseudo[]; lang: string[]; is?: SelectorGroup[] };

const IDENT = /^-?(?:[A-Za-z_]|[^\x00-\x7f])(?:[\w-]|[^\x00-\x7f])*/;

/**
 * Parse a selector list (`#shop .row > span, button:hover`) into selectors to match. Throws an Error
 * that says what's wrong for anything outside the grammar the cascade matches.
 */
export function parseSelectorQuery(text: string): Selector[] {
  const reader = { text, i: 0 };
  const list = readList(reader);
  skipSpace(reader);
  if (reader.i < text.length) fail(reader, `unexpected "${text[reader.i]}"`);
  return list;
}

interface Reader {
  readonly text: string;
  i: number;
}

function fail(r: Reader, why: string): never {
  throw new Error(`${why} at ${r.i + 1}`);
}

function skipSpace(r: Reader): boolean {
  const start = r.i;
  while (r.i < r.text.length && /\s/.test(r.text[r.i])) r.i++;
  return r.i > start;
}

function ident(r: Reader, what: string): string {
  const m = IDENT.exec(r.text.slice(r.i));
  if (!m) fail(r, `expected ${what}`);
  r.i += m[0].length;
  return m[0];
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

function readComplex(r: Reader): Selector {
  skipSpace(r);
  const parts: { selector: SimpleSelector; combinator: " " | ">" | null }[] = [];
  let combinator: " " | ">" | null = null;
  for (;;) {
    const compound = readCompound(r);
    if (!compound) {
      if (parts.length === 0 || combinator === ">") fail(r, "expected a selector");
      break;
    }
    parts.push({ selector: compound, combinator: parts.length === 0 ? null : (combinator ?? " ") });
    const spaced = skipSpace(r);
    const c = r.text[r.i];
    if (c === ">") {
      r.i++;
      skipSpace(r);
      combinator = ">";
    } else if (c === "+" || c === "~") fail(r, `the "${c}" combinator isn't supported; use descendants (A B) or children (A > B)`);
    else if (spaced && c !== undefined && c !== "," && c !== ")") combinator = " ";
    else break;
  }
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const p of parts) {
    if (p.selector.id) ids++;
    classes += p.selector.classes.length + p.selector.pseudo.length + p.selector.lang.length;
    if (p.selector.tag) tags++;
    for (const g of p.selector.is ?? []) {
      const [a, b, c] = groupSpecificity(g);
      ids += a;
      classes += b;
      tags += c;
    }
  }
  return { parts, specificity: [ids, classes, tags], root: false };
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
    if (!isKnownTag(tag)) {
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
      if (r.text[r.i] === ":") fail(r, "pseudo-elements aren't supported");
      const name = ident(r, "a pseudo-class");
      if (PSEUDO.has(name)) out.pseudo.push(name as UIPseudo);
      else if (name === "is" || name === "where") {
        open(r, name);
        const selectors = readList(r);
        close(r, name);
        (out.is ??= []).push({ selectors, zero: name === "where" });
      } else if (name === "lang") {
        open(r, name);
        skipSpace(r);
        const range = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*/.exec(r.text.slice(r.i));
        if (!range) fail(r, ":lang() takes one language code, such as :lang(de)");
        r.i += range[0].length;
        out.lang.push(range[0]);
        close(r, name);
      } else fail(r, `:${name} isn't supported; UI pseudo-classes are :hover, :pressed, :focus, :disabled, :lang(), :is() and :where()`);
    } else if (c === "[") fail(r, "attribute selectors aren't supported");
    else break;
    any = true;
  }
  return any ? out : null;
}

function open(r: Reader, name: string): void {
  if (r.text[r.i] !== "(") fail(r, `:${name}() needs its argument in parentheses`);
  r.i++;
}

function close(r: Reader, name: string): void {
  skipSpace(r);
  if (r.text[r.i] !== ")") fail(r, `:${name}( isn't closed`);
  r.i++;
}
