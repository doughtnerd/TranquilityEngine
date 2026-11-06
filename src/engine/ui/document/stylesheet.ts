/**
 * UI stylesheets (`*.ui.css`, ADR 0077): a CSS subset parsed with `css-tree` (its parser only, not the
 * lexer and its property data), selector matching against the built element tree, and the cascade
 * that turns attributes, rules, inheritance and variables into component field values. Pure and
 * renderer-neutral; never throws for a bad sheet (problems are reported).
 */
import parse from "css-tree/parser";
import type { CssNode, Declaration as CssDeclaration, Rule as CssRule, Selector as CssSelector } from "css-tree";
import { Color, Vector2 } from "../../core/math";
import { AssetRef, getFields, type FieldInfo } from "../../core/registry";
import { UI_TYPES } from "../components";
import { hasBinding, problemAt, resolvePath } from "./markup";
import type {
  Declaration,
  MarkupAttribute,
  MarkupElement,
  ParseStylesheet,
  ResolvedValue,
  ResolveStyle,
  Selector,
  SimpleSelector,
  SourceProblem,
  StyleRule,
  StyleTarget,
  UIPseudo,
  UITag,
  ValueSource,
} from "./types";

const UI_TAGS: ReadonlySet<string> = new Set<UITag>(["Canvas", "Panel", "Text", "Image", "Button", "InputField"]);
const PSEUDO: ReadonlySet<string> = new Set<UIPseudo>(["hover", "pressed", "focus", "disabled"]);
/** Text fields children inherit, as on the web (camelCase field names). */
export const INHERITED_FIELDS: ReadonlySet<string> = new Set(["color", "fontSize", "fontWeight", "textAlign"]);
/** String fields that hold a `UILength`. */
const LENGTH_FIELDS: ReadonlySet<string> = new Set(["width", "height", "top", "right", "bottom", "left"]);
/** Attributes that aren't fields. */
const NOT_FIELDS: ReadonlySet<string> = new Set(["id", "class"]);

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
  let current: { tag: UITag | null; id: string | null; classes: string[]; pseudo: UIPseudo[] } | null = null;
  let pendingCombinator: " " | ">" | null = null;
  let root = false;
  let ok = true;
  const flush = () => {
    if (!current) return;
    parts.push({ selector: current, combinator: parts.length === 0 ? null : (pendingCombinator ?? " ") });
    current = null;
    pendingCombinator = null;
  };
  const compound = () => (current ??= { tag: null, id: null, classes: [], pseudo: [] });
  for (const n of sel.children.toArray()) {
    const s = n.loc?.start.offset ?? 0;
    const e = n.loc?.end.offset ?? 0;
    switch (n.type) {
      case "TypeSelector":
        if (n.name === "*") compound();
        else if (UI_TAGS.has(n.name)) compound().tag = n.name as UITag;
        else {
          report(s, e, `Unknown element "${n.name}" in a selector. Elements are ${[...UI_TAGS].join(", ")}.`);
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
        else {
          report(s, e, `:${n.name} isn't supported; UI pseudo-classes are :hover, :pressed, :focus and :disabled.`);
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
  if (root && (parts.length > 1 || parts[0].selector.tag || parts[0].selector.id || parts[0].selector.classes.length || parts[0].selector.pseudo.length)) {
    report(sel.loc?.start.offset ?? 0, sel.loc?.end.offset ?? 0, ":root only goes alone, to declare variables.");
    return null;
  }
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const p of parts) {
    if (p.selector.id) ids++;
    classes += p.selector.classes.length + p.selector.pseudo.length;
    if (p.selector.tag) tags++;
  }
  return { parts, specificity: root ? [0, 1, 0] : [ids, classes, tags], root };
}

// --- Matching -----------------------------------------------------------------------------------

function matchesSimple(s: SimpleSelector, t: StyleTarget): boolean {
  if (s.tag && s.tag !== t.tag) return false;
  if (s.id && s.id !== t.id) return false;
  for (const c of s.classes) if (!t.classes.includes(c)) return false;
  for (const p of s.pseudo) if (!t.state[p]) return false;
  return true;
}

/** True when a selector matches an element (`:root` selectors match nothing: they only declare variables). */
export function matchSelector(selector: Selector, target: StyleTarget): boolean {
  if (selector.root) return false;
  return matchFrom(selector, selector.parts.length - 1, target);
}

function matchFrom(selector: Selector, index: number, target: StyleTarget): boolean {
  const part = selector.parts[index];
  if (!matchesSimple(part.selector, target)) return false;
  if (index === 0) return true;
  // The combinator before this part joins it to the part on its left.
  if (part.combinator === ">") return target.parent !== null && matchFrom(selector, index - 1, target.parent);
  for (let p = target.parent; p; p = p.parent) if (matchFrom(selector, index - 1, p)) return true;
  return false;
}

/** True when any rule of these sheets uses a pseudo-class (so elements restyle when their state changes). */
export function usesPseudo(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => sel.parts.some((p) => p.selector.pseudo.length > 0))));
}

// --- Values -------------------------------------------------------------------------------------

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", orange: "#ffa500",
  purple: "#800080", pink: "#ffc0cb", brown: "#a52a2a", gray: "#808080", grey: "#808080", silver: "#c0c0c0",
  navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000", gold: "#ffd700", coral: "#ff7f50",
  crimson: "#dc143c", indigo: "#4b0082", violet: "#ee82ee", salmon: "#fa8072", tomato: "#ff6347",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", dimgray: "#696969", dimgrey: "#696969",
};

/** A CSS colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, a named colour, `transparent`; `none` is null (no fill). */
export function parseColor(raw: string): Color | null | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "none") return null;
  if (v === "transparent") return new Color(0, 0, 0, 0);
  const named = NAMED_COLORS[v];
  if (named) return Color.from(named);
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) {
    let hex = v.slice(1);
    if (hex.length <= 4) hex = hex.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return new Color(n(0), n(2), n(4), hex.length === 8 ? n(6) : 1);
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const channel = (s: string) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const alpha = (s: string) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));
    const c = new Color(channel(parts[0]), channel(parts[1]), channel(parts[2]), parts[3] !== undefined ? alpha(parts[3]) : 1);
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : undefined;
  }
  return undefined;
}

function parseNumber(raw: string): number | undefined {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/.exec(raw.trim());
  return m ? parseFloat(m[1]) : undefined;
}

function unquote(raw: string): string {
  const v = raw.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/**
 * Convert a value as written (attribute or declaration, variables already substituted) to a field's
 * type. Undefined when it can't. `file` resolves relative asset paths (`./logo.png`).
 */
export function convertValue(raw: string, info: FieldInfo, file: string): unknown {
  const type = info.type;
  const v = raw.trim();
  if (type === Number) return parseNumber(v);
  if (type === Boolean) return v === "true" ? true : v === "false" ? false : undefined;
  if (type === Color) return parseColor(v);
  if (type === Vector2) {
    const parts = v.split(/[\s,]+/).filter(Boolean).map(parseNumber);
    if (parts.length === 1 && parts[0] !== undefined) return new Vector2(parts[0], parts[0]);
    return parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined ? new Vector2(parts[0], parts[1]) : undefined;
  }
  if (type === AssetRef) {
    const url = /^url\((.*)\)$/.exec(v);
    const path = unquote(url ? url[1] : v);
    if (path === "" || path.startsWith("asset:")) return path;
    return `asset:${path.startsWith("./") || path.startsWith("../") ? resolvePath(file, path) : path.replace(/^\//, "")}`;
  }
  if (type === String) {
    const s = unquote(v);
    if (LENGTH_FIELDS.has(info.name)) {
      if (s === "auto" || /^-?(\d+\.?\d*|\.\d+)%$/.test(s)) return s;
      const n = parseNumber(s);
      return n === undefined ? undefined : String(n);
    }
    const choices = info.options?.choices;
    if (Array.isArray(choices) && info.name !== "fontWeight") {
      const values = choices.map((c) => (typeof c === "string" ? c : (c as { value: unknown }).value));
      if (!values.includes(s)) return undefined;
    }
    return s;
  }
  return undefined;
}

/**
 * A bound value (`{name}` filled in) for a field: text fields take the string as it is (quotes and all);
 * other fields convert like an attribute. Undefined when it can't convert.
 */
export function boundValue(text: string, info: FieldInfo, file: string): unknown {
  if (info.type === String && !LENGTH_FIELDS.has(info.name) && !Array.isArray(info.options?.choices)) return text;
  return convertValue(text, info, file);
}

/** `background-color` → `backgroundColor`; camelCase stays. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Property and attribute names (camelCase) that name another field: CSS's `position` is `positionType`. */
const ALIASES: Readonly<Record<string, string>> = { position: "positionType" };

/** The field a property or attribute sets: its camelCase name (`flex-direction` → `flexDirection`), or the field an alias names (`position` → `positionType`). */
export function propertyField(name: string): string {
  const field = camelCase(name);
  return ALIASES[field] ?? field;
}

/** `var(--x)` and `var(--x, fallback)` substituted from `vars`; undefined when a variable is missing and has no fallback. */
export function substituteVars(value: string, vars: ReadonlyMap<string, string>, depth = 0): string | undefined {
  if (!value.includes("var(")) return value;
  if (depth > 8) return undefined;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // Find the matching close paren.
    let level = 0;
    let j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === "(") level++;
      else if (value[j] === ")" && --level === 0) break;
    }
    const inner = value.slice(at + 4, j);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const found = vars.get(name) ?? fallback;
    if (found === undefined) return undefined;
    const resolved = substituteVars(found, vars, depth + 1);
    if (resolved === undefined) return undefined;
    out += resolved;
    i = j + 1;
  }
  return out;
}

// --- Cascade ------------------------------------------------------------------------------------

const fieldMaps = new Map<abstract new (...args: never[]) => object, Map<string, FieldInfo>>();

/** A component class's fields by name. */
export function fieldsOf(component: abstract new (...args: never[]) => object): Map<string, FieldInfo> {
  let map = fieldMaps.get(component);
  if (!map) {
    map = new Map(getFields(component as never).map((f) => [f.name, f]));
    fieldMaps.set(component, map);
  }
  return map;
}

let knownFields: Set<string> | null = null;
/** Every UI component's field names: properties outside these are unknown. */
function isKnownField(name: string): boolean {
  knownFields ??= new Set(UI_TYPES.flatMap((t) => [...fieldsOf(t).keys()]));
  return knownFields.has(name);
}

/** The field an attribute sets (`flex-direction` and `flexDirection` both name `flexDirection`; `position` names `positionType`), or null for `id`/`class`. */
export function attributeField(attribute: MarkupAttribute): string | null {
  return NOT_FIELDS.has(attribute.name) ? null : propertyField(attribute.name);
}

/** A variable's key in a resolved map: `--name` (variables inherit, like the text properties). */
const isVariable = (key: string) => key.startsWith("--");

/** Variables declared on `:root` in these sheets, in cascade order. */
function rootVariables(sheets: readonly { rules: readonly StyleRule[]; file: string }[]): Map<string, ResolvedValue> {
  const out = new Map<string, ResolvedValue>();
  const rules = sheets.flatMap((s) => s.rules.map((r) => ({ r, file: s.file }))).filter(({ r }) => r.selectors.some((sel) => sel.root));
  rules.sort((a, b) => a.r.order - b.r.order);
  for (const { r, file } of rules) {
    for (const d of r.declarations) if (isVariable(d.property)) out.set(d.property, { field: d.property, value: d.value, source: { kind: "rule", rule: r, declaration: d, file } });
  }
  return out;
}

const warnedOnce = new Set<string>();

export const resolveStyle: ResolveStyle = (target, element, component, sheets, parent, warn) => {
  const out = new Map<string, ResolvedValue>();
  const fields = fieldsOf(component);
  const warnOnce = (message: string) => {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    warn(message);
  };

  // Matching declarations in cascade order: specificity, then rule order, then position in the rule.
  const matched: { rule: StyleRule; declaration: Declaration; file: string; spec: readonly [number, number, number]; index: number }[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      let best: readonly [number, number, number] | null = null;
      for (const sel of rule.selectors) {
        if (!matchSelector(sel, target)) continue;
        if (!best || compareSpec(sel.specificity, best) > 0) best = sel.specificity;
      }
      if (!best) continue;
      rule.declarations.forEach((declaration, index) => matched.push({ rule, declaration, file: sheet.file, spec: best!, index }));
    }
  }
  matched.sort((a, b) => compareSpec(a.spec, b.spec) || a.rule.order - b.rule.order || a.index - b.index);

  // Variables: inherited (the root's from `:root`), then this element's own.
  const inheritedVars = parent ? [...parent].filter(([k]) => isVariable(k)) : [...rootVariables(sheets)];
  for (const [k, v] of inheritedVars) out.set(k, v);
  for (const m of matched) {
    if (isVariable(m.declaration.property)) out.set(m.declaration.property, { field: m.declaration.property, value: m.declaration.value, source: { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file } });
  }
  const vars = new Map<string, string>();
  for (const [k, v] of out) vars.set(k, String(v.value));

  const set = (field: string, raw: string, source: ValueSource, where: string) => {
    const info = fields.get(field);
    if (!info) return false;
    const substituted = substituteVars(raw, vars);
    if (substituted === undefined) {
      warnOnce(`${where}: "${raw}" uses a variable that isn't defined.`);
      return false;
    }
    const value = convertValue(substituted, info, element.file);
    if (value === undefined) {
      warnOnce(`${where}: "${substituted}" isn't a valid ${field} for <${target.tag}>.`);
      return false;
    }
    out.set(field, { field, value, source });
    return true;
  };

  // Rules.
  for (const m of matched) {
    const prop = m.declaration.property;
    if (isVariable(prop)) continue;
    const field = propertyField(prop);
    if (!isKnownField(field)) {
      warnOnce(`${m.file}: unknown property "${prop}" (in "${m.rule.selectorText}").`);
      continue;
    }
    const where = `${m.file} "${m.rule.selectorText}" ${prop}`;
    const source: ValueSource = { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file };
    if (fields.has(field)) {
      set(field, m.declaration.value, source, where);
    } else if (INHERITED_FIELDS.has(field)) {
      // Not this element's field, but its children inherit it (a Panel's color reaches its Text).
      const substituted = substituteVars(m.declaration.value, vars);
      if (substituted !== undefined) out.set(field, { field, value: substituted, source });
    }
  }

  // Attributes beat rules. Bound attributes (`{name}`) are the runtime's: it writes them as data changes.
  for (const a of element.attributes) {
    const field = attributeField(a);
    if (!field || hasBinding(a.value)) continue;
    if (!fields.has(field)) {
      if (!isKnownField(field)) warnOnce(`${element.file}: <${element.tag}> has no field "${a.name}".`);
      continue;
    }
    set(field, a.value, { kind: "attribute", attribute: a, file: element.file }, `${element.file} <${element.tag} ${a.name}>`);
  }

  // Inheritance: text properties nothing set here come from the parent.
  if (parent) {
    for (const name of INHERITED_FIELDS) {
      if (out.has(name)) continue;
      const from = parent.get(name);
      if (!from) continue;
      const source: ValueSource = { kind: "inherited", from: target.parent ?? target, source: from.source };
      const info = fields.get(name);
      if (!info) {
        out.set(name, { field: name, value: from.value, source }); // passed on to grandchildren
        continue;
      }
      // A raw string inherited through an element without the field converts here.
      const value = typeof from.value === "string" && info.type !== String ? convertValue(from.value, info, element.file) : from.value;
      if (value !== undefined) out.set(name, { field: name, value: cloneValue(value), source });
    }
  }
  return out;
};

function compareSpec(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Colors and vectors are mutable: each element gets its own copy. */
export function cloneValue(value: unknown): unknown {
  if (value instanceof Color) return new Color(value.r, value.g, value.b, value.a);
  if (value instanceof Vector2) return new Vector2(value.x, value.y);
  return value;
}
