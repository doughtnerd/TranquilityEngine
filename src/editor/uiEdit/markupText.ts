// Editing UI document markup (`*.ui.xml`, ADR 0077 §4) as text: every edit replaces only the text it
// changes, so comments, blank lines, attribute order, quotes and indentation elsewhere stay as the
// person wrote them. Pure: each function takes a file's text and returns the new text. Callers
// re-parse after each edit (`parseSource`) rather than tracking shifted spans.
//
// Elements are addressed by an `ElementPath`: indices among element children (UI tags and `<Use>`)
// from the file's root element, the same order as the parsed markup's `children` (where a `<Use>`
// is its used document's root). `<Style>`, `<Template>` and comments aren't counted.
import { Parser } from "htmlparser2";
import type { SourceSpan } from "../../engine/ui/document/types";

export interface SourceAttribute {
  readonly name: string;
  /** Decoded (entities resolved). */
  readonly value: string;
  /** The whole `name="value"`. */
  readonly span: SourceSpan;
  /** Inside the quotes. */
  readonly valueSpan: SourceSpan;
}

/** A tag in the file with its spans: UI elements, `<Use>`, `<Style>`, `<Template>` and unknown tags alike. */
export interface SourceElement {
  readonly tag: string;
  readonly attributes: readonly SourceAttribute[];
  /** Open tag to close tag. */
  readonly span: SourceSpan;
  readonly openTagSpan: SourceSpan;
  readonly selfClosing: boolean;
  /** Every tag directly inside, in order. */
  readonly nodes: readonly SourceElement[];
  /** Comments directly inside (text content edits keep them). */
  readonly comments: readonly SourceSpan[];
}

export type ElementPath = readonly number[];

/** Tags that are a document's elements (a `<Use>` stands for its used root). */
export const ELEMENT_TAGS: ReadonlySet<string> = new Set(["Canvas", "Panel", "Text", "Image", "Button", "InputField", "Use"]);

/** An edit that can't be made (no such element, the root can't be removed…). */
export class MarkupEditError extends Error {}

/** An element's element children: UI tags and `<Use>`, in order. */
export const elementChildren = (el: SourceElement): SourceElement[] => el.nodes.filter((n) => ELEMENT_TAGS.has(n.tag));

/** The value's span inside an attribute's text (after the quote; empty at the end for a bare name). */
function valueSpanOf(source: string, start: number, end: number): SourceSpan {
  const text = source.slice(start, end);
  const eq = text.indexOf("=");
  if (eq < 0) return { start: end, end };
  let i = eq + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, i + 1);
    return { start: start + i + 1, end: start + (close < 0 ? text.length : close) };
  }
  let j = i;
  while (j < text.length && !/[\s/>]/.test(text[j])) j++;
  return { start: start + i, end: start + j };
}

interface Building {
  tag: string;
  attributes: SourceAttribute[];
  nodes: SourceElement[];
  comments: SourceSpan[];
  start: number;
  openEnd: number;
}

/** The file's root element (its first top-level UI element or `<Use>`), or null when it has none. */
export function parseSource(text: string): SourceElement | null {
  return parseTopLevel(text).find((n) => ELEMENT_TAGS.has(n.tag)) ?? null;
}

/** Every top-level tag in the text. */
export function parseTopLevel(text: string): SourceElement[] {
  const stack: Building[] = [];
  const top: SourceElement[] = [];
  let pending: SourceAttribute[] = [];
  const parser: Parser = new Parser(
    {
      onopentag(name) {
        stack.push({ tag: name, attributes: pending, nodes: [], comments: [], start: parser.startIndex, openEnd: parser.endIndex + 1 });
        pending = [];
      },
      onattribute(name, value) {
        const start = parser.startIndex, end = parser.endIndex;
        pending.push({ name, value, span: { start, end }, valueSpan: valueSpanOf(text, start, end) });
      },
      oncomment() {
        stack[stack.length - 1]?.comments.push({ start: parser.startIndex, end: parser.endIndex + 1 });
      },
      onclosetag(name, implied) {
        const b = stack.pop();
        if (!b) return;
        const selfClosing = implied && parser.startIndex === b.start;
        const end = implied && !selfClosing ? b.openEnd : parser.endIndex + 1;
        const el: SourceElement = { tag: name, attributes: b.attributes, span: { start: b.start, end }, openTagSpan: { start: b.start, end: b.openEnd }, selfClosing, nodes: b.nodes, comments: b.comments };
        const parent = stack[stack.length - 1];
        if (parent) parent.nodes.push(el);
        else top.push(el);
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.end(text);
  return top;
}

/** The element at `path` in a parsed root, or null. */
export function elementAt(root: SourceElement | null, path: ElementPath): SourceElement | null {
  let el = root;
  for (const i of path) {
    if (!el) return null;
    el = elementChildren(el)[i] ?? null;
  }
  return el;
}

/** The element at `path` in `text`; throws when there's none. */
export function requireElement(text: string, path: ElementPath): SourceElement {
  const el = elementAt(parseSource(text), path);
  if (!el) throw new MarkupEditError(`There's no element at ${path.length ? path.join("/") : "the root"} in the file (it changed).`);
  return el;
}

// --- Text helpers ---------------------------------------------------------------------------------

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);

/** An attribute value written inside double quotes. */
export const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Text content. */
export const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The whitespace between the start of `pos`'s line and `pos`, or null when something else comes first on the line. */
export function lineIndent(text: string, pos: number): string | null {
  let i = pos;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  return i === 0 || text[i - 1] === "\n" ? text.slice(i, pos) : null;
}

/** The leading whitespace of `pos`'s line. */
function leadingWhitespace(text: string, pos: number): string {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** One level of indentation in the file: a child's indent minus its parent's, else two spaces. */
export function indentUnit(text: string, root: SourceElement | null = parseSource(text)): string {
  const walk = (el: SourceElement): string | null => {
    const outer = lineIndent(text, el.span.start);
    for (const c of el.nodes) {
      const inner = lineIndent(text, c.span.start);
      if (outer !== null && inner !== null && inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  return (root && walk(root)) ?? "  ";
}

/** Where an element's close tag starts (its span's end for a self-closing one). */
function closeTagStart(text: string, el: SourceElement): number {
  if (el.selfClosing) return el.span.end;
  const at = text.lastIndexOf("</", el.span.end - 1);
  return at < el.openTagSpan.end ? el.span.end : at;
}

/** `snippet` (its first line at column 0, the rest relative to it) with lines after the first indented by `indent`. */
const indentLines = (snippet: string, indent: string) =>
  snippet
    .split("\n")
    .map((line, i) => (i === 0 || line.trim() === "" ? line : indent + line))
    .join("\n");

// --- Attributes ------------------------------------------------------------------------------------

/** Set an attribute: its value in place (keeping its quotes), or a new one at the end of the open tag. */
export function setAttribute(text: string, path: ElementPath, name: string, value: string): string {
  const el = requireElement(text, path);
  const existing = el.attributes.find((a) => a.name === name);
  if (existing) {
    const quote = text[existing.valueSpan.start - 1];
    if ((quote === '"' || quote === "'") && existing.valueSpan.end < existing.span.end) {
      const escaped = quote === "'" ? escapeAttribute(value).replace(/&quot;/g, '"').replace(/'/g, "&apos;") : escapeAttribute(value);
      return splice(text, existing.valueSpan.start, existing.valueSpan.end, escaped);
    }
    return splice(text, existing.span.start, existing.span.end, `${name}="${escapeAttribute(value)}"`);
  }
  const attr = `${name}="${escapeAttribute(value)}"`;
  const nameEnd = el.openTagSpan.start + 1 + el.tag.length;
  const last = el.attributes[el.attributes.length - 1];
  if (!last) return splice(text, nameEnd, nameEnd, ` ${attr}`);
  // Attributes one per line: the new one on its own line, indented like the last.
  const prevEnd = el.attributes.length > 1 ? el.attributes[el.attributes.length - 2].span.end : nameEnd;
  const gap = text.slice(prevEnd, last.span.start);
  if (gap.includes("\n")) return splice(text, last.span.end, last.span.end, `\n${gap.slice(gap.lastIndexOf("\n") + 1)}${attr}`);
  return splice(text, last.span.end, last.span.end, ` ${attr}`);
}

/** Remove an attribute with the whitespace before it. No change if it isn't there. */
export function removeAttribute(text: string, path: ElementPath, name: string): string {
  const el = requireElement(text, path);
  const a = el.attributes.find((x) => x.name === name);
  if (!a) return text;
  let start = a.span.start;
  while (start > 0 && /\s/.test(text[start - 1])) start--;
  return splice(text, start, a.span.end, "");
}

// --- Text content ----------------------------------------------------------------------------------

/** The stretches of text directly inside an element, between its child tags and comments. */
function textSegments(text: string, el: SourceElement): SourceSpan[] {
  const start = el.openTagSpan.end, end = closeTagStart(text, el);
  const blocks = [...el.nodes.map((n) => n.span), ...el.comments].sort((a, b) => a.start - b.start);
  const out: SourceSpan[] = [];
  let at = start;
  for (const b of blocks) {
    out.push({ start: at, end: b.start });
    at = b.end;
  }
  out.push({ start: at, end });
  return out;
}

/**
 * Set an element's text content (a Text's text, a Button's label, an InputField's value): the
 * first non-blank stretch of text is replaced, keeping the whitespace around it; a self-closing
 * element gets a close tag. `content` is plain text (escaped here); `{bindings}` stay bindings.
 */
export function setText(text: string, path: ElementPath, content: string): string {
  const el = requireElement(text, path);
  const escaped = escapeText(content);
  if (el.selfClosing) {
    if (content === "") return text;
    let s = el.openTagSpan.end - 2; // the "/" of "/>"
    while (s > 0 && /\s/.test(text[s - 1])) s--;
    return splice(text, s, el.openTagSpan.end, `>${escaped}</${el.tag}>`);
  }
  const plain = el.nodes.length === 0 && el.comments.length === 0;
  const segments = textSegments(text, el);
  const filled = segments.find((s) => text.slice(s.start, s.end).trim() !== "");
  if (filled) {
    const raw = text.slice(filled.start, filled.end);
    if (plain && content === "") return splice(text, filled.start, filled.end, "");
    const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
    return splice(text, filled.start + lead, filled.end - trail, escaped);
  }
  if (plain) return splice(text, segments[0].start, segments[0].end, escaped);
  return content === "" ? text : splice(text, el.openTagSpan.end, el.openTagSpan.end, escaped);
}

// --- Elements --------------------------------------------------------------------------------------

/**
 * Insert `snippet` (one element's markup; lines after the first relative to the first) as the
 * `index`th element child of the element at `parentPath` (past the end: last). It's indented like
 * its siblings, or one level inside the parent when it's the first; a self-closing parent opens up.
 */
export function insertElement(text: string, parentPath: ElementPath, index: number, snippet: string): string {
  const root = parseSource(text);
  const parent = elementAt(root, parentPath);
  if (!parent) throw new MarkupEditError("The element to insert into isn't in the file (it changed).");
  const kids = elementChildren(parent);
  if (index < kids.length) {
    const ref = kids[Math.max(0, index)];
    const indent = lineIndent(text, ref.span.start);
    return indent !== null ? splice(text, ref.span.start, ref.span.start, `${indentLines(snippet, indent)}\n${indent}`) : splice(text, ref.span.start, ref.span.start, snippet);
  }
  const last = parent.nodes[parent.nodes.length - 1];
  if (last) {
    const indent = lineIndent(text, last.span.start);
    return indent !== null ? splice(text, last.span.end, last.span.end, `\n${indent}${indentLines(snippet, indent)}`) : splice(text, last.span.end, last.span.end, snippet);
  }
  const outer = leadingWhitespace(text, parent.span.start);
  const inner = outer + indentUnit(text, root);
  const multiline = lineIndent(text, parent.span.start) !== null;
  if (parent.selfClosing) {
    let s = parent.openTagSpan.end - 2;
    while (s > 0 && /\s/.test(text[s - 1])) s--;
    const body = multiline ? `>\n${inner}${indentLines(snippet, inner)}\n${outer}</${parent.tag}>` : `>${snippet}</${parent.tag}>`;
    return splice(text, s, parent.openTagSpan.end, body);
  }
  const close = closeTagStart(text, parent);
  const content = text.slice(parent.openTagSpan.end, close);
  if (content.trim() === "") return splice(text, parent.openTagSpan.end, close, multiline ? `\n${inner}${indentLines(snippet, inner)}\n${outer}` : snippet);
  // Comments or stray text inside: after them, on a new line.
  const at = parent.openTagSpan.end + content.trimEnd().length;
  return splice(text, at, at, `\n${inner}${indentLines(snippet, inner)}`);
}

/** Remove an element (not the root): its whole line when it's alone on it, else just its text. */
export function removeElement(text: string, path: ElementPath): string {
  if (path.length === 0) throw new MarkupEditError("The root element can't be removed.");
  const el = requireElement(text, path);
  let start = el.span.start, end = el.span.end;
  const indent = lineIndent(text, start);
  let e = end;
  while (e < text.length && (text[e] === " " || text[e] === "\t")) e++;
  if (indent !== null && (e === text.length || text[e] === "\n" || text[e] === "\r")) {
    start -= indent.length;
    end = e;
    if (text[end] === "\r") end++;
    if (text[end] === "\n") end++;
    else if (start > 0 && text[start - 1] === "\n") start--; // last line of the file: take the newline before it
  }
  return splice(text, start, end, "");
}

/** An element's markup with lines after the first un-indented by its own line's indent (for re-inserting elsewhere). */
export function elementSnippet(text: string, path: ElementPath): string {
  const el = requireElement(text, path);
  const raw = text.slice(el.span.start, el.span.end);
  const indent = lineIndent(text, el.span.start) ?? leadingWhitespace(text, el.span.start);
  if (!indent) return raw;
  return raw
    .split("\n")
    .map((line, i) => (i > 0 && line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

/** `path` adjusted for removing the element at `removed` (paths after it among its siblings move up one). */
export function pathAfterRemoval(path: ElementPath, removed: ElementPath): number[] {
  const out = [...path];
  const d = removed.length - 1;
  if (path.length > d && removed.slice(0, d).every((v, i) => path[i] === v) && path[d] > removed[d]) out[d]--;
  return out;
}

const startsWithPath = (path: ElementPath, prefix: ElementPath) => prefix.length <= path.length && prefix.every((v, i) => path[i] === v);

/**
 * Move the element at `from` to be the `index`th element child of `toParent` (both as the file is
 * now; `index` counts the moved element if it's already there). Returns the new text and the
 * element's path in it. Comments around the element stay where they were.
 */
export function moveElement(text: string, from: ElementPath, toParent: ElementPath, index: number): { text: string; path: number[] } {
  if (from.length === 0) throw new MarkupEditError("The root element can't be moved.");
  if (startsWithPath(toParent, from)) throw new MarkupEditError("An element can't go inside itself.");
  const snippet = elementSnippet(text, from);
  const parent = pathAfterRemoval(toParent, from);
  const sameParent = toParent.length === from.length - 1 && startsWithPath(from, toParent);
  const at = sameParent && from[from.length - 1] < index ? index - 1 : index;
  const removed = removeElement(text, from);
  const count = elementChildren(elementAt(parseSource(removed), parent)!).length;
  const clamped = Math.max(0, Math.min(at, count));
  return { text: insertElement(removed, parent, clamped, snippet), path: [...parent, clamped] };
}

/** Every `id` in the text. */
export function idsIn(text: string): Set<string> {
  const out = new Set<string>();
  const walk = (el: SourceElement) => {
    for (const a of el.attributes) if (a.name === "id") out.add(a.value);
    el.nodes.forEach(walk);
  };
  parseTopLevel(text).forEach(walk);
  return out;
}

/** `base`, or `base-2`, `base-3`… whichever isn't in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const stem = base.replace(/-\d+$/, "");
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** `snippet` with every `id` in it changed to one not in `taken` (which grows). */
export function withUniqueIds(snippet: string, taken: Set<string>): string {
  const spans: { span: SourceSpan; value: string }[] = [];
  const walk = (el: SourceElement) => {
    for (const a of el.attributes) if (a.name === "id") spans.push({ span: a.valueSpan, value: a.value });
    el.nodes.forEach(walk);
  };
  parseTopLevel(snippet).forEach(walk);
  let out = snippet;
  const fresh = spans.map((s) => {
    const id = uniqueName(s.value, taken);
    taken.add(id);
    return id;
  });
  for (let i = spans.length - 1; i >= 0; i--) out = splice(out, spans[i].span.start, spans[i].span.end, escapeAttribute(fresh[i]));
  return out;
}

/** Duplicate the element at `path` right after itself, with fresh ids. Returns the new text and the copy's path. */
export function duplicateElement(text: string, path: ElementPath): { text: string; path: number[] } {
  if (path.length === 0) throw new MarkupEditError("The root element can't be duplicated.");
  const snippet = withUniqueIds(elementSnippet(text, path), idsIn(text));
  const parent = path.slice(0, -1);
  const index = path[path.length - 1] + 1;
  return { text: insertElement(text, parent, index, snippet), path: [...parent, index] };
}

/** Add a `<Style src>` as the root's first child (after any `<Style>` already there). */
export function addStyle(text: string, src: string): string {
  const root = parseSource(text);
  if (!root) throw new MarkupEditError("The document has no root element.");
  const styles = root.nodes.filter((n) => n.tag === "Style");
  const tag = `<Style src="${escapeAttribute(src)}"/>`;
  const after = styles[styles.length - 1];
  if (after) {
    const indent = lineIndent(text, after.span.start);
    return splice(text, after.span.end, after.span.end, indent !== null ? `\n${indent}${tag}` : tag);
  }
  const first = root.nodes[0];
  if (first) {
    const indent = lineIndent(text, first.span.start);
    return splice(text, first.span.start, first.span.start, indent !== null ? `${tag}\n${indent}` : tag);
  }
  return insertElement(text, [], 0, tag);
}
