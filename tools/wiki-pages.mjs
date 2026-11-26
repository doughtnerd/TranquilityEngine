// Turns the repo's user docs (docs/wiki/) and TypeDoc's Markdown output into a flat GitHub wiki (ADR 0407).
// Pure: it reads nothing from disk. tools/build-wiki.mjs gathers the files and writes the result.
//
// A GitHub wiki ignores folders when it resolves links and names a page after its file, so every page is written
// to the wiki's root under a unique name: guide pages take the name of their first `# ` heading, API pages are
// `API-<Kind>-<Name>`, and links are rewritten to those names. Links that leave docs/wiki/ become GitHub URLs.
import { posix } from "node:path";

const { dirname, join, normalize, relative } = posix;

/** The source folder, relative to the repo root. */
export const WIKI_SOURCE = "docs/wiki";

/** Pages GitHub gives special meaning: they keep their file names. */
const SPECIAL = new Set(["Home", "_Sidebar", "_Footer"]);

/** TypeDoc's output folders and the kind each one names in an API page name. */
const API_KINDS = {
  classes: "Class",
  interfaces: "Interface",
  functions: "Function",
  "type-aliases": "Type",
  variables: "Variable",
  enumerations: "Enum",
  enums: "Enum",
  namespaces: "Namespace",
  modules: "Module",
};

/** The wiki page that indexes the API reference. */
export const API_INDEX = "API-Reference";

/**
 * A source page's wiki name: Home, _Sidebar and _Footer keep their file names; any other page is named after its
 * first `# ` heading, without inline-code ticks, a trailing "(ADR …)" note, or characters that break a wiki page
 * name or a Markdown link to it (dots become spaces, so `Bus.loudness` isn't read as an extension). Null when a
 * page has no heading.
 */
export function pageName(file, markdown) {
  const base = file.split("/").pop().replace(/\.md$/, "");
  if (SPECIAL.has(base)) return base;
  const heading = firstHeading(markdown);
  if (heading === null) return null;
  return heading
    .replace(/`/g, "")
    .replace(/\s*\((?:[^()]*\b)?ADRs?\b[^()]*\)\s*$/i, "")
    .replace(/[?:/\\#%"<>|*[\](),]/g, "")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The wiki file name and link target for a page name: spaces become hyphens, as the wiki does. */
export function pageSlug(name) {
  return name.replace(/ /g, "-");
}

/** An API page's wiki name from its path in TypeDoc's output (`classes/Animator.md` → `API-Class-Animator`). */
export function apiPageName(file) {
  if (file === "README.md") return API_INDEX;
  const [folder, ...rest] = file.replace(/\.md$/, "").split("/");
  const kind = API_KINDS[folder];
  if (!kind || rest.length === 0) return `API-${file.replace(/\.md$/, "").replace(/\//g, "-")}`;
  return `API-${kind}-${rest.join("-")}`;
}

/** The text of a Markdown file's first `# ` heading outside code fences, or null. */
export function firstHeading(markdown) {
  for (const { text } of proseLines(markdown)) {
    const m = text.match(/^ {0,3}#\s+(.*?)\s*#*\s*$/);
    if (m) return m[1];
  }
  return null;
}

/** A heading's anchor by GitHub's rules: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every heading anchor in a Markdown file; a repeated heading gets -1, -2… as on GitHub. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const { text } of proseLines(markdown)) {
    const m = text.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = slug(m[1].replace(/`/g, ""));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Lines outside fenced code blocks, with their index. */
function* proseLines(markdown) {
  let fence = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null) yield { text: lines[i], index: i };
  }
}

/**
 * Rewrites the targets of inline links `[text](target)` and reference definitions `[id]: target`, outside code
 * fences and inline code. `map(target, line)` returns the new target (or the same one).
 */
export function rewriteLinks(markdown, map) {
  const lines = markdown.split(/\r?\n/);
  for (const { text, index } of proseLines(markdown)) {
    const def = text.match(/^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/);
    if (def) {
      lines[index] = def[1] + map(def[2], index + 1) + def[3];
      continue;
    }
    // Split off inline code spans so links inside them are left alone.
    lines[index] = text
      .split(/(`+[^`]*?`+)/)
      .map((part, i) =>
        i % 2 === 1
          ? part
          : part.replace(/(\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g, (_, open, target, close) => open + map(target, index + 1) + close),
      )
      .join("");
  }
  return lines.join("\n");
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Plans the whole wiki.
 *
 * - `sources`: Map of repo-relative path (`docs/wiki/guide/physics.md`) → Markdown, every file under docs/wiki/.
 *   Non-Markdown files there (images) are copied and linked by their raw wiki URL.
 * - `api`: Map of path in TypeDoc's output (`classes/Animator.md`) → Markdown.
 * - `apiOmitted`: the API wasn't generated (a quick preview), so links to `API-…` pages aren't checked.
 * - `repoUrl`: `https://github.com/owner/repo`, for links that leave docs/wiki/.
 * - `exists(path)`: `"file"`, `"dir"` or null for a repo-relative path outside docs/wiki/.
 *
 * Returns `{ pages: Map<wiki file, Markdown>, copies: Map<wiki file, repo path>, problems: string[] }`. The build
 * should fail when `problems` isn't empty: a page without a heading, two pages with one name, or a broken link.
 */
export function planWiki({ sources, api = new Map(), apiOmitted = false, repoUrl, exists }) {
  const problems = [];
  const pages = new Map();
  const copies = new Map();
  const wikiRaw = repoUrl.replace("https://github.com/", "https://raw.githubusercontent.com/wiki/");

  // Name every page first, so links can point at any of them.
  const nameOf = new Map(); // repo path → page slug
  const anchorsOf = new Map(); // page slug → anchors
  const owner = new Map(); // page slug → the file that claimed it
  const claim = (slugName, file) => {
    const key = slugName.toLowerCase();
    if (owner.has(key)) problems.push(`${file}: wiki page name "${slugName}" is also used by ${owner.get(key)}`);
    else owner.set(key, file);
  };
  for (const [file, text] of sources) {
    if (!file.endsWith(".md")) continue;
    const name = pageName(file, text);
    if (name === null) {
      problems.push(`${file}: no "# " heading to name the page after`);
      continue;
    }
    const s = pageSlug(name);
    claim(s, file);
    nameOf.set(file, s);
    anchorsOf.set(s, headingAnchors(text));
  }
  const apiNames = new Map();
  for (const file of api.keys()) {
    const s = apiPageName(file);
    claim(s, `API ${file}`);
    apiNames.set(file, s);
  }
  const generated = new Set(apiNames.values());
  const pageSlugs = new Set(nameOf.values());

  for (const [file, text] of sources) {
    if (!file.endsWith(".md")) {
      copies.set(relative(WIKI_SOURCE, file), file);
      continue;
    }
    const self = nameOf.get(file);
    if (!self) continue;
    const rewritten = rewriteLinks(text, (target, line) => {
      if (EXTERNAL.test(target)) return target;
      const where = `${file}:${line}: ${target}`;
      const [pathPart, anchor] = splitAnchor(target);
      if (pathPart === "") {
        if (anchor && !anchorsOf.get(self).has(anchor.toLowerCase())) problems.push(`${where} (no heading "#${anchor}" on this page)`);
        return target;
      }
      // A bare wiki page name (`API-Reference`, `Home`) is already a wiki link.
      if (!/[/.]/.test(pathPart) && (generated.has(pathPart) || pageSlugs.has(pathPart) || (apiOmitted && pathPart.startsWith("API-")))) return target;
      const path = normalize(join(dirname(file), decodeURIComponent(pathPart)));
      if (path === WIKI_SOURCE || path.startsWith(`${WIKI_SOURCE}/`)) {
        if (sources.has(path)) {
          if (!path.endsWith(".md")) return `${wikiRaw}/${relative(WIKI_SOURCE, path)}`;
          const to = nameOf.get(path);
          if (!to) return target; // already reported: no heading
          if (anchor && !anchorsOf.get(to).has(anchor.toLowerCase())) problems.push(`${where} (no heading "#${anchor}" in ${path})`);
          return anchor ? `${to}#${anchor}` : to;
        }
        problems.push(`${where} (no such file)`);
        return target;
      }
      if (path.startsWith("../") || path === "..") {
        problems.push(`${where} (outside the repository)`);
        return target;
      }
      const kind = exists(path);
      if (!kind) {
        problems.push(`${where} (no such file)`);
        return target;
      }
      return `${repoUrl}/${kind === "dir" ? "tree" : "blob"}/master/${encodeURI(path)}${anchor ? `#${anchor}` : ""}`;
    });
    const special = SPECIAL.has(self) && self !== "Home";
    const footer = special ? "" : `\n\n---\n\n[Source of this page](${repoUrl}/blob/master/${encodeURI(file)})\n`;
    pages.set(`${self}.md`, rewritten.replace(/\s*$/, "") + footer);
  }

  for (const [file, text] of api) {
    const self = apiNames.get(file);
    let body = rewriteLinks(text, (target, line) => {
      if (EXTERNAL.test(target)) return target;
      const [pathPart, anchor] = splitAnchor(target);
      if (pathPart === "") return target;
      const path = normalize(join(dirname(file), decodeURIComponent(pathPart)));
      const to = apiNames.get(path);
      if (!to) {
        problems.push(`API ${file}:${line}: ${target} (no such API page)`);
        return target;
      }
      return anchor ? `${to}#${anchor}` : to;
    });
    if (self === API_INDEX) {
      body = body.replace(
        /^# .*$/m,
        "# API reference\n\nEvery class, function, type and value the `myco` module exports (`import { … } from \"myco\"`), generated from the source on each push to `master`. The [guides](Home) explain how the pieces fit together.",
      );
    }
    pages.set(`${self}.md`, body);
  }

  return { pages, copies, problems };
}

function splitAnchor(target) {
  const i = target.indexOf("#");
  return i < 0 ? [target, undefined] : [target.slice(0, i), target.slice(i + 1) || undefined];
}
