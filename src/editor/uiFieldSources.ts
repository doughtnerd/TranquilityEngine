// Where a selected UI element's field values come from, as the Inspector shows them (ADR 0077 §4, ADR 0423 wave C):
// the origins (a literal attribute, a rule, inheritance, the text, a Svelte expression, the default, a transition or
// animation), their one-line descriptions and badges, and the value text helpers the Svelte UI edits share
// (`uiViews.ts` reads the origins, `uiViewEdits.ts` writes values).
import { Color, Vector2, type GameObject } from "../engine";
import { AssetRef, type FieldInfo } from "../engine/core/registry";
import { parseColor } from "../engine/ui/document/stylesheet";
import type { MarkupAttribute, SourceSpan } from "../engine/ui/document/types";
import type { NodePath } from "./document";
import { withoutAssetScheme } from "../engine/scene/assetPath";

/** What a WorldSync gives the UI models (the open scene's, or a test's). */
export interface NodeLookup {
  nodeFor(path: NodePath | string): GameObject | null;
  pathOf(node: GameObject | number): NodePath | null;
}

/** Where a field's value comes from, as the Inspector shows it. */
export type FieldOrigin =
  /** An attribute on the element, in its file. */
  | { readonly kind: "attribute"; readonly file: string; readonly attribute: MarkupAttribute; readonly line: number }
  /** A stylesheet rule: its selector and the declaration. `state` for a button's `:hover` / `:pressed` colours. */
  | { readonly kind: "rule"; readonly file: string; readonly selector: string; readonly property: string; readonly value: string; readonly span: SourceSpan; readonly line: number; readonly state?: "hover" | "pressed" }
  /** Inherited (text properties) from an ancestor element, where `origin` sets it. */
  | { readonly kind: "inherited"; readonly fromLabel: string; readonly origin: FieldOrigin }
  /** The element's text content (a Text's text, a button label's text). */
  | { readonly kind: "content"; readonly file: string; readonly line: number }
  /** ADR 0423 wave C: a Svelte expression sets it (`width={w}`, `style:color={c}`, text with `{…}`): view-only, shown as written. */
  | { readonly kind: "expression"; readonly file: string; readonly line: number; readonly name: string; readonly source: string }
  /** Nothing sets it: the component's default. */
  | { readonly kind: "default" }
  /**
   * A stylesheet transition (named by its property) or keyframe animation (by its name) is animating it right now
   * (ADR 0422 wave 4); `origin` is where the value it animates to, or falls back to when it stops, comes from.
   */
  | { readonly kind: "animated"; readonly via: "transition" | "animation"; readonly name: string; readonly origin: FieldOrigin };

/** One field of a selected element: its current value, shown as text, and where it comes from. */
export interface FieldSourceRow {
  readonly field: string;
  /** The stylesheet/attribute name: `background-color`. */
  readonly property: string;
  readonly info: FieldInfo;
  readonly value: unknown;
  readonly display: string;
  readonly origin: FieldOrigin;
}

/** `backgroundColor` → `background-color`. */
export const kebab = (field: string) => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0");

/** A field value as the Inspector shows it read-only. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (value instanceof Color) return `#${hex2(value.r)}${hex2(value.g)}${hex2(value.b)}${value.a < 1 ? hex2(value.a) : ""}`;
  if (value instanceof Vector2) return `${value.x} ${value.y}`;
  if (typeof value === "string") return value === "" ? '""' : value;
  return String(value);
}

/** A field value as an attribute writes it. */
export function attributeText(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return formatValue(value);
}

/** Number fields that are lengths, written with `px` in stylesheets. */
const PX_FIELDS: ReadonlySet<string> = new Set([
  "gap", "padding", "margin", "borderRadius", "borderWidth", "fontSize",
  // ADR 0422 wave 1
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
]);
/** String fields that hold a length (`auto`, `50%`, or pixels). */
const LENGTH_FIELDS: ReadonlySet<string> = new Set(["width", "height", "top", "right", "bottom", "left", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis"]);

const pixels = (n: number) => (n === 0 ? "0" : `${n}px`);

/** An attribute's value as a stylesheet declaration writes it: colours as hex, lengths with `px`, assets as `url()` (Move to class). */
export function cssValue(info: FieldInfo | null, raw: string): string {
  const v = raw.trim();
  if (!info || v.includes("var(")) return v;
  const number = /^-?(\d+\.?\d*|\.\d+)(px)?$/.test(v) ? parseFloat(v) : null;
  if (info.type === Color) {
    const c = parseColor(v);
    return c === null ? "none" : c ? formatValue(c) : v;
  }
  if (info.type === Number) return PX_FIELDS.has(info.name) && number !== null ? pixels(number) : v;
  if (info.type === AssetRef) return v === "" ? '""' : `url("${withoutAssetScheme(v)}")`;
  if (info.type === String) {
    if (LENGTH_FIELDS.has(info.name)) return number !== null ? pixels(number) : v;
    if (Array.isArray(info.options?.choices) || /^[\w-]+$/.test(v)) return v;
    return v.includes('"') ? `'${v}'` : `"${v}"`;
  }
  return v;
}

/** One line describing an origin, for the Inspector and tooltips. */
export function describeOrigin(origin: FieldOrigin): string {
  switch (origin.kind) {
    case "attribute":
      return `Attribute ${origin.attribute.name}="${origin.attribute.value}" · ${origin.file}:${origin.line}`;
    case "rule":
      return `${origin.selector} { ${origin.property}: ${origin.value} }${origin.state ? ` (as :${origin.state} background)` : ""} · ${origin.file}:${origin.line}`;
    case "inherited":
      return `Inherited from ${origin.fromLabel} · ${describeOrigin(origin.origin)}`;
    case "content":
      return `Text content · ${origin.file}:${origin.line}`;
    case "expression":
      return `Expression: ${origin.name}${origin.source.startsWith("{") || origin.name === "text" ? " " : "="}${origin.source} (view-only: edit it in the Code panel) · ${origin.file}:${origin.line}`;
    case "default":
      return "Default";
    case "animated":
      return `${origin.via === "transition" ? `Transition of ${origin.name}` : `Animation "${origin.name}" (@keyframes)`}, over ${describeOrigin(origin.origin)}`;
  }
}

/** A short badge for an origin: Attribute, Rule, Inherited, Content, Expression or Default. */
export function originBadge(origin: FieldOrigin): string {
  if (origin.kind === "animated") return origin.via === "transition" ? "Transition" : "Animation";
  return { attribute: "Attribute", rule: "Rule", inherited: "Inherited", content: "Content", expression: "Expression", default: "Default" }[origin.kind];
}
