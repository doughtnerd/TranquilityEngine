// The e2e web server (playwright.config.ts): builds the editor (with the player and the samples)
// only when its inputs changed since the last build this script made, then serves dist/editor/
// with `vite preview`. Rebuilding on every run cost about a minute even for one spec file.
//
// The inputs are hashed from git: every tracked or untracked (not ignored) file under INPUTS, by
// content. The hash is written to dist/editor/.e2e-build after a successful build; any other build
// of dist/editor/ (`npm run build`) empties the folder and so removes it, forcing a rebuild here.
// E2E_REBUILD=1 rebuilds regardless.
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const port = process.env.E2E_PORT ?? "4174";
const STAMP = "dist/editor/.e2e-build";
/** What the editor and player builds read. Tests, docs and native sources are left out. */
const INPUTS = ["src", "samples", "editor.html", "projects.html", "player.html", "index.html", "package-lock.json", "patches", "tsconfig.json", "vite.shared.ts", "vite.editor.config.ts", "vite.player.config.ts"];

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

const server = spawn(`npx vite preview --config vite.editor.config.ts --port ${port} --strictPort`, { stdio: "inherit", shell: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
