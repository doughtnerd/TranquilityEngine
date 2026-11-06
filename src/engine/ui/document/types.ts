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
export type UITag = "Canvas" | "Panel" | "Text" | "Image" | "Button" | "InputField";

export interface MarkupAttribute {
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

/** A simple selector: a tag, an id, classes, and pseudo-classes, all of which must match. */
export interface SimpleSelector {
  readonly tag: UITag | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly pseudo: readonly UIPseudo[];
}

export type UIPseudo = "hover" | "pressed" | "focus" | "disabled";

/** A complex selector: compound parts joined by descendant (" ") or child (">") combinators, rightmost last. */
export interface Selector {
  readonly parts: readonly { readonly selector: SimpleSelector; readonly combinator: " " | ">" | null }[];
  /** [ids, classes + pseudo-classes, tags], compared in that order. */
  readonly specificity: readonly [number, number, number];
  /** `:root`: only declares variables. */
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
}

export interface UIStylesheet {
  readonly file: string;
  readonly rules: readonly StyleRule[];
  readonly problems: readonly SourceProblem[];
}

/** Parse a stylesheet. Never throws: problems are reported. `firstOrder` numbers its rules after earlier sheets'. */
export type ParseStylesheet = (source: string, file: string, firstOrder?: number) => UIStylesheet;

/** What a selector is matched against: an element in the built tree. */
export interface StyleTarget {
  readonly tag: UITag;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly state: Readonly<Record<UIPseudo, boolean>>;
  readonly parent: StyleTarget | null;
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
