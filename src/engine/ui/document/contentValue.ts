/**
 * The `content` property of `::before` and `::after` (ADR 0432), read from CSS text into pieces the UI host joins into the
 * generated element's text: strings and `attr(name)` (the originating element's attribute, "" when it has none).
 * `none` and `normal` generate nothing. Counters, quotes and images (`counter()`, `open-quote`, `url()`) are out of scope
 * and refused. Pure: a value that can't be read comes back as a message saying why.
 */

/** One piece of a `content` value: literal text, or an attribute of the originating element to read. */
export type UIContentPiece = string | { readonly attr: string };

/** `content`: its pieces (an empty list for `""`), null for `none`/`normal`, or a problem. */
export type UIContentParse = { readonly ok: true; readonly value: readonly UIContentPiece[] | null } | { readonly ok: false; readonly problem: string };

/** A CSS string's text with its escapes undone (`\"`, `\\`, `\A` a line break, hex code points), from after its opening quote. */
function readString(v: string, start: number, quote: string): { text: string; end: number } | null {
  let out = "";
  for (let i = start; i < v.length; i++) {
    const ch = v[i];
    if (ch === quote) return { text: out, end: i + 1 };
    if (ch === "\n") return null;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6} ?/.exec(v.slice(i + 1));
    if (hex) {
      const code = parseInt(hex[0], 16);
      out += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
      i += hex[0].length;
    } else if (i + 1 < v.length) {
      if (v[i + 1] !== "\n") out += v[i + 1]; // an escaped line break continues the string
      i++;
    }
  }
  return null;
}

/** Read a `content` value. */
export function parseContent(raw: string): UIContentParse {
  const v = raw.trim();
  const word = v.toLowerCase();
  if (word === "none" || word === "normal") return { ok: true, value: null };
  const pieces: UIContentPiece[] = [];
  let i = 0;
  while (i < v.length) {
    const ch = v[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const s = readString(v, i + 1, ch);
      if (!s) return { ok: false, problem: "has a string that isn't closed." };
      pieces.push(s.text);
      i = s.end;
      continue;
    }
    const fn = /^attr\(\s*([A-Za-z_][\w-]*)\s*\)/i.exec(v.slice(i));
    if (fn) {
      pieces.push({ attr: fn[1].toLowerCase() });
      i += fn[0].length;
      continue;
    }
    const other = /^[\w-]+\(?/.exec(v.slice(i))?.[0] ?? v.slice(i);
    return { ok: false, problem: `isn't supported in content: UI content takes strings and attr(name) (counters, quotes and images are out of scope; "${other}" was found).` };
  }
  if (!pieces.length) return { ok: false, problem: "is empty; content takes strings, attr(name), none or normal." };
  return { ok: true, value: pieces };
}

/** The text pieces make, reading `attr()` from `attribute` (a missing attribute is ""). */
export function contentText(pieces: readonly UIContentPiece[], attribute: (name: string) => string | undefined): string {
  let out = "";
  for (const p of pieces) out += typeof p === "string" ? p : (attribute(p.attr) ?? "");
  return out;
}
