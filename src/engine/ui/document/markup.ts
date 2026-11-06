/**
 * The markup parser for UI documents (`*.ui.xml`, ADR 0077): `htmlparser2` in XML mode, keeping each
 * element's and attribute's source span so the editor can patch the file in place. Pure and
 * renderer-neutral; never throws for bad markup (problems are reported and the rest still parses).
 */
import { Parser } from "htmlparser2";
import type { BindingPart, MarkupAttribute, MarkupElement, ParseBindings, ParseMarkup, SourceProblem, SourceSpan, UIMarkup, UITag } from "./types";

const UI_TAGS: ReadonlySet<string> = new Set<UITag>(["Canvas", "Panel", "Text", "Image", "Button", "InputField"]);
/** Elements whose text content is a field (`Text`'s text, a `Button`'s label, an `InputField`'s value). */
const TEXT_TAGS: ReadonlySet<string> = new Set(["Text", "Button", "InputField"]);
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
}

/** The folder part of a project path (`ui/menu.ui.xml` → `ui/`). */
function folderOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i + 1);
}

/** Resolve `src` against the file that has it; `/` at the start means the project root. `..` and `.` resolve. */
export function resolvePath(file: string, src: string): string {
  const raw = src.replace(/^asset:/, "");
  const joined = raw.startsWith("/") ? raw.slice(1) : folderOf(file) + raw;
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** 1-based line and column of an offset. */
function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function problemAt(source: string, file: string, span: SourceSpan, message: string): SourceProblem {
  const { line, column } = lineColumn(source, span.start);
  return { message: `${file}:${line}:${column}: ${message}`, line, column, span };
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

export const parseBindings: ParseBindings = (value) => {
  const parts: BindingPart[] = [];
  let text = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "{" && value[i + 1] === "{") {
      text += "{";
      i += 2;
    } else if (c === "}" && value[i + 1] === "}") {
      text += "}";
      i += 2;
    } else if (c === "{") {
      const close = value.indexOf("}", i + 1);
      const name = close < 0 ? "" : value.slice(i + 1, close).trim();
      if (close < 0 || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name)) {
        text += c; // not a binding: kept as written
        i++;
        continue;
      }
      if (text) parts.push({ text });
      text = "";
      parts.push({ binding: name });
      i = close + 1;
    } else {
      text += c;
      i++;
    }
  }
  if (text || parts.length === 0) parts.push({ text });
  return parts;
};

/** True when a value has a `{name}` binding. */
export function hasBinding(value: string): boolean {
  return parseBindings(value).some((p) => "binding" in p);
}

/**
 * Text content as HTML's `white-space: normal` shows it: runs of spaces, tabs and line breaks become
 * one space, trimmed at both ends. Only those (HTML's ASCII whitespace) collapse, so `&#160;` keeps a
 * space. A `text="…"` attribute is never collapsed: it's the way to give exact spacing.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ").replace(/^ | $/g, "");
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
    else parent.children.push(el);
  };

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

  parser = new Parser(
    {
      onopentag(name) {
        const start = parser.startIndex;
        const b: Building = { tag: name, attributes: pendingAttributes, children: [], text: "", template: null, special: !UI_TAGS.has(name), start, openEnd: parser.endIndex + 1 };
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
        if (TEXT_TAGS.has(top.tag)) top.text += text;
        else if (text.trim()) report({ start: parser.startIndex, end: parser.endIndex + 1 }, `Text inside <${top.tag}> is ignored (only Text, Button and InputField take text).`);
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
