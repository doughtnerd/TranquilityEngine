#!/usr/bin/env node
// Checks the relative links and anchors in Markdown files (no dependencies).
//
//   node tools/check-doc-links.mjs                 # the audio docs (the default set below)
//   node tools/check-doc-links.mjs docs README.md  # any files, or directories searched for *.md
//
// A link `[text](target)` or `<target>` that is not http(s), mailto or a bare `#` is checked: the file (or directory)
// must exist relative to the Markdown file, and `#anchor` must match a heading of the target Markdown file by
// GitHub's slug rules (lower case, punctuation dropped, spaces to hyphens, repeated headings get -1, -2). Code
// fences and inline code are skipped. Exit code 1 lists every broken link as `file:line: target (reason)`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The audio documentation: the guide's audio pages, the 0157 design docs, the core's own notes. */
const DEFAULTS = [
  "docs/guide/playing-sound.md",
  "docs/guide/why-no-sound.md",
  "docs/guide/atmosphere-and-sound.md",
  "docs/guide/audio-mixer.md",
  "docs/guide/sound-events.md",
  "docs/guide/spatial-audio.md",
  "docs/guide/interactive-music.md",
  "docs/guide/audio-minimum-versions.md",
  "docs/design/0157-audio-core",
  "native/audio/README.md",
  "native/audio/PORTS.md",
  "native/audio/third_party/blink/PROVENANCE.md",
  "docs/README.md",
];

function markdownFiles(path) {
  const abs = resolve(root, path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return abs.endsWith(".md") ? [abs] : [];
  return readdirSync(abs).flatMap((name) => (name === "node_modules" || name === "target" ? [] : markdownFiles(join(abs, name))));
}

/** GitHub's heading slug. */
function slug(heading) {
  return heading
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  let set = anchorCache.get(file);
  if (set) return set;
  set = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  anchorCache.set(file, set);
  return set;
}

/** The link targets on one line, with inline code removed. */
function targetsOf(line) {
  const text = line.replace(/`[^`]*`/g, "");
  const out = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) out.push(m[1]);
  return out;
}

const args = process.argv.slice(2);
const files = [...new Set((args.length ? args : DEFAULTS).flatMap(markdownFiles))].sort();
const problems = [];
let checked = 0;

for (const file of files) {
  let fenced = false;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return;
      for (const target of targetsOf(line)) {
        if (/^(https?:|mailto:|data:)/i.test(target)) continue;
        checked++;
        const [pathPart, anchor] = target.split("#");
        const where = `${relative(root, file)}:${i + 1}: ${target}`;
        const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
        if (!existsSync(dest)) {
          problems.push(`${where} (no such file)`);
          continue;
        }
        if (anchor === undefined || anchor === "") continue;
        if (statSync(dest).isDirectory() || !dest.endsWith(".md")) continue; // anchors in non-Markdown targets aren't checked
        if (!anchorsOf(dest).has(decodeURIComponent(anchor).toLowerCase())) problems.push(`${where} (no heading "#${anchor}" in ${relative(root, dest)})`);
      }
    });
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken link(s) of ${checked} checked in ${files.length} file(s).`);
  process.exit(1);
}
console.log(`ok: ${checked} relative links in ${files.length} file(s) resolve.`);
