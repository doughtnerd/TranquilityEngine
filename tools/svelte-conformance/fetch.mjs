// Fetches Svelte's own runtime test fixtures at the pinned version (ADR 0419) for the conformance harness
// (`npm run test:svelte-conformance`): a sparse, shallow checkout of the svelte repository's tag into
// node_modules/.cache/svelte-conformance/<version>/, kept between runs. The fixtures aren't in the npm package.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(readFileSync(join(root, "node_modules/svelte/package.json"), "utf8")).version;
const dir = join(process.env.SVELTE_CONFORMANCE_CACHE ?? join(root, "node_modules/.cache/svelte-conformance"), version);
const marker = join(dir, "packages/svelte/tests/runtime-runes/samples");

if (existsSync(marker)) {
  console.log(`Svelte ${version} fixtures: ${dir}`);
} else {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "inherit" });
  if (!existsSync(join(dir, ".git"))) {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/sveltejs/svelte.git");
  }
  git("sparse-checkout", "set", "packages/svelte/tests/runtime-runes", "packages/svelte/tests/helpers.js", "packages/svelte/tests/animation-helpers.js", "packages/svelte/tests/suite.ts");
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", `refs/tags/svelte@${version}`);
  git("checkout", "-q", "FETCH_HEAD");
  console.log(`Fetched Svelte ${version}'s runtime-runes fixtures into ${dir}`);
}
