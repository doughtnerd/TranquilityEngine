/**
 * The markup parser for UI documents (`*.ui.xml`, ADR 0077): `htmlparser2` in XML mode, keeping each
 * element's and attribute's source span so the editor can patch the file in place. Pure and
 * renderer-neutral; never throws for bad markup (problems are reported and the rest still parses).
 */
import { Parser } from "htmlparser2";
import { UI_TAGS as UI_KIND_TAGS } from "../elementKinds";
import { HTML_TAGS } from "../host/htmlTags";
import { hasBinding, parseBindings, problemAt, resolvePath } from "./sourceText";
import type { MarkupAttribute, MarkupElement, ParseMarkup, SourceProblem, SourceSpan, UIMarkup, UITag } from "./types";

export { hasBinding, parseBindings, problemAt, resolvePath };

const UI_TAGS: ReadonlySet<string> = UI_KIND_TAGS;
/** Elements whose text content is a field (`Text`'s text, a `Button`'s label, an `InputField`'s value; ADR 0424: a `TextArea`'s value, an `Option`'s and a `Label`'s label). */
const TEXT_TAGS: ReadonlySet<string> = new Set(["Text", "Button", "InputField", "TextArea", "Option", "Label"]);
/** `<Use>` nesting deeper than this is taken for a cycle the path check missed. */
const MAX_USE_DEPTH = 16;

/** Mutable while parsing; frozen into `MarkupElement`s once closed. */
interface Building {
  tag: string;
  attributes: MarkupAttribute[];
  children: MarkupElement[];
  text: string;
  template: MarkupElement | null;
  /** True for `<Template>`, `<Style>`, `<Use>` and unknown tags, which never become elements. */
  special: boolean;
  start: number;
  openEnd: number;
  /** `<Template>` children collect here until it closes. */
  templateChildren?: MarkupElement[];
  /** ADR 0425: an inline run inside a `Text` (`b`, `span`, `br`, `img`…): its tag as written; null otherwise. */
  inline: string | null;
  /** ADR 0425: a `Text`'s or inline run's text and child elements in order (text pieces become runs beside the children). */
  content: (string | MarkupElement)[];
}

/** ADR 0425: the HTML phrasing tags a `Text` takes as inline runs (each builds a Text, `img` an Image). */
function inlineTagOf(name: string): string | null {
  const lower = name.toLowerCase();
  return lower === "img" || HTML_TAGS.get(lower) === "Text" ? lower : null;
}

/** ADR 0425: text inside an inline run with whitespace collapsed, its ends kept (one space each: the text joins its runs). */
function collapseInner(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

/**
 * Text content as HTML's `white-space: normal` shows it: runs of spaces, tabs and line breaks become
 * one space, trimmed at both ends. Only those (HTML's ASCII whitespace) collapse, so `&#160;` keeps a
 * space. A `text="…"` attribute is never collapsed: it's the way to give exact spacing.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ").replace(/^ | $/g, "");
}

/** The value's span inside an attribute's `name="value"` text (after the quote; empty at the end for a bare name). */
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

function attr(el:{ attributes: readonly MarkupAttribute[] }, name: string): MarkupAttribute | undefined {
  return el.attributes.find((a) => a.name === name);
}

/** Re-home an element tree from a used file: its root gets `from`. Elements keep their own file and spans. */
function withFrom(root: MarkupElement, from: string): MarkupElement {
  return { ...root, from };
}

export const parseMarkup: ParseMarkup = (source, file, read) => parseFile(source, file, read, [file], 0);

function parseFile(source: string, file: string, read: (path: string) => string | null, chain: readonly string[], depth: number): UIMarkup {
  const problems: SourceProblem[] = [];
  const styles: string[] = [];
  const files: string[] = [file];
  const report = (span: SourceSpan, message: string) => problems.push(problemAt(source, file, span, message));
  const stack: Building[] = [];
  const roots: MarkupElement[] = [];
  let parser: Parser;

  const addChild = (el: MarkupElement | null) => {
    if (!el) return;
    const parent = stack[stack.length - 1];
    if (!parent) roots.push(el);
    else if (parent.templateChildren) parent.templateChildren.push(el);
    else if (parent.special) report(el.span, `<${el.tag}> can't go inside <${parent.tag}>.`);
    else {
      parent.children.push(el);
      parent.content.push(el);
    }
  };
  /** ADR 0425: the element on top takes text and inline runs: a `Text`, or an inline run in one. */
  const holdsRuns = (b: Building | undefined): boolean => !!b && !b.special && (b.tag === "Text" || (b.inline !== null && b.inline !== "img"));

  const useFile = (b: Building, span: SourceSpan): MarkupElement | null => {
    const srcAttr = attr(b, "src");
    if (!srcAttr?.value) {
      report(span, "<Use> needs a src attribute.");
      return null;
    }
    const path = resolvePath(file, srcAttr.value);
    if (chain.includes(path) || depth >= MAX_USE_DEPTH) {
      report(srcAttr.span, `<Use src="${srcAttr.value}"> uses itself (${[...chain, path].join(" → ")}).`);
      return null;
    }
    const text = read(path);
    if (text === null) {
      report(srcAttr.span, `<Use src="${srcAttr.value}">: there's no file "${path}".`);
      return null;
    }
    const used = parseFile(text, path, read, [...chain, path], depth + 1);
    for (const f of used.files) if (!files.includes(f)) files.push(f);
    for (const s of used.styles) if (!styles.includes(s)) styles.push(s);
    problems.push(...used.problems);
    if (!used.root) return null;
    // Attributes on <Use> other than src (id, class, fields) apply to the used root, after its own.
    const extra = b.attributes.filter((a) => a.name !== "src");
    const root = extra.length ? { ...used.root, attributes: [...used.root.attributes.filter((a) => !extra.some((e) => e.name === a.name)), ...extra] } : used.root;
    return withFrom(root, path);
  };

  /**
   * ADR 0425: a Text with inline runs, or an inline run: its text pieces between inline children become `#text` runs
   * (collapsed, ends kept), a text-only run keeps its text (ends kept), a `br` is a line break, an `img` an Image (`src`
   * its `image`).
   */
  const inlineElement = (b: Building, span: SourceSpan, openTagSpan: SourceSpan): MarkupElement => {
    const base = { kind: "element" as const, template: b.template, span, openTagSpan, file };
    const tag: UITag = b.inline === "img" ? "Image" : "Text";
    const attributes = b.inline === "img" ? b.attributes.map((a) => (a.name === "src" ? { ...a, name: "image" } : a)) : b.attributes;
    const own = b.inline ? { inlineTag: b.inline } : {};
    if (b.inline === "br") return { ...base, ...own, tag, attributes, children: [], text: "\n" };
    if (!b.children.some((c) => c.inlineTag)) {
      const text = b.inline ? collapseInner(b.text) : collapseWhitespace(b.text);
      return { ...base, ...own, tag, attributes, children: b.children, text: text === "" ? null : text };
    }
    const children: MarkupElement[] = [];
    for (const c of b.content) {
      if (typeof c !== "string") children.push(c);
      else if (c !== "") children.push({ ...base, tag: "Text", inlineTag: "#text", attributes: [], children: [], template: null, text: collapseInner(c) });
    }
    return { ...base, ...own, tag, attributes, children, text: null };
  };

  parser = new Parser(
    {
      onopentag(name) {
        const start = parser.startIndex;
        // ADR 0425: inside a Text, HTML's phrasing tags are its inline runs.
        const inline = !UI_TAGS.has(name) && holdsRuns(stack[stack.length - 1]) ? inlineTagOf(name) : null;
        const b: Building = { tag: name, attributes: pendingAttributes, children: [], text: "", template: null, special: !UI_TAGS.has(name) && !inline, start, openEnd: parser.endIndex + 1, inline, content: [] };
        pendingAttributes = [];
        if (name === "Template") {
          const parent = stack[stack.length - 1];
          if (!parent || parent.special) report({ start, end: b.openEnd }, "<Template> goes inside a UI element.");
          b.templateChildren = [];
        } else if (b.special && name !== "Style" && name !== "Use") {
          report({ start, end: b.openEnd }, `Unknown element <${name}>. Elements are ${[...UI_TAGS].join(", ")}, Use, Style and Template.`);
        }
        stack.push(b);
      },
      onattribute(name, value) {
        const start = parser.startIndex;
        const end = parser.endIndex;
        const span = { start, end };
        if (pendingAttributes.some((a) => a.name === name)) report(span, `Attribute "${name}" is given twice.`);
        pendingAttributes.push({ name, value, span, valueSpan: valueSpanOf(source, start, end) });
      },
      ontext(text) {
        const top = stack[stack.length - 1];
        if (!top) {
          if (text.trim()) report({ start: parser.startIndex, end: parser.endIndex + 1 }, "Text outside the root element is ignored.");
          return;
        }
        if (TEXT_TAGS.has(top.tag) || holdsRuns(top)) {
          top.text += text;
          if (holdsRuns(top)) {
            const last = top.content.length - 1;
            if (typeof top.content[last] === "string") top.content[last] += text;
            else top.content.push(text);
          }
        }
        else if (text.trim()) report({ start: parser.startIndex, end: parser.endIndex + 1 }, `Text inside <${top.tag}> is ignored (only Text, Button, InputField, TextArea, Option and Label take text).`);
      },
      onclosetag(name, implied) {
        const b = stack.pop();
        if (!b) return;
        const end = parser.endIndex + 1;
        const selfClosed = implied && parser.startIndex === b.start;
        if (implied && !selfClosed) report({ start: b.start, end: b.openEnd }, `<${name}> isn't closed.`);
        const span = { start: b.start, end: implied && !selfClosed ? b.openEnd : end };
        const openTagSpan = { start: b.start, end: b.openEnd };
        if (name === "Style") {
          const s = attr(b, "src");
          if (!s?.value) report(openTagSpan, "<Style> needs a src attribute.");
          else {
            const path = resolvePath(file, s.value);
            if (read(path) === null) report(s.span, `<Style src="${s.value}">: there's no file "${path}".`);
            if (!styles.includes(path)) styles.push(path);
            if (!files.includes(path)) files.push(path);
          }
          return;
        }
        if (name === "Template") {
          const parent = stack[stack.length - 1];
          const kids = b.templateChildren ?? [];
          if (kids.length !== 1) report(openTagSpan, `<Template> holds exactly one element (it has ${kids.length}).`);
          if (parent && !parent.special) {
            if (parent.template) report(openTagSpan, `<${parent.tag}> has more than one <Template>.`);
            else parent.template = kids[0] ?? null;
          }
          return;
        }
        if (name === "Use") {
          addChild(useFile(b, span));
          return;
        }
        if (b.special) return; // unknown: reported at its open tag
        if (b.inline || (b.tag === "Text" && b.children.some((c) => c.inlineTag))) return addChild(inlineElement(b, span, openTagSpan));
        const trimmed = collapseWhitespace(b.text);
        const el: MarkupElement = {
          kind: "element",
          tag: name as UITag,
          attributes: b.attributes,
          children: b.children,
          text: trimmed === "" ? null : trimmed,
          template: b.template,
          span,
          openTagSpan,
          file,
        };
        addChild(el);
      },
      onerror(err) {
        report({ start: parser.startIndex, end: parser.endIndex + 1 }, err.message);
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );
  let pendingAttributes: MarkupAttribute[] = [];
  parser.end(source);

  if (roots.length === 0) {
    report({ start: 0, end: 0 }, "The document has no root element.");
    return { file, root: null, styles, files, problems };
  }
  if (roots.length > 1) report(roots[1].span, "A document has one root element; the others are ignored.");
  return { file, root: roots[0], styles, files, problems };
}
