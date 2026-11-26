/**
 * UI stylesheets (`*.ui.css`, ADR 0077, and Svelte components' CSS, ADR 0419): a CSS subset parsed with
 * `css-tree` (its parser only, not the lexer and its property data) into rule data (`UIStylesheet`) for
 * the cascade (`cascade.ts`, re-exported here). Pure and renderer-neutral; never throws for a bad sheet
 * (problems are reported). Svelte components' styles are parsed with it when they compile (the editor,
 * the export), so games using only Svelte UI never load it.
 */
import parse from "css-tree/parser";
import type { CssNode, Declaration as CssDeclaration, Rule as CssRule, Selector as CssSelector } from "css-tree";
import { groupSpecificity, isKnownTag, PSEUDO, UI_TAGS, type SelectorGroup } from "./cascade";
import { problemAt } from "./sourceText";
import type { Declaration, ParseStylesheet, Selector, SimpleSelector, SourceProblem, StyleRule, UIPseudo } from "./types";

export * from "./cascade";

// --- Parsing ------------------------------------------------------------------------------------

export const parseStylesheet: ParseStylesheet = (source, file, firstOrder = 0) => {
  const problems: SourceProblem[] = [];
  const report = (start: number, end: number, message: string) => problems.push(problemAt(source, file, { start, end }, message));
  const rules: StyleRule[] = [];
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
  for (const node of ast.children.toArray()) {
    const loc = node.loc;
    const start = loc?.start.offset ?? 0;
    const end = loc?.end.offset ?? 0;
    if (node.type === "Atrule") {
      report(start, end, `@${node.name} isn't supported in UI stylesheets; the rule is ignored.`);
      continue;
    }
    if (node.type !== "Rule") continue;
    const rule = parseRule(node, source, report);
    if (rule) rules.push({ ...rule, order: firstOrder + rules.length });
  }
  return { file, rules, problems };
};

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
    const parsed = parseSelector(sel, report);
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

function parseSelector(sel: CssSelector, report: (start: number, end: number, message: string) => void): Selector | null {
  const parts: { selector: SimpleSelector; combinator: " " | ">" | null }[] = [];
  let current: { tag: string | null; id: string | null; classes: string[]; pseudo: UIPseudo[]; lang: string[]; is?: SelectorGroup[] } | null = null;
  let pendingCombinator: " " | ">" | null = null;
  let root = false;
  let ok = true;
  const flush = () => {
    if (!current) return;
    parts.push({ selector: current, combinator: parts.length === 0 ? null : (pendingCombinator ?? " ") });
    current = null;
    pendingCombinator = null;
  };
  const compound = () => (current ??= { tag: null, id: null, classes: [], pseudo: [], lang: [] });
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
      case "PseudoClassSelector":
        if (n.name === "root") {
          root = true;
          compound();
        } else if (PSEUDO.has(n.name)) compound().pseudo.push(n.name as UIPseudo);
        else if (n.name === "is" || n.name === "where") {
          const group = parseSelectorGroup(n, report);
          if (group) (compound().is ??= []).push(group);
          else ok = false;
        }
        else if (n.name === "lang") {
          // `:lang(de)` (ADR 0356 §4): one language range, matched by BCP 47 prefix against the current text language.
          const ranges = (n.children?.toArray() ?? []).map((c) => (c.type === "Identifier" ? c.name : c.type === "String" ? c.value : "")).filter((r) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(r));
          if (ranges.length !== 1) {
            report(s, e, ":lang() takes one language code, such as :lang(de) or :lang(zh-Hant).");
            ok = false;
          } else compound().lang.push(ranges[0]);
        } else {
          report(s, e, `:${n.name} isn't supported; UI pseudo-classes are :hover, :pressed, :focus, :disabled, :lang(), :is() and :where().`);
          ok = false;
        }
        break;
      case "Combinator":
        if (n.name === " " || n.name === ">") {
          flush();
          pendingCombinator = n.name;
        } else {
          report(s, e, `The "${n.name}" combinator isn't supported; use descendants (A B) or children (A > B).`);
          ok = false;
        }
        break;
      default:
        report(s, e, `${n.type === "AttributeSelector" ? "Attribute selectors" : n.type === "PseudoElementSelector" ? "Pseudo-elements" : n.type} aren't supported in UI stylesheets.`);
        ok = false;
    }
  }
  flush();
  if (!ok || parts.length === 0) return null;
  if (root && (parts.length > 1 || parts[0].selector.tag || parts[0].selector.id || parts[0].selector.classes.length || parts[0].selector.pseudo.length || parts[0].selector.lang.length || parts[0].selector.is?.length)) {
    report(sel.loc?.start.offset ?? 0, sel.loc?.end.offset ?? 0, ":root only goes alone, to declare variables.");
    return null;
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
  return { parts, specificity: root ? [0, 1, 0] : [ids, classes, tags], root };
}

function parseSelectorGroup(n: CssNode, report: (start: number, end: number, message: string) => void): SelectorGroup | null {
  if (n.type !== "PseudoClassSelector") return null;
  const list = n.children?.toArray().find((c) => c.type === "SelectorList");
  if (!list || list.type !== "SelectorList") {
    report(n.loc?.start.offset ?? 0, n.loc?.end.offset ?? 0, `:${n.name}() takes a selector list.`);
    return null;
  }
  const selectors: Selector[] = [];
  for (const sel of list.children.toArray()) {
    if (sel.type !== "Selector") continue;
    const parsed = parseSelector(sel, report);
    if (!parsed) return null;
    if (parsed.root) {
      report(sel.loc?.start.offset ?? 0, sel.loc?.end.offset ?? 0, `:root can't go inside :${n.name}().`);
      return null;
    }
    selectors.push(parsed);
  }
  return selectors.length ? { selectors, zero: n.name === "where" } : null;
}

