#!/usr/bin/env node
// Fails when two files in one folder could be confused by an import on a case-insensitive
// filesystem (Windows, default macOS): names equal ignoring case, or equal ignoring case once the
// script extension is dropped (`ambisonicBlock.ts` vs `AmbisonicBlock.tsx`). An extensionless
// import such as "./AmbisonicBlock" then resolves to whichever file the resolver probes first, so
// the build breaks on Windows while a case-sensitive Linux checkout compiles fine.
//
// Checks tracked and untracked (not ignored) files, so a new file is caught before it is committed.
import { execFileSync } from "node:child_process";

const SCRIPT_EXT = /\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

/** @type {Map<string, Set<string>>} key -> the distinct real paths sharing it */
const groups = new Map();
const add = (key, path) => {
  let set = groups.get(key);
  if (!set) groups.set(key, (set = new Set()));
  set.add(path);
};

for (const path of files) {
  const lower = path.toLowerCase();
  add(`exact:${lower}`, path);
  if (SCRIPT_EXT.test(path)) add(`module:${lower.replace(SCRIPT_EXT, "")}`, path);
}

// Same-case siblings (`foo.js` + `foo.d.ts`, `memory.ts` + `memory.mjs`) are fine; only a difference
// in case is ambiguous.
const stem = (path) => path.replace(SCRIPT_EXT, "");
const clashes = [...groups.values()]
  .filter((set) => new Set([...set].map(stem)).size > 1)
  .map((set) => [...set].sort());
const seen = new Set();
const unique = clashes.filter((c) => {
  const k = c.join("\n");
  return seen.has(k) ? false : (seen.add(k), true);
});

if (unique.length) {
  console.error("Files whose names differ only in case (or in case plus a script extension).");
  console.error("Imports between them resolve differently on Windows/macOS than on Linux. Rename one:\n");
  for (const c of unique) console.error(`  ${c.join("  <->  ")}`);
  process.exit(1);
}
console.log(`check-filename-case: ${files.length} files, no case collisions.`);
