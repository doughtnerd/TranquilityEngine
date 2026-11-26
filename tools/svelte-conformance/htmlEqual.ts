// HTML comparison for the conformance harness, after Svelte's own `tests/html_equal.js` (which needs jsdom):
// both sides parsed with htmlparser2, attributes sorted, Svelte's scoping hash normalised, comments dropped,
// whitespace collapsed, whitespace-only text beside elements dropped and each element's text trimmed.
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { assert } from "vitest";

// Two serialisations that aren't behaviour: a class list is a set of tokens (the DOM's `classList` dedupes and moves
// tokens as Svelte's DOM path toggles them; a renderer gets the whole string each time), and an inline style is its
// declarations (the DOM's `style` serialises `color: red;`, a written attribute keeps its own spacing and case).
// An empty `class` or `style` is the same as none.
function classTokens(value: string): string {
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort().join(" ");
}

function declarations(value: string): string {
  const out = new Map<string, string>();
  for (const part of value.split(/;(?![^(]*\))/)) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const raw = part.slice(0, at).trim();
    const name = raw.startsWith("--") ? raw : raw.toLowerCase();
    if (name) out.set(name, part.slice(at + 1).trim());
  }
  return [...out].map(([n, v]) => `${n}: ${v};`).join(" ");
}

function clean(nodes: ChildNode[], preserveComments: boolean): string {
  const parts: { kind: "text" | "node"; text: string }[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      const text = (n as unknown as { data: string }).data.replace(/[^\S]+/g, " ");
      const last = parts.at(-1);
      if (last?.kind === "text") last.text = (last.text + text).replace(/[^\S]+/g, " ");
      else parts.push({ kind: "text", text });
    } else if (n.type === "comment") {
      if (preserveComments) parts.push({ kind: "node", text: `<!--${(n as unknown as { data: string }).data}-->` });
    } else if (n.type === "tag" || n.type === "script" || n.type === "style") {
      const el = n as Element;
      const attrs = Object.entries(el.attribs)
        .filter(([name, value]) => !(["onload", "onerror"].includes(name) && value === "this.__e=event") && name !== "xmlns")
        .map(([name, value]) => [name, name === "class" ? classTokens(value.replace(/svelte-\w+/, "svelte-xyz123")) : name === "style" ? declarations(value) : value] as const)
        .filter(([name, value]) => !((name === "class" || name === "style") && value === ""))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, value]) => ` ${name}="${value.replace(/"/g, "&quot;")}"`)
        .join("");
      parts.push({ kind: "node", text: `<${el.name}${attrs}>${clean(el.children, preserveComments)}</${el.name}>` });
    }
  }
  // Whitespace-only text beside an element or comment is layout, not content.
  const kept = parts.filter((p, i) => !(p.kind === "text" && !p.text.trim() && (parts[i - 1]?.kind === "node" || parts[i + 1]?.kind === "node")));
  if (kept[0]?.kind === "text") kept[0].text = kept[0].text.trimStart();
  const last = kept.at(-1);
  if (last?.kind === "text") last.text = last.text.trimEnd();
  return kept.map((p) => p.text).join("");
}

export function normalizeHtml(html: string, { preserveComments = false } = {}): string {
  return clean(parseDocument(html.trim(), { decodeEntities: true }).children, preserveComments);
}

export function assertHtmlEqual(actual: string, expected: string, message?: string): void {
  assert.deepEqual(normalizeHtml(actual), normalizeHtml(expected), message);
}

export function assertHtmlEqualWithOptions(actual: string, expected: string, opts: { preserveComments?: boolean; withoutNormalizeHtml?: boolean }, message?: string): void {
  if (opts.withoutNormalizeHtml) {
    const strip = (s: string) => s.trim().replace(/\r\n/g, "\n").replace(/(<!(--)?.*?\2>)/g, opts.preserveComments !== false ? "$1" : "");
    assert.deepEqual(strip(actual), strip(expected), message);
  } else assert.deepEqual(normalizeHtml(actual, opts), normalizeHtml(expected, opts), message);
}
