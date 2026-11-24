#!/usr/bin/env node
// Builds the GitHub wiki (ADR 0407): the user docs in docs/wiki/ plus a TypeDoc API reference of the `myco` module,
// as a flat folder of pages ready to replace the wiki repo's contents. CI (.github/workflows/wiki.yml) runs it on
// pull requests (to check) and on pushes to master (to publish); run it locally to preview.
//
//   npm run docs:wiki -- --out DIR      # the whole wiki into DIR (emptied first)
//   npm run docs:wiki -- --no-api       # skip TypeDoc (about two minutes) and only check the pages and links
//
// Exits 1 and lists every problem (a page without a heading, two pages with one name, a broken link or anchor).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WIKI_SOURCE, planWiki } from "./wiki-pages.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPO_URL = "https://github.com/doughtnerd/TranquilityEngine";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node tools/build-wiki.mjs [--out DIR] [--no-api]");
  process.exit(0);
}
const outArg = args.indexOf("--out");
const out = outArg >= 0 ? resolve(args[outArg + 1] ?? "") : null;
const withApi = !args.includes("--no-api");

/** Every file under a directory, as paths relative to `base` with forward slashes. */
function filesUnder(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? filesUnder(abs, base) : [relative(base, abs).split(sep).join("/")];
  });
}

const sources = new Map();
for (const file of filesUnder(join(root, WIKI_SOURCE))) {
  const path = `${WIKI_SOURCE}/${file}`;
  sources.set(path, file.endsWith(".md") ? readFileSync(join(root, path), "utf8") : "");
}

const api = new Map();
let apiDir = null;
if (withApi) {
  apiDir = mkdtempSync(join(tmpdir(), "myco-api-"));
  console.log("Generating the API reference with TypeDoc…");
  const typedoc = join(root, "node_modules", "typedoc", "bin", "typedoc");
  const run = spawnSync(process.execPath, [typedoc, "--options", join(root, "typedoc.json"), "--out", apiDir], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error("TypeDoc failed.");
    process.exit(1);
  }
  for (const file of filesUnder(apiDir)) if (file.endsWith(".md")) api.set(file, readFileSync(join(apiDir, file), "utf8"));
}

const exists = (path) => {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  return statSync(abs).isDirectory() ? "dir" : "file";
};

const { pages, copies, problems } = planWiki({ sources, api, apiOmitted: !withApi, repoUrl: REPO_URL, exists });
if (apiDir) rmSync(apiDir, { recursive: true, force: true });

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s); the wiki was not written.`);
  process.exit(1);
}

if (out) {
  // Empty the folder but keep a .git inside it, so CI can build straight into a clone of the wiki.
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out)) if (name !== ".git") rmSync(join(out, name), { recursive: true, force: true });
  for (const [file, text] of pages) writeFileSync(join(out, file), text);
  for (const [to, from] of copies) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(join(root, from), join(out, to));
  }
}
const apiCount = [...pages.keys()].filter((f) => f.startsWith("API-")).length;
console.log(`ok: ${pages.size} pages (${apiCount} API), ${copies.size} other files${out ? ` written to ${out}` : " checked"}.`);
