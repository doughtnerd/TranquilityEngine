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
import type { Declaration, ParseStylesheet, Selector, SimpleSelector, SourceProblem, StyleRule, UIKeyframe, UIKeyframes, UIPseudo } from "./types";

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
  for (const node of ast.children.toArray()) {
    const loc = node.loc;
    const start = loc?.start.offset ?? 0;
    const end = loc?.end.offset ?? 0;
    if (node.type === "Atrule") {
      if (node.name.toLowerCase() === "keyframes") {
        const block = parseKeyframes(node, source, report);
        if (block) keyframes.push(block);
        continue;
      }
      report(start, end, `@${node.name} isn't supported in UI stylesheets; the rule is ignored.`);
      continue;
    }
    if (node.type !== "Rule") continue;
    const rule = parseRule(node, source, report);
    if (rule) rules.push({ ...rule, order: firstOrder + rules.length });
  }
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

