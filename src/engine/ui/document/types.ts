/**
 * The contract between UI documents' parsers and their runtime (ADR 0077). Parsers (`markup.ts`,
 * `stylesheet.ts`) are pure and renderer-neutral; the runtime (`UIDocument.ts`) builds nodes from what
 * they return. Spans let the editor (wave B) patch the source files in place. Nothing here is public
 * API except where `UIDocument.ts` re-exports it.
 */

/** A range in a source file: character offsets, `end` exclusive. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

/** A problem found while parsing: a message with where it is (1-based line and column). */
export interface SourceProblem {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly span: SourceSpan;
}

// --- Markup (`*.ui.xml`) ------------------------------------------------------------------------

/** Element names and the UI components they make (ADR 0069 components). */
/** ADR 0426: `Svg`, `Video` and `Audio` are the HTML `svg`, `video` and `audio` elements (Svelte UI). */
export type UITag = "Canvas" | "Panel" | "Text" | "Image" | "Button" | "InputField" | "Svg" | "Video" | "Audio";

export interface MarkupAttribute {
  /** As written: a field (`fontSize`), `id`, `class`, `translate`, or a key binding `t:<field>` (ADR 0356 §4). */
  readonly name: string;
  /** The raw value, with `{name}` bindings left in. */
  readonly value: string;
  /** The whole `name="value"` text. */
  readonly span: SourceSpan;
  /** Just the value, inside the quotes. */
  readonly valueSpan: SourceSpan;
}

/** A piece of a binding-aware string: literal text, or `{name}`. */
export type BindingPart = { readonly text: string } | { readonly binding: string };

export interface MarkupElement {
  readonly kind: "element";
  readonly tag: UITag;
  /** In source order. `id` and `class` are among them. */
  readonly attributes: readonly MarkupAttribute[];
  /** Child elements, in order. `<Use>` is already expanded (each gets `from` set); `<Style>` and `<Template>` aren't here. */
  readonly children: readonly MarkupElement[];
  /**
   * A `Text`, `Button` label shorthand or `InputField`'s text content, with whitespace collapsed as in
   * HTML (runs of spaces, tabs and line breaks become one space, trimmed; `&#160;` isn't collapsed), or
   * null when none. Bindings left in. A `text="…"` attribute keeps its spacing exactly.
   */
  readonly text: string | null;
  /** The `<Template>` child's single element, for `list()` (null when none). */
  readonly template: MarkupElement | null;
  /** The element's whole source, open tag to close tag. */
  readonly span: SourceSpan;
  /** The open tag only (`<Panel …>`), where the editor inserts attributes. */
  readonly openTagSpan: SourceSpan;
  /** The file it comes from (differs from the document's for elements from a `<Use>`). */
  readonly file: string;
  /** Set on the root element of an expanded `<Use src>`: the used file. */
  readonly from?: string;
}

export interface UIMarkup {
  readonly file: string;
  /** The document's single root element (normally a `Canvas`); null when it has none (a problem says so). */
  readonly root: MarkupElement | null;
  /** Stylesheet paths from `<Style src>`, resolved against the file's folder, in order (used documents' first). */
  readonly styles: readonly string[];
  /** Every file the document depends on (itself, used documents, stylesheets): a change to any rebuilds it. */
  readonly files: readonly string[];
  readonly problems: readonly SourceProblem[];
}

/**
 * Parse a markup document. `read(path)` returns another project file's text (for `<Use src>`), or null
 * when it doesn't exist. Paths are project-relative (`ui/menu.ui.xml`); `src` attributes are relative to
 * the file that has them. Never throws for bad markup: problems are reported and the rest still parses.
 */
export type ParseMarkup = (source: string, file: string, read: (path: string) => string | null) => UIMarkup;

/** Split a string into literal and `{name}` parts (`{{` is a literal brace). */
export type ParseBindings = (value: string) => readonly BindingPart[];

// --- Stylesheets (`*.ui.css`) -------------------------------------------------------------------

/** A simple selector: a tag, an id, classes, pseudo-classes and `:lang()` ranges, all of which must match. */
export interface SimpleSelector {
  /** As written, matched case-insensitively (ADR 0419: `button` is `Button`; Svelte's HTML tags such as `div` match as written). */
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly pseudo: readonly UIPseudo[];
  /** `:lang(de)` (ADR 0356 §4): language ranges the current text language must match by BCP 47 prefix. */
  readonly lang: readonly string[];
  /** `:is()` and `:where()` (ADR 0419): each a selector list, one of which must match the element; `zero` for `:where()`. */
  readonly is?: readonly { readonly selectors: readonly Selector[]; readonly zero: boolean }[];
  // ADR 0418 wave 5. Each is absent when the compound doesn't use it, so rule data stays small.
  /** `:not()`: each a selector list, none of which may match the element. */
  readonly not?: readonly (readonly Selector[])[];
  /** `:first-child`, `:nth-child(an+b [of S])`, `:last-of-type`…: the element's position among its siblings. */
  readonly nth?: readonly UINthSelector[];
  /** `[a]`, `[a=v]`, `[a~=v]`, `[a|=v]`, `[a^=v]`, `[a$=v]`, `[a*=v]` (each with an `i` flag). */
  readonly attributes?: readonly UIAttributeSelector[];
  /** `:empty`: no child elements and no text. */
  readonly empty?: boolean;
  /** `:root`: the tree's root (a hosted tree's canvas, a document's root element). */
  readonly root?: boolean;
}

/**
 * A structural pseudo-class (ADR 0418 wave 5): the element is at a position `a·n + b` (n = 0, 1, 2…; 1-based) among
 * its parent's child elements, counted from the end with `last`, only among elements with its tag with `ofType`, and
 * only among elements matching `of` (`:nth-child(2 of .item)`). `:first-child` is `{ a: 0, b: 1 }`.
 */
export interface UINthSelector {
  readonly a: number;
  readonly b: number;
  readonly last?: boolean;
  readonly ofType?: boolean;
  readonly of?: readonly Selector[];
}

/** An attribute selector (ADR 0418 wave 5): the attribute is present, or its value compares by `op` (`insensitive`: ASCII case-insensitively, the `i` flag). */
export interface UIAttributeSelector {
  /** Matched case-insensitively, as HTML attribute names are. */
  readonly name: string;
  readonly op?: "=" | "~=" | "|=" | "^=" | "$=" | "*=";
  readonly value?: string;
  readonly insensitive?: boolean;
}

export type UIPseudo = "hover" | "pressed" | "focus" | "disabled";

/** How a compound joins the one on its left: descendant, child, next sibling or any later sibling (ADR 0418 wave 5). */
export type Combinator = " " | ">" | "+" | "~";

/** A complex selector: compound parts joined by combinators, rightmost last. */
export interface Selector {
  readonly parts: readonly { readonly selector: SimpleSelector; readonly combinator: Combinator | null }[];
  /** [ids, classes + pseudo-classes + attributes, tags], compared in that order. */
  readonly specificity: readonly [number, number, number];
  /** The selector is `:root` alone, where variables are declared (its compound says `root` too). */
  readonly root: boolean;
}

export interface Declaration {
  /** As written, kebab-case (`background-color`) or a variable (`--accent`). */
  readonly property: string;
  /** The raw value text, `var(--x)` left in. */
  readonly value: string;
  readonly span: SourceSpan;
}

export interface StyleRule {
  readonly selectors: readonly Selector[];
  readonly declarations: readonly Declaration[];
  /** The selector text as written, for showing where a value came from. */
  readonly selectorText: string;
  readonly span: SourceSpan;
  /** Order across all of a document's sheets (later wins ties). */
  readonly order: number;
  /**
   * The `@media` blocks the rule is in (ADR 0418 wave 5), outermost first: each a query list, one of whose queries must
   * match the canvas; every block must. Absent outside `@media`.
   */
  readonly media?: readonly (readonly UIMediaQuery[])[];
}

/** A media query (ADR 0418 wave 5): an optional media type (`not` negates the whole query) and a condition. */
export interface UIMediaQuery {
  readonly not?: boolean;
  /** `all` and `screen` match; any other type never does. Absent: `all`. */
  readonly type?: string;
  readonly condition?: UIMediaCondition;
}

/**
 * A media condition: `and`, `or` or `not` of conditions, or one feature test (`(min-width: 600px)` is width `>=` 600).
 * A feature without `op` is the boolean form (`(orientation)`). Lengths are UI pixels; ratios are numbers.
 */
export type UIMediaCondition =
  | { readonly and: readonly UIMediaCondition[] }
  | { readonly or: readonly UIMediaCondition[] }
  | { readonly not: UIMediaCondition }
  | { readonly feature: string; readonly op?: "=" | "<" | "<=" | ">" | ">="; readonly value?: number | string };

/** What media queries are evaluated against: the canvas, in UI pixels after the canvas scaler. */
export interface UIMediaEnvironment {
  readonly width: number;
  readonly height: number;
}

export interface UIStylesheet {
  readonly file: string;
  readonly rules: readonly StyleRule[];
  readonly problems: readonly SourceProblem[];
  /** `@keyframes` blocks (ADR 0418 wave 4), in source order; absent when the sheet has none. */
  readonly keyframes?: readonly UIKeyframes[];
}

/** One keyframe of a `@keyframes` block: its offsets (`from` 0, `to` 1, `50%` 0.5) and declarations. */
export interface UIKeyframe {
  readonly offsets: readonly number[];
  readonly declarations: readonly Declaration[];
  readonly span: SourceSpan;
}

/** A `@keyframes` block (ADR 0418 wave 4): the last one with a name, across a document's sheets, is the one used. */
export interface UIKeyframes {
  readonly name: string;
  readonly frames: readonly UIKeyframe[];
  readonly span: SourceSpan;
}

/** Parse a stylesheet. Never throws: problems are reported. `firstOrder` numbers its rules after earlier sheets'. */
export type ParseStylesheet = (source: string, file: string, firstOrder?: number) => UIStylesheet;

/** What a selector is matched against: an element in the built tree. */
export interface StyleTarget {
  /** A UI document's tag (`Button`), or the HTML tag a Svelte component wrote (`button`, `div`; ADR 0419). */
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly state: Readonly<Record<UIPseudo, boolean>>;
  readonly parent: StyleTarget | null;
  /** The current text language (ADR 0356 §4), for `:lang()`; absent: no `:lang()` rule matches. */
  readonly lang?: string;
  // ADR 0418 wave 5. Absent: the structural, attribute and `@media` tests that need them don't match.
  /** The attributes as written (markup attributes; a Svelte element's renderer attributes), for attribute selectors. */
  readonly attributes?: ReadonlyMap<string, string>;
  /** Its child elements in order (text isn't an element), for structural selectors and sibling combinators. */
  readonly children?: readonly StyleTarget[];
  /** It has text (a text element's, or text beside its child elements), so it isn't `:empty`. */
  readonly content?: boolean;
  /** On the root target: the canvas `@media` rules are matched against; null before its size is known. */
  readonly media?: UIMediaEnvironment | null;
}

/** Where an element's field value comes from (the Inspector shows this in wave B). */
export type ValueSource =
  | { readonly kind: "attribute"; readonly attribute: MarkupAttribute; readonly file: string }
  | { readonly kind: "rule"; readonly rule: StyleRule; readonly declaration: Declaration; readonly file: string }
  | { readonly kind: "inherited"; readonly from: StyleTarget; readonly source: ValueSource }
  | { readonly kind: "default" };

/** One field's resolved value: already converted to the field's type (number, string, Color, Vector2, boolean…). */
export interface ResolvedValue {
  readonly field: string;
  readonly value: unknown;
  readonly source: ValueSource;
}

/**
 * The cascade for one element: its attributes beat matching rules (by specificity, then order), text
 * properties (`color`, `font-size`, `font-weight`, `text-align`) inherit from the parent, variables
 * resolve. Returns only fields that something sets (attribute, rule or inheritance), keyed by field
 * name (camelCase: `background-color` → `backgroundColor`). Values that can't convert to the field's
 * type are left out and reported once through `warn`.
 */
export type ResolveStyle = (
  target: StyleTarget,
  element: MarkupElement,
  component: abstract new (...args: never[]) => object,
  sheets: readonly UIStylesheet[],
  parent: ReadonlyMap<string, ResolvedValue> | null,
  warn: (message: string) => void,
) => Map<string, ResolvedValue>;
