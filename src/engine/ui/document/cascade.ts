/**
 * The UI cascade (ADR 0077, 0419): selector matching against the built element tree, and the cascade
 * that turns attributes, rules, inheritance and variables into component field values. It works on
 * parsed rule data (`UIStylesheet`), so it holds no CSS parser: Svelte components' styles are parsed with
 * `stylesheet.ts` (css-tree) when they compile, in the editor and at export, so games load this module and
 * never the parser (ADR 0419).
 */
import { Color, Vector2 } from "../../core/math";
import { AssetRef, getFields, type FieldInfo } from "../../core/registry";
import { UI_TYPES, UIText } from "../components";
import { isGenericFontFamily } from "../fonts";
import { UI_TAGS as UI_KIND_TAGS } from "../elementKinds";
import { HTML_TAGS } from "../host/htmlTags";
import { resolvePath } from "./sourceText";
import { parseColor } from "./cssColor";
import { parseBackgroundImage, parseCornerRadii, parseShadow } from "./paintValues";
import { parseRotate, parseScale, parseTransform, parseTransformOrigin, parseTranslate } from "./transformValues";
import { matrixText, type UIAffine } from "../transform2d";
import { FILTER_FIELDS, parseFilter } from "./filterValues";
import {
  animationSpecs,
  ANIMATION_PROPERTIES,
  parseAnimationLonghand,
  parseTimingFunction,
  parseTransitionLonghand,
  transitionSpecs,
  type UIAnimationLonghands,
  type UITimingFunction,
  type UITransitionLonghands,
} from "./animationValues";
import type {
  Combinator,
  Declaration,
  MarkupAttribute,
  ResolvedValue,
  ResolveStyle,
  Selector,
  SimpleSelector,
  StyleRule,
  StyleTarget,
  UIAttributeSelector,
  UIMediaEnvironment,
  UINthSelector,
  UIPseudo,
  UIPseudoElement,
  UIStylesheet,
  ValueSource,
} from "./types";
import { matchMediaQueries } from "./mediaQuery";
import { parseContent } from "./contentValue";
import { hasViewportUnits, linearLength, resolveMath, resolveRelativeUnits, type UIRelativeUnits } from "./cssMath";


export const UI_TAGS: ReadonlySet<string> = UI_KIND_TAGS;
/** The pseudo-classes UI elements have. */
export const PSEUDO: ReadonlySet<string> = new Set<UIPseudo>(["hover", "pressed", "focus", "disabled", "checked", "indeterminate", "placeholder-shown"]);
/** Text fields children inherit, as on the web (camelCase field names). */
export const INHERITED_FIELDS: ReadonlySet<string> = new Set(["color", "fontSize", "fontWeight", "textAlign", "textOutlineColor", "textOutlineWidth", "textShadowColor", "textShadowOffsetX", "textShadowOffsetY", "textShadowBlur", "fontStyle"]);

/**
 * ADR 0425: what HTML's own stylesheet gives phrasing elements, by tag as written: below every author declaration (an
 * attribute or any rule), above inheritance, as the user-agent origin is. `fontSize` is a share of the parent's.
 */
const TAG_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  b: { fontWeight: "bold" },
  strong: { fontWeight: "bold" },
  i: { fontStyle: "italic" },
  em: { fontStyle: "italic" },
  cite: { fontStyle: "italic" },
  var: { fontStyle: "italic" },
  dfn: { fontStyle: "italic" },
  u: { textDecoration: "underline" },
  ins: { textDecoration: "underline" },
  a: { textDecoration: "underline" },
  s: { textDecoration: "line-through" },
  del: { textDecoration: "line-through" },
  strike: { textDecoration: "line-through" },
  code: { font: "monospace" },
  kbd: { font: "monospace" },
  samp: { font: "monospace" },
  small: { fontSize: 0.83 },
  sub: { fontSize: 0.83, verticalAlign: "sub" },
  sup: { fontSize: 0.83, verticalAlign: "super" },
  mark: { backgroundColor: new Color(1, 1, 0, 1), color: new Color(0, 0, 0, 1) },
};

/** ADR 0425: the tag of a run of text between a text element's inline children (not an element: no rule matches it). */
export const TEXT_PIECE_TAG = "#text";

/** ADR 0425: an element's user-agent defaults (`TAG_DEFAULTS`), with a relative font size worked out from the parent's. */
function tagDefaults(tag: string, parent: ReadonlyMap<string, ResolvedValue> | null): [string, unknown][] {
  const d = TAG_DEFAULTS[tag.toLowerCase()];
  if (!d || !Object.hasOwn(TAG_DEFAULTS, tag.toLowerCase())) return [];
  return Object.entries(d).map(([field, value]) => {
    if (field !== "fontSize") return [field, cloneValue(value)];
    const from = parent?.get("fontSize")?.value;
    const size = typeof from === "number" && Number.isFinite(from) ? from : 16;
    return [field, Math.round(size * (value as number) * 100) / 100];
  });
}
/** String fields that hold a `UILength`. */
const LENGTH_FIELDS: ReadonlySet<string> = new Set(["width", "height", "top", "right", "bottom", "left", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis"]);
/** Length fields that take `none` (no maximum, ADR 0418). */
const NONE_LENGTH_FIELDS: ReadonlySet<string> = new Set(["maxWidth", "maxHeight"]);
/**
 * Number fields where null means "not set here" (ADR 0418): a side takes the all-sides value, `flexShrink` its
 * element kind's. `auto` and `none` write null.
 */
const NULLABLE_NUMBER_FIELDS: ReadonlySet<string> = new Set([
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "flexShrink",
]);
/** Attributes that aren't fields (HTML's `translate`). */
const NOT_FIELDS: ReadonlySet<string> = new Set(["id", "class", "translate"]);
/** Node reference fields an attribute sets by naming another element's id (ADR 0340): the UI host resolves them in its tree. */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set(["navUp", "navDown", "navLeft", "navRight", "firstSelected"]);

// --- Matching -----------------------------------------------------------------------------------

function matchesSimple(s: SimpleSelector, t: StyleTarget): boolean {
  if (s.tag && !sameTag(s.tag, t.tag)) return false;
  if (s.id && s.id !== t.id) return false;
  for (const c of s.classes) if (!t.classes.includes(c)) return false;
  for (const p of s.pseudo) if (!t.state[p]) return false;
  for (const range of s.lang) if (!langMatches(t.lang, range)) return false;
  if (s.root && t.parent) return false;
  if (s.attributes) for (const a of s.attributes) if (!matchAttribute(a, t)) return false;
  if (s.empty && !(t.children !== undefined && t.children.length === 0 && !t.content)) return false;
  if (s.nth) for (const n of s.nth) if (!matchNth(n, t)) return false;
  if (s.is) for (const g of s.is) if (!matchesGroup(g, t)) return false;
  if (s.not) for (const list of s.not) if (list.some((sel) => matchFrom(sel, sel.parts.length - 1, t))) return false;
  if (s.has) for (const list of s.has) if (!list.some((rel) => matchHas(rel, t))) return false;
  return true;
}

/** CSS `:lang()` matching (ADR 0356 §4): the language equals the range or starts with it and a hyphen (`de` matches `de-AT`). */
function langMatches(language: string | undefined, range: string): boolean {
  if (!language) return false;
  const l = language.toLowerCase();
  const r = range.toLowerCase();
  return l === r || l.startsWith(`${r}-`);
}

/**
 * ADR 0428: the pseudo-elements UI selectors style (`UIPseudoElement`). `before` and `after` are also read with one colon,
 * as CSS 2 wrote them.
 */
export const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set<UIPseudoElement>([
  "before", "after", "placeholder", "selection",
  "-webkit-slider-thumb", "-webkit-slider-runnable-track", "-webkit-progress-bar", "-webkit-progress-value",
  "-webkit-meter-optimum-value", "-webkit-meter-suboptimum-value", "-webkit-meter-even-less-good-value",
  "checkmark", "picker-icon",
]);

/**
 * True when a selector matches an element (`:root` matches the tree's root: the element without a parent). ADR 0428: a
 * selector with a pseudo-element matches only that pseudo-element's target, its parts matched against the originating
 * element (the target's parent).
 */
export function matchSelector(selector: Selector, target: StyleTarget): boolean {
  if (selector.pseudoElement !== target.pseudoElement) return false;
  if (target.pseudoElement) return target.parent !== null && matchFrom(selector, selector.parts.length - 1, target.parent);
  if (selector.root && target.parent) return false; // rule data from before wave 5 marks `:root` only here
  return matchFrom(selector, selector.parts.length - 1, target);
}

/** ADR 0428: the pseudo-elements the rules of these sheets style (empty: none). */
export function pseudoElementsUsed(sheets: readonly { rules: readonly StyleRule[] }[]): ReadonlySet<UIPseudoElement> {
  const out = new Set<UIPseudoElement>();
  for (const s of sheets) for (const r of s.rules) for (const sel of r.selectors) if (sel.pseudoElement) out.add(sel.pseudoElement);
  return out;
}

/**
 * True when parts `0…index` of a selector match with part `index` on `target`. `anchor` (ADR 0428): the selector is
 * relative, inside `:has()`, and its first part must stand to the anchor as its leading combinator says.
 */
function matchFrom(selector: Selector, index: number, target: StyleTarget, anchor?: StyleTarget): boolean {
  const part = selector.parts[index];
  if (!matchesSimple(part.selector, target)) return false;
  if (index === 0) return !anchor || relatedTo(target, part.combinator ?? " ", anchor);
  // The combinator before this part joins it to the part on its left.
  switch (part.combinator) {
    case ">":
      return target.parent !== null && matchFrom(selector, index - 1, target.parent, anchor);
    case "+":
    case "~": {
      const siblings = siblingsOf(target);
      const at = siblings ? siblings.indexOf(target) : -1;
      if (at <= 0) return false;
      if (part.combinator === "+") return matchFrom(selector, index - 1, siblings![at - 1], anchor);
      for (let i = at - 1; i >= 0; i--) if (matchFrom(selector, index - 1, siblings![i], anchor)) return true;
      return false;
    }
  }
  for (let p = target.parent; p; p = p.parent) {
    if (p === anchor) return false; // a relative selector's parts all stand after its anchor
    if (matchFrom(selector, index - 1, p, anchor)) return true;
  }
  return false;
}

// --- :has() (ADR 0428) -------------------------------------------------------------------------------
// A relative selector matches an element when some element after it (a descendant for `" "` and `>`, a later sibling
// or a later sibling's descendant for `+` and `~`) matches the selector, with its first part standing to the anchor as
// its leading combinator says. Targets that don't list their children can't say, so `:has()` doesn't match them.

/** True when `t` stands to `anchor` as `combinator` says: its descendant, child, next sibling or later sibling. */
function relatedTo(t: StyleTarget, combinator: Combinator, anchor: StyleTarget): boolean {
  switch (combinator) {
    case ">":
      return t.parent === anchor;
    case "+":
    case "~": {
      const siblings = siblingsOf(t);
      const at = siblings ? siblings.indexOf(t) : -1;
      if (at <= 0) return false;
      return combinator === "+" ? siblings![at - 1] === anchor : siblings!.indexOf(anchor) >= 0 && siblings!.indexOf(anchor) < at;
    }
  }
  for (let p = t.parent; p; p = p.parent) if (p === anchor) return true;
  return false;
}

/** True when the relative selector `rel` matches some element relative to `anchor`. */
function matchHas(rel: Selector, anchor: StyleTarget): boolean {
  const last = rel.parts.length - 1;
  const leading = rel.parts[0].combinator ?? " ";
  // With one compound, only the elements the combinator itself reaches can match; with more, their descendants too.
  const deep = last > 0;
  const visit = (t: StyleTarget, descend: boolean): boolean => {
    if (matchFrom(rel, last, t, anchor)) return true;
    if (descend) for (const c of t.children ?? []) if (visit(c, true)) return true;
    return false;
  };
  if (leading === " " || leading === ">") {
    for (const c of anchor.children ?? []) if (visit(c, deep || leading === " ")) return true;
    return false;
  }
  const siblings = siblingsOf(anchor);
  if (!siblings) return false;
  const at = siblings.indexOf(anchor);
  const until = leading === "+" && !deep ? at + 2 : siblings.length;
  for (let i = at + 1; i < Math.min(until, siblings.length); i++) if (visit(siblings[i], deep)) return true;
  return false;
}

// --- Structural and attribute selectors (ADR 0418 wave 5) --------------------------------------------
// Positions count child elements (text isn't one), so a button's label text doesn't make its first span a second
// child. The root counts as the only child of nothing, as in CSS. Targets without `children` (or `attributes`) can't
// say, so the tests that need them don't match.

/** The element and its siblings, in order; null when its parent doesn't list its children. */
function siblingsOf(t: StyleTarget): readonly StyleTarget[] | null {
  if (!t.parent) return [t];
  return t.parent.children ?? null;
}

/** True when some `n ≥ 0` gives `a·n + b = position`. */
function nthMatches(a: number, b: number, position: number): boolean {
  if (a === 0) return position === b;
  const n = (position - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function matchNth(nth: UINthSelector, t: StyleTarget): boolean {
  const siblings = siblingsOf(t);
  if (!siblings) return false;
  let list = siblings;
  if (nth.ofType) list = list.filter((c) => sameTag(c.tag, t.tag));
  if (nth.of) {
    const of = nth.of;
    list = list.filter((c) => of.some((sel) => matchFrom(sel, sel.parts.length - 1, c)));
  }
  const i = list.indexOf(t);
  if (i < 0) return false;
  return nthMatches(nth.a, nth.b, nth.last ? list.length - i : i + 1);
}

function matchAttribute(a: UIAttributeSelector, t: StyleTarget): boolean {
  const attrs = t.attributes;
  if (!attrs) return false;
  let value: string | undefined = attrs.get(a.name);
  if (value === undefined) {
    for (const [k, v] of attrs) {
      if (k.toLowerCase() === a.name) {
        value = v;
        break;
      }
    }
  }
  if (value === undefined) return false;
  if (!a.op) return true;
  let want = a.value ?? "";
  if (a.insensitive) {
    value = value.toLowerCase();
    want = want.toLowerCase();
  }
  switch (a.op) {
    case "=":
      return value === want;
    case "~=":
      return want !== "" && !/\s/.test(want) && value.split(/\s+/).includes(want);
    case "|=":
      return value === want || value.startsWith(`${want}-`);
    case "^=":
      return want !== "" && value.startsWith(want);
    case "$=":
      return want !== "" && value.endsWith(want);
    case "*=":
      return want !== "" && value.includes(want);
  }
  return false;
}

/**
 * A selector's specificity from its parts: ids; classes, pseudo-classes and attribute selectors; tags (and a
 * pseudo-element, ADR 0428). `:is()`, `:not()` and `:nth-child(… of S)` add their most specific argument's, `:where()`
 * nothing.
 */
export function selectorSpecificity(parts: Selector["parts"], pseudoElement?: UIPseudoElement | null): [number, number, number] {
  let ids = 0;
  let classes = 0;
  let tags = pseudoElement ? 1 : 0; // ADR 0428: a pseudo-element counts as a type selector
  const addMost = (list: readonly Selector[]) => {
    const [a, b, c] = groupSpecificity({ selectors: list, zero: false });
    ids += a;
    classes += b;
    tags += c;
  };
  for (const p of parts) {
    const s = p.selector;
    if (s.id) ids++;
    classes += s.classes.length + s.pseudo.length + s.lang.length + (s.attributes?.length ?? 0) + (s.root ? 1 : 0) + (s.empty ? 1 : 0) + (s.nth?.length ?? 0);
    if (s.tag) tags++;
    for (const g of s.is ?? []) {
      const [a, b, c] = groupSpecificity(g);
      ids += a;
      classes += b;
      tags += c;
    }
    for (const list of s.not ?? []) addMost(list);
    for (const list of s.has ?? []) addMost(list);
    for (const n of s.nth ?? []) if (n.of) addMost(n.of);
  }
  return [ids, classes, tags];
}

/** True when any rule of these sheets uses a structural pseudo-class or a sibling combinator (so moving, adding and removing elements restyles their siblings). */
export function usesStructure(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => sel.parts.some((p, i) => i > 0 && (p.combinator === "+" || p.combinator === "~")) || selectorUses(sel, (p) => !!p.nth?.length || !!p.empty))));
}

/** True when any rule of these sheets is inside `@media` (so the rules match again when the canvas size changes). */
export function usesMedia(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => !!r.media?.length));
}

/** The canvas a target's `@media` rules match against: its root's. */
function mediaOf(t: StyleTarget): UIMediaEnvironment | null {
  let root = t;
  while (root.parent) root = root.parent;
  return root.media ?? null;
}

/** ADR 0428: the canvas a target's viewport lengths resolve against: its root's (`viewport`, else `media`). */
function viewportOf(t: StyleTarget): UIMediaEnvironment | null {
  let root = t;
  while (root.parent) root = root.parent;
  return root.viewport ?? root.media ?? null;
}

/** True when every `@media` block a rule is in matches the canvas. */
function ruleInMedia(rule: StyleRule, env: UIMediaEnvironment | null): boolean {
  if (!rule.media) return true;
  return rule.media.every((list) => matchMediaQueries(list, env));
}

/** True when any rule of these sheets uses a pseudo-class (so elements restyle when their state changes). */
export function usesPseudo(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => selectorUses(sel, (p) => p.pseudo.length > 0))));
}

/**
 * ADR 0428: how changes inside the tree restyle the elements whose `:has()` may match differently, for sheets using it
 * (null when none does). `anchors`: the compounds holding a `:has()` (tag, id and classes; `any` when one has none),
 * so only ancestors that could be one restyle. `deep`: a `:has()` compound isn't the subject of its selector (`.card:has(.x)
 * .title`), so an anchor restyles with its parent's subtree. `siblings`: a relative selector starts with `+` or `~`, so
 * earlier siblings can be anchors too.
 */
export interface UIHasUse {
  readonly anchors: readonly { readonly tag: string | null; readonly id: string | null; readonly classes: readonly string[] }[];
  readonly any: boolean;
  readonly deep: boolean;
  readonly siblings: boolean;
}

export function hasUse(sheets: readonly { rules: readonly StyleRule[] }[]): UIHasUse | null {
  const anchors: { tag: string | null; id: string | null; classes: readonly string[] }[] = [];
  let any = false, deep = false, siblings = false, found = false;
  const visit = (sel: Selector, subject: boolean) => {
    sel.parts.forEach((p, i) => {
      const s = p.selector;
      const isSubject = subject && i === sel.parts.length - 1;
      if (s.has?.length) {
        found = true;
        if (!isSubject) deep = true;
        if (!s.tag && !s.id && !s.classes.length) any = true;
        else anchors.push({ tag: s.tag, id: s.id, classes: s.classes });
        for (const list of s.has) for (const rel of list) if (rel.parts[0].combinator === "+" || rel.parts[0].combinator === "~") siblings = true;
      }
      for (const g of s.is ?? []) for (const x of g.selectors) visit(x, isSubject);
      for (const list of s.not ?? []) for (const x of list) visit(x, isSubject);
      for (const n of s.nth ?? []) for (const x of n.of ?? []) visit(x, false);
    });
  };
  for (const sheet of sheets) for (const r of sheet.rules) for (const sel of r.selectors) visit(sel, true);
  return found ? { anchors, any, deep, siblings } : null;
}

/** ADR 0428: true when an element with this tag, id and classes could be the anchor of one of the sheets' `:has()`. */
export function couldAnchorHas(use: UIHasUse, tag: string, id: string | null, classes: readonly string[]): boolean {
  if (use.any) return true;
  return use.anchors.some((a) => (!a.tag || sameTag(a.tag, tag)) && (!a.id || a.id === id) && a.classes.every((c) => classes.includes(c)));
}

/** ADR 0428: true when any declaration of these sheets (keyframes included) has a viewport length, so a canvas resize restyles. */
export function usesViewportUnits(sheets: readonly UIStylesheet[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.declarations.some((d) => hasViewportUnits(d.value))) || (s.keyframes ?? []).some((k) => k.frames.some((f) => f.declarations.some((d) => hasViewportUnits(d.value)))));
}

/** True when any rule of these sheets uses `:lang()` (so elements restyle when the language changes, ADR 0356 §4). */
export function usesLang(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => selectorUses(sel, (p) => p.lang.length > 0))));
}

// --- Selectors: :is(), :where() and tag names (ADR 0419) -----------------------------------------
// Svelte's scoped CSS emits `:where(.svelte-hash)` and lowercase HTML tags. `:is()` (the specificity of
// its most specific argument) and `:where()` (no specificity) each hold a selector list matched against
// the element itself. Tags match case-insensitively: the HTML tags Svelte components are written with (`div`,
// `button`) match the tag as written, and a UI element name (`Button`) matches it in any case.

/** An `:is()` or `:where()` argument list: one of its selectors must match the element. */
export interface SelectorGroup {
  readonly selectors: readonly Selector[];
  /** `:where()`: adds no specificity. */
  readonly zero: boolean;
}

const KNOWN_TAGS: ReadonlySet<string> = new Set([...[...UI_TAGS].map((t) => t.toLowerCase()), ...HTML_TAGS.keys()]);

/** A UI element name (any case), or an HTML tag the renderer maps onto one (`div`, `span`, `button`…). */
export function isKnownTag(name: string): boolean {
  return KNOWN_TAGS.has(name.toLowerCase());
}

/** Tags match case-insensitively, as HTML tags do. */
function sameTag(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

export function groupSpecificity(g: SelectorGroup): readonly [number, number, number] {
  if (g.zero) return [0, 0, 0];
  let best: readonly [number, number, number] = [0, 0, 0];
  for (const sel of g.selectors) if (compareSpec(sel.specificity, best) > 0) best = sel.specificity;
  return best;
}

function matchesGroup(g: SelectorGroup, t: StyleTarget): boolean {
  return g.selectors.some((sel) => matchFrom(sel, sel.parts.length - 1, t));
}

/** True when `test` holds for a compound of the selector, or of a selector inside its `:is()`, `:where()`, `:not()` or `:nth-*(… of S)`. */
function selectorUses(sel: Selector, test: (s: SimpleSelector) => boolean): boolean {
  const inner = (list: readonly Selector[]) => list.some((s) => selectorUses(s, test));
  return sel.parts.some((p) => {
    const s = p.selector;
    return test(s) || (s.is ?? []).some((g) => inner(g.selectors)) || (s.not ?? []).some(inner) || (s.has ?? []).some(inner) || (s.nth ?? []).some((n) => !!n.of && inner(n.of));
  });
}

// --- Values -------------------------------------------------------------------------------------

export { parseColor };

function parseNumber(raw: string): number | undefined {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/.exec(raw.trim());
  return m ? parseFloat(m[1]) : undefined;
}

/** `aspect-ratio` (ADR 0418): `16 / 9`, `1.5`, or `auto` or `0` (none). Undefined for anything else. */
function parseAspectRatio(raw: string): number | undefined {
  if (raw === "auto") return 0;
  const m = /^(\d+\.?\d*|\.\d+)\s*(?:\/\s*(\d+\.?\d*|\.\d+))?$/.exec(raw);
  if (!m) return undefined;
  const r = parseFloat(m[1]) / (m[2] !== undefined ? parseFloat(m[2]) : 1);
  return Number.isFinite(r) && r >= 0 ? r : undefined;
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
  const paint = PAINT_VALUES[info.name] ?? TRANSFORM_VALUES[info.name];
  if (paint) return paint(v, file);
  if (type === Number) {
    if (NULLABLE_NUMBER_FIELDS.has(info.name) && (v === "auto" || v === "none")) return null;
    if (info.name === "aspectRatio") return parseAspectRatio(v);
    return parseNumber(v);
  }
  // A bare attribute (`<Canvas auto-focus>`) is true, as in HTML.
  if (type === Boolean) return v === "true" || v === "" ? true : v === "false" ? false : undefined;
  if (type === Color) return parseColor(v);
  if (type === Vector2) {
    const parts = v.split(/[\s,]+/).filter(Boolean).map(parseNumber);
    if (parts.length === 1 && parts[0] !== undefined) return new Vector2(parts[0], parts[0]);
    return parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined ? new Vector2(parts[0], parts[1]) : undefined;
  }
  if (type === AssetRef) {
    // ADR 0425: `font-family` names a font file or a CSS generic family (`monospace`); of a list, the first.
    if (info.name === "font") {
      const first = unquote((v.split(",")[0] ?? "").trim());
      if (isGenericFontFamily(first)) return first;
      if (!/^url\(/.test(v) && v.includes(",")) return convertValue(first, info, file);
    }
    const url = /^url\((.*)\)$/.exec(v);
    const path = unquote(url ? url[1] : v);
    if (path === "" || path.startsWith("asset:")) return path;
    return `asset:${path.startsWith("./") || path.startsWith("../") ? resolvePath(file, path) : path.replace(/^\//, "")}`;
  }
  if (type === String) {
    const s = unquote(v);
    if (LENGTH_FIELDS.has(info.name)) {
      if (s === "auto" || /^-?(\d+\.?\d*|\.\d+)%$/.test(s)) return s;
      if (s === "none" && NONE_LENGTH_FIELDS.has(info.name)) return s;
      // `calc()` mixing % and px (ADR 0418 wave 5), in the form `resolveMath` writes: the UI core resolves it at layout.
      if (linearLength(s)) return s;
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

/** `background-color` → `backgroundColor`; camelCase stays. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Property and attribute names (camelCase) that name another field: CSS's `position` is `positionType`. */
const ALIASES: Readonly<Record<string, string>> = { position: "positionType", fontFamily: "font", textDecorationLine: "textDecoration" };

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

// --- Paint values (ADR 0418 wave 2) --------------------------------------------------------------

/**
 * String fields whose value is CSS paint, checked and normalised as they're set: `backgroundImage` takes `none`,
 * `url()` (a relative path resolved against the file, as asset fields are) or a gradient. Undefined when invalid.
 */
const PAINT_VALUES: Readonly<Record<string, (value: string, file: string) => unknown>> = {
  backgroundImage: (value, file) => {
    const parsed = parseBackgroundImage(value);
    if (!parsed.ok) return undefined;
    if (parsed.value.kind === "none") return "";
    if (parsed.value.kind !== "url") return value;
    const path = parsed.value.path;
    const asset = path.startsWith("asset:") ? path : `asset:${path.startsWith("./") || path.startsWith("../") ? resolvePath(file, path) : path.replace(/^\//, "")}`;
    return `url("${asset}")`;
  },
};

/** The fields a paint shorthand sets, with their values; or why the value can't be read. */
type PaintExpansion = { readonly ok: true; readonly fields: readonly (readonly [string, unknown])[] } | { readonly ok: false; readonly problem: string };

const CORNERS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"] as const;

function shadowFields(prefix: "boxShadow" | "textShadow", value: string): PaintExpansion {
  const s = parseShadow(value);
  if (!s.ok) return s;
  const { offsetX, offsetY, blur, color } = s.value;
  return { ok: true, fields: [[`${prefix}Color`, color], [`${prefix}OffsetX`, offsetX], [`${prefix}OffsetY`, offsetY], [`${prefix}Blur`, blur]] };
}

/**
 * Paint shorthands (camelCase property to its expansion): `box-shadow` and `text-shadow` set their colour, offset and
 * blur fields; `border-radius` with one value sets `borderRadius` and puts every corner back on it (-1), and with two
 * to four sets the corners, in CSS order.
 */
const PAINT_SHORTHANDS: Readonly<Record<string, (value: string) => PaintExpansion>> = {
  boxShadow: (value) => shadowFields("boxShadow", value),
  textShadow: (value) => shadowFields("textShadow", value),
  borderRadius: (value) => {
    const r = parseCornerRadii(value);
    if (!r.ok) return r;
    if (value.trim().split(/\s+/).length === 1) return { ok: true, fields: [["borderRadius", r.value[0]], ...CORNERS.map((c) => [c, -1] as const)] };
    return { ok: true, fields: CORNERS.map((c, i) => [c, r.value[i]] as const) };
  },
};

/** True for a property (camelCase) that's a paint shorthand rather than one field. */
export function isPaintShorthand(property: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAINT_SHORTHANDS, property);
}

/** A paint shorthand's longhand fields and values (`box-shadow: 0 2px 4px #0008` sets `boxShadowOffsetY` to 2, and so on). */
export function expandPaintShorthand(property: string, value: string): PaintExpansion {
  const expand = PAINT_SHORTHANDS[property];
  return expand ? expand(value) : { ok: false, problem: `${property} isn't a paint shorthand.` };
}

// --- Transform values (ADR 0418 wave 3) ---------------------------------------------------------
//
// `transform`, `translate`, `scale` and `transform-origin` are shorthands of the transform fields, expanded where they're
// declared, as the paint shorthands are (typed values, parsed by `transformValues.ts`). `rotate` is a field itself and
// takes an angle. A `transform` list folds into the fields, applied as translate, rotate, scale (`transform2d.ts`); a list
// that can't fold (a skew, `matrix()`) is held in `transformMatrix` (ADR 0426). The `translate` attribute stays HTML's localisation marker
// (ADR 0356 §4), so markup writes `transform="translate(…)"` or `translate-x`/`translate-y`.

/** A px or % length, as a transform length field stores it (`"12"`, `"50%"`). Undefined when it isn't one. */
function transformLength(value: string): string | undefined {
  if (/\s/.test(value.trim())) return undefined;
  const r = parseTranslate(value);
  return r.ok && value.trim().toLowerCase() !== "none" ? r.value.translateX : undefined;
}

/** A position along one axis: px, %, or that axis's keywords. */
function originAlong(axis: "x" | "y") {
  const keywords: Record<string, string> = axis === "x" ? { left: "0%", center: "50%", right: "100%" } : { top: "0%", center: "50%", bottom: "100%" };
  return (value: string): string | undefined => keywords[value.trim().toLowerCase()] ?? transformLength(value);
}

/** Transform fields whose values are checked and normalised as they're set (lengths, angles). Undefined when invalid. */
const TRANSFORM_VALUES: Readonly<Record<string, (value: string, file: string) => unknown>> = {
  translateX: transformLength,
  translateY: transformLength,
  transformOriginX: originAlong("x"),
  transformOriginY: originAlong("y"),
  rotate: (value) => {
    const r = parseRotate(value);
    return r.ok ? r.value : undefined;
  },
  // ADR 0426: `matrix(a, b, c, d, e, f)` (or six numbers), stored as `matrix()` text; "" or `none` for none.
  transformMatrix: (value) => {
    const v = value.trim();
    if (v === "" || v.toLowerCase() === "none") return "";
    const n = (/^matrix\(([^()]*)\)$/i.exec(v)?.[1] ?? v).split(/[\s,]+/).filter((p) => p !== "").map(Number);
    return n.length === 6 && n.every(Number.isFinite) ? matrixText(n as unknown as UIAffine) : undefined;
  },
};

const fieldsFrom = (r: { ok: true; value: object } | { ok: false; problem: string }): PaintExpansion => (r.ok ? { ok: true, fields: Object.entries(r.value) } : r);

/** Transform shorthands (camelCase property to its expansion into the transform fields). */
const TRANSFORM_SHORTHANDS: Readonly<Record<string, (value: string) => PaintExpansion>> = {
  transform: (value) => fieldsFrom(parseTransform(value)),
  translate: (value) => fieldsFrom(parseTranslate(value)),
  scale: (value) => fieldsFrom(parseScale(value)),
  transformOrigin: (value) => fieldsFrom(parseTransformOrigin(value)),
};

/** ADR 0426: `filter` sets every filter field (`filterValues.ts`). */
const filterShorthand = (value: string): PaintExpansion => fieldsFrom(parseFilter(value));

/** The expansion of a shorthand that sets typed values (paint, ADR 0418 wave 2; transforms, wave 3; filters, 0426), or undefined. */
function typedShorthand(property: string): ((value: string) => PaintExpansion) | undefined {
  if (Object.prototype.hasOwnProperty.call(PAINT_SHORTHANDS, property)) return PAINT_SHORTHANDS[property];
  if (Object.prototype.hasOwnProperty.call(TRANSFORM_SHORTHANDS, property)) return TRANSFORM_SHORTHANDS[property];
  if (property === "filter") return filterShorthand;
  return undefined;
}

// --- Shorthands (ADR 0418 wave 1) ---------------------------------------------------------------
//
// A shorthand (`padding: 4px 8px`, `border: 2px solid #fff`, `flex: 1 1 0`) expands to its longhand fields where it
// is declared, in an attribute or a rule, so the cascade orders it with the longhands as CSS does: whichever comes
// later (by specificity, then order; attributes after rules) wins for each longhand. `padding`, `margin` and
// `borderWidth` are fields too, the all-sides values: one value sets that field and clears the sides (null: take it),
// two to four set the sides.

/** One longhand of an expansion: its field and the value to convert, or null to write null (a side that takes the all-sides value). */
type Longhand = readonly [field: string, raw: string | null];

interface Shorthand {
  /** Every field it can set. */
  readonly longhands: readonly string[];
  /** The longhands a value sets; null when the value isn't valid for it. */
  expand(value: string): Longhand[] | null;
}

/** A value's space-separated parts, keeping parenthesised groups (`rgb(1, 2, 3)`) whole. */
function valueParts(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

/** CSS's one to four values as top, right, bottom, left. */
function fourSides(parts: readonly string[]): [string, string, string, string] | null {
  const [a, b = a, c = a, d = b] = parts;
  return parts.length >= 1 && parts.length <= 4 ? [a, b, c, d] : null;
}

/** `padding`, `margin`, `border-width`: one value is the all-sides field (sides cleared), two to four the sides. */
function edgeShorthand(all: string, side: (s: (typeof SIDES)[number]) => string): Shorthand {
  const sides = SIDES.map(side);
  return {
    longhands: [all, ...sides],
    expand(value) {
      const parts = valueParts(value);
      if (parts.length === 1) return [[all, parts[0]], ...sides.map((s): Longhand => [s, null])];
      const four = fourSides(parts);
      return four ? sides.map((s, i): Longhand => [s, four[i]]) : null;
    },
  };
}

const BORDER_STYLES: ReadonlySet<string> = new Set(["solid", "none", "hidden"]);

/**
 * `border: <width> <style> <colour>`, any order, each optional: the width on every side (`medium`, 3, when only a
 * style is given), `solid`, or `none`/`hidden` for no border, and the colour.
 */
const BORDER: Shorthand = {
  longhands: ["borderWidth", ...SIDES.map((s) => `border${s}Width`), "borderColor"],
  expand(value) {
    let width: string | null = null, style: string | null = null, color: string | null = null;
    for (const part of valueParts(value)) {
      const p = part.toLowerCase();
      if (BORDER_STYLES.has(p) && style === null) style = p;
      else if (parseNumber(p) !== undefined && width === null) width = p;
      else if (p === "medium" || p === "thin" || p === "thick") width = p === "thin" ? "1" : p === "thick" ? "5" : "3";
      else if (parseColor(p) && color === null) color = part;
      else return null;
    }
    if (width === null && style === null && color === null) return null;
    const w = style === "none" || style === "hidden" ? "0" : (width ?? "3");
    const out: Longhand[] = [["borderWidth", w], ...SIDES.map((s): Longhand => [`border${s}Width`, null])];
    if (color !== null) out.push(["borderColor", color]);
    return out;
  },
};

const isFlexNumber = (p: string) => /^(\d+\.?\d*|\.\d+)$/.test(p);

/**
 * `flex: <grow> <shrink> <basis>`, as CSS reads it: `none` (0 0 auto), `auto` (1 1 auto), `initial` (0 1 auto),
 * one number (that grow, 1, 0), one length (1 1 that basis), two numbers (grow shrink 0), a number and a length
 * (grow 1 basis), or all three.
 */
const FLEX: Shorthand = {
  longhands: ["flexGrow", "flexShrink", "flexBasis"],
  expand(value) {
    const parts = valueParts(value);
    const of = (grow: string, shrink: string, basis: string): Longhand[] => [["flexGrow", grow], ["flexShrink", shrink], ["flexBasis", basis]];
    if (parts.length === 1) {
      const p = parts[0];
      if (p === "none") return of("0", "0", "auto");
      if (p === "auto") return of("1", "1", "auto");
      if (p === "initial") return of("0", "1", "auto");
      return isFlexNumber(p) ? of(p, "1", "0") : of("1", "1", p);
    }
    if (parts.length === 2) {
      const [a, b] = parts;
      if (!isFlexNumber(a)) return null;
      return isFlexNumber(b) ? of(a, b, "0") : of(a, "1", b);
    }
    if (parts.length === 3 && isFlexNumber(parts[0]) && isFlexNumber(parts[1])) return of(parts[0], parts[1], parts[2]);
    return null;
  },
};

/**
 * ADR 0423: `overflow: <x> [<y>]`: one value is the field itself (both axes, the axes' own fields cleared), two set
 * `overflowX` and `overflowY`. CSS's `clip` is `hidden` here.
 */
const OVERFLOW: Shorthand = {
  longhands: ["overflow", "overflowX", "overflowY"],
  expand(value) {
    const parts = valueParts(value).map((p) => (p.toLowerCase() === "clip" ? "hidden" : p.toLowerCase()));
    if (parts.length === 1) return [["overflow", parts[0]], ["overflowX", null], ["overflowY", null]];
    if (parts.length === 2) return [["overflowX", parts[0]], ["overflowY", parts[1]]];
    return null;
  },
};

/** ADR 0423: `scrollbar-color: <thumb> <track>`, or `auto` (the defaults). */
const SCROLLBAR_COLOR: Shorthand = {
  longhands: ["scrollbarThumbColor", "scrollbarTrackColor"],
  expand(value) {
    const parts = valueParts(value);
    if (parts.length === 1 && parts[0].toLowerCase() === "auto") return [["scrollbarThumbColor", null], ["scrollbarTrackColor", null]];
    return parts.length === 2 ? [["scrollbarThumbColor", parts[0]], ["scrollbarTrackColor", parts[1]]] : null;
  },
};

/** ADR 0428: `scroll-padding`/`scroll-margin`'s `auto` is no inset here. */
const scrollInset = (p: string) => (p.toLowerCase() === "auto" ? "0" : p);

/** ADR 0428: `scroll-padding` and `scroll-margin`: one to four values to the sides (`auto` is 0). */
function scrollEdges(prefix: "scrollPadding" | "scrollMargin"): Shorthand {
  const sides = SIDES.map((s) => `${prefix}${s}`);
  return {
    longhands: sides,
    expand(value) {
      const four = fourSides(valueParts(value).map(scrollInset));
      return four ? sides.map((s, i): Longhand => [s, four[i]]) : null;
    },
  };
}

/** ADR 0428: `scroll-padding-block`/`-inline` (and the margins'): `<start> [<end>]` on the vertical or horizontal sides. */
function scrollAxisEdges(prefix: "scrollPadding" | "scrollMargin", axis: "block" | "inline"): Shorthand {
  const [a, b] = axis === "block" ? [`${prefix}Top`, `${prefix}Bottom`] : [`${prefix}Left`, `${prefix}Right`];
  return {
    longhands: [a, b],
    expand(value) {
      const parts = valueParts(value).map(scrollInset);
      return parts.length === 1 || parts.length === 2 ? [[a, parts[0]], [b, parts[1] ?? parts[0]]] : null;
    },
  };
}

const SNAP_AXES: ReadonlySet<string> = new Set(["x", "y", "block", "inline", "both"]);

/** ADR 0428: `scroll-snap-type: none | <axis> [mandatory | proximity]` (`scrollSnapAxis`, `scrollSnapStrictness`). */
const SCROLL_SNAP_TYPE: Shorthand = {
  longhands: ["scrollSnapAxis", "scrollSnapStrictness"],
  expand(value) {
    const parts = valueParts(value).map((p) => p.toLowerCase());
    if (parts.length === 1 && parts[0] === "none") return [["scrollSnapAxis", "none"], ["scrollSnapStrictness", "proximity"]];
    if (parts.length < 1 || parts.length > 2 || !SNAP_AXES.has(parts[0])) return null;
    const strictness = parts[1] ?? "proximity";
    return strictness === "mandatory" || strictness === "proximity" ? [["scrollSnapAxis", parts[0]], ["scrollSnapStrictness", strictness]] : null;
  },
};

/** ADR 0428: `scroll-snap-align: <block> [<inline>]` (one value both). */
const SCROLL_SNAP_ALIGN: Shorthand = {
  longhands: ["scrollSnapAlignBlock", "scrollSnapAlignInline"],
  expand(value) {
    const parts = valueParts(value).map((p) => p.toLowerCase());
    return parts.length === 1 || parts.length === 2 ? [["scrollSnapAlignBlock", parts[0]], ["scrollSnapAlignInline", parts[1] ?? parts[0]]] : null;
  },
};

/** ADR 0428: `scrollbar-gutter: auto | stable | stable both-edges` (either order). */
const SCROLLBAR_GUTTER: Shorthand = {
  longhands: ["scrollbarGutter"],
  expand(value) {
    const parts = valueParts(value).map((p) => p.toLowerCase()).sort();
    const key = parts.join(" ");
    if (key === "auto" || key === "stable") return [["scrollbarGutter", key]];
    return key === "both-edges stable" ? [["scrollbarGutter", "stable both-edges"]] : null;
  },
};

/** Shorthand properties by the field name they're written as (`border-width` → `borderWidth`). */
const SHORTHANDS: ReadonlyMap<string, Shorthand> = new Map([
  ["padding", edgeShorthand("padding", (s) => `padding${s}`)],
  ["margin", edgeShorthand("margin", (s) => `margin${s}`)],
  ["borderWidth", edgeShorthand("borderWidth", (s) => `border${s}Width`)],
  ["border", BORDER],
  ["flex", FLEX],
  ["overflow", OVERFLOW],
  ["scrollbarColor", SCROLLBAR_COLOR],
  ["scrollbarGutter", SCROLLBAR_GUTTER],
  ["scrollSnapType", SCROLL_SNAP_TYPE],
  ["scrollSnapAlign", SCROLL_SNAP_ALIGN],
  ["scrollPadding", scrollEdges("scrollPadding")],
  ["scrollMargin", scrollEdges("scrollMargin")],
  ["scrollPaddingBlock", scrollAxisEdges("scrollPadding", "block")],
  ["scrollPaddingInline", scrollAxisEdges("scrollPadding", "inline")],
  ["scrollMarginBlock", scrollAxisEdges("scrollMargin", "block")],
  ["scrollMarginInline", scrollAxisEdges("scrollMargin", "inline")],
]);

/** True when `name` is a shorthand that sets one of `fields` (a Text has no border, so `border` on it sets nothing). */
function shorthandApplies(name: string, fields: ReadonlyMap<string, FieldInfo>): boolean {
  return SHORTHANDS.get(name)?.longhands.some((f) => fields.has(f)) ?? false;
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

const passedOn = new WeakMap<ReadonlyMap<string, FieldInfo>, ReadonlyMap<string, FieldInfo>>();

/**
 * ADR 0428: the inherited fields a component doesn't have, which it only passes on to its children (a panel's `color`),
 * with a text element's field info for their types: what the UI animator animates for its children.
 */
export function passedOnFields(fields: ReadonlyMap<string, FieldInfo>): ReadonlyMap<string, FieldInfo> {
  let out = passedOn.get(fields);
  if (!out) {
    const text = fieldsOf(UIText);
    const map = new Map<string, FieldInfo>();
    for (const f of INHERITED_FIELDS) if (!fields.has(f) && text.has(f)) map.set(f, text.get(f)!);
    passedOn.set(fields, (out = map));
  }
  return out;
}

/** ADR 0428: an inherited value an element passes on (the text it was declared as, or a typed value) as `info`'s type, or undefined. */
export function passedOnValue(value: unknown, info: FieldInfo, file: string): unknown {
  return typeof value === "string" && info.type !== String ? convertValue(value, info, file) : value;
}

let knownFields: Set<string> | null = null;
/** Every UI component's field names and the shorthands (`border`, `flex`): properties outside these are unknown. */
function isKnownField(name: string): boolean {
  knownFields ??= new Set(UI_TYPES.flatMap((t) => [...fieldsOf(t).keys()]));
  return knownFields.has(name) || typedShorthand(name) !== undefined || SHORTHANDS.has(name);
}

/**
 * The field an attribute sets (`flex-direction` and `flexDirection` both name `flexDirection`; `position` names
 * `positionType`), or null for `id`, `class`, `translate` and key attributes (`t:text`, see `keyAttributeField`).
 */
export function attributeField(attribute: MarkupAttribute): string | null {
  if (NOT_FIELDS.has(attribute.name)) return null;
  const field = propertyField(attribute.name);
  return REFERENCE_FIELDS.has(field) ? null : field;
}

/** The node reference field an attribute names by an element id (`nav-up="play"` → `navUp`, `first-selected` → `firstSelected`), or null. */
export function referenceField(attribute: MarkupAttribute): string | null {
  const field = propertyField(attribute.name);
  return REFERENCE_FIELDS.has(field) ? field : null;
}

/**
 * ADR 0428: the resolved-map key holding what an element's relative lengths resolved against (`UIRelativeUnits`: its
 * font size for `em`, the root's for `rem`, the canvas for viewport units); never a field. Children read the root's
 * font size from their parent's, and keyframes convert with the element's.
 */
export const UNITS_KEY = "@units";

/** A font size as a resolved map holds it (a number, or the text an element without the field passes on), or undefined. */
function fontSizeOf(v: ResolvedValue | undefined): number | undefined {
  const value = v?.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" ? parseNumber(value) : undefined;
}

/** What an element's relative lengths resolved against (`UNITS_KEY`): `em` its font size, `parentEm` its parent's (`em` inside `font-size`). */
export interface UIElementUnits extends UIRelativeUnits {
  readonly parentEm: number;
}

/** The units an element's relative lengths resolve against (`UNITS_KEY`), or null when it has none. */
export function unitsOf(resolved: ReadonlyMap<string, ResolvedValue> | null | undefined): UIElementUnits | null {
  return (resolved?.get(UNITS_KEY)?.value as UIElementUnits | undefined) ?? null;
}

/** ADR 0428: a value with an element's relative lengths in px (`em` inside `font-size` is its parent's), or undefined when a viewport length can't resolve. */
export function withElementUnits(value: string, field: string, units: UIElementUnits | null): string | undefined {
  if (!units) return resolveRelativeUnits(value, { em: 16, rem: 16, viewport: null });
  return resolveRelativeUnits(value, field === "fontSize" ? { em: units.parentEm, rem: units.rem, viewport: units.viewport } : units);
}

/**
 * ADR 0428: the resolved-map key holding a pseudo-element's `content` (`UIContentPiece[]`, or null for `none`/`normal`);
 * never a field, never inherited. Only pseudo-element targets get it: `content` on an element does nothing, as in CSS.
 */
export const CONTENT_KEY = "@content";

/** A variable's key in a resolved map: `--name` (variables inherit, like the text properties). */
const isVariable = (key: string) => key.startsWith("--");

/** Variables declared on `:root` in these sheets (in `@media` blocks that match `env`), in cascade order. */
function rootVariables(sheets: readonly { rules: readonly StyleRule[]; file: string }[], env: UIMediaEnvironment | null): Map<string, ResolvedValue> {
  const out = new Map<string, ResolvedValue>();
  const rules = sheets.flatMap((s) => s.rules.map((r) => ({ r, file: s.file }))).filter(({ r }) => r.selectors.some((sel) => sel.root) && ruleInMedia(r, env));
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
  const env = mediaOf(target);
  // ADR 0425: a run of text between inline elements (`#text`) isn't an element: no rule matches it (not even `*`); it
  // only inherits, as a DOM text node's style is its parent's.
  for (const sheet of target.tag === TEXT_PIECE_TAG ? [] : sheets) {
    for (const rule of sheet.rules) {
      if (rule.media && !ruleInMedia(rule, env)) continue;
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
  const inheritedVars = parent ? [...parent].filter(([k]) => isVariable(k)) : [...rootVariables(sheets, env)];
  for (const [k, v] of inheritedVars) out.set(k, v);
  for (const m of matched) {
    if (isVariable(m.declaration.property)) out.set(m.declaration.property, { field: m.declaration.property, value: m.declaration.value, source: { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file } });
  }
  // An inline style's variables (`style="--accent: red"`, and Svelte's CSS custom property props) beat the rules', as on the web.
  for (const a of element.attributes) {
    if (isVariable(a.name)) out.set(a.name, { field: a.name, value: a.value, source: { kind: "attribute", attribute: a, file: element.file } });
  }
  const vars = new Map<string, string>();
  for (const [k, v] of out) vars.set(k, String(v.value));

  // ADR 0428: relative lengths. `em` is the element's font size (its parent's inside `font-size`), `rem` the root's (the
  // initial 16px inside the root's own `font-size`), viewport units the canvas in UI pixels.
  const parentFont = fontSizeOf(parent?.get("fontSize")) ?? 16;
  const viewport = viewportOf(target);
  const parentUnits = unitsOf(parent);
  const rem = parent ? (parentUnits?.rem ?? 16) : 16;
  const fontUnits: UIRelativeUnits = { em: parentFont, rem, viewport };
  let units: UIRelativeUnits = fontUnits;

  /** A declared value with variables substituted, relative lengths in px and math functions worked out (ADR 0418 wave 5, 0428); undefined, warned once, when it can't be. */
  const prepare = (raw: string, where: string, field?: string): string | undefined => {
    let substituted = substituteVars(raw, vars);
    if (substituted === undefined) {
      warnOnce(`${where}: "${raw}" uses a variable that isn't defined.`);
      return undefined;
    }
    const resolvedUnits = resolveRelativeUnits(substituted, field === "fontSize" ? fontUnits : units);
    if (resolvedUnits === undefined) {
      warnOnce(`${where}: "${substituted}" uses a viewport length before the canvas size is known.`);
      return undefined;
    }
    substituted = resolvedUnits;
    const math = resolveMath(substituted);
    if (!math.ok) {
      warnOnce(`${where}: "${substituted}" ${math.problem}`);
      return undefined;
    }
    return math.value;
  };

  const set = (field: string, raw: string, source: ValueSource, where: string) => {
    const shorthand = SHORTHANDS.get(field);
    const info = fields.get(field);
    if (!info && !shorthand) return false;
    const substituted = prepare(raw, where, field);
    if (substituted === undefined) return false;
    if (shorthand) {
      // ADR 0418: every longhand this element has, or none when one of them isn't valid.
      const invalid = () => warnOnce(`${where}: "${substituted}" isn't a valid ${field} for <${target.tag}>.`);
      const longhands = shorthand.expand(substituted);
      if (!longhands) return invalid(), false;
      const values: [string, unknown][] = [];
      for (const [f, r] of longhands) {
        const fi = fields.get(f);
        if (!fi) continue;
        const v = r === null ? null : convertValue(r, fi, element.file);
        if (v === undefined) return invalid(), false;
        values.push([f, v]);
      }
      for (const [f, v] of values) out.set(f, { field: f, value: v, source });
      return true;
    }
    const value = convertValue(substituted, info!, element.file);
    if (value === undefined) {
      warnOnce(`${where}: "${substituted}" isn't a valid ${field} for <${target.tag}>.`);
      return false;
    }
    out.set(field, { field, value, source });
    return true;
  };

  // A paint or transform shorthand (ADR 0418 waves 2 and 3) sets its longhands: this element's own, and inherited ones it passes on.
  const setShorthand = (property: string, raw: string, source: ValueSource, where: string) => {
    const substituted = prepare(raw, where);
    if (substituted === undefined) return;
    const expanded = typedShorthand(property)!(substituted);
    if (!expanded.ok) {
      warnOnce(`${where}: "${substituted}" ${expanded.problem}`);
      return;
    }
    for (const [field, value] of expanded.fields) {
      if (fields.has(field) || INHERITED_FIELDS.has(field)) out.set(field, { field, value: cloneValue(value), source });
    }
  };

  // ADR 0428: the element's own font size first (what `em` means in its other declarations): the winning `font-size`
  // (attributes after rules), else HTML's default for its tag, else inherited, else the initial 16px.
  {
    let own: { raw: string; where: string } | null = null;
    for (const m of matched) if (propertyField(m.declaration.property) === "fontSize") own = { raw: m.declaration.value, where: `${m.file} "${m.rule.selectorText}" ${m.declaration.property}` };
    for (const a of element.attributes) if (!isVariable(a.name) && attributeField(a) === "fontSize") own = { raw: a.value, where: `${element.file} <${element.tag} ${a.name}>` };
    let size: number | undefined;
    if (own) {
      const value = prepare(own.raw, own.where, "fontSize");
      size = value === undefined ? undefined : parseNumber(value);
    }
    size ??= (tagDefaults(target.tag, parent).find(([f]) => f === "fontSize")?.[1] as number | undefined) ?? parentFont;
    units = { em: size, rem: parent ? rem : size, viewport };
    const stored: UIElementUnits = { ...units, parentEm: parentFont };
    out.set(UNITS_KEY, { field: UNITS_KEY, value: stored, source: { kind: "default" } });
  }

  // Transitions and animations (ADR 0418 wave 4) are cascade data, ordered like the fields.
  const animation = new AnimationCascade();

  // Rules.
  for (const m of matched) {
    const prop = m.declaration.property;
    if (isVariable(prop)) continue;
    if (prop === "content") {
      if (!target.pseudoElement) continue;
      const where = `${m.file} "${m.rule.selectorText}" content`;
      const value = substituteVars(m.declaration.value, vars);
      if (value === undefined) {
        warnOnce(`${where}: "${m.declaration.value}" uses a variable that isn't defined.`);
        continue;
      }
      const parsed = parseContent(value);
      if (!parsed.ok) warnOnce(`${where}: "${value}" ${parsed.problem}`);
      else out.set(CONTENT_KEY, { field: CONTENT_KEY, value: parsed.value, source: { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file } });
      continue;
    }
    if (isAnimationProperty(prop)) {
      const where = `${m.file} "${m.rule.selectorText}" ${prop}`;
      const value = prepare(m.declaration.value, where);
      if (value !== undefined) animation.declare(prop, value, { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file }, where, warnOnce);
      continue;
    }
    const field = propertyField(prop);
    if (!isKnownField(field)) {
      warnOnce(`${m.file}: unknown property "${prop}" (in "${m.rule.selectorText}").`);
      continue;
    }
    const where = `${m.file} "${m.rule.selectorText}" ${prop}`;
    const source: ValueSource = { kind: "rule", rule: m.rule, declaration: m.declaration, file: m.file };
    if (typedShorthand(field)) {
      setShorthand(field, m.declaration.value, source, where);
    } else if (fields.has(field) || shorthandApplies(field, fields)) {
      set(field, m.declaration.value, source, where);
    } else if (INHERITED_FIELDS.has(field)) {
      // Not this element's field, but its children inherit it (a Panel's color reaches its Text).
      const substituted = prepare(m.declaration.value, where, field);
      if (substituted !== undefined) out.set(field, { field, value: substituted, source });
    }
  }

  // Attributes beat rules.
  for (const a of element.attributes) {
    if (isVariable(a.name)) continue; // declared above, with the rules' variables (an inline `style="--accent: …"`)
    const field = attributeField(a);
    if (!field) continue;
    if (isAnimationProperty(a.name)) {
      const where = `${element.file} <${element.tag} ${a.name}>`;
      const value = prepare(a.value, where);
      if (value !== undefined) animation.declare(a.name, value, { kind: "attribute", attribute: a, file: element.file }, where, warnOnce);
      continue;
    }
    if (typedShorthand(field)) {
      setShorthand(field, a.value, { kind: "attribute", attribute: a, file: element.file }, `${element.file} <${element.tag} ${a.name}>`);
      continue;
    }
    if (!fields.has(field) && !shorthandApplies(field, fields)) {
      if (!isKnownField(field)) warnOnce(`${element.file}: <${element.tag}> has no field "${a.name}".`);
      continue;
    }
    set(field, a.value, { kind: "attribute", attribute: a, file: element.file }, `${element.file} <${element.tag} ${a.name}>`);
  }

  // ADR 0425: HTML's own defaults for phrasing elements (`<b>` bold, `<a>` underlined…), below every declaration.
  for (const [field, value] of tagDefaults(target.tag, parent)) {
    if (!out.has(field) && fields.has(field)) out.set(field, { field, value, source: { kind: "default" } });
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
  animation.finish(out);
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

// --- Animation (ADR 0418 wave 4) ----------------------------------------------------------------
//
// `transition`, `animation`, their longhands and `@keyframes` are cascade data, not component fields: declarations
// (rules, then attributes, an inline style last) are ordered like the fields', and whichever comes later wins per
// longhand (a shorthand resets all of its longhands). The resolved map carries them under two keys that are never
// fields, `TRANSITION_KEY` and `ANIMATION_KEY`; the document and the UI host hand them to the UI animator
// (`ui/animation/`), which runs them on the tween backend (ADR 0420). Keyframe values convert here, per element, as
// rule values do: shorthands expand, variables substitute, and a value that can't convert is warned about once.

/** The resolved-map key holding an element's transitions (`UITransitionSpec[]`); never a field. */
export const TRANSITION_KEY = "@transition";
/** The resolved-map key holding an element's animations (`UIAnimationSpec[]`); never a field. */
export const ANIMATION_KEY = "@animation";

/** `transitionDuration` and `transition-duration` both name `transition-duration`. */
const kebabName = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();

/** True for a transition or animation property (kebab-case or camelCase): cascade data, not a field. */
export function isAnimationProperty(name: string): boolean {
  return ANIMATION_PROPERTIES.has(kebabName(name));
}

/** Declarations already read (an element restyles often; its sheets' values are few): the longhands set, or a problem. */
const longhandCache = new Map<string, Readonly<UITransitionLonghands | UIAnimationLonghands> | string>();

function parsedLonghands(name: string, raw: string, transition: boolean): Readonly<UITransitionLonghands | UIAnimationLonghands> | string {
  const key = `${name}:${raw}`;
  let parsed = longhandCache.get(key);
  if (parsed === undefined) {
    const into: UITransitionLonghands & UIAnimationLonghands = {};
    const problem = transition ? parseTransitionLonghand(name, raw, into) : parseAnimationLonghand(name, raw, into);
    parsed = problem ?? into;
    if (longhandCache.size >= 1024) longhandCache.clear();
    longhandCache.set(key, parsed);
  }
  return parsed;
}

/** The transition and animation declarations that apply to one element, in cascade order. */
class AnimationCascade {
  private readonly transition: UITransitionLonghands = {};
  private readonly animation: UIAnimationLonghands = {};
  private transitionSource: ValueSource | null = null;
  private animationSource: ValueSource | null = null;

  declare(property: string, raw: string | undefined, source: ValueSource, where: string, warn: (message: string) => void): void {
    if (raw === undefined) return warn(`${where}: uses a variable that isn't defined.`);
    const name = kebabName(property);
    const transition = name.startsWith("transition");
    const parsed = parsedLonghands(name, raw, transition);
    if (typeof parsed === "string") return warn(`${where}: "${raw}" isn't valid: ${parsed}`);
    if (transition) {
      Object.assign(this.transition, parsed);
      this.transitionSource = source;
    } else {
      Object.assign(this.animation, parsed);
      this.animationSource = source;
    }
  }

  finish(out: Map<string, ResolvedValue>): void {
    if (this.transitionSource) out.set(TRANSITION_KEY, { field: TRANSITION_KEY, value: transitionSpecs(this.transition), source: this.transitionSource });
    if (this.animationSource) out.set(ANIMATION_KEY, { field: ANIMATION_KEY, value: animationSpecs(this.animation), source: this.animationSource });
  }
}

/** The longhand fields of a shorthand property (camelCase), or null when it isn't one. */
function longhandsOf(property: string): readonly string[] | null {
  const plain = SHORTHANDS.get(property);
  if (plain) return plain.longhands;
  switch (property) {
    case "transform":
      return ["translateX", "translateY", "scaleX", "scaleY", "rotate", "transformMatrix"];
    case "translate":
      return ["translateX", "translateY"];
    case "scale":
      return ["scaleX", "scaleY"];
    case "transformOrigin":
      return ["transformOriginX", "transformOriginY"];
    case "boxShadow":
      return ["boxShadowColor", "boxShadowOffsetX", "boxShadowOffsetY", "boxShadowBlur"];
    case "textShadow":
      return ["textShadowColor", "textShadowOffsetX", "textShadowOffsetY", "textShadowBlur"];
    case "borderRadius":
      return ["borderRadius", ...CORNERS];
    case "filter":
      return FILTER_FIELDS;
  }
  return null;
}

/**
 * The fields of `fields` a `transition-property` name covers: every field for `all`, a shorthand's longhands
 * (`padding` its sides, `transform` the transform fields, `box-shadow` the shadow's), or the one field it names.
 */
export function transitionFields(property: string, fields: ReadonlyMap<string, FieldInfo>): string[] {
  if (property === "all") return [...fields.keys()];
  const field = propertyField(property);
  const longhands = longhandsOf(field);
  return (longhands ?? [field]).filter((f) => fields.has(f));
}

/** One stop of a keyframe track: where it is (0–1), the field's value there, and the timing of the segment it starts. */
export interface UIKeyframeStop {
  readonly offset: number;
  readonly value: unknown;
  /** `animation-timing-function` of its keyframe, or null (the animation's). */
  readonly timing: UITimingFunction | null;
}

/** The last `@keyframes` named `name` across the sheets (later sheets, then later blocks, win), or null. */
function findKeyframes(sheets: readonly UIStylesheet[], name: string) {
  for (let i = sheets.length - 1; i >= 0; i--) {
    const blocks = sheets[i].keyframes;
    if (!blocks) continue;
    for (let j = blocks.length - 1; j >= 0; j--) if (blocks[j].name === name) return { block: blocks[j], file: sheets[i].file };
  }
  return null;
}

/**
 * The tracks `@keyframes name` gives an element of `component`: per field, its stops in offset order (a keyframe
 * listing the same offset again overrides the field there). Values convert as rule values do, with the element's
 * variables (`resolved`); `file` resolves relative asset paths. Null when no such block exists.
 */
export function keyframeTracks(
  sheets: readonly UIStylesheet[],
  name: string,
  component: abstract new (...args: never[]) => object,
  resolved: ReadonlyMap<string, ResolvedValue>,
  file: string,
  warn: (message: string) => void,
  /** ADR 0428: fields the component only passes on (`passedOnFields`), animated for its children. */
  passed?: ReadonlyMap<string, FieldInfo>,
): Map<string, UIKeyframeStop[]> | null {
  const found = findKeyframes(sheets, name);
  if (!found) return null;
  const fields = passed?.size ? new Map([...fieldsOf(component), ...passed]) : fieldsOf(component);
  const vars = new Map<string, string>();
  for (const [k, v] of resolved) if (isVariable(k)) vars.set(k, String(v.value));
  const units = unitsOf(resolved);
  const tracks = new Map<string, Map<number, UIKeyframeStop>>();
  const put = (field: string, offset: number, value: unknown, timing: UITimingFunction | null) => {
    let track = tracks.get(field);
    if (!track) tracks.set(field, (track = new Map()));
    track.set(offset, { offset, value: cloneValue(value), timing });
  };
  for (const frame of found.block.frames) {
    let timing: UITimingFunction | null = null;
    const timingDecl = [...frame.declarations].reverse().find((d) => kebabName(d.property) === "animation-timing-function");
    if (timingDecl) {
      const t = parseTimingFunction(substituteVars(timingDecl.value, vars) ?? "");
      if (t.ok) timing = t.value;
      else warn(`${found.file} @keyframes ${name}: ${t.problem}`);
    }
    for (const d of frame.declarations) {
      if (isVariable(d.property) || isAnimationProperty(d.property)) continue;
      const where = `${found.file} @keyframes ${name} ${d.property}`;
      const field = propertyField(d.property);
      const varsDone = substituteVars(d.value, vars);
      if (varsDone === undefined) {
        warn(`${where}: "${d.value}" uses a variable that isn't defined.`);
        continue;
      }
      const substituted = withElementUnits(varsDone, field, units);
      if (substituted === undefined) {
        warn(`${where}: "${varsDone}" uses a viewport length before the canvas size is known.`);
        continue;
      }
      const math = resolveMath(substituted);
      if (!math.ok) {
        warn(`${where}: "${substituted}" ${math.problem}`);
        continue;
      }
      const raw = math.value;
      const values = keyframeValues(field, raw, fields, file);
      if (typeof values === "string") {
        warn(`${where}: "${raw}" ${values}`);
        continue;
      }
      for (const offset of frame.offsets) for (const [field, value] of values) put(field, offset, value, timing);
    }
  }
  const out = new Map<string, UIKeyframeStop[]>();
  for (const [field, stops] of tracks) out.set(field, [...stops.values()].sort((a, b) => a.offset - b.offset));
  return out;
}

/**
 * A keyframe declaration's fields and values for an element with `fields` (none it lacks), or why it can't be read:
 * shorthands expand and values convert as rule values do. Also the UI host's for keyframes played at runtime (ADR 0419:
 * Svelte transitions' CSS, through the renderer's `animate` hook).
 */
export function keyframeValues(field: string, raw: string, fields: ReadonlyMap<string, FieldInfo>, file: string): (readonly [string, unknown])[] | string {
  const typed = typedShorthand(field);
  if (typed) {
    const expanded = typed(raw);
    if (!expanded.ok) return expanded.problem;
    return expanded.fields.filter(([f]) => fields.has(f));
  }
  const shorthand = SHORTHANDS.get(field);
  if (shorthand) {
    const longhands = shorthand.expand(raw);
    if (!longhands) return `isn't a valid ${field}.`;
    const out: [string, unknown][] = [];
    for (const [f, r] of longhands) {
      const info = fields.get(f);
      if (!info) continue;
      const v = r === null ? null : convertValue(r, info, file);
      if (v === undefined) return `isn't a valid ${field}.`;
      out.push([f, v]);
    }
    return out;
  }
  const info = fields.get(field);
  if (!info) return isKnownField(field) ? [] : "isn't a known property.";
  const value = convertValue(raw, info, file);
  return value === undefined ? `isn't a valid ${field}.` : [[field, value]];
}
