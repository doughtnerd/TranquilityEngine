// Editing UI stylesheets (`*.ui.css`, ADR 0077 §4) as text: add, change or remove a declaration in a
// rule, or add a rule at the end. Only the text an edit changes is replaced, so comments and
// formatting elsewhere stay. Pure; each call re-parses (with the runtime's own parser) rather than
// tracking shifted spans.
import { parseStylesheet } from "../../engine/ui/document/stylesheet";
import type { Declaration, StyleRule } from "../../engine/ui/document/types";

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);

const normalize = (selector: string) => selector.trim().replace(/\s+/g, " ").replace(/\s*([>,])\s*/g, "$1");

/** The rules of a sheet, with spans into `text`. */
export function rulesOf(text: string): readonly StyleRule[] {
  return parseStylesheet(text, "edit.ui.css").rules;
}

/** The last rule whose selector is exactly `selector` (whitespace aside), or null. */
export function findRule(text: string, selector: string): StyleRule | null {
  const want = normalize(selector);
  const rules = rulesOf(text).filter((r) => normalize(r.selectorText) === want);
  return rules[rules.length - 1] ?? null;
}

/** A declaration's span without trailing whitespace (css-tree includes it for the last one in a block). */
function declarationEnd(text: string, d: Declaration): number {
  let end = d.span.end;
  while (end > d.span.start && /\s/.test(text[end - 1])) end--;
  return end;
}

/** Where the rule's block opens and closes: the offsets of `{` and `}`. */
function blockOf(text: string, rule: StyleRule): { open: number; close: number } {
  const open = text.indexOf("{", rule.span.start);
  let close = rule.span.end - 1;
  while (close > open && text[close] !== "}") close--;
  return { open, close };
}

/** One indentation level in the sheet (from the first indented declaration), else two spaces. */
function indentOf(text: string): string {
  const m = /\{[^}\n]*\n([ \t]+)\S/.exec(text);
  return m ? m[1] : "  ";
}

/**
 * Set `property: value` in the rule for `selector`: its last declaration of that property changes
 * value in place; otherwise one is added after the rule's last declaration, on its own line in a
 * multi-line rule or inline in a one-line rule. Without such a rule, one is added at the end.
 */
export function setDeclaration(text: string, selector: string, property: string, value: string): string {
  const rule = findRule(text, selector);
  if (!rule) return addRule(text, selector, [[property, value]]);
  const existing = [...rule.declarations].reverse().find((d) => d.property === property);
  if (existing) {
    const colon = text.indexOf(":", existing.span.start);
    let start = colon + 1;
    while (start < text.length && (text[start] === " " || text[start] === "\t")) start++;
    return splice(text, start, declarationEnd(text, existing), value);
  }
  const { open, close } = blockOf(text, rule);
  const decl = `${property}: ${value};`;
  const last = rule.declarations[rule.declarations.length - 1];
  const body = text.slice(open + 1, close);
  const multiline = body.includes("\n");
  if (!last) {
    if (multiline) {
      const outer = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", rule.span.start - 1) + 1))![0];
      const inner = outer + indentOf(text);
      return splice(text, open + 1, close, `${body.trimEnd()}\n${inner}${decl}\n${outer}`);
    }
    return splice(text, open + 1, close, ` ${decl} `);
  }
  let end = declarationEnd(text, last);
  let insert = "";
  // The last declaration may omit its semicolon: add one.
  let after = end;
  while (after < close && /[ \t]/.test(text[after])) after++;
  if (text[after] === ";") end = after + 1;
  else insert = ";";
  if (multiline) {
    const lineStart = text.lastIndexOf("\n", last.span.start - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
    insert += `\n${indent}${decl}`;
  } else insert += ` ${decl}`;
  return splice(text, end, end, insert);
}

/** Remove every declaration of `property` in the rule for `selector` (its line when alone on it). No change without one. */
export function removeDeclaration(text: string, selector: string, property: string): string {
  for (;;) {
    const rule = findRule(text, selector);
    const d = rule && [...rule.declarations].reverse().find((x) => x.property === property);
    if (!rule || !d) return text;
    const { close } = blockOf(text, rule);
    let start = d.span.start, end = declarationEnd(text, d);
    let after = end;
    while (after < close && /[ \t]/.test(text[after])) after++;
    if (text[after] === ";") end = after + 1;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let e = end;
    while (e < text.length && /[ \t]/.test(text[e])) e++;
    const firstOnLine = /^[ \t]*$/.test(text.slice(lineStart, start));
    if (firstOnLine && text[e] === "\n") {
      start = lineStart;
      end = e + 1;
    } else if (firstOnLine) {
      end = e; // something follows on the line (a comment): keep the indent, drop the space after
    } else {
      while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
    }
    text = splice(text, start, end, "");
  }
}

/** Add `selector { … }` at the end of the sheet, one declaration per line, after a blank line. */
export function addRule(text: string, selector: string, declarations: readonly (readonly [string, string])[]): string {
  const indent = indentOf(text);
  const body = declarations.map(([p, v]) => `${indent}${p}: ${v};\n`).join("");
  const rule = `${selector} {\n${body}}\n`;
  if (text.trim() === "") return text + rule;
  return text + (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") + rule;
}

/** Set several declarations in one rule (made if missing), in order. */
export function setDeclarations(text: string, selector: string, declarations: readonly (readonly [string, string])[]): string {
  if (!findRule(text, selector)) return addRule(text, selector, declarations);
  for (const [p, v] of declarations) text = setDeclaration(text, selector, p, v);
  return text;
}
