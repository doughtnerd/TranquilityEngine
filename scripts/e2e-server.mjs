// The e2e web server (playwright.config.ts): builds the editor (with the player and the samples)
// only when its inputs changed since the last build this script made, then serves dist/editor/.
// Rebuilding on every run cost about a minute even for one spec file.
//
// It serves the files as they are, with no compression: every test opens the editor in a fresh
// browser context (an empty HTTP cache), and `vite preview` gzipped its megabytes of scripts for
// each one, about a tenth of the suite's CPU time with software GL.
//
// The inputs are hashed from git: every tracked or untracked (not ignored) file under INPUTS, by
// content. The hash is written to dist/editor/.e2e-build after a successful build; any other build
// of dist/editor/ (`npm run build`) empties the folder and so removes it, forcing a rebuild here.
// E2E_REBUILD=1 rebuilds regardless.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const port = process.env.E2E_PORT ?? "4174";
const STAMP = "dist/editor/.e2e-build";
/** What the editor and player builds read. Tests, docs and native sources are left out. */
const INPUTS = ["src", "samples", "editor.html", "projects.html", "panel-window.html", "player.html", "index.html", "package-lock.json", "patches", "tsconfig.json", "vite.shared.ts", "vite.editor.config.ts", "vite.player.config.ts"];

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A hash of the inputs' contents: git's blob ids for clean tracked files, the file contents for changed and untracked ones. */
function inputsHash() {
  const h = createHash("sha256");
  h.update(git(["ls-files", "-s", "--", ...INPUTS])); // staged blob ids of tracked files
  const changed = git(["ls-files", "-m", "-o", "--exclude-standard", "--", ...INPUTS]).split("\n").filter(Boolean).sort();
  for (const file of changed) {
    h.update(`\0${file}\0`);
    if (existsSync(file)) h.update(readFileSync(file));
  }
  return h.digest("hex");
}

function run(command) {
  const r = spawnSync(command, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const hash = inputsHash();
const built = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
if (process.env.E2E_REBUILD || built !== hash) {
  console.error(built ? "e2e: sources changed, rebuilding the editor" : "e2e: no e2e build yet, building the editor");
  run("npm run build:editor");
  writeFileSync(STAMP, hash);
} else {
  console.error("e2e: editor build is up to date (E2E_REBUILD=1 rebuilds)");
}

const ROOT = resolve("dist/editor");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The file a request path names under ROOT (a folder's index.html), or null if there's none. */
function fileFor(urlPath) {
  let path;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(ROOT, path));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  try {
    const stat = statSync(full);
    if (stat.isFile()) return { full, stat };
    if (stat.isDirectory()) {
      const index = join(full, "index.html");
      const s = statSync(index);
      if (s.isFile()) return { full: index, stat: s };
    }
  } catch {}
  return null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = req.method === "GET" || req.method === "HEAD" ? fileFor(url.pathname) : null;
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const headers = { "Content-Type": TYPES[extname(file.full).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache", "Accept-Ranges": "bytes" };
  const size = file.stat.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
  }
  if (req.method === "HEAD" || size === 0) return void res.end();
  createReadStream(file.full, { start, end }).pipe(res);
});
server.on("error", (err) => {
  console.error(`e2e: can't serve on port ${port}: ${err.message}`);
  process.exit(1);
});
server.listen(Number(port), () => console.error(`e2e: serving dist/editor/ on http://localhost:${port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
