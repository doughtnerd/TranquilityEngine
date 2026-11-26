/**
 * The inline HTML parser (ADR 0425): what `{@html}`, `innerHTML` and `bind:innerHTML` hand the engine's Svelte renderer,
 * as a small tokenizer rather than a full HTML parser (`htmlparser2`). Compiled components import it (`myco/ui-html`)
 * only when they use `{@html}` or `bind:innerHTML` (`compileSvelteUI` adds the import), so other games never load it.
 *
 * - Elements with their attributes and text, entities decoded (the named ones UI text uses, and numeric ones). Tag
 *   names are lowercased (outside `<svg>`, whose `linearGradient` and `foreignObject` keep their case); attribute names
 *   stay as written. The renderer maps each tag as it does a template's: phrasing elements inside a text element are its
 *   inline runs, block elements are panels.
 * - Comments, as comment nodes (the DOM's `innerHTML` keeps them; Svelte's `createRawSnippet` checks its HTML is one
 *   element by them).
 * - **Dropped:** `<script>`, `<style>` and the other elements that run code or embed documents (with their content),
 *   doctypes, CDATA; every event handler attribute (`on…`), `srcdoc`, and URL attributes that hold a
 *   `javascript:`, `vbscript:` or (but on an image's `src`) `data:` URL.
 * - Void elements (`br`, `img`, `hr`, `input`…) take no children; a close tag closes the open element it names (and
 *   the ones inside it), one that names nothing open is ignored; opening a block element closes an open `p`, as
 *   HTML does, and a list item, a definition term or description, or an option closes the one before it.
 *
 * Pure: no DOM, nothing from the engine.
 */

/** An element (its tag, attributes in order and children), a run of text, or a comment (its text). */
export type InlineHtmlNode =
  | { readonly kind: "element"; readonly tag: string; readonly attributes: readonly (readonly [string, string])[]; readonly children: readonly InlineHtmlNode[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "comment"; readonly text: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen"]);
/** Elements dropped with everything inside them: they run code, style the page or embed another document. */
const DROPPED = new Set(["script", "style", "iframe", "object", "embed", "frame", "frameset", "noscript", "noembed", "noframes", "template", "head", "title", "meta", "link", "base", "applet", "xmp", "plaintext"]);
/** Elements whose content is raw text up to their close tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
/** Elements whose opening closes an open `p`. */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
/** Elements that close an open one of the same group (a list item closes the list item before it). */
const SIBLING_GROUPS: Readonly<Record<string, readonly string[]>> = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], option: ["option"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"] };
/** Attributes holding a URL. */
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "background", "cite", "longdesc", "data"]);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", deg: "°", times: "×", divide: "÷", middot: "·", bull: "•",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", shy: "­", iexcl: "¡", iquest: "¿", plusmn: "±", micro: "µ",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", star: "☆",
  thinsp: " ", ensp: " ", emsp: " ", zwj: "‍", zwnj: "‌", lrm: "‎", rlm: "‏",
};

/** Text with its character references decoded (`&amp;`, `&#233;`, `&#xE9;`; an unknown one stays as written). */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (all, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : all;
  });
}

/** True for an attribute dropped for safety: an event handler, `srcdoc`, or a URL that would run script or embed data. */
function unsafeAttribute(tag: string, name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on") || n === "srcdoc") return true;
  if (!URL_ATTRIBUTES.has(n)) return false;
  const v = value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return true;
  return v.startsWith("data:") && !(tag === "img" && n === "src" && v.startsWith("data:image/"));
}

interface Open {
  readonly tag: string;
  readonly attributes: (readonly [string, string])[];
  readonly children: InlineHtmlNode[];
  readonly svg: boolean;
}

/** Parse an HTML string into nodes. Never throws: what can't be read is text, or left out. */
export function parseInlineHtml(html: string): InlineHtmlNode[] {
  const root: Open = { tag: "#root", attributes: [], children: [], svg: false };
  const stack: Open[] = [root];
  const top = () => stack[stack.length - 1];
  const text = (t: string) => {
    if (!t) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (last?.kind === "text") kids[kids.length - 1] = { kind: "text", text: last.text + t };
    else kids.push({ kind: "text", text: t });
  };
  const close = (index: number) => {
    while (stack.length > index) {
      const el = stack.pop()!;
      top().children.push({ kind: "element", tag: el.tag, attributes: el.attributes, children: el.children });
    }
  };
  const openIndex = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) return i;
    return -1;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(html.slice(i, lt)));
    i = lt;
    // A comment, kept; doctypes, CDATA and processing instructions: dropped.
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      top().children.push({ kind: "comment", text: html.slice(i + 4, end < 0 ? n : end) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // A close tag.
    const closing = /^<\/([a-zA-Z][^\s/>]*)\s*>/.exec(html.slice(i, i + 256));
    if (closing) {
      const tag = top().svg ? closing[1] : closing[1].toLowerCase();
      const at = openIndex(tag);
      if (at > 0) close(at);
      i += closing[0].length;
      continue;
    }
    // An open tag: its name, then attributes up to `>`.
    const name = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 256));
    if (!name) {
      text("<");
      i++;
      continue;
    }
    const inSvg = top().svg || name[1].toLowerCase() === "svg";
    const tag = inSvg && name[1].toLowerCase() !== "svg" ? name[1] : name[1].toLowerCase();
    i += name[0].length;
    const attributes: (readonly [string, string])[] = [];
    let selfClosing = false;
    while (i < n) {
      while (i < n && /\s/.test(html[i])) i++;
      if (html[i] === ">") {
        i++;
        break;
      }
      if (html.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (html[i] === "/") {
        i++;
        continue;
      }
      const attr = /^([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/.exec(html.slice(i));
      if (!attr) {
        i++;
        continue;
      }
      i += attr[0].length;
      const key = attr[1];
      const value = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
      if (attributes.some(([k]) => k === key) || unsafeAttribute(tag, key, value)) continue;
      attributes.push([key, value]);
    }
    const lower = tag.toLowerCase();
    // Raw text: up to the close tag (kept as text in a <textarea>, dropped with the element otherwise).
    if (RAW.has(lower) && !selfClosing) {
      const end = html.toLowerCase().indexOf(`</${lower}`, i);
      const content = html.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : html.indexOf(">", end) + 1 || n;
      if (!DROPPED.has(lower)) top().children.push({ kind: "element", tag, attributes, children: content ? [{ kind: "text", text: decodeEntities(content) }] : [] });
      continue;
    }
    if (DROPPED.has(lower)) continue;
    if (!top().svg) {
      if (CLOSES_P.has(lower)) {
        const p = openIndex("p");
        if (p > 0) close(p);
      }
      const group = SIBLING_GROUPS[lower];
      if (group) {
        const t = top().tag;
        if (group.includes(t)) close(stack.length - 1);
      }
    }
    if (VOID.has(lower) || (selfClosing && inSvg)) {
      top().children.push({ kind: "element", tag, attributes, children: [] });
      continue;
    }
    stack.push({ tag, attributes, children: [], svg: inSvg });
  }
  close(1);
  return root.children;
}
