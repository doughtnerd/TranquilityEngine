// Writing scene files (ADR 0013, 0026) so saves from the editor produce small diffs. Nodes that
// didn't change keep their original text exactly (`OriginalLayout`); other values are formatted
// Prettier-style: anything that fits on a line stays inline (`{ "a": 1 }`, `[0, 1, 0]`), longer
// values break one entry per line, and the top-level `nodes` list has one node per entry. Blank
// lines that grouped nodes in the original file are kept.

/** Line width before a value breaks across lines (the demo's files stay within it). */
export const LINE_WIDTH = 112;

export interface FormatOptions {
  width?: number;
  /** Node ids that had a blank line before them in the original file (see `blankLinesBefore`). */
  blankBefore?: ReadonlySet<string>;
  /** Original text of top-level nodes by id; a node whose data is unchanged is written as it was. */
  original?: ReadonlyMap<string, string>;
}

/** What `formatSceneJSON` needs from a file's original text to keep its layout. */
export interface OriginalLayout {
  blankBefore: Set<string>;
  original: Map<string, string>;
}

export function originalLayout(text: string): OriginalLayout {
  return { blankBefore: blankLinesBefore(text), original: nodeTexts(text) };
}

/**
 * The source text of each element of the root object's `nodes` array, by node id. A small
 * scanner (strings and nesting only); returns an empty map for anything it doesn't understand.
 */
export function nodeTexts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0, i = 0, inNodes = false, start = -1, lastKey = "";
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) lastKey = text.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (depth === 2 && c === "[" && lastKey === "nodes") inNodes = true;
      else if (depth === 3 && inNodes && c === "{") start = i;
    } else if (c === "}" || c === "]") {
      if (depth === 3 && inNodes && c === "}" && start >= 0) {
        const slice = text.slice(start, i + 1);
        try {
          const id = (JSON.parse(slice) as { id?: unknown }).id;
          if (typeof id === "string") out.set(id, slice);
        } catch {
          // not a plain node object; it will be formatted
        }
        start = -1;
      }
      if (depth === 2 && inNodes) inNodes = false;
      depth--;
    }
    i++;
  }
  return out;
}

/** Ids of top-level nodes preceded by a blank line in `text`, so a re-save can keep the grouping. */
export function blankLinesBefore(text: string): Set<string> {
  const out = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].trim() !== "") continue;
    // A node starts on this line ({ "id": … inline) or the next line ({ then "id": …).
    const here = /^\s*\{\s*"id":\s*"([^"]+)"/.exec(lines[i]);
    const next = /^\s*\{\s*$/.test(lines[i]) ? /^\s*"id":\s*"([^"]+)"/.exec(lines[i + 1] ?? "") : null;
    const id = here?.[1] ?? next?.[1];
    if (id) out.add(id);
  }
  return out;
}

/** Format a scene file. Ends with a newline. */
export function formatSceneJSON(file: unknown, options: FormatOptions = {}): string {
  const width = options.width ?? LINE_WIDTH;
  const blank = options.blankBefore ?? new Set<string>();
  const original = options.original ?? new Map<string, string>();

  /** The node's original text, re-indented, if its data didn't change. */
  function unchanged(node: unknown, indent: number): string | null {
    const id = node && typeof node === "object" ? (node as { id?: unknown }).id : undefined;
    const text = typeof id === "string" ? original.get(id) : undefined;
    if (text === undefined || JSON.stringify(JSON.parse(text)) !== JSON.stringify(node)) return null;
    // Re-indent continuation lines if the node moved to a different depth (the closing brace's
    // indent tells the original depth).
    const lines = text.split(/\r?\n/);
    const old = lines.length > 1 ? /^\s*/.exec(lines[lines.length - 1])![0].length : indent;
    const shift = indent - old;
    if (shift === 0) return lines.join("\n");
    return lines
      .map((l, k) => (k === 0 ? l : shift > 0 ? " ".repeat(shift) + l : l.slice(Math.min(-shift, /^\s*/.exec(l)![0].length))))
      .join("\n");
  }

  function inline(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : "{}";
    }
    return JSON.stringify(v) ?? "null";
  }

  /** `v` at `indent`, where `used` columns of its line are already taken (indent + key) and `tail` follows it. */
  function format(v: unknown, indent: number, used: number, tail: number, forceBreak = false, isNodes = false): string {
    const flat = inline(v);
    const breakable = v !== null && typeof v === "object" && flat !== "{}" && flat !== "[]";
    if (!breakable || (!forceBreak && used + flat.length + tail <= width)) return flat;
    const pad = " ".repeat(indent + 2);
    const close = " ".repeat(indent);
    if (Array.isArray(v)) {
      const items = v.map((x, i) => {
        const id = isNodes && x && typeof x === "object" ? (x as { id?: unknown }).id : undefined;
        const gap = i > 0 && typeof id === "string" && blank.has(id) ? "\n" : "";
        const kept = isNodes ? unchanged(x, indent + 2) : null;
        return gap + pad + (kept ?? format(x, indent + 2, indent + 2, i < v.length - 1 ? 1 : 0));
      });
      return `[\n${items.join(",\n")}\n${close}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    const lines = entries.map(([k, x], i) => {
      const key = `${JSON.stringify(k)}: `;
      const last = i === entries.length - 1;
      const nodes = indent === 0 && k === "nodes";
      return pad + key + format(x, indent + 2, indent + 2 + key.length, last ? 0 : 1, nodes, nodes);
    });
    return `{\n${lines.join(",\n")}\n${close}}`;
  }

  return format(file, 0, 0, 0, true) + "\n";
}
