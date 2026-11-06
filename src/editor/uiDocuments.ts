// UI documents in the editor (ADR 0077 §4, wave B part 1): the model between the editor's selection,
// the live `UIDocumentElement`s a `UIDocument` builds in the Editor World, and their markup (file,
// element and attribute spans), with where each field's value comes from. Read-only for now; part 2
// (editing, Move to class, handles) writes back to the files through the spans this module gives.
//
// Elements aren't document nodes: they belong to the markup file, aren't in the scene file and are
// rebuilt when it changes. So they're addressed by a ref, not a node path: the host node's path key,
// which UIDocument on it (by index), and the element's static path in the built tree
// (`UIDocumentElement._path`: "" for the root, then `/#id` or `/Tag[n]` per level, `/label` for a
// button's text content). Refs survive rebuilds (hot reload) as long as the structure is the same.
import { batch, signal } from "@preact/signals";
import { Color, UIDocument, Vector2, type GameObject, type UIDocumentElement } from "../engine";
import { getFields, type FieldInfo } from "../engine/core/registry";
import { Assets } from "../engine/scene/Assets";
import type { UIComponentType } from "../engine/ui/components";
import type { MarkupAttribute, MarkupElement, ResolvedValue, SourceSpan, StyleTarget, ValueSource } from "../engine/ui/document/types";
import { pathKey, type NodePath } from "./document";
import { selectedAssets } from "./assetSelection";
import { select, selectedUIElement } from "./state";

// --- Refs and keys ------------------------------------------------------------------------------

/** Where an element is: its UIDocument's node (path key), which UIDocument on it, and its static path in the tree. */
export interface UIElementRef {
  readonly host: string;
  readonly index: number;
  readonly path: string;
}

/** What a WorldSync gives this module (the open scene's, or a test's). */
export interface NodeLookup {
  nodeFor(path: NodePath | string): GameObject | null;
  pathOf(node: GameObject | number): NodePath | null;
}

const SEP = "|";

/** A ref as one string, for the selection signal, hierarchy rows and collapsed state. */
export const uiRefKey = (ref: UIElementRef): string => `ui:${ref.host}${SEP}${ref.index}${SEP}${ref.path}`;

/** The ref a key names, or null if it isn't one. */
export function parseUIRefKey(key: string): UIElementRef | null {
  if (!key.startsWith("ui:")) return null;
  const rest = key.slice(3);
  const a = rest.indexOf(SEP), b = a < 0 ? -1 : rest.indexOf(SEP, a + 1);
  if (a < 0 || b < 0) return null;
  const index = Number(rest.slice(a + 1, b));
  if (!Number.isInteger(index) || index < 0) return null;
  return { host: rest.slice(0, a), index, path: rest.slice(b + 1) };
}

/** The UIDocuments on a node, in component order. */
export function documentsOn(node: GameObject): UIDocument[] {
  return node.isValid ? node.getComponents(UIDocument) : [];
}

/** The live element a ref names, or null (the node or document is gone, or the file changed shape). */
export function resolveUIElement(lookup: NodeLookup, ref: UIElementRef): UIDocumentElement | null {
  const node = lookup.nodeFor(ref.host);
  const doc = node ? documentsOn(node)[ref.index] : undefined;
  return doc?._elementAt(ref.path) ?? null;
}

/** The ref of a live element in the scene being edited, or null (a list row, or a document outside the scene). */
export function refOfElement(lookup: NodeLookup, el: UIDocumentElement): UIElementRef | null {
  if (el._path === null || !el.isValid) return null;
  const doc = el.document;
  const hostPath = lookup.pathOf(doc.node);
  if (!hostPath) return null;
  const index = documentsOn(doc.node).indexOf(doc);
  return index < 0 ? null : { host: pathKey(hostPath), index, path: el._path };
}

/** The document element a UI component (from picking) belongs to, or null for hand-built UI. */
export function elementOfComponent(c: UIComponentType): UIDocumentElement | null {
  return UIDocument._elementOf(c);
}

// --- Selection ----------------------------------------------------------------------------------

/** Select a UI element (null clears it). Node and asset selections are cleared: one thing shows in the Inspector. */
export function selectUIElement(ref: UIElementRef | null): void {
  batch(() => {
    select([]);
    if (selectedAssets.peek().length > 0) selectedAssets.value = [];
    selectedUIElement.value = ref ? uiRefKey(ref) : null;
  });
}

/** The selected UI element's ref, or null. Tracks the selection like a signal. */
export function selectedUIRef(): UIElementRef | null {
  const key = selectedUIElement.value;
  return key ? parseUIRefKey(key) : null;
}

/**
 * Bumped whenever a UIDocument builds, rebuilds (hot reload) or loses its tree, so the hierarchy,
 * Inspector and outline follow. Installed once, on first use.
 */
export const uiBuildVersion = signal(0);
let watching = false;
/** Start following document builds (idempotent). Returns nothing: it stays for the editor's lifetime. */
export function watchUIDocumentBuilds(): void {
  if (watching) return;
  watching = true;
  UIDocument._onBuilt(() => queueMicrotask(() => uiBuildVersion.value++));
}

// --- The tree, for the hierarchy ----------------------------------------------------------------

/** One element as a hierarchy row. */
export interface UIElementRow {
  readonly ref: UIElementRef;
  readonly key: string;
  readonly tag: string;
  /** `Button#play.primary`, or `Text "Score: {score}"` for unnamed text. */
  readonly label: string;
  /** The file the element is written in (a used document's for elements from a `<Use>`). */
  readonly file: string;
  /** A button's label made from its text content (it has no tag of its own in the file). */
  readonly synthetic: boolean;
  readonly children: readonly UIElementRow[];
}

/** A UIDocument on a node, as the hierarchy shows it. */
export interface UIDocumentRows {
  readonly document: UIDocument;
  readonly index: number;
  /** The markup file, or null before it's built. */
  readonly file: string | null;
  readonly root: UIElementRow | null;
}

const short = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A row's label: tag, `#id` and `.classes`, or the text for unnamed text elements. */
export function elementLabel(el: UIDocumentElement): string {
  if (el._synthetic) return `Label "${short(el._markup.text ?? "")}"`;
  const classes = el.classList.values();
  const named = `${el.tag}${el.id ? `#${el.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
  if (!el.id && classes.length === 0 && el._markup.text) return `${el.tag} "${short(el._markup.text)}"`;
  return named;
}

function rowOf(el: UIDocumentElement, host: string, index: number): UIElementRow | null {
  if (!el.isValid || el._path === null) return null; // list rows aren't the file's (none in the editor anyway)
  const ref = { host, index, path: el._path };
  const children: UIElementRow[] = [];
  for (const c of el.children) {
    const row = rowOf(c, host, index);
    if (row) children.push(row);
  }
  return { ref, key: uiRefKey(ref), tag: el.tag, label: elementLabel(el), file: el._markup.file, synthetic: el._synthetic, children };
}

/** The documents on the node at `host` (a path key) with their element trees. Empty when it has none. */
export function documentRows(lookup: NodeLookup, host: string): UIDocumentRows[] {
  const node = lookup.nodeFor(host);
  if (!node) return [];
  return documentsOn(node).map((document, index) => ({
    document,
    index,
    file: document._markupPath,
    root: document.root ? rowOf(document.root, host, index) : null,
  }));
}

/** Keys of a row and every row above it in its tree up to (not including) the host node, for opening the hierarchy to a selection. */
export function rowAncestry(rows: readonly UIDocumentRows[], key: string): string[] | null {
  const find = (row: UIElementRow, trail: string[]): string[] | null => {
    if (row.key === key) return trail;
    for (const c of row.children) {
      const found = find(c, [...trail, row.key]);
      if (found) return found;
    }
    return null;
  };
  for (const d of rows) {
    const found = d.root ? find(d.root, []) : null;
    if (found) return found;
  }
  return null;
}

// --- Markup locations ---------------------------------------------------------------------------

/** 1-based line and column of an offset in a file's current text (1:1 when it can't be read). */
export function lineColumnOf(file: string, offset: number): { line: number; column: number } {
  const text = Assets.has(file) ? Assets.get(file) : null;
  if (typeof text !== "string") return { line: 1, column: 1 };
  let line = 1, start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start + 1 };
}

/**
 * The span of an element's text content (between its open and close tags), or null when it has
 * none or is self-closing. `source` is the text of `element.file`.
 */
export function contentSpan(element: MarkupElement, source: string): SourceSpan | null {
  const { openTagSpan, span } = element;
  if (openTagSpan.end >= span.end) return null; // self-closing
  const close = source.lastIndexOf("</", span.end);
  if (close < openTagSpan.end) return null;
  return { start: openTagSpan.end, end: close };
}

/** Where an element is written: its file, whole span and open tag, and (for part 2's edits) its attributes. */
export interface MarkupLocation {
  readonly file: string;
  /** The used file, when the element is the root of a `<Use>`. */
  readonly from: string | null;
  readonly span: SourceSpan;
  readonly openTagSpan: SourceSpan;
  readonly line: number;
  readonly attributes: readonly MarkupAttribute[];
  /** A button label made from the button's text content: its spans are the button's. */
  readonly synthetic: boolean;
}

export function markupLocation(el: UIDocumentElement): MarkupLocation {
  const m = el._markup;
  return {
    file: m.file,
    from: m.from ?? null,
    span: m.span,
    openTagSpan: m.openTagSpan,
    line: lineColumnOf(m.file, m.span.start).line,
    attributes: m.attributes,
    synthetic: el._synthetic,
  };
}

// --- Value sources, for the Inspector -----------------------------------------------------------

/** Where a field's value comes from, as the Inspector shows it. */
export type FieldOrigin =
  /** An attribute on the element, in its file. */
  | { readonly kind: "attribute"; readonly file: string; readonly attribute: MarkupAttribute; readonly line: number }
  /** A stylesheet rule: its selector and the declaration. `state` for a button's `:hover` / `:pressed` colours. */
  | { readonly kind: "rule"; readonly file: string; readonly selector: string; readonly property: string; readonly value: string; readonly span: SourceSpan; readonly line: number; readonly state?: "hover" | "pressed" }
  /** Inherited (text properties) from an ancestor element, where `origin` sets it. */
  | { readonly kind: "inherited"; readonly from: UIDocumentElement | null; readonly fromLabel: string; readonly origin: FieldOrigin }
  /** The element's text content (a Text's text, an InputField's value, a button label's text). */
  | { readonly kind: "content"; readonly file: string; readonly line: number; readonly bound: boolean }
  /** An attribute with a `{name}` binding: the document's `data` (or a list item) sets it. */
  | { readonly kind: "binding"; readonly file: string; readonly attribute: MarkupAttribute; readonly line: number }
  /** Nothing sets it: the component's default. */
  | { readonly kind: "default" };

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

/** The element whose style target is `target`, among `el` and its ancestors. */
function elementWithTarget(el: UIDocumentElement, target: StyleTarget): UIDocumentElement | null {
  for (let e: UIDocumentElement | null = el; e; e = e.parent) if (e._target === target) return e;
  return null;
}

function originOf(el: UIDocumentElement, source: ValueSource): FieldOrigin {
  switch (source.kind) {
    case "attribute":
      return { kind: "attribute", file: source.file, attribute: source.attribute, line: lineColumnOf(source.file, source.attribute.span.start).line };
    case "rule":
      return {
        kind: "rule",
        file: source.file,
        selector: source.rule.selectorText,
        property: source.declaration.property,
        value: source.declaration.value,
        span: source.declaration.span,
        line: lineColumnOf(source.file, source.declaration.span.start).line,
      };
    case "inherited": {
      // Follow the chain to the element that sets it (each step names the parent it came through).
      let from = elementWithTarget(el, source.from);
      let inner: ValueSource = source.source;
      while (inner.kind === "inherited") {
        from = (from && elementWithTarget(from, inner.from)) ?? from;
        inner = inner.source;
      }
      return { kind: "inherited", from, fromLabel: from ? elementLabel(from) : "a parent element", origin: originOf(from ?? el, inner) };
    }
    case "default":
      return { kind: "default" };
  }
}

/** Fields whose value is the element's text content. */
const CONTENT_FIELD: Readonly<Record<string, string>> = { Text: "text", InputField: "value" };

/**
 * Every field of the element's component with its current value and where it comes from: its own
 * attribute, a stylesheet rule (selector and file), inherited from an ancestor, the text content,
 * a `{binding}`, or the default. In the component's field order.
 */
export function fieldSources(el: UIDocumentElement): FieldSourceRow[] {
  const comp = el.component as unknown as Record<string, unknown>;
  const fields = getFields(el.component.constructor as never);
  const resolved: ReadonlyMap<string, ResolvedValue> = el._resolved;
  const bound = new Set(el._boundFields());
  const markup = el._markup;
  const line = (offset: number) => lineColumnOf(markup.file, offset).line;
  const contentField = el._synthetic ? "text" : CONTENT_FIELD[el.tag];
  const rows: FieldSourceRow[] = [];
  for (const info of fields) {
    const field = info.name;
    let origin: FieldOrigin = { kind: "default" };
    if (bound.has(field)) {
      const attribute = markup.attributes.find((a) => a.name === field || a.name === kebab(field));
      if (attribute) origin = { kind: "binding", file: markup.file, attribute, line: line(attribute.span.start) };
      else if (field === contentField) origin = { kind: "content", file: markup.file, line: line(markup.openTagSpan.end), bound: /\{[A-Za-z_$]/.test(markup.text ?? "") };
    } else {
      const rv = resolved.get(field);
      if (rv) origin = originOf(el, rv.source);
      else if ((field === "hoverColor" || field === "pressedColor") && el.tag === "Button") origin = stateColorOrigin(el, field === "hoverColor" ? "hover" : "pressed") ?? origin;
    }
    const value = comp[field];
    rows.push({ field, property: kebab(field), info, value, display: formatValue(value), origin });
  }
  return rows;
}

/** A button's `:hover` / `:pressed` colour from its stylesheet's background for that state, when it differs from the plain one. */
function stateColorOrigin(el: UIDocumentElement, state: "hover" | "pressed"): FieldOrigin | null {
  const at = el.document._resolveAt(el, state === "hover" ? { hover: true } : { hover: true, pressed: true }).get("backgroundColor");
  const base = el._resolved.get("backgroundColor");
  if (!at || at.source === base?.source || at.source.kind !== "rule") return null;
  const o = originOf(el, at.source);
  return o.kind === "rule" ? { ...o, state } : null;
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
      return `Text content${origin.bound ? " with {bindings}" : ""} · ${origin.file}:${origin.line}`;
    case "binding":
      return `Bound: ${origin.attribute.name}="${origin.attribute.value}" (set from the document's data at runtime) · ${origin.file}:${origin.line}`;
    case "default":
      return "Default";
  }
}

/** A short badge for an origin: Attribute, Rule, Inherited, Content, Bound or Default. */
export function originBadge(origin: FieldOrigin): string {
  return { attribute: "Attribute", rule: "Rule", inherited: "Inherited", content: "Content", binding: "Bound", default: "Default" }[origin.kind];
}
