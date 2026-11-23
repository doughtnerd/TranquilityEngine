// Internal (ADR 0351 §2, §7): project-path globs as in `.gitignore`, for encoding rules and package `include` lists.
// A generic matcher; nothing here knows about audio. (Line comments: the patterns below would close a block comment.)
//
// - `*` matches anything but `/`; `?` one character but `/`; `[abc]`, `[a-z]` and `[!abc]` one character of a set.
// - `**` as a whole segment matches any number of segments: `a/**/b` matches `a/b` and `a/x/y/b`; `a/**` everything
//   under `a`; `**/b` a `b` at any depth.
// - A pattern without a `/` (other than a trailing one) matches the name at any depth (`*.wav`); one with a `/` is
//   anchored to the project root (a leading `/` is allowed and ignored).
// - A pattern that matches a folder matches everything under it (`audio/music` and `audio/music/` match
//   `audio/music/a.ogg`); a trailing `/` matches only what is under a folder.
// - `\` escapes the next character. Negation (`!`) isn't supported: rule lists are first-match-wins instead.

/** A compiled pattern. */
export interface PathGlob {
  readonly pattern: string;
  /** Whether `path` (a project path, `/`-separated) matches. */
  matches(path: string): boolean;
}

/** Whether `pattern` holds a wildcard (else it names one path or folder). */
export function hasWildcard(pattern: string): boolean {
  return /(^|[^\\])[*?[]/.test(pattern);
}

const escape = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** One segment (no `/`) as a regular expression source. */
function segmentSource(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\" && i + 1 < seg.length) out += escape(seg[++i]);
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) {
        out += "\\[";
        continue;
      }
      let body = seg.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^/" : ""}${body.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`;
      i = end;
    } else out += escape(c);
  }
  return out;
}

/** Compiles `pattern` (see the module header). */
export function compileGlob(pattern: string): PathGlob {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  const segs = p.split("/").filter((s) => s !== "");
  if (segs.length === 0) return { pattern, matches: () => false };
  let src = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      // At the end: everything under what precedes (one or more segments); elsewhere: zero or more whole segments.
      if (last) src += i === 0 ? ".+" : "/.+";
      else src += i === 0 ? "(?:[^/]+/)*" : "/(?:[^/]+/)*";
      return;
    }
    if (i > 0 && segs[i - 1] !== "**") src += "/";
    src += segmentSource(seg);
  });
  const head = anchored ? "^" : "^(?:[^/]+/)*";
  // A match may be a folder: everything under it matches too.
  const tail = dirOnly ? "/.+$" : "(?:/.+)?$";
  const re = new RegExp(`${head}${src}${tail}`);
  return { pattern, matches: (path) => re.test(path.replace(/^\/+/, "")) };
}

/** Whether `path` matches `pattern` (compiles each call; keep a `compileGlob` for many paths). */
export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).matches(path);
}
