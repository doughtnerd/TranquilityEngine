// Text edits on a Svelte component's source (ADR 0423 wave C): every edit
// re-parses the file with `parse(src, { modern: true })` and changes only the text its spans name, so comments,
// formatting and hand edits stay. Elements are found by where they start (the offset of their `<`), which is
// what Svelte's dev-mode template location names (line, column).
//
// Only static parts are edited (owner decision 1 of ADR 0423): literal attribute values, literal text, the static
// `class` attribute, a literal `style` attribute's declarations, the elements of the component's own template
// (not inside `{#each}` or a `{#snippet}`, which render more than once) and the component's `<style>` rules.
// Anything in `{…}` is refused with the reason (`SvelteEditError`).
//
// `svelte/compiler` loads on demand (`loadSvelteParser`): the editor only needs it once a project has Svelte UI,
// and compiling that UI loads the same module anyway.

import { DASHED, uniqueName } from "../../engine/core/uniqueName";

type Parse = typeof import("svelte/compiler").parse;

let parser: Parse | null = null;
let loading: Promise<void> | null = null;

/** Load Svelte's parser (once). Resolves when `parseSvelte` can run. */
export function loadSvelteParser(): Promise<void> {
  if (parser) return Promise.resolve();
  loading ??= import("svelte/compiler").then(
    (m) => {
      parser = m.parse;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/** True once `loadSvelteParser` has resolved. */
export const svelteParserLoaded = (): boolean => parser !== null;

/** An edit that can't be made, with the reason in words (shown in the status bar). */
export class SvelteEditError extends Error {}

// --- The parsed source ------------------------------------------------------------------------------

/** A literal attribute value's text and its span (inside the quotes). `quoted` false: written `gap=2`. */
export interface LiteralValue {
  readonly kind: "literal";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly quoted: boolean;
}

/**
 * A `t("key")` or `tHtml("key", …)` call with a literal key (`myco`'s localised text, ADR 0356, 0423): the key, which
 * function, and whether it passes message arguments.
 */
export interface KeyCall {
  readonly name: "t" | "tHtml";
  readonly key: string;
  readonly args: boolean;
}

/** An attribute as written: its name, span and value (literal, bare, or with `{…}` in it: `call` when it's one `{t("key")}`). */
export interface SvelteAttribute {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly value: LiteralValue | { readonly kind: "boolean" } | { readonly kind: "dynamic"; readonly source: string; readonly call: KeyCall | null };
}

/** A directive or spread on an element (`class:x={…}`, `style:color={…}`, `bind:value`, `{...props}`), as written. */
export interface SvelteDirective {
  /** `ClassDirective`, `StyleDirective`, `BindDirective`, `OnDirective`, `SpreadAttribute`… */
  readonly kind: string;
  readonly name: string;
  readonly source: string;
}

/** An element's text content: literal text (its children are only text), text with `{…}` in it, or none (it has elements or nothing). */
export type SvelteText =
  | { readonly kind: "literal"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: "dynamic"; readonly source: string; readonly start: number }
  | { readonly kind: "none" };

/**
 * One piece of what an element holds directly, in order: literal text (decoded, as shown) or an expression tag
 * (`{…}`, or `{@html …}` with `html`), with `call` when the expression is one `t("key")`/`tHtml("key")` call.
 */
export type SvelteContent =
  | { readonly kind: "text"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: "expression"; readonly source: string; readonly start: number; readonly end: number; readonly html: boolean; readonly call: KeyCall | null };

/** An element (`RegularElement`) of a component's template. */
export interface SvelteElement {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** Just past the open tag's `>`. */
  readonly openTagEnd: number;
  readonly selfClosing: boolean;
  readonly attributes: readonly SvelteAttribute[];
  readonly directives: readonly SvelteDirective[];
  readonly text: SvelteText;
  /** Its direct text and expression tags, in order (whitespace-only text left out), whatever else it holds. */
  readonly content: readonly SvelteContent[];
  /** The nearest element it's inside, or null at the top of the template. */
  readonly parent: SvelteElement | null;
  /** Its place among the elements written directly beside it (the same fragment), and how many there are. */
  readonly index: number;
  readonly siblings: number;
  /** Its child elements written directly inside it. */
  readonly children: readonly SvelteElement[];
  /** Why it renders more than once (inside `{#each}` or a `{#snippet}`), or null. */
  readonly repeated: string | null;
  /** The block it's directly in when that's not its parent element (`{#if}`, `{#each}`, a component's children), or null. */
  readonly block: string | null;
}

/** A rule of the component's `<style>`: its selector as written, spans, and declarations. */
export interface SvelteRule {
  readonly selector: string;
  readonly start: number;
  readonly end: number;
  /** Just past `{` and at `}`. */
  readonly blockStart: number;
  readonly blockEnd: number;
  readonly declarations: readonly { readonly property: string; readonly value: string; readonly start: number; readonly end: number }[];
}

/** An import of the instance `<script>`, as written: its span, module, and named specifiers. */
export interface SvelteImport {
  readonly from: string;
  readonly start: number;
  readonly end: number;
  /** Named specifiers (`{ a, b as c }`): imported and local names, and where each ends. */
  readonly named: readonly { readonly imported: string; readonly local: string; readonly end: number }[];
  /** Default and namespace specifiers' local names. */
  readonly others: readonly string[];
}

export interface SvelteSource {
  readonly text: string;
  /** Every element of the template, in source order. */
  readonly elements: readonly SvelteElement[];
  /** The elements at the top of the template. */
  readonly top: readonly SvelteElement[];
  /** The `<style>` block's content span and rules, or null without one. */
  readonly style: { readonly start: number; readonly end: number; readonly rules: readonly SvelteRule[] } | null;
  /** The instance `<script>`'s content span and imports, or null without one (a `module` script isn't it). */
  readonly script: { readonly start: number; readonly end: number; readonly imports: readonly SvelteImport[] } | null;
}

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const BLOCK_NAMES: Readonly<Record<string, string>> = {
  IfBlock: "{#if}",
  EachBlock: "{#each}",
  AwaitBlock: "{#await}",
  KeyBlock: "{#key}",
  SnippetBlock: "{#snippet}",
  Component: "a component's children",
  SvelteComponent: "a component's children",
  SvelteBoundary: "<svelte:boundary>",
};

/** The fragments a node holds (blocks hold several: an `{#if}`'s branches, an `{#each}`'s body and fallback). */
function fragmentsOf(node: Node): Node[][] {
  const out: Node[][] = [];
  for (const key of ["fragment", "consequent", "alternate", "body", "fallback", "pending", "then", "catch"]) {
    const f = node[key] as { nodes?: Node[] } | null | undefined;
    if (f && Array.isArray(f.nodes)) out.push(f.nodes);
  }
  return out;
}

/** 1-based line and 0-based column of an offset (Svelte's template locations). */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1, start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start };
}

/** The offset of a 1-based line and 0-based column, or -1 past the end. */
export function offsetAt(text: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at + column <= text.length ? at + column : -1;
}

/** The `t("key")`/`tHtml("key")` call an expression is, or null (a key built at runtime isn't one). */
function keyCallOf(expression: Node | undefined): KeyCall | null {
  if (!expression || expression.type !== "CallExpression") return null;
  const callee = expression.callee as Node;
  const name = callee.type === "Identifier" ? String(callee.name) : "";
  if (name !== "t" && name !== "tHtml") return null;
  const args = expression.arguments as Node[];
  const first = args[0];
  let key: string | null = null;
  if (first?.type === "Literal" && typeof first.value === "string") key = first.value;
  else if (first?.type === "TemplateLiteral" && (first.expressions as Node[]).length === 0) key = String(((first.quasis as Node[])[0].value as { cooked: string }).cooked);
  return key === null ? null : { name, key, args: args.length > 1 };
}

function attributeOf(text: string, a: Node): SvelteAttribute {
  const name = String(a.name);
  const v = a.value as true | Node | Node[];
  if (v === true) return { name, start: a.start, end: a.end, value: { kind: "boolean" } };
  const parts = Array.isArray(v) ? v : [v];
  if (parts.every((p) => p.type === "Text")) {
    if (parts.length === 0) {
      // `name=""`: the span between the quotes.
      const raw = text.slice(a.start, a.end);
      const q = raw.search(/["']/);
      const at = q < 0 ? a.end : a.start + q + 1;
      return { name, start: a.start, end: a.end, value: { kind: "literal", text: "", start: at, end: at, quoted: q >= 0 } };
    }
    const start = parts[0].start, end = parts[parts.length - 1].end;
    const quoted = /["']/.test(text[start - 1] ?? "");
    return { name, start: a.start, end: a.end, value: { kind: "literal", text: parts.map((p) => String(p.data)).join(""), start, end, quoted } };
  }
  const first = parts[0], last = parts[parts.length - 1];
  const call = parts.length === 1 && first.type === "ExpressionTag" ? keyCallOf(first.expression as Node) : null;
  return { name, start: a.start, end: a.end, value: { kind: "dynamic", source: text.slice(first.start, last.end), call } };
}

function contentOf(text: string, nodes: readonly Node[]): SvelteContent[] {
  const out: SvelteContent[] = [];
  for (const n of nodes) {
    if (n.type === "Text" && String(n.data).trim() !== "") out.push({ kind: "text", text: String(n.data), start: n.start, end: n.end });
    else if (n.type === "ExpressionTag" || n.type === "HtmlTag") out.push({ kind: "expression", source: text.slice(n.start, n.end), start: n.start, end: n.end, html: n.type === "HtmlTag", call: keyCallOf(n.expression as Node) });
  }
  return out;
}

function textOf(text: string, nodes: readonly Node[]): SvelteText {
  const meaningful = nodes.filter((n) => !(n.type === "Text" && String(n.data).trim() === "") && n.type !== "Comment");
  if (meaningful.length === 0) {
    const texts = nodes.filter((n) => n.type === "Text");
    return texts.length > 0 && nodes.every((n) => n.type === "Text") ? { kind: "literal", text: "", start: texts[0].start, end: texts[texts.length - 1].end } : { kind: "none" };
  }
  if (meaningful.some((n) => n.type !== "Text" && n.type !== "ExpressionTag")) return { kind: "none" };
  const start = nodes[0].start, end = nodes[nodes.length - 1].end;
  if (meaningful.some((n) => n.type === "ExpressionTag")) return { kind: "dynamic", source: text.slice(start, end).trim(), start };
  return { kind: "literal", text: nodes.map((n) => String(n.data)).join(""), start, end };
}

/** Parse a component's source. Throws `SvelteEditError` (with Svelte's message) when it doesn't parse, or before `loadSvelteParser`. */
export function parseSvelte(text: string): SvelteSource {
  if (!parser) throw new SvelteEditError("Svelte's parser isn't loaded yet; try again in a moment");
  let root: { fragment: { nodes: Node[] }; css: Node | null; instance: Node | null };
  try {
    root = parser(text, { modern: true }) as unknown as typeof root;
  } catch (err) {
    throw new SvelteEditError(`the file doesn't parse (${String((err as Error)?.message ?? err).split("\n")[0]})`);
  }
  const elements: SvelteElement[] = [];
  const top: SvelteElement[] = [];
  const visit = (nodes: readonly Node[], parent: SvelteElement | null, repeated: string | null, block: string | null, into: SvelteElement[]) => {
    const here = nodes.filter((n) => n.type === "RegularElement");
    for (const n of nodes) {
      if (n.type === "RegularElement") {
        const attributes: SvelteAttribute[] = [];
        const directives: SvelteDirective[] = [];
        for (const a of n.attributes as Node[]) {
          if (a.type === "Attribute") attributes.push(attributeOf(text, a));
          else directives.push({ kind: a.type, name: String(a.name ?? ""), source: text.slice(a.start, a.end) });
        }
        const children: SvelteElement[] = [];
        const fragment = (n.fragment as { nodes: Node[] }).nodes;
        const raw = text.slice(n.start, n.end);
        const selfClosing = /\/\s*>$/.test(raw) && !raw.includes(`</${String(n.name)}`);
        const lastAttr = (n.attributes as Node[]).reduce((m, a) => Math.max(m, a.end), n.start + 1 + String(n.name).length);
        const gt = text.indexOf(">", lastAttr);
        const el: SvelteElement = {
          name: String(n.name),
          start: n.start,
          end: n.end,
          openTagEnd: gt < 0 ? n.end : gt + 1,
          selfClosing,
          attributes,
          directives,
          text: textOf(text, fragment),
          content: contentOf(text, fragment),
          parent,
          index: here.indexOf(n),
          siblings: here.length,
          children,
          repeated,
          block,
        };
        elements.push(el);
        into.push(el);
        visit(fragment, el, repeated, null, children);
        continue;
      }
      const name = BLOCK_NAMES[n.type];
      if (!name && n.type !== "SvelteElement" && n.type !== "SvelteFragment" && n.type !== "TitleElement") continue;
      const at = lineColumnAt(text, n.start);
      const where = `${name ?? `<${String(n.name ?? n.type)}>`} at line ${at.line}`;
      const again = n.type === "EachBlock" ? `it's a row of the {#each} at line ${at.line}` : n.type === "SnippetBlock" ? `it's in the {#snippet ${String((n.expression as Node | undefined)?.name ?? "")}} at line ${at.line}` : null;
      // A block's elements render inside the parent element, but they're written in the block: not its direct children.
      for (const f of fragmentsOf(n)) visit(f, parent, repeated ?? again, where, []);
    }
  };
  visit(root.fragment.nodes, null, null, null, top);
  elements.sort((a, b) => a.start - b.start);
  let style: SvelteSource["style"] = null;
  if (root.css) {
    const content = root.css.content as { start: number; end: number };
    const rules: SvelteRule[] = [];
    for (const r of (root.css.children as Node[]) ?? []) {
      if (r.type !== "Rule") continue;
      const prelude = r.prelude as Node, block = r.block as Node;
      rules.push({
        selector: text.slice(prelude.start, prelude.end),
        start: r.start,
        end: r.end,
        blockStart: block.start + 1,
        blockEnd: block.end - 1,
        declarations: ((block.children as Node[]) ?? []).filter((d) => d.type === "Declaration").map((d) => ({ property: String(d.property), value: String(d.value), start: d.start, end: d.end })),
      });
    }
    style = { start: content.start, end: content.end, rules };
  }
  let script: SvelteSource["script"] = null;
  if (root.instance) {
    const content = root.instance.content as Node & { body: Node[] };
    const imports: SvelteImport[] = content.body
      .filter((b) => b.type === "ImportDeclaration")
      .map((b) => {
        const specifiers = b.specifiers as Node[];
        return {
          from: String((b.source as Node).value),
          start: b.start,
          end: b.end,
          named: specifiers.filter((x) => x.type === "ImportSpecifier").map((x) => ({ imported: String((x.imported as Node).name ?? (x.imported as Node).value), local: String((x.local as Node).name), end: x.end })),
          others: specifiers.filter((x) => x.type !== "ImportSpecifier").map((x) => String((x.local as Node).name)),
        };
      });
    // The content node's span is its statements'; the script's content runs from its open tag's `>` to `</script>`.
    const open = text.indexOf(">", root.instance.start) + 1;
    const close = text.lastIndexOf("</script", root.instance.end);
    script = { start: open, end: close < open ? open : close, imports };
  }
  return { text, elements, top, style, script };
}

/** The element starting at `offset` (its `<`), or null. */
export function elementStartingAt(source: SvelteSource, offset: number): SvelteElement | null {
  return source.elements.find((e) => e.start === offset) ?? null;
}

/** The element a template location (1-based line, 0-based column) names, or null. */
export function elementAtLocation(source: SvelteSource, line: number, column: number): SvelteElement | null {
  const at = offsetAt(source.text, line, column);
  return at < 0 ? null : elementStartingAt(source, at);
}

/** Literal ids written in the file. */
export function idsIn(source: SvelteSource): Set<string> {
  const out = new Set<string>();
  for (const e of source.elements) {
    const id = e.attributes.find((a) => a.name === "id")?.value;
    if (id?.kind === "literal" && id.text) out.add(id.text);
  }
  return out;
}

/** Selector text with whitespace collapsed (to compare a rule's selector with one asked for). */
export const normalizeSelector = (s: string): string => s.replace(/\s+/g, " ").replace(/\s*([>+~,])\s*/g, "$1").trim();

// --- Helpers ---------------------------------------------------------------------------------------

function element(text: string, at: number): { source: SvelteSource; el: SvelteElement } {
  const source = parseSvelte(text);
  const el = elementStartingAt(source, at);
  if (!el) throw new SvelteEditError("the element isn't where it was (the file changed); try again once it reloads");
  return { source, el };
}

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);

/** A value as literal attribute text: quotes, `{` and `}` escaped (Svelte reads `{` as an expression). */
export const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
/** Text as literal template text: `<`, `{` and `}` escaped. */
export const escapeText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

/** The whitespace at the start of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** One indent step as the file writes it (a tab, or two spaces). */
function indentUnit(text: string): string {
  const m = /\n(\t+|[ ]+)</.exec(text);
  return m?.[1].startsWith("\t") ? "\t" : "  ";
}

/** Where an element's closing tag starts (`</name>`), or null for a self-closing one. */
function closeTagStart(text: string, el: SvelteElement): number | null {
  if (el.selfClosing) return null;
  const at = text.lastIndexOf("</", el.end);
  return at >= el.openTagEnd ? at : null;
}

// --- Attributes --------------------------------------------------------------------------------------

/**
 * Set attribute `name` on the element starting at `at` to the literal `value`: its literal value is replaced in
 * place (a bare attribute gets one), a new one is added at the end of the open tag. Refused when it's written with
 * `{…}` (an expression), or set by a spread.
 */
export function setAttribute(text: string, at: number, name: string, value: string): string {
  const { el } = element(text, at);
  const a = el.attributes.find((x) => x.name === name);
  const quoted = `"${escapeAttribute(value)}"`;
  if (a) {
    if (a.value.kind === "dynamic") throw new SvelteEditError(`${name} is an expression (${a.value.source}): edit it in the Code panel`);
    if (a.value.kind === "boolean") return splice(text, a.end, a.end, `=${quoted}`);
    const v = a.value;
    return v.quoted ? splice(text, v.start, v.end, escapeAttribute(value)) : splice(text, v.start, v.end, quoted);
  }
  // At the end of the open tag, before `>` or `/>` (after any directive).
  let insertAt = el.openTagEnd - 1;
  if (text[insertAt - 1] === "/") insertAt--;
  while (insertAt > el.start && /\s/.test(text[insertAt - 1])) insertAt--;
  return splice(text, insertAt, insertAt, ` ${name}=${quoted}`);
}

/** Remove attribute `name` from the element starting at `at` (and the space before it). Nothing to remove: the text as it is. */
export function removeAttribute(text: string, at: number, name: string): string {
  const { el } = element(text, at);
  const a = el.attributes.find((x) => x.name === name);
  if (!a) return text;
  let start = a.start;
  while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
  if (text[start - 1] === "\n") {
    // On a line of its own: take the line.
    let lineStart = start - 1;
    const after = text.slice(a.end).match(/^[ \t]*/)![0].length;
    if (text[a.end + after] === "\n") return splice(text, lineStart, a.end + after, "");
    lineStart = start;
    return splice(text, lineStart, a.end + after, "");
  }
  return splice(text, start, a.end, "");
}

/** A literal `style` attribute's declarations, in order (an expression in it: null). */
export function styleDeclarations(el: SvelteElement): { property: string; value: string }[] | null {
  const a = el.attributes.find((x) => x.name === "style");
  if (!a) return [];
  if (a.value.kind !== "literal") return a.value.kind === "boolean" ? [] : null;
  return a.value.text
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const c = d.indexOf(":");
      return c < 0 ? { property: d.trim(), value: "" } : { property: d.slice(0, c).trim(), value: d.slice(c + 1).trim() };
    });
}

/** Set (or with null, remove) a declaration in the element's literal `style` attribute (removing the attribute once it's empty). */
export function setStyleProperty(text: string, at: number, property: string, value: string | null): string {
  const { el } = element(text, at);
  const decls = styleDeclarations(el);
  if (decls === null) throw new SvelteEditError("its style attribute is an expression: edit it in the Code panel");
  const i = decls.findIndex((d) => d.property === property);
  if (value === null) {
    if (i < 0) return text;
    decls.splice(i, 1);
  } else if (i < 0) decls.push({ property, value });
  else decls[i] = { property, value };
  if (decls.length === 0) return removeAttribute(text, at, "style");
  return setAttribute(text, at, "style", decls.map((d) => `${d.property}: ${d.value}`).join("; "));
}

// --- Text --------------------------------------------------------------------------------------------

/** Set the literal text content of the element starting at `at`. Refused when it has elements inside, or text with `{…}`. */
export function setText(text: string, at: number, value: string): string {
  const { el } = element(text, at);
  if (el.text.kind === "dynamic") throw new SvelteEditError(`its text has expressions (${el.text.source}): edit it in the Code panel`);
  if (el.text.kind === "literal") {
    // Keep the whitespace around the text as written.
    const raw = text.slice(el.text.start, el.text.end);
    const lead = /^\s*/.exec(raw)![0], trail = raw.trim() === "" ? "" : /\s*$/.exec(raw)![0];
    return splice(text, el.text.start, el.text.end, `${lead}${escapeText(value)}${trail}`);
  }
  if (el.children.length > 0) throw new SvelteEditError("it has elements inside: its text is theirs");
  if (el.selfClosing) {
    let slash = text.lastIndexOf("/", el.openTagEnd);
    while (slash > el.start && /\s/.test(text[slash - 1])) slash--;
    return splice(text, slash, el.end, `>${escapeText(value)}</${el.name}>`);
  }
  const close = closeTagStart(text, el);
  if (close === null) throw new SvelteEditError("its closing tag can't be found");
  return splice(text, el.openTagEnd, close, escapeText(value));
}

/**
 * Replace the literal text content of the element starting at `at` with the expression tag `{expression}` (the
 * whitespace around the text kept as written). Refused when it has no literal text, or has elements inside.
 */
export function setTextExpression(text: string, at: number, expression: string): string {
  const { el } = element(text, at);
  if (el.text.kind === "dynamic") throw new SvelteEditError(`its text has expressions (${el.text.source}): only literal text can be replaced`);
  if (el.text.kind === "none" && el.content.some((c) => c.kind === "expression")) throw new SvelteEditError(`its text has expressions (${text.slice(el.content[0].start, el.content[el.content.length - 1].end)}): only literal text can be replaced`);
  if (el.text.kind === "none" || el.text.text.trim() === "") throw new SvelteEditError(el.children.length > 0 ? "it has elements inside: its text is theirs" : "it has no text");
  const raw = text.slice(el.text.start, el.text.end);
  const lead = /^\s*/.exec(raw)![0], trail = /\s*$/.exec(raw)![0];
  return splice(text, el.text.start, el.text.end, `${lead}{${expression}}${trail}`);
}

/** Write attribute `name` of the element starting at `at` as `name={expression}`, replacing its literal value. Refused when it's missing or already an expression. */
export function setAttributeExpression(text: string, at: number, name: string, expression: string): string {
  const { el } = element(text, at);
  const a = el.attributes.find((x) => x.name === name);
  if (!a) throw new SvelteEditError(`it has no ${name} attribute`);
  if (a.value.kind === "dynamic") throw new SvelteEditError(`${name} is an expression (${a.value.source}) already`);
  return splice(text, a.start, a.end, `${name}={${expression}}`);
}

/**
 * Write `value` as literal text where the element starting at `at` has one expression: its text content (`field`
 * `text`, when that's a single `{…}` tag) or attribute `field` (`name={…}` becomes `name="value"`). Refused otherwise.
 */
export function setExpressionLiteral(text: string, at: number, field: string, value: string): string {
  const { el } = element(text, at);
  if (field === "text") {
    const only = el.content.length === 1 ? el.content[0] : null;
    if (only?.kind !== "expression" || only.html) throw new SvelteEditError("its text isn't one {…} expression");
    return splice(text, only.start, only.end, escapeText(value));
  }
  const a = el.attributes.find((x) => x.name === field);
  if (!a || a.value.kind !== "dynamic") throw new SvelteEditError(`its ${field} isn't an expression`);
  return splice(text, a.start, a.end, `${field}="${escapeAttribute(value)}"`);
}

/**
 * Make sure the component's instance `<script>` imports `name` from `from` (`import { t } from "myco"`): added to an
 * import of that module with named specifiers, else as a new import after the last one, else in a new `<script>` at
 * the top of the file. Refused when another import already binds `name`.
 */
export function addNamedImport(text: string, name: string, from: string): string {
  const source = parseSvelte(text);
  const script = source.script;
  if (!script) return `<script lang="ts">\n  import { ${name} } from "${from}";\n</script>\n\n${text}`;
  const imports = script.imports;
  if (imports.some((i) => i.from === from && i.named.some((n) => n.imported === name && n.local === name))) return text;
  const clash = imports.find((i) => i.named.some((n) => n.local === name) || i.others.includes(name));
  if (clash) throw new SvelteEditError(`the component's script already imports another ${name} (from "${clash.from}")`);
  const same = imports.find((i) => i.from === from && i.named.length > 0);
  if (same) return splice(text, same.named[same.named.length - 1].end, same.named[same.named.length - 1].end, `, ${name}`);
  const line = `import { ${name} } from "${from}";`;
  if (imports.length > 0) {
    const last = imports[imports.length - 1];
    return splice(text, last.end, last.end, `\n${indentAt(text, last.start)}${line}`);
  }
  const body = text.slice(script.start, script.end);
  const firstCode = body.search(/\S/);
  const indent = firstCode < 0 ? "  " : indentAt(text, script.start + firstCode) || "  ";
  return splice(text, script.start, script.start, `\n${indent}${line}${firstCode < 0 ? "\n" : ""}`);
}

// --- Structure ---------------------------------------------------------------------------------------

/** The span an element takes with its line, when it's alone on it (so removing it leaves no blank line). */
function lineSpan(text: string, el: { start: number; end: number }): { start: number; end: number } {
  let start = el.start;
  while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
  let end = el.end;
  while (end < text.length && /[ \t]/.test(text[end])) end++;
  if ((start === 0 || text[start - 1] === "\n") && (end === text.length || text[end] === "\n")) return { start: start === 0 ? 0 : start - 1, end };
  return { start: el.start, end: el.end };
}

/** Remove the element starting at `at` from its template. */
export function removeElement(text: string, at: number): string {
  const { el } = element(text, at);
  if (el.repeated) throw new SvelteEditError(el.repeated);
  const span = lineSpan(text, el);
  return splice(text, span.start, span.end, "");
}

/**
 * Insert `markup` as the `index`th child element of the element starting at `parentAt` (past the end: last), or of
 * the template's top level with `parentAt` null. Returns the new text and where the new element starts.
 */
export function insertElement(text: string, parentAt: number | null, index: number, markup: string): { text: string; start: number } {
  const source = parseSvelte(text);
  const parent = parentAt === null ? null : elementStartingAt(source, parentAt);
  if (parentAt !== null && !parent) throw new SvelteEditError("the element isn't where it was (the file changed); try again once it reloads");
  if (parent?.repeated) throw new SvelteEditError(parent.repeated);
  if (parent && parent.text.kind === "dynamic") throw new SvelteEditError(`its content is text with expressions (${parent.text.source})`);
  const kids = parent ? parent.children : source.top;
  const unit = indentUnit(text);
  if (kids.length > 0) {
    const i = Math.max(0, Math.min(index, kids.length));
    if (i < kids.length) {
      const next = kids[i];
      const indent = indentAt(text, next.start);
      const lineStart = text.lastIndexOf("\n", next.start - 1) + 1;
      const alone = text.slice(lineStart, next.start).trim() === "";
      const insert = alone ? `${markup}\n${indent}` : `${markup}`;
      return { text: splice(text, next.start, next.start, insert), start: next.start };
    }
    const prev = kids[kids.length - 1];
    const indent = indentAt(text, prev.start);
    const insert = `\n${indent}${markup}`;
    return { text: splice(text, prev.end, prev.end, insert), start: prev.end + 1 + indent.length };
  }
  if (!parent) {
    // An empty template: after the script (and module script), else at the top of the file.
    const scriptEnd = text.lastIndexOf("</script>");
    const at = scriptEnd < 0 ? 0 : scriptEnd + "</script>".length;
    const insert = `${at === 0 ? "" : "\n\n"}${markup}\n`;
    return { text: splice(text, at, at, insert), start: at + (at === 0 ? 0 : 2) };
  }
  const indent = indentAt(text, parent.start);
  const inner = indent + unit;
  if (parent.selfClosing) {
    const slash = text.lastIndexOf("/", parent.openTagEnd);
    let tagEnd = slash;
    while (tagEnd > parent.start && /\s/.test(text[tagEnd - 1])) tagEnd--;
    const insert = `>\n${inner}${markup}\n${indent}</${parent.name}>`;
    return { text: splice(text, tagEnd, parent.end, insert), start: tagEnd + 2 + inner.length };
  }
  const close = closeTagStart(text, parent);
  if (close === null) throw new SvelteEditError("its closing tag can't be found");
  const between = text.slice(parent.openTagEnd, close);
  if (between.trim() === "") {
    const insert = `\n${inner}${markup}\n${indent}`;
    return { text: splice(text, parent.openTagEnd, close, insert), start: parent.openTagEnd + 1 + inner.length };
  }
  // Text (or a block) inside: after it.
  let end = close;
  while (end > parent.openTagEnd && /\s/.test(text[end - 1])) end--;
  const insert = `\n${inner}${markup}`;
  return { text: splice(text, end, end, insert), start: end + 1 + inner.length };
}

/** Insert `markup` right after the element starting at `at` (beside it, in the same block). Returns the new text and where it starts. */
export function insertAfterElement(text: string, at: number, markup: string): { text: string; start: number } {
  const { el } = element(text, at);
  if (el.repeated) throw new SvelteEditError(el.repeated);
  const indent = indentAt(text, el.start);
  const lineStart = text.lastIndexOf("\n", el.start - 1) + 1;
  const sep = text.slice(lineStart, el.start).trim() === "" ? `\n${indent}` : "";
  return { text: splice(text, el.end, el.end, `${sep}${markup}`), start: el.end + sep.length };
}

/** Copy the element starting at `at` right after itself, with fresh literal ids. Returns the new text and where the copy starts. */
export function duplicateElement(text: string, at: number): { text: string; start: number } {
  const { source, el } = element(text, at);
  if (el.repeated) throw new SvelteEditError(el.repeated);
  const taken = idsIn(source);
  // Fresh ids for literal ids inside the copy, last first so earlier spans stay right.
  let copy = text.slice(el.start, el.end);
  const inside = source.elements.filter((e) => e.start >= el.start && e.end <= el.end).sort((a, b) => b.start - a.start);
  for (const e of inside) {
    const id = e.attributes.find((a) => a.name === "id")?.value;
    if (id?.kind !== "literal" || !id.text) continue;
    const next = uniqueName(id.text, taken, DASHED); // the copied id is in `taken`, so always renumbered
    taken.add(next);
    copy = splice(copy, id.start - el.start, id.end - el.start, id.quoted ? next : `"${next}"`);
  }
  const indent = indentAt(text, el.start);
  const lineStart = text.lastIndexOf("\n", el.start - 1) + 1;
  const alone = text.slice(lineStart, el.start).trim() === "";
  const sep = alone ? `\n${indent}` : "";
  return { text: splice(text, el.end, el.end, `${sep}${copy}`), start: el.end + sep.length };
}

/**
 * Move the element starting at `at` to be the `index`th child element of the one starting at `parentAt` (null: the
 * template's top level), counting the children as they are now with it among them. Returns the new text and where it starts.
 */
export function moveElement(text: string, at: number, parentAt: number | null, index: number): { text: string; start: number } {
  const { source, el } = element(text, at);
  if (el.repeated) throw new SvelteEditError(el.repeated);
  const parent = parentAt === null ? null : elementStartingAt(source, parentAt);
  if (parentAt !== null && !parent) throw new SvelteEditError("the parent isn't where it was (the file changed)");
  if (parent && parent.start >= el.start && parent.end <= el.end) throw new SvelteEditError("an element can't go inside itself");
  const siblings = parent ? parent.children : source.top;
  const from = siblings.indexOf(el);
  const target = from >= 0 && from < index ? index - 1 : index;
  const markup = text.slice(el.start, el.end);
  const span = lineSpan(text, el);
  const removed = splice(text, span.start, span.end, "");
  const shift = span.end - span.start;
  const newParent = parentAt === null ? null : parentAt > el.start ? parentAt - shift : parentAt;
  return insertElement(removed, newParent, target, markup);
}

// --- The component's <style> ---------------------------------------------------------------------------

/**
 * Add or extend the rule `selector` in the component's `<style>` with `declarations` (existing properties in it get
 * the new value), making the `<style>` block at the end of the file when it has none.
 */
export function setRuleDeclarations(text: string, selector: string, declarations: readonly (readonly [string, string])[]): string {
  const source = parseSvelte(text);
  const body = declarations.map(([p, v]) => `${p}: ${v};`).join(" ");
  if (!source.style) {
    const sep = text.endsWith("\n") ? "" : "\n";
    return `${text}${sep}\n<style>\n  ${selector} { ${body} }\n</style>\n`;
  }
  const want = normalizeSelector(selector);
  const rule = source.style.rules.find((r) => normalizeSelector(r.selector) === want);
  if (!rule) {
    const first = source.style.rules[0];
    const indent = first ? indentAt(text, first.start) : "  ";
    let end = source.style.end;
    while (end > source.style.start && /\s/.test(text[end - 1])) end--;
    return splice(text, end, end, `\n${indent}${selector} { ${body} }`);
  }
  // Replace existing declarations in place (last first), then add the new ones after the last.
  let out = text;
  const added: (readonly [string, string])[] = [];
  const replaced: { start: number; end: number; text: string }[] = [];
  for (const [p, v] of declarations) {
    const d = rule.declarations.find((x) => x.property === p);
    if (d) replaced.push({ start: d.start, end: d.end, text: `${p}: ${v}` });
    else added.push([p, v]);
  }
  let tailAt: number, tail: string;
  if (rule.declarations.length > 0) {
    const last = rule.declarations[rule.declarations.length - 1];
    const after = text.slice(last.end, rule.blockEnd);
    const hasSemi = /^\s*;/.test(after);
    const semiAt = hasSemi ? last.end + after.indexOf(";") + 1 : last.end;
    const multiline = text.slice(rule.blockStart, rule.blockEnd).includes("\n");
    const indent = multiline ? indentAt(text, last.start) : "";
    tailAt = semiAt;
    tail = (hasSemi ? "" : ";") + added.map(([p, v]) => (multiline ? `\n${indent}${p}: ${v};` : ` ${p}: ${v};`)).join("");
  } else {
    tailAt = rule.blockStart;
    tail = added.map(([p, v]) => ` ${p}: ${v};`).join("") + (added.length ? " " : "");
  }
  if (added.length > 0) out = splice(out, tailAt, tailAt, tail);
  for (const r of replaced.sort((a, b) => b.start - a.start)) out = splice(out, r.start, r.end, r.text);
  return out;
}
