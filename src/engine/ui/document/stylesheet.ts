/**
 * UI stylesheets (Svelte components' CSS and the `.css` files they import, ADR 0419; the CSS subset of ADR 0077): parsed with
 * `css-tree` (its parser only, not the lexer and its property data) into rule data (`UIStylesheet`) for
 * the cascade (`cascade.ts`, re-exported here). Pure and renderer-neutral; never throws for a bad sheet
 * (problems are reported). Svelte components' styles are parsed with it when they compile (the editor,
 * the export), so games using only Svelte UI never load it.
 */
import parse from "css-tree/parser";
import type { CssNode, Declaration as CssDeclaration, Rule as CssRule, Selector as CssSelector } from "css-tree";
import { isKnownTag, PSEUDO, selectorSpecificity, UI_TAGS, type SelectorGroup } from "./cascade";
import { parseMediaQueryList } from "./mediaQuery";
import { parseCompoundText } from "./selectorQuery";
import { problemAt } from "./sourceText";
import type { Combinator, Declaration, ParseStylesheet, Selector, SimpleSelector, SourceProblem, StyleRule, UIAttributeSelector, UIKeyframe, UIKeyframes, UIMediaQuery, UINthSelector, UIPseudo } from "./types";

export * from "./cascade";

// --- Parsing ------------------------------------------------------------------------------------

export const parseStylesheet: ParseStylesheet = (source, file, firstOrder = 0) => {
  const problems: SourceProblem[] = [];
  const report = (start: number, end: number, message: string) => problems.push(problemAt(source, file, { start, end }, message));
  const rules: StyleRule[] = [];
  const keyframes: UIKeyframes[] = [];
  let ast: CssNode;
  try {
    ast = parse(source, {
      positions: true,
      parseValue: false,
      parseCustomProperty: false,
      onParseError: (err: { message: string; offset?: number }) => report(err.offset ?? 0, err.offset ?? 0, err.message),
    });
  } catch (err) {
    report(0, 0, `Couldn't parse the stylesheet: ${(err as Error).message}`);
    return { file, rules, problems };
  }
  if (ast.type !== "StyleSheet") return { file, rules, problems };
  const walk = (nodes: readonly CssNode[], media: readonly (readonly UIMediaQuery[])[]) => {
    for (const node of nodes) {
      const loc = node.loc;
      const start = loc?.start.offset ?? 0;
      const end = loc?.end.offset ?? 0;
      if (node.type === "Atrule") {
        const name = node.name.toLowerCase();
        if (name === "keyframes" && media.length === 0) {
          const block = parseKeyframes(node, source, report);
          if (block) keyframes.push(block);
          continue;
        }
        if (name === "media") {
          // ADR 0418 wave 5: `@media` on the canvas; its rules carry the query lists they're in.
          const prelude = node.prelude?.loc ? source.slice(node.prelude.loc.start.offset, node.prelude.loc.end.offset) : "";
          let list: UIMediaQuery[];
          try {
            list = parseMediaQueryList(prelude, true);
          } catch (err) {
            report(start, end, `@media ${(err as Error).message}; the block is ignored.`);
            continue;
          }
          if (node.block) walk(node.block.children.toArray(), [...media, list]);
          continue;
        }
        report(start, end, `@${node.name} isn't supported${media.length ? " inside @media" : ""} in UI stylesheets; the rule is ignored.`);
        continue;
      }
      if (node.type !== "Rule") continue;
      const rule = parseRule(node, source, report);
      if (rule) rules.push({ ...rule, order: firstOrder + rules.length, ...(media.length ? { media } : {}) });
    }
  };
  walk(ast.children.toArray(), []);
  return keyframes.length ? { file, rules, problems, keyframes } : { file, rules, problems };
};

// --- @keyframes (ADR 0418 wave 4) ------------------------------------------------------------------

/** A `@keyframes name { from {…} 50% {…} to {…} }` block: its keyframes, with their offsets (0–1) and declarations. */
function parseKeyframes(node: CssNode, source: string, report: (start: number, end: number, message: string) => void): UIKeyframes | null {
  if (node.type !== "Atrule") return null;
  const start = node.loc?.start.offset ?? 0;
  const end = node.loc?.end.offset ?? 0;
  const prelude = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.toArray() : [];
  const head = prelude.length === 1 ? prelude[0] : null;
  const name = head?.type === "Identifier" ? head.name : head?.type === "String" ? head.value : null;
  if (!name || name === "none") {
    report(start, end, "@keyframes needs one name (not none); the block is ignored.");
    return null;
  }
  if (!node.block) {
    report(start, end, `@keyframes ${name} has no block; it's ignored.`);
    return null;
  }
  const frames: UIKeyframe[] = [];
  for (const child of node.block.children.toArray()) {
    const cs = child.loc?.start.offset ?? 0;
    const ce = child.loc?.end.offset ?? 0;
    if (child.type !== "Rule" || child.prelude.type !== "SelectorList") {
      report(cs, ce, `@keyframes ${name}: "${source.slice(cs, ce).trim()}" isn't a keyframe (from, to or a percentage, then declarations).`);
      continue;
    }
    const offsets: number[] = [];
    let ok = true;
    for (const sel of child.prelude.children.toArray()) {
      const parts = sel.type === "Selector" ? sel.children.toArray() : [];
      const p = parts.length === 1 ? parts[0] : null;
      const offset = p?.type === "TypeSelector" && p.name.toLowerCase() === "from" ? 0 : p?.type === "TypeSelector" && p.name.toLowerCase() === "to" ? 1 : p?.type === "Percentage" ? parseFloat(p.value) / 100 : NaN;
      if (!(offset >= 0 && offset <= 1)) ok = false;
      else offsets.push(offset);
    }
    if (!ok || offsets.length === 0) {
      report(cs, ce, `@keyframes ${name}: a keyframe selector is from, to or a percentage from 0% to 100%; the keyframe is ignored.`);
      continue;
    }
    const declarations: Declaration[] = [];
    for (const d of child.block.children.toArray()) {
      const ds = d.loc?.start.offset ?? 0;
      const de = d.loc?.end.offset ?? 0;
      if (d.type !== "Declaration") {
        report(ds, de, `"${source.slice(ds, de).trim()}" isn't a declaration (property: value).`);
        continue;
      }
      const decl = d as CssDeclaration;
      if (decl.important) report(ds, de, `!important is ignored inside @keyframes.`);
      const value = decl.value.type === "Raw" ? decl.value.value : source.slice(decl.value.loc?.start.offset ?? ds, decl.value.loc?.end.offset ?? de);
      declarations.push({ property: decl.property, value: value.replace(/\s*!\s*important\s*$/i, "").trim(), span: { start: ds, end: de } });
    }
    frames.push({ offsets, declarations, span: { start: cs, end: ce } });
  }
  return { name, frames, span: { start, end } };
}

function parseRule(node: CssRule, source: string, report: (start: number, end: number, message: string) => void): Omit<StyleRule, "order"> | null {
  const start = node.loc?.start.offset ?? 0;
  const end = node.loc?.end.offset ?? 0;
  const prelude = node.prelude;
  const selectorText = source.slice(prelude.loc?.start.offset ?? start, prelude.loc?.end.offset ?? start).trim();
  if (prelude.type !== "SelectorList") {
    report(start, end, `Couldn't read the selector "${selectorText}".`);
    return null;
  }
  const selectors: Selector[] = [];
  for (const sel of prelude.children.toArray()) {
    if (sel.type !== "Selector") continue;
    const parsed = parseSelector(sel, source, report);
    if (parsed) selectors.push(parsed);
  }
  const declarations: Declaration[] = [];
  for (const d of node.block.children.toArray()) {
    const ds = d.loc?.start.offset ?? 0;
    const de = d.loc?.end.offset ?? 0;
    if (d.type !== "Declaration") {
      report(ds, de, `"${source.slice(ds, de).trim()}" isn't a declaration (property: value).`);
      continue;
    }
    const decl = d as CssDeclaration;
    if (decl.important) report(ds, de, `!important isn't supported in UI stylesheets; "${decl.property}" is applied without it.`);
    const value = decl.value.type === "Raw" ? decl.value.value : source.slice(decl.value.loc?.start.offset ?? ds, decl.value.loc?.end.offset ?? de);
    declarations.push({ property: decl.property, value: value.replace(/\s*!\s*important\s*$/i, "").trim(), span: { start: ds, end: de } });
  }
  if (selectors.length === 0) return null;
  return { selectors, declarations, selectorText, span: { start, end } };
}

type Report = (start: number, end: number, message: string) => void;

type MutableCompound = {
  tag: string | null;
  id: string | null;
  classes: string[];
  pseudo: UIPseudo[];
  lang: string[];
  is?: SelectorGroup[];
  not?: (readonly Selector[])[];
  nth?: UINthSelector[];
  attributes?: UIAttributeSelector[];
  empty?: boolean;
  root?: boolean;
  has?: (readonly Selector[])[];
};

/** Pseudo-classes read by the query reader (ADR 0418 wave 5), so rule data and queries read them alike. */
const READ_AS_TEXT: ReadonlySet<string> = new Set([
  "not", "first-child", "last-child", "only-child", "nth-child", "nth-last-child",
  "first-of-type", "last-of-type", "only-of-type", "nth-of-type", "nth-last-of-type", "empty", "root",
  // ADR 0428: `:has()` and its relative selectors.
  "has",
]);

const SUPPORTED = ":hover, :pressed, :focus, :disabled, :lang(), :is(), :where(), :not(), :first-child, :last-child, :only-child, :nth-child(), :nth-last-child(), the -of-type forms, :empty, :root and :has()";

function parseSelector(sel: CssSelector, source: string, report: Report): Selector | null {
  const parts: { selector: SimpleSelector; combinator: Combinator | null }[] = [];
  let current: MutableCompound | null = null;
  let pendingCombinator: Combinator | null = null;
  let ok = true;
  const flush = () => {
    if (!current) return;
    parts.push({ selector: current, combinator: parts.length === 0 ? null : (pendingCombinator ?? " ") });
    current = null;
    pendingCombinator = null;
  };
  const compound = (): MutableCompound => (current ??= { tag: null, id: null, classes: [], pseudo: [], lang: [] });
  /** Read `source[s, e)` (an attribute selector or a wave 5 pseudo-class) with the query reader, into the compound. */
  const readText = (s: number, e: number) => {
    let read: SimpleSelector;
    try {
      read = parseCompoundText(source.slice(s, e));
    } catch (err) {
      report(s, e, `"${source.slice(s, e)}": ${(err as Error).message.replace(/ at \d+$/, "")}.`);
      ok = false;
      return;
    }
    const c = compound();
    if (read.attributes) (c.attributes ??= []).push(...read.attributes);
    if (read.nth) (c.nth ??= []).push(...read.nth);
    if (read.not) (c.not ??= []).push(...read.not);
    if (read.empty) c.empty = true;
    if (read.root) c.root = true;
    if (read.has) (c.has ??= []).push(...read.has);
  };
  for (const n of sel.children.toArray()) {
    const s = n.loc?.start.offset ?? 0;
    const e = n.loc?.end.offset ?? 0;
    switch (n.type) {
      case "TypeSelector":
        if (n.name === "*") compound();
        else if (isKnownTag(n.name)) compound().tag = n.name;
        else {
          report(s, e, `Unknown element "${n.name}" in a selector. Elements are ${[...UI_TAGS].join(", ")}, or the HTML tags Svelte components write them as (div, span, button…).`);
          ok = false;
        }
        break;
      case "ClassSelector":
        compound().classes.push(n.name);
        break;
      case "IdSelector":
        compound().id = n.name;
        break;
      case "AttributeSelector":
        readText(s, e);
        break;
      case "PseudoClassSelector": {
        const name = n.name.toLowerCase();
        if (PSEUDO.has(name)) compound().pseudo.push(name as UIPseudo);
        else if (READ_AS_TEXT.has(name)) readText(s, e);
        else if (name === "is" || name === "where") {
          const group = parseSelectorGroup(n, source, report);
          if (group) (compound().is ??= []).push(group);
          else ok = false;
        } else if (name === "lang") {
          // `:lang(de)` (ADR 0356 §4): one language range, matched by BCP 47 prefix against the current text language.
          const ranges = (n.children?.toArray() ?? []).map((c) => (c.type === "Identifier" ? c.name : c.type === "String" ? c.value : "")).filter((r) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(r));
          if (ranges.length !== 1) {
            report(s, e, ":lang() takes one language code, such as :lang(de) or :lang(zh-Hant).");
            ok = false;
          } else compound().lang.push(ranges[0]);
        } else {
          report(s, e, `:${n.name} isn't supported; UI pseudo-classes are ${SUPPORTED}.`);
          ok = false;
        }
        break;
      }
      case "Combinator":
        if (n.name === " " || n.name === ">" || n.name === "+" || n.name === "~") {
          flush();
          pendingCombinator = n.name;
        } else {
          report(s, e, `The "${n.name}" combinator isn't supported; use descendants (A B), children (A > B) or siblings (A + B, A ~ B).`);
          ok = false;
        }
        break;
      default:
        report(s, e, `${n.type === "PseudoElementSelector" ? "Pseudo-elements" : n.type} aren't supported in UI stylesheets.`);
        ok = false;
    }
  }
  flush();
  if (!ok || parts.length === 0) return null;
  const only = parts.length === 1 ? parts[0].selector : null;
  const root = !!only?.root && !only.tag && !only.id && !only.classes.length && !only.pseudo.length && !only.lang.length && !only.is && !only.not && !only.nth && !only.attributes && !only.empty && !only.has;
  return { parts, specificity: selectorSpecificity(parts), root };
}

function parseSelectorGroup(n: CssNode, source: string, report: Report): SelectorGroup | null {
  if (n.type !== "PseudoClassSelector") return null;
  const list = n.children?.toArray().find((c) => c.type === "SelectorList");
  if (!list || list.type !== "SelectorList") {
    report(n.loc?.start.offset ?? 0, n.loc?.end.offset ?? 0, `:${n.name}() takes a selector list.`);
    return null;
  }
  const selectors: Selector[] = [];
  for (const sel of list.children.toArray()) {
    if (sel.type !== "Selector") continue;
    const parsed = parseSelector(sel, source, report);
    if (!parsed) return null;
    selectors.push(parsed);
  }
  return selectors.length ? { selectors, zero: n.name === "where" } : null;
}
