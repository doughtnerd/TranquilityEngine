// Svelte UI in the editor (ADR 0419 wave C): the model between the editor's selection, the elements a `UIView`
// renders in the Editor World (`UIHostElement`s, through the UI core's tree host) and the `.svelte` source they're
// written in, with where each field's value comes from. It's `uiDocuments.ts`'s counterpart for views; editing is
// `uiViewEdits.ts`.
//
// A rendered element is addressed by its template location, not by a path in the tree: the view's node (path key),
// which UIView on it (by index), the file and the line and column its tag starts at (Svelte's dev-mode location),
// and which of the elements rendered from that place it is (`nth`: an `{#each}` renders one place many times).
// So a selection survives re-renders and hot reload while the source keeps the element where it was, and an edit
// that moves it says where it went.
//
// What's editable follows owner decision 1 of ADR 0419: static parts of the view's own component are; expressions,
// `{#each}` rows, snippets and child components' insides (written in another file) are view-only, with the reason.
import { signal } from "@preact/signals";
import type { GameObject } from "../engine";
import { getFields } from "../engine/core/registry";
import type { UIComponentType } from "../engine/ui/components";
import type { MarkupAttribute, ResolvedValue, ValueSource } from "../engine/ui/document/types";
import { uiAnimatedField } from "../engine/ui/animation/UIAnimator";
import { onUIHostChanged, uiHostElementOf, type UIHostElement } from "../engine/ui/host/UIHost";
import { normalizeAssetPath } from "../engine/scene/Assets";
import { UIView } from "../plugins/ui/runtime/UIView";
import { pathKey } from "./document";
import { selectedUIElement } from "./state";
import { editorTextFiles } from "./textFiles";
import { elementAtLocation, lineColumnAt, loadSvelteParser, normalizeSelector, parseSvelte, styleDeclarations, svelteParserLoaded, SvelteEditError, type SvelteElement, type SvelteSource } from "./uiEdit/svelteText";
import { formatValue, kebab, resolveUIElement, selectedUIRef, type FieldOrigin, type FieldSourceRow, type NodeLookup } from "./uiDocuments";

// --- Refs and keys ------------------------------------------------------------------------------

/** Where a rendered element is: its UIView's node (path key), which UIView on it, and its template location. */
export interface UIViewRef {
  readonly host: string;
  readonly index: number;
  readonly file: string;
  /** 1-based line and 0-based column of its `<` (Svelte's template location). */
  readonly line: number;
  readonly column: number;
  /** Which of the elements rendered from that place (0 unless an `{#each}` or a snippet renders it again). */
  readonly nth: number;
}

const SEP = "|";

/** A view ref as one string, for the selection signal and hierarchy rows (`uiv:` beside documents' `ui:`). */
export const uiViewRefKey = (r: UIViewRef): string => `uiv:${r.host}${SEP}${r.index}${SEP}${r.file}${SEP}${r.line}:${r.column}${SEP}${r.nth}`;

/** The view ref a key names, or null if it isn't one. */
export function parseUIViewRefKey(key: string): UIViewRef | null {
  if (!key.startsWith("uiv:")) return null;
  const parts = key.slice(4).split(SEP);
  if (parts.length < 5) return null;
  const nth = Number(parts.pop()), loc = parts.pop()!, index = Number(parts[1]);
  const [line, column] = loc.split(":").map(Number);
  const file = parts.slice(2).join(SEP);
  if (![nth, index, line, column].every((n) => Number.isInteger(n) && n >= 0) || !file) return null;
  return { host: parts[0], index, file, line, column, nth };
}

/** True for a ref of a view's element (not a document's). */
export const isUIViewKey = (key: string | null): boolean => !!key && key.startsWith("uiv:");

/** The UIViews on a node, in component order. */
export function viewsOn(node: GameObject): UIView[] {
  return node.isValid ? node.getComponents(UIView) : [];
}

/** The view a ref's host and index name, or null. */
export function viewOf(lookup: NodeLookup, at: { readonly host: string; readonly index: number }): UIView | null {
  const node = lookup.nodeFor(at.host);
  return (node && viewsOn(node)[at.index]) ?? null;
}

/** The view's component file (`ui/Hud.svelte`), or "" without one. */
export const viewFile = (view: UIView): string => normalizeAssetPath(view.component);

function walk(el: UIHostElement, fn: (el: UIHostElement) => void): void {
  fn(el);
  for (const c of el.children) walk(c, fn);
}

const sameLocation = (el: UIHostElement, r: { file: string; line: number; column: number }) => !!el.source && el.source.file === r.file && el.source.line === r.line && el.source.column === r.column;

/** The live element a ref names, or null (the view, its tree or that place is gone). */
export function resolveUIViewElement(lookup: NodeLookup, ref: UIViewRef): UIHostElement | null {
  const root = viewOf(lookup, ref)?.root;
  if (!root) return null;
  let n = 0;
  let found: UIHostElement | null = null;
  walk(root, (el) => {
    if (found || el.synthetic || !el.isValid || !sameLocation(el, ref)) return;
    if (n++ === ref.nth) found = el;
  });
  return found;
}

/** The element a picked UI component belongs to (a button's label from its text picks the button), or null. */
export function viewElementOfComponent(c: UIComponentType): UIHostElement | null {
  let el = uiHostElementOf(c);
  while (el?.synthetic) el = el.parent;
  return el && el.source ? el : null;
}

/** The ref of a rendered element in the scene being edited, or null (no location, or a view outside the scene). */
export function refOfViewElement(lookup: NodeLookup, el: UIHostElement): UIViewRef | null {
  if (!el.source || el.synthetic) return null;
  const node = el.tree.root.node.parent;
  if (!node) return null;
  const hostPath = lookup.pathOf(node);
  if (!hostPath) return null;
  const index = viewsOn(node).findIndex((v) => v.root === el.tree.root);
  if (index < 0) return null;
  let n = 0, nth = -1;
  walk(el.tree.root, (e) => {
    if (nth >= 0 || e.synthetic || !e.isValid || !sameLocation(e, el.source!)) return;
    if (e === el) nth = n;
    n++;
  });
  return nth < 0 ? null : { host: pathKey(hostPath), index, file: el.source.file, line: el.source.line, column: el.source.column, nth };
}

/** How many live elements were rendered from the place `ref` names (more than one: an `{#each}` or a snippet). */
function renderedFrom(lookup: NodeLookup, ref: UIViewRef): number {
  const root = viewOf(lookup, ref)?.root;
  let n = 0;
  if (root) walk(root, (el) => void (!el.synthetic && el.isValid && sameLocation(el, ref) && n++));
  return n;
}

// --- Selection and changes ------------------------------------------------------------------------

/** The selected view element's ref, or null. Tracks the selection like a signal. */
export function selectedUIViewRef(): UIViewRef | null {
  const key = selectedUIElement.value;
  return key ? parseUIViewRefKey(key) : null;
}

/** Bumped when a view's tree is made, changes shape or goes, and when Svelte's parser has loaded, so panels follow. */
export const uiViewVersion = signal(0);
let watching = false;
/** Start following views' trees (idempotent; stays for the editor's lifetime), loading Svelte's parser with the first. */
export function watchUIViews(): void {
  if (watching) return;
  watching = true;
  let queued = false;
  const bump = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      uiViewVersion.value++;
    });
  };
  onUIHostChanged(() => {
    bump();
    if (!svelteParserLoaded()) void loadSvelteParser().then(bump, () => {});
  });
}

/** The selected UI element of either kind (a document's, or one a view rendered) as the scene view draws it, or null. */
export function selectedUIComponent(lookup: NodeLookup): { readonly component: UIComponentType; readonly node: GameObject } | null {
  const doc = selectedUIRef();
  if (doc) return resolveUIElement(lookup, doc);
  const view = selectedUIViewRef();
  return view ? resolveUIViewElement(lookup, view) : null;
}

// --- The source ------------------------------------------------------------------------------------

/** A file's current text as edits read it (writes not on disk yet included), or null. */
export const sourceText = (file: string): string | null => editorTextFiles.read(file);

const parsed = new Map<string, { text: string; source: SvelteSource | null }>();

/** A component file's parsed source (cached per text), or null when it can't be read or parsed (or the parser isn't loaded). */
export function sourceOfFile(file: string): SvelteSource | null {
  const text = sourceText(file);
  if (text === null || !svelteParserLoaded()) return null;
  const hit = parsed.get(file);
  if (hit && hit.text === text) return hit.source;
  let source: SvelteSource | null = null;
  try {
    source = parseSvelte(text);
  } catch (err) {
    if (!(err instanceof SvelteEditError)) throw err;
  }
  parsed.set(file, { text, source });
  return source;
}

/** Where a rendered element is written: its file, location, the view's own file, and (when the source parses) the element there. */
export interface ViewElementSource {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The view's component file: elements written elsewhere are a child component's. */
  readonly viewFile: string;
  readonly source: SvelteSource | null;
  readonly element: SvelteElement | null;
}

/** Where `el` (of the view `ref` names) is written, or null for one without a template location. */
export function viewElementSource(lookup: NodeLookup, ref: UIViewRef): ViewElementSource | null {
  const view = viewOf(lookup, ref);
  if (!view) return null;
  const source = sourceOfFile(ref.file);
  return { file: ref.file, line: ref.line, column: ref.column, viewFile: viewFile(view), source, element: source ? elementAtLocation(source, ref.line, ref.column) : null };
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Why the element `ref` names is view-only (owner decision 1 of ADR 0419), or null when its static parts can be
 * edited: it's written in a child component's file, renders more than once, or its file changed shape.
 */
export function whyViewOnly(lookup: NodeLookup, ref: UIViewRef): string | null {
  const where = viewElementSource(lookup, ref);
  if (!where) return "it's gone (its view changed)";
  if (where.file !== where.viewFile) return `it's inside a child component (${fileName(where.file)}): edit that component's own view`;
  if (!svelteParserLoaded()) return "Svelte's parser is still loading";
  if (!where.source) return `${fileName(where.file)} doesn't parse`;
  if (!where.element) return `${fileName(where.file)} changed since it compiled; wait for it to reload`;
  if (where.element.repeated) return where.element.repeated;
  if (renderedFrom(lookup, ref) > 1) return "it's rendered more than once from one place in the file";
  return null;
}

// --- Rows, for the hierarchy -----------------------------------------------------------------------

/** One rendered element as a hierarchy row. */
export interface UIViewRow {
  readonly ref: UIViewRef;
  readonly key: string;
  readonly tag: string;
  readonly label: string;
  readonly file: string;
  readonly children: readonly UIViewRow[];
}

/** A UIView on a node, as the hierarchy shows it: its file and its rendered elements (the canvas's children). */
export interface UIViewRows {
  readonly view: UIView;
  readonly index: number;
  readonly file: string;
  readonly rows: readonly UIViewRow[];
}

const short = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** An element's classes as written (Svelte's scoping hash classes left out). */
export const writtenClasses = (el: UIHostElement): string[] => el.classes.filter((c) => !/^svelte-[a-z0-9]+$/.test(c));

/** A row's label: tag, `#id` and `.classes`, or the text for an unnamed element with text. */
export function viewElementLabel(el: UIHostElement): string {
  const classes = writtenClasses(el);
  const named = `${el.tag}${el.id ? `#${el.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
  if (el.id || classes.length > 0) return named;
  const text = (el.component as { text?: unknown }).text;
  const label = typeof text === "string" && text ? text : el.children.find((c) => c.synthetic && c.isValid)?.component;
  const shown = typeof label === "string" ? label : (label as { text?: unknown } | undefined)?.text;
  return typeof shown === "string" && shown ? `${el.tag} "${short(shown)}"` : named;
}

/** The rows of a view's elements under `parent` (counting each place's renders as it goes). */
function rowsUnder(parent: UIHostElement, at: { host: string; index: number }, seen: Map<string, number>): UIViewRow[] {
  const out: UIViewRow[] = [];
  for (const el of parent.children) {
    if (el.synthetic || !el.isValid) continue;
    if (!el.source) {
      out.push(...rowsUnder(el, at, seen));
      continue;
    }
    const place = `${el.source.file}|${el.source.line}:${el.source.column}`;
    const nth = seen.get(place) ?? 0;
    seen.set(place, nth + 1);
    const ref: UIViewRef = { ...at, file: el.source.file, line: el.source.line, column: el.source.column, nth };
    out.push({ ref, key: uiViewRefKey(ref), tag: el.tag, label: viewElementLabel(el), file: el.source.file, children: rowsUnder(el, at, seen) });
  }
  return out;
}

/** The views on the node at `host` (a path key) with their rendered elements. Empty when it has none. */
export function viewRows(lookup: NodeLookup, host: string): UIViewRows[] {
  const node = lookup.nodeFor(host);
  if (!node) return [];
  return viewsOn(node).map((view, index) => ({ view, index, file: viewFile(view), rows: view.root ? rowsUnder(view.root, { host, index }, new Map()) : [] }));
}

/** Keys of the rows above the one `key` names (to open the hierarchy to a selection), or null when it isn't there. */
export function viewRowAncestry(views: readonly UIViewRows[], key: string): string[] | null {
  const find = (rows: readonly UIViewRow[], trail: string[]): string[] | null => {
    for (const r of rows) {
      if (r.key === key) return trail;
      const found = find(r.children, [...trail, r.key]);
      if (found) return found;
    }
    return null;
  };
  for (const v of views) {
    const found = find(v.rows, []);
    if (found) return found;
  }
  return null;
}

// --- Value sources, for the Inspector ------------------------------------------------------------

/** The source attribute names a field may be written as (`flex-direction`, `flexDirection`; HTML's `src` for an image). */
export function attributeNamesOf(field: string): string[] {
  const html: Record<string, string> = { image: "src", maxLength: "maxlength" };
  return [...new Set([kebab(field), field, ...(html[field] ? [html[field]] : [])])];
}

/** Fields whose value is the element's text content. */
const CONTENT_FIELD: Readonly<Record<string, string>> = { Text: "text" };

/** A scoped selector as written: Svelte's hash classes and `:where(.svelte-…)` taken out, `:global(…)` unwrapped. */
function plainSelector(selector: string): string {
  let s = selector.replace(/:where\(\.svelte-[a-z0-9]+\)/g, "").replace(/\.svelte-[a-z0-9]+/g, "");
  for (let i = 0; i < 4 && s.includes(":global("); i++) s = s.replace(/:global\(((?:[^()]|\([^()]*\))*)\)/g, "$1");
  return normalizeSelector(s.replace(/:global\s+/g, ""));
}

/** A rule origin pointing into the source the rule is written in (a component's `<style>`, or a `.css` file). */
function ruleOrigin(source: Extract<ValueSource, { kind: "rule" }>): FieldOrigin {
  const file = source.file;
  const text = sourceText(file);
  const selector = plainSelector(source.rule.selectorText);
  let line = 1;
  let span = source.declaration.span;
  if (text !== null && file.endsWith(".svelte")) {
    const style = sourceOfFile(file)?.style;
    const rule = style?.rules.find((r) => normalizeSelector(r.selector.replace(/:global\(((?:[^()]|\([^()]*\))*)\)/g, "$1")) === selector);
    const decl = rule?.declarations.find((d) => d.property === source.declaration.property);
    const at = decl?.start ?? rule?.start;
    if (at !== undefined) {
      line = lineColumnAt(text, at).line;
      span = decl ? { start: decl.start, end: decl.end } : span;
    }
  } else if (text !== null) line = lineColumnAt(text, span.start).line;
  return { kind: "rule", file, selector, property: source.declaration.property, value: source.declaration.value, span, line };
}

/** The element whose style target is `target`, among `el` and its ancestors. */
function withTarget(el: UIHostElement, target: unknown): UIHostElement | null {
  for (let e: UIHostElement | null = el; e; e = e.parent) if (e._target === target) return e;
  return null;
}

/** Where an attribute value the cascade read comes from, in the source: a literal attribute, the literal style, or an expression. */
function attributeOrigin(el: UIHostElement, field: string): FieldOrigin {
  const src = el.source;
  if (!src) return { kind: "default" };
  const text = sourceText(src.file);
  const element = text !== null ? (() => {
    const s = sourceOfFile(src.file);
    return s ? elementAtLocation(s, src.line, src.column) : null;
  })() : null;
  const line = (offset: number) => (text !== null ? lineColumnAt(text, offset).line : src.line);
  if (!element) return { kind: "expression", file: src.file, line: src.line, name: kebab(field), source: "(the file changed since it compiled)" };
  const property = kebab(field);
  // An inline style beats attributes (ADR 0077 §2): `style:prop`, then the style attribute, then the attribute.
  const directive = element.directives.find((d) => d.kind === "StyleDirective" && d.name === property);
  if (directive) return { kind: "expression", file: src.file, line: src.line, name: `style:${property}`, source: directive.source };
  const style = element.attributes.find((a) => a.name === "style");
  if (style) {
    const decls = styleDeclarations(element);
    if (decls === null) return { kind: "expression", file: src.file, line: line(style.start), name: "style", source: style.value.kind === "dynamic" ? style.value.source : "" };
    const d = decls.find((x) => x.property === property);
    if (d && style.value.kind === "literal") {
      const attribute: MarkupAttribute = { name: "style", value: style.value.text, span: { start: style.start, end: style.end }, valueSpan: { start: style.value.start, end: style.value.end } };
      return { kind: "attribute", file: src.file, attribute, line: line(style.start) };
    }
  }
  const names = attributeNamesOf(field);
  const a = element.attributes.find((x) => names.includes(x.name));
  if (a?.value.kind === "dynamic") return { kind: "expression", file: src.file, line: line(a.start), name: a.name, source: a.value.source };
  if (a) {
    const value = a.value.kind === "literal" ? a.value.text : "";
    const valueSpan = a.value.kind === "literal" ? { start: a.value.start, end: a.value.end } : { start: a.end, end: a.end };
    return { kind: "attribute", file: src.file, attribute: { name: a.name, value, span: { start: a.start, end: a.end }, valueSpan }, line: line(a.start) };
  }
  const spread = element.directives.find((d) => d.kind === "SpreadAttribute");
  return { kind: "expression", file: src.file, line: src.line, name: property, source: spread?.source ?? "(set at runtime)" };
}

function originOf(el: UIHostElement, field: string, source: ValueSource): FieldOrigin {
  switch (source.kind) {
    case "attribute":
      return attributeOrigin(el, field);
    case "rule":
      return ruleOrigin(source);
    case "inherited": {
      let from = withTarget(el, source.from);
      let inner: ValueSource = source.source;
      while (inner.kind === "inherited") {
        from = (from && withTarget(from, inner.from)) ?? from;
        inner = inner.source;
      }
      return { kind: "inherited", from: null, fromLabel: from ? viewElementLabel(from) : "a parent element", origin: originOf(from ?? el, field, inner) };
    }
    case "default":
      return { kind: "default" };
  }
}

/** Where the text content of a text element comes from: literal text, or text with expressions. */
function contentOrigin(el: UIHostElement): FieldOrigin {
  const src = el.source!;
  const s = sourceOfFile(src.file);
  const element = s ? elementAtLocation(s, src.line, src.column) : null;
  const line = element && element.text.kind !== "none" ? lineColumnAt(s!.text, element.text.start).line : src.line;
  if (element?.text.kind === "dynamic") return { kind: "expression", file: src.file, line, name: "text", source: element.text.source };
  return { kind: "content", file: src.file, line, bound: false };
}

/**
 * Every field of a rendered element's component with its current value and where it comes from: a literal
 * attribute (or the literal `style`), an expression `{…}`, a scoped or global rule (as written, with its file and
 * line), inherited, the text content, or the default; and a transition or keyframe animation over any of those.
 */
export function viewFieldSources(el: UIHostElement): FieldSourceRow[] {
  if (!el.source) return [];
  const comp = el.component as unknown as Record<string, unknown>;
  const resolved: ReadonlyMap<string, ResolvedValue> = el._resolved;
  const contentField = CONTENT_FIELD[el.uiTag];
  const rows: FieldSourceRow[] = [];
  for (const info of getFields(el.component.constructor as never)) {
    const field = info.name;
    let origin: FieldOrigin = { kind: "default" };
    if (field === contentField) origin = contentOrigin(el);
    else if (el.attributes.has(kebab(field)) && !resolved.has(field)) origin = attributeOrigin(el, field); // a content attribute (an input's value)
    else {
      const rv = resolved.get(field);
      if (rv) origin = originOf(el, field, rv.source);
    }
    const animated = uiAnimatedField(el.node.world, el.component, field);
    if (animated) origin = { kind: "animated", via: animated.kind, name: animated.name, origin };
    const value = comp[field];
    rows.push({ field, property: kebab(field), info, value, display: formatValue(value), origin });
  }
  return rows;
}
