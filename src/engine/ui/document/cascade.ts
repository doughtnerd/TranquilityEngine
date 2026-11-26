/**
 * The UI cascade (ADR 0077, 0419): selector matching against the built element tree, and the cascade
 * that turns attributes, rules, inheritance and variables into component field values. It works on
 * parsed rule data (`UIStylesheet`), so it holds no CSS parser: UI documents parse their sheets with
 * `stylesheet.ts` (css-tree), and Svelte components' styles are parsed when they compile, in the editor
 * and at export, so games using only Svelte UI load this module and never the parser.
 */
import { Color, Vector2 } from "../../core/math";
import { AssetRef, getFields, type FieldInfo } from "../../core/registry";
import { UI_TYPES } from "../components";
import { UI_TAGS as UI_KIND_TAGS } from "../elementKinds";
import { HTML_TAGS } from "../host/htmlTags";
import { hasBinding, resolvePath } from "./sourceText";
import { parseColor } from "./cssColor";
import { parseBackgroundImage, parseCornerRadii, parseShadow } from "./paintValues";
import { parseRotate, parseScale, parseTransform, parseTransformOrigin, parseTranslate } from "./transformValues";
import type {
  Declaration,
  MarkupAttribute,
  ResolvedValue,
  ResolveStyle,
  Selector,
  SimpleSelector,
  StyleRule,
  StyleTarget,
  UIPseudo,
  ValueSource,
} from "./types";


export const UI_TAGS: ReadonlySet<string> = UI_KIND_TAGS;
/** The pseudo-classes UI elements have. */
export const PSEUDO: ReadonlySet<string> = new Set<UIPseudo>(["hover", "pressed", "focus", "disabled"]);
/** Text fields children inherit, as on the web (camelCase field names). */
export const INHERITED_FIELDS: ReadonlySet<string> = new Set(["color", "fontSize", "fontWeight", "textAlign", "textOutlineColor", "textOutlineWidth", "textShadowColor", "textShadowOffsetX", "textShadowOffsetY", "textShadowBlur"]);
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
/** Attributes that aren't fields (`translate="no"` marks text as deliberately unlocalised, ADR 0356 §4). */
const NOT_FIELDS: ReadonlySet<string> = new Set(["id", "class", "translate"]);
/** The prefix of key attributes (`t:text="menu.start"`, ADR 0356 §4): the runtime writes the localised message. */
const KEY_ATTRIBUTE_PREFIX = "t:";
/** Node reference fields an attribute sets by naming another element's id (ADR 0340): the document resolves them after building. */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set(["navUp", "navDown", "navLeft", "navRight", "firstSelected"]);

// --- Matching -----------------------------------------------------------------------------------

function matchesSimple(s: SimpleSelector, t: StyleTarget): boolean {
  if (s.tag && !sameTag(s.tag, t.tag)) return false;
  if (s.id && s.id !== t.id) return false;
  for (const c of s.classes) if (!t.classes.includes(c)) return false;
  for (const p of s.pseudo) if (!t.state[p]) return false;
  for (const range of s.lang) if (!langMatches(t.lang, range)) return false;
  if (s.is) for (const g of s.is) if (!matchesGroup(g, t)) return false;
  return true;
}

/** CSS `:lang()` matching (ADR 0356 §4): the language equals the range or starts with it and a hyphen (`de` matches `de-AT`). */
function langMatches(language: string | undefined, range: string): boolean {
  if (!language) return false;
  const l = language.toLowerCase();
  const r = range.toLowerCase();
  return l === r || l.startsWith(`${r}-`);
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
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => selectorUses(sel, (p) => p.pseudo.length > 0))));
}

/** True when any rule of these sheets uses `:lang()` (so elements restyle when the language changes, ADR 0356 §4). */
export function usesLang(sheets: readonly { rules: readonly StyleRule[] }[]): boolean {
  return sheets.some((s) => s.rules.some((r) => r.selectors.some((sel) => selectorUses(sel, (p) => p.lang.length > 0))));
}

// --- Selectors: :is(), :where() and tag names (ADR 0419) -----------------------------------------
// Svelte's scoped CSS emits `:where(.svelte-hash)` and lowercase HTML tags. `:is()` (the specificity of
// its most specific argument) and `:where()` (no specificity) each hold a selector list matched against
// the element itself. Tags match case-insensitively: `button` is a UI document's `Button`, and the HTML
// tags Svelte components are written with (`div`) match the tag as written.

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

/** True when `test` holds for a compound of the selector, or of a selector inside its `:is()` / `:where()`. */
function selectorUses(sel: Selector, test: (s: SimpleSelector) => boolean): boolean {
  return sel.parts.some((p) => test(p.selector) || (p.selector.is ?? []).some((g) => g.selectors.some((inner) => selectorUses(inner, test))));
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
  if (isTextField(info)) return text;
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
// that can't fold (a skew) is refused with a warning. The `translate` attribute stays HTML's localisation marker
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
};

const fieldsFrom = (r: { ok: true; value: object } | { ok: false; problem: string }): PaintExpansion => (r.ok ? { ok: true, fields: Object.entries(r.value) } : r);

/** Transform shorthands (camelCase property to its expansion into the transform fields). */
const TRANSFORM_SHORTHANDS: Readonly<Record<string, (value: string) => PaintExpansion>> = {
  transform: (value) => fieldsFrom(parseTransform(value)),
  translate: (value) => fieldsFrom(parseTranslate(value)),
  scale: (value) => fieldsFrom(parseScale(value)),
  transformOrigin: (value) => fieldsFrom(parseTransformOrigin(value)),
};

/** The expansion of a shorthand that sets typed values (paint, ADR 0418 wave 2; transforms, wave 3), or undefined. */
function typedShorthand(property: string): ((value: string) => PaintExpansion) | undefined {
  if (Object.prototype.hasOwnProperty.call(PAINT_SHORTHANDS, property)) return PAINT_SHORTHANDS[property];
  if (Object.prototype.hasOwnProperty.call(TRANSFORM_SHORTHANDS, property)) return TRANSFORM_SHORTHANDS[property];
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

/** Shorthand properties by the field name they're written as (`border-width` → `borderWidth`). */
const SHORTHANDS: ReadonlyMap<string, Shorthand> = new Map([
  ["padding", edgeShorthand("padding", (s) => `padding${s}`)],
  ["margin", edgeShorthand("margin", (s) => `margin${s}`)],
  ["borderWidth", edgeShorthand("borderWidth", (s) => `border${s}Width`)],
  ["border", BORDER],
  ["flex", FLEX],
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
  if (NOT_FIELDS.has(attribute.name) || attribute.name.startsWith(KEY_ATTRIBUTE_PREFIX)) return null;
  const field = propertyField(attribute.name);
  return REFERENCE_FIELDS.has(field) ? null : field;
}

/** The field a key attribute localises (`t:text` → `text`, `t:placeholder` → `placeholder`), or null for other attributes. */
export function keyAttributeField(attribute: MarkupAttribute): string | null {
  if (!attribute.name.startsWith(KEY_ATTRIBUTE_PREFIX)) return null;
  const name = attribute.name.slice(KEY_ATTRIBUTE_PREFIX.length);
  return name === "" ? null : propertyField(name);
}

/** True for a field a key attribute may localise: a plain string (not a length, a choice or an asset). */
export function isTextField(info: FieldInfo): boolean {
  return info.type === String && !LENGTH_FIELDS.has(info.name) && !Array.isArray(info.options?.choices) && !PAINT_VALUES[info.name] && !TRANSFORM_VALUES[info.name];
}

/** The node reference field an attribute names by an element id (`nav-up="play"` → `navUp`, `first-selected` → `firstSelected`), or null. */
export function referenceField(attribute: MarkupAttribute): string | null {
  if (attribute.name.startsWith(KEY_ATTRIBUTE_PREFIX)) return null;
  const field = propertyField(attribute.name);
  return REFERENCE_FIELDS.has(field) ? field : null;
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
    const shorthand = SHORTHANDS.get(field);
    const info = fields.get(field);
    if (!info && !shorthand) return false;
    const substituted = substituteVars(raw, vars);
    if (substituted === undefined) {
      warnOnce(`${where}: "${raw}" uses a variable that isn't defined.`);
      return false;
    }
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
    const substituted = substituteVars(raw, vars);
    if (substituted === undefined) {
      warnOnce(`${where}: "${raw}" uses a variable that isn't defined.`);
      return;
    }
    const expanded = typedShorthand(property)!(substituted);
    if (!expanded.ok) {
      warnOnce(`${where}: "${substituted}" ${expanded.problem}`);
      return;
    }
    for (const [field, value] of expanded.fields) {
      if (fields.has(field) || INHERITED_FIELDS.has(field)) out.set(field, { field, value: cloneValue(value), source });
    }
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
    if (typedShorthand(field)) {
      setShorthand(field, m.declaration.value, source, where);
    } else if (fields.has(field) || shorthandApplies(field, fields)) {
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
